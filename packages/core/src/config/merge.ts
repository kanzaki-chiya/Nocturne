/**
 * 分层合并（config.md 第 2 节；模型字段合并与来源标注见 ADR-0024 第 2 节）。
 * 输入按层序排列（低层在前）；输出 ResolvedConfig 与逐字段来源表。
 * - model / preset / turn.*：高层覆盖低层
 * - providers：按 id 合并，同 id 浅合并；其中 models 按模型 id **逐字段合并**——
 *   顶层字段逐个覆盖、capabilities 逐键覆盖、数组（reasoningEffort）整体替换
 * - permissions.rules：追加（高层规则排在低层之后，权限"后写优先"）
 */
import { inferShellKindFromPath } from "../platform/index.js";
import type { HookPoint, RuleOrigin } from "../protocol/index.js";
import type {
  ConfigFile,
  McpServerEntry,
  ModelOverrideShape,
  ModelRole,
  ProviderEntryConfig,
  ResolvedConfig,
  TurnOverrides,
} from "./types.js";
import { MODEL_ROLES } from "./types.js";

/** 层的身份（模型字段来源标注用；ADR-0024/0025） */
export type LayerKind =
  "modelsDev" | "setup" | "userModels" | "settings" | "user" | "project" | "env" | "cli";

export interface MergeLayer {
  /**
   * 层身份：setup=向导层 providers.json；userModels=providers.json 条目的
   * 用户编辑派生出的合成层（load.ts 插在 setup 与 user 之间）；其余为
   * 手写/环境/命令行层。权限规则 origin 由 kind 推导（user→"user"、
   * project→"project"、env/cli→"cli"；setup/userModels 不产生规则）。
   */
  kind: LayerKind;
  /** 定义该层的文件（来源标注与警告文案用）；env/cli 层无文件 */
  path?: string | undefined;
  file: ConfigFile;
}

/** 字段生效值由哪一层给出 */
export interface FieldOrigin {
  kind: LayerKind;
  path?: string | undefined;
}

/**
 * 某字段在一层的声明（值原文 + 来源）：按层序入栈，栈顶是生效声明；
 * "跳过 userModels 层"的下层取值直接从栈里找（模型编辑页「跟随」显示用）。
 */
export interface FieldDecl {
  origin: FieldOrigin;
  value: unknown;
}

/** 逐模型逐字段的来源表（编辑页来源标注用） */
export interface ModelFieldOrigins {
  /** providerId → modelId → 字段名（顶层字段与 capabilities.<k> 扁平记录）→ 声明栈 */
  fields: Map<string, Map<string, Map<string, FieldDecl[]>>>;
  /** providerId → 定义该服务商条目的最高层 */
  providers: Map<string, FieldOrigin>;
  /** providerId → modelId → 声明过该模型的层集合（剔除纯合成层模型的依据） */
  declaredLayers: Map<string, Map<string, Set<LayerKind>>>;
}

export interface MergeResult {
  resolved: ResolvedConfig;
  modelInfo: ModelFieldOrigins;
  origins: Partial<
    Record<
      | "model"
      | "reasoningEffort"
      | "shell"
      | "shellPath"
      | "permissions.preset"
      | "compaction.threshold"
      | "permission.reviewer"
      | `modelRoles.${ModelRole}`,
      LayerKind
    >
  >;
}

const CONFIG_KINDS: ReadonlySet<LayerKind> = new Set(["user", "project", "env", "cli"]);
const isConfigKind = (k: LayerKind): boolean => CONFIG_KINDS.has(k);

/**
 * 顶层模型字段（逐个覆盖；pricing/endpoints 作为整体值替换，不下钻）。
 * ADR-0026：protocol/endpoints 同样逐字段——高层只覆盖它实际声明的字段。
 */
const MODEL_TOP_FIELDS = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "pricing",
  "protocol",
  "endpoints",
] as const;
/** capabilities 内的键（逐键覆盖；数组整体替换） */
const CAP_FIELDS = [
  "toolCalls",
  "parallelToolCalls",
  "reasoning",
  "reasoningEffort",
  "imageInput",
  "promptCache",
  "editTool",
] as const;

type ModelCaps = NonNullable<ModelOverrideShape["capabilities"]>;

/**
 * 模型条目的逐字段合并（ADR-0024 第 2 节）：upper 只覆盖它实际声明的字段，
 * 未声明的继承 lower；capabilities 同样逐键，reasoningEffort 数组整体替换。
 */
function mergeModelEntry(
  lower: ModelOverrideShape | undefined,
  upper: ModelOverrideShape,
): ModelOverrideShape {
  const out: ModelOverrideShape = {};
  for (const f of MODEL_TOP_FIELDS) {
    const v = upper[f] ?? lower?.[f];
    if (v !== undefined) (out as Record<string, unknown>)[f] = v;
  }
  const caps: ModelCaps = {};
  let hasCaps = false;
  for (const f of CAP_FIELDS) {
    const v = upper.capabilities?.[f] ?? lower?.capabilities?.[f];
    if (v !== undefined) {
      (caps as Record<string, unknown>)[f] = v;
      hasCaps = true;
    }
  }
  if (hasCaps) out.capabilities = caps;
  return out;
}

/** 记录上层模型条目声明的字段（值 !== undefined 才入栈） */
function recordFieldOrigins(
  info: ModelFieldOrigins,
  providerId: string,
  modelId: string,
  model: ModelOverrideShape,
  layer: MergeLayer,
): void {
  info.declaredLayers.get(providerId)?.get(modelId)?.add(layer.kind);
  const fields = info.fields.get(providerId)?.get(modelId);
  if (fields === undefined) return;
  const origin: FieldOrigin = {
    kind: layer.kind,
    ...(layer.path !== undefined ? { path: layer.path } : {}),
  };
  const push = (key: string, value: unknown): void => {
    const decls = fields.get(key) ?? [];
    decls.push({ origin, value: Array.isArray(value) ? [...(value as unknown[])] : value });
    fields.set(key, decls);
  };
  for (const f of MODEL_TOP_FIELDS) {
    if (model[f] !== undefined) push(f, model[f]);
  }
  for (const f of CAP_FIELDS) {
    if (model.capabilities?.[f] !== undefined) push(`capabilities.${f}`, model.capabilities[f]);
  }
}

function trackModel(info: ModelFieldOrigins, providerId: string, modelId: string): void {
  let decl = info.declaredLayers.get(providerId);
  if (decl === undefined) {
    decl = new Map();
    info.declaredLayers.set(providerId, decl);
  }
  if (!decl.has(modelId)) decl.set(modelId, new Set());
  let fields = info.fields.get(providerId);
  if (fields === undefined) {
    fields = new Map();
    info.fields.set(providerId, fields);
  }
  if (!fields.has(modelId)) fields.set(modelId, new Map());
}

function mergeProviders(
  into: Map<string, ProviderEntryConfig>,
  entries: readonly ProviderEntryConfig[],
  layer: MergeLayer,
  info: ModelFieldOrigins,
): void {
  for (const entry of entries) {
    info.providers.set(entry.id, {
      kind: layer.kind,
      ...(layer.path !== undefined ? { path: layer.path } : {}),
    });
    for (const modelId of Object.keys(entry.models ?? {})) {
      trackModel(info, entry.id, modelId);
      recordFieldOrigins(info, entry.id, modelId, entry.models?.[modelId] ?? {}, layer);
    }
    const existing = into.get(entry.id);
    if (existing === undefined) {
      into.set(entry.id, {
        ...entry,
        models: entry.models !== undefined ? { ...entry.models } : undefined,
      });
      continue;
    }
    const models = { ...existing.models };
    for (const [modelId, model] of Object.entries(entry.models ?? {})) {
      models[modelId] = mergeModelEntry(models[modelId], model);
    }
    into.set(entry.id, {
      ...existing,
      ...entry,
      models,
      providerOptions: { ...existing.providerOptions, ...entry.providerOptions },
      headers: { ...existing.headers, ...entry.headers },
    });
  }
}

/** 警告文案中的层指代（手写配置矛盾用） */
function layerLabel(origin: FieldOrigin): string {
  switch (origin.kind) {
    case "userModels":
      return "providers.json 的用户编辑";
    case "setup":
      return origin.path ?? "providers.json";
    case "settings":
      return origin.path ?? "settings.json";
    case "modelsDev":
      return "models.dev";
    case "user":
      return origin.path ?? "config.json";
    case "project":
      return origin.path ?? "项目配置";
    case "env":
      return "环境变量";
    case "cli":
      return "命令行参数";
  }
}

/** 权限规则/事件里的 RuleOrigin：由层 kind 推导（setup/userModels 不产生规则） */
function ruleOrigin(kind: LayerKind): Extract<RuleOrigin, "user" | "project" | "cli"> {
  if (kind === "project") return "project";
  if (kind === "user" || kind === "userModels" || kind === "setup") return "user";
  return "cli";
}

export function mergeLayers(layers: readonly MergeLayer[]): MergeResult {
  const origins: MergeResult["origins"] = {};
  const out: ResolvedConfig = {
    rules: [],
    untrustedRules: [],
    providers: [],
    turn: {},
    hooks: {},
    mcpServers: [],
    warnings: [],
  };
  const providers = new Map<string, ProviderEntryConfig>();
  const mcpServers = new Map<string, { origin: "user" | "project"; entry: McpServerEntry }>();
  const info: ModelFieldOrigins = {
    fields: new Map(),
    providers: new Map(),
    declaredLayers: new Map(),
  };

  for (const layer of layers) {
    const { kind, file } = layer;
    for (const role of MODEL_ROLES) {
      const ref = file.modelRoles?.[role];
      if (ref !== undefined) {
        out.modelRoles = { ...out.modelRoles, [role]: ref };
        origins[`modelRoles.${role}`] = kind;
      }
    }
    // 旧 shell 选择把程序设置、手写配置、环境各作为一份声明；
    // 手写层之间仍逐字段覆盖，跨这些边界时不沿用低层的可执行路径。
    if (
      (file.shell !== undefined || file.shellPath !== undefined) &&
      (kind === "env" || origins.shell === "settings" || origins.shellPath === "settings")
    ) {
      delete out.shell;
      delete out.shellPath;
      delete origins.shell;
      delete origins.shellPath;
    }
    for (const key of ["model", "reasoningEffort", "shell", "shellPath"] as const) {
      if (file[key] !== undefined) origins[key] = kind;
    }
    if (file.permission?.reviewer !== undefined) {
      out.permissionReviewer = file.permission.reviewer;
      origins["permission.reviewer"] = layer.kind;
    }
    if (file.permissions?.preset !== undefined) origins["permissions.preset"] = kind;
    if (file.model !== undefined) out.model = file.model;
    if (file.compaction?.threshold !== undefined) {
      out.compactionThreshold = file.compaction.threshold;
      origins["compaction.threshold"] = kind;
    }
    if (file.reasoningEffort !== undefined) out.reasoningEffort = file.reasoningEffort;
    // ADR-0034：所有 shell 声明均在配置合并链里处理。
    if (file.shell !== undefined) out.shell = file.shell;
    if (file.shellPath !== undefined) out.shellPath = file.shellPath;
    if (file.permissions?.preset !== undefined) out.permissionPreset = file.permissions.preset;
    for (const rule of file.permissions?.rules ?? []) {
      out.rules.push({ rule, origin: ruleOrigin(kind) });
    }
    if (file.providers !== undefined) {
      for (const entry of file.providers) {
        if (entry.thinking?.levels !== undefined) {
          out.providerThinkingWarnings ??= [];
          if (!out.providerThinkingWarnings.includes(entry.id))
            out.providerThinkingWarnings.push(entry.id);
        }
      }
      mergeProviders(providers, file.providers, layer, info);
    }
    // hooks：按点位追加（高层条目排在其后，hooks.md 第 2 节）
    for (const [point, entries] of Object.entries(file.hooks ?? {})) {
      const key = point as HookPoint;
      out.hooks[key] = [...(out.hooks[key] ?? []), ...entries.map((e) => ({ ...e }))];
    }
    // mcp.servers：按名字合并，同名字段浅覆盖；origin 记录定义它的层
    // （setup/userModels/env/cli 层不产生 mcp 配置，落到 "user" 仅为类型收敛）
    for (const [name, entry] of Object.entries(file.mcp?.servers ?? {})) {
      const existing = mcpServers.get(name);
      mcpServers.set(name, {
        origin: kind === "project" ? "project" : "user",
        entry: existing === undefined ? { ...entry } : { ...existing.entry, ...entry },
      });
    }
    const t = file.turn;
    if (t !== undefined) {
      const merged: TurnOverrides = { ...out.turn };
      if (t.maxSteps !== undefined) merged.maxSteps = t.maxSteps;
      if (t.retryLimit !== undefined) merged.retryLimit = t.retryLimit;
      if (t.retryBaseDelayMs !== undefined) merged.retryBaseDelayMs = t.retryBaseDelayMs;
      if (t.firstEventTimeoutMs !== undefined) merged.firstEventTimeoutMs = t.firstEventTimeoutMs;
      if (t.idleTimeoutMs !== undefined) merged.idleTimeoutMs = t.idleTimeoutMs;
      out.turn = merged;
    }
  }

  // 合成层（userModels）不为清单外模型建条目：只由 userModels 引入的模型剔除
  for (const [providerId, entry] of providers) {
    if (entry.models === undefined) continue;
    const decl = info.declaredLayers.get(providerId);
    const kept: Record<string, ModelOverrideShape> = {};
    let touched = false;
    for (const [modelId, model] of Object.entries(entry.models)) {
      const kinds = decl?.get(modelId);
      if (kinds !== undefined && [...kinds].every((k) => k === "userModels")) {
        info.fields.get(providerId)?.delete(modelId);
        touched = true;
        continue;
      }
      kept[modelId] = model;
    }
    if (touched) providers.set(providerId, { ...entry, models: kept });
  }

  // 手写配置自身同时声明推理 none 与非空档位时，推理为准并报告矛盾。
  for (const [providerId, entry] of providers) {
    const fields = info.fields.get(providerId);
    for (const [modelId, model] of Object.entries(entry.models ?? {})) {
      if (model.capabilities?.reasoning !== "none") continue;
      const rSrc = fields?.get(modelId)?.get("capabilities.reasoning")?.at(-1)?.origin;
      if (rSrc === undefined || !isConfigKind(rSrc.kind)) continue;
      const effort = model.capabilities.reasoningEffort;
      const eSrc = fields?.get(modelId)?.get("capabilities.reasoningEffort")?.at(-1)?.origin;
      if (
        effort !== undefined &&
        effort.length > 0 &&
        eSrc !== undefined &&
        isConfigKind(eSrc.kind)
      ) {
        const where =
          rSrc.kind === eSrc.kind && rSrc.path === eSrc.path
            ? layerLabel(rSrc)
            : `${layerLabel(rSrc)}（档位来自 ${layerLabel(eSrc)}）`;
        out.warnings.push(
          `${where} 中服务商 ${providerId} 的模型 ${modelId} 推理为 none 却声明了思考档位，已按不可切换处理`,
        );
      }
    }
  }

  // ADR-0022：shellPath 是给指定种类换可执行文件用的；单独存在且
  // 文件名识别不出种类时不是有效声明——忽略并警告（不静默回退自动，
  // 由下一层/自动选择接管）
  if (
    out.shellPath !== undefined &&
    out.shell === undefined &&
    inferShellKindFromPath(out.shellPath) === undefined
  ) {
    out.warnings.push(
      `配置的 shellPath="${out.shellPath}" 无法识别为支持的 shell 可执行文件，已忽略（请同时设置 shell）`,
    );
  }

  out.providers = [...providers.values()].map((entry) => {
    if (entry.thinking === undefined) return entry;
    const { levels: _levels, source: _source, ...thinking } = entry.thinking;
    return { ...entry, thinking };
  });
  out.mcpServers = [...mcpServers.entries()].map(([name, v]) => ({
    name,
    origin: v.origin,
    entry: v.entry,
  }));
  return { resolved: out, modelInfo: info, origins };
}
