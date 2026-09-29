/**
 * ProviderRegistry：按 ModelRef 解析 Provider + ModelInfo。
 * 模型信息 = 内置目录 ← 用户配置覆盖 ← 保守默认。
 */
import { normalizeReasoningEffortLevels, type ModelRef } from "../protocol/index.js";
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
export type ModelOverride = Partial<Omit<ModelInfo, "ref" | "unavailable">>;

/** 在既有 ModelInfo 上应用用户覆盖 */
export function applyModelOverride(
  base: ModelInfo,
  override: ModelOverride | undefined,
): ModelInfo {
  if (override === undefined) return base;
  return {
    ref: base.ref,
    displayName: override.displayName ?? base.displayName,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    pricing: override.pricing ?? base.pricing,
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

/** 合并目录项与覆盖项，生成 ModelInfo */
export function resolveModelInfo(ref: ModelRef, override: ModelOverride | undefined): ModelInfo {
  const builtin = BUILTIN_MODEL_CATALOG[ref.provider]?.[ref.model];
  const base: ModelInfo = {
    ref,
    ...(builtin ?? DEFAULT_MODEL_FALLBACK),
  };
  const inferred =
    builtin === undefined &&
    override?.capabilities?.reasoning === undefined &&
    (override?.capabilities?.reasoningEffort?.length ?? 0) > 0;
  return applyModelOverride(
    inferred
      ? {
          ...base,
          capabilities: { ...base.capabilities, reasoning: "visible" },
        }
      : base,
    override,
  );
}

export function createProviderRegistry(
  providers: Provider[],
  modelOverrides: Record<string, Record<string, ModelOverride>> = {},
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
      const base = configured ?? resolveModelInfo(ref, undefined);
      const merged = applyModelOverride(base, modelOverrides[ref.provider]?.[ref.model]);
      // 清单内模型适配器已解析（幂等）；清单外模型按逐模型能力推导档位。
      const merged2 = withReasoningEfforts(merged);
      // ADR-0026：按条目标识协议重算生效协议——清单内模型已盖章（幂等），
      // 清单外/覆盖后的模型取条目 type；非协议感知的 Provider（type 不是
      // 两种协议）不盖章。
      const model = isModelProtocol(provider.type)
        ? withEffectiveProtocol(merged2, provider.type)
        : merged2;
      return { provider, model };
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
