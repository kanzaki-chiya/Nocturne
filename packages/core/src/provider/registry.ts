/**
 * ProviderRegistry：按 ModelRef 解析 Provider + ModelInfo。
 * 模型信息 = 内置目录 ← 用户配置覆盖 ← 保守默认。
 */
import {
  normalizeReasoningEffortLevels,
  type EditToolKind,
  type ModelRef,
} from "../protocol/index.js";
import { BUILTIN_MODEL_CATALOG, DEFAULT_MODEL_FALLBACK } from "./catalog.js";
import { isModelProtocol, withEffectiveProtocol } from "./effective-protocol.js";
import { withReasoningEfforts } from "./reasoning.js";
import type { ModelInfo, Provider, ProviderRegistry, ResolvedModel } from "./types.js";

export class UnknownModelError extends Error {
  readonly ref: ModelRef;
  constructor(ref: ModelRef, message: string) {
    super(message);
    this.name = "UnknownModelError";
    this.ref = ref;
  }
}

/**
 * 用户在 Provider 配置里对某个模型的覆盖。
 * unavailable 是派生结果（ADR-0026 §5），不是可声明字段——覆盖
 * protocol/endpoints 后由装配层重新推导。
 */
export type ModelOverride = Partial<
  Omit<ModelInfo, "ref" | "unavailable" | "disabled" | "providerDisabled">
>;

/**
 * 用户级停用集合（ADR-0054 §3）：providers 是服务商 id（区分大小写），
 * models 是 `"<provider>/<model>"`。构建注册表时传入，resolve() 据此盖
 * `unavailable` + `disabled`；停用的服务商不从注册表移除（不沿用旧解析）。
 */
export interface DisabledModels {
  providers: ReadonlySet<string>;
  models: ReadonlySet<string>;
}

const DISABLED_ENABLE_HINT = "可在 设置 › 服务商 或 /provider 重新启用";

/** 停用导致不可用时的原因文案（ADR-0054 §3） */
export function disabledReason(ref: ModelRef, source: "provider" | "model"): string {
  return source === "provider"
    ? `服务商 ${ref.provider} 已停用（${DISABLED_ENABLE_HINT}）`
    : `模型 ${ref.provider}/${ref.model} 已停用（${DISABLED_ENABLE_HINT}）`;
}

/**
 * 给解析结果盖上停用标记：停用的服务商覆盖其下全部模型；逐个停用的模型
 * 独立命中。个别停用优先于服务商停用（disabled="model"）——服务商停用时
 * 客户端仍能从该来源还原逐个设置（ADR-0054 §3、§4「开关保留状态」）。
 * 双重命中时另带 providerDisabled（ADR-0054 §3：一键重新启用需同时恢复两者）。
 * 已由协议推导标 unavailable 的模型在停用时改写为停用原因
 * （重新启用才是可操作的动作）。未停用时原样返回。
 */
export function applyDisabled(model: ModelInfo, disabled: DisabledModels | undefined): ModelInfo {
  if (disabled === undefined) return model;
  const modelOff = disabled.models.has(`${model.ref.provider}/${model.ref.model}`);
  const providerOff = disabled.providers.has(model.ref.provider);
  const source = modelOff ? ("model" as const) : providerOff ? ("provider" as const) : undefined;
  if (source === undefined) {
    // 未停用：同时剥掉可能残留的旧盖章（provider.models() 的条目可能带着
    // 构造时的 disabled，listModels / resolve 每次都以当前集合重算）。
    if (model.disabled === undefined && model.providerDisabled === undefined) return model;
    const { disabled: _dropped, providerDisabled: _alsoDropped, ...rest } = model;
    return rest;
  }
  const { providerDisabled: _stale, ...rest } = model;
  return {
    ...rest,
    unavailable: { reason: disabledReason(model.ref, source) },
    disabled: source,
    ...(modelOff && providerOff ? { providerDisabled: true as const } : {}),
  };
}

/** 在既有 ModelInfo 上应用用户覆盖 */
export function applyModelOverride(
  base: ModelInfo,
  override: ModelOverride | undefined,
): ModelInfo {
  if (override === undefined) return base;
  return {
    ref: base.ref,
    baseURL: override.baseURL ?? base.baseURL,
    baseURLSource: override.baseURLSource ?? base.baseURLSource,
    displayName: override.displayName ?? base.displayName,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    pricing: override.pricing ?? base.pricing,
    pricingSource:
      override.pricing !== undefined ? (override.pricingSource ?? "config") : base.pricingSource,
    protocol: override.protocol ?? base.protocol,
    endpoints: override.endpoints ?? base.endpoints,
    ...(base.unavailable !== undefined ? { unavailable: base.unavailable } : {}),
    capabilities: {
      ...base.capabilities,
      ...override.capabilities,
      // 声明空间的 reasoningEffort 是任意字符串数组，归一化为合法档位
      // （保留显式空数组语义 = 明确无档位）
      ...(override.capabilities?.reasoningEffort !== undefined
        ? { reasoningEffort: normalizeReasoningEffortLevels(override.capabilities.reasoningEffort) }
        : {}),
    },
  };
}

/**
 * 编辑工具的模型默认表（ADR-0035 §5）：config 层纯数据函数经装配处注入；
 * 只在「条目/覆盖均未声明 editTool 且内置目录未命中」时参与兜底。
 */
export type EditToolDefault = (modelId: string) => EditToolKind;

/** 合并目录项与覆盖项，生成 ModelInfo */
export function resolveModelInfo(
  ref: ModelRef,
  override: ModelOverride | undefined,
  editToolDefault?: EditToolDefault,
): ModelInfo {
  const builtin = BUILTIN_MODEL_CATALOG[ref.provider]?.[ref.model];
  const base: ModelInfo = {
    ref,
    ...(builtin ?? DEFAULT_MODEL_FALLBACK),
  };
  const inferred =
    builtin === undefined &&
    override?.capabilities?.reasoning === undefined &&
    (override?.capabilities?.reasoningEffort?.length ?? 0) > 0;
  const merged = applyModelOverride(
    inferred
      ? {
          ...base,
          capabilities: { ...base.capabilities, reasoning: "visible" },
        }
      : base,
    override,
  );
  // ADR-0035 §5：条目/覆盖声明 > 内置目录 > 按模型名的默认表 > "edit"
  if (override?.capabilities?.editTool === undefined && builtin === undefined) {
    return {
      ...merged,
      capabilities: {
        ...merged.capabilities,
        editTool: editToolDefault?.(ref.model) ?? "edit",
      },
    };
  }
  return merged;
}

export function createProviderRegistry(
  providers: Provider[],
  modelOverrides: Record<string, Record<string, ModelOverride>> = {},
  editToolDefault?: EditToolDefault,
  disabled?: DisabledModels,
): ProviderRegistry {
  const byId = new Map<string, Provider>();
  for (const p of providers) {
    if (byId.has(p.id)) {
      throw new Error(`Provider id 重复: ${p.id}`);
    }
    byId.set(p.id, p);
  }
  return {
    resolve(ref: ModelRef): ResolvedModel {
      const provider = byId.get(ref.provider);
      if (provider === undefined) {
        throw new UnknownModelError(ref, `未配置的 Provider: ${ref.provider}`);
      }
      const configured = provider.models().find((m) => m.ref.model === ref.model);
      const base = configured ?? resolveModelInfo(ref, undefined, editToolDefault);
      const merged = applyModelOverride(base, modelOverrides[ref.provider]?.[ref.model]);
      // 清单内模型适配器已解析（幂等）；清单外模型按逐模型能力推导档位。
      const merged2 = withReasoningEfforts(merged);
      // ADR-0026：按条目标识协议重算生效协议——清单内模型已盖章（幂等），
      // 清单外/覆盖后的模型取条目 type；非协议感知的 Provider（type 不是
      // 两种协议）不盖章。
      const model = isModelProtocol(provider.type)
        ? withEffectiveProtocol(merged2, provider.type)
        : merged2;
      // ADR-0054 §3：停用在此盖章——停用的服务商照常解析出实例，但结果不可用。
      return { provider, model: applyDisabled(model, disabled) };
    },
    providers: () => [...byId.values()],
  };
}

/**
 * 命令行/环境变量模型 id 归一化（cli.md §2/§4 同规则）：
 * 值归属"当前 Provider"（providerId = 生效的 api-type）；前缀等于当前
 * Provider 时剥掉，前缀是另一种 api-type 时报错；其余含斜杠的值
 * （命名空间模型 id，如 deepseek/deepseek-v4.1-flash）原样保留。
 * 归一化语义属于 Provider 层，CLI 与 TUI 共用（tui.md §9）。
 */
export function normalizeModelRef(
  model: string,
  providerId: string,
): { ok: true; ref: string } | { ok: false; problem: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { ok: true, ref: `${providerId}/${model}` };
  const prefix = model.slice(0, slash);
  if (prefix === providerId) return { ok: true, ref: model };
  if (prefix === "openai-compatible" || prefix === "anthropic") {
    return {
      ok: false,
      problem: `模型前缀 "${prefix}" 与当前 Provider "${providerId}" 不一致`,
    };
  }
  return { ok: true, ref: `${providerId}/${model}` };
}
