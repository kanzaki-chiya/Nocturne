/**
 * 模型设置编辑（ADR-0024 第 2、3 节）：把合并结果 + 逐字段来源表 + 内置目录
 * 翻译成编辑页/CLI 问答用的 ModelSettingsView，并把补丁落到 userModels。
 * 本文件只做纯计算；层的构造与文件写回在 load.ts。
 */
import {
  isReasoningEffortLevel,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
} from "../protocol/index.js";
import type { FieldDecl, FieldOrigin, ModelFieldOrigins } from "./merge.js";
import type {
  BuiltinModelLookup,
  ModelField,
  ModelFieldSource,
  ModelSettingsPatch,
  ModelSettingsView,
  UserModelEntry,
} from "./types.js";
import type { ProviderEntryConfig } from "./types.js";

type ReasoningValue = "none" | "hidden" | "visible";

function toSource(origin: FieldOrigin): ModelFieldSource {
  switch (origin.kind) {
    case "modelsDev":
      return { kind: "modelsDev" };
    case "setup":
      return { kind: "upstream" };
    case "userModels":
      return { kind: "user" };
    case "user":
      return {
        kind: "config",
        layer: "user",
        ...(origin.path !== undefined ? { path: origin.path } : {}),
      };
    case "project":
      return {
        kind: "config",
        layer: "project",
        ...(origin.path !== undefined ? { path: origin.path } : {}),
      };
    case "env":
      return { kind: "config", layer: "env" };
    case "cli":
      return { kind: "config", layer: "cli" };
  }
}

/** 定义服务商条目的层 → 只读提示（managed=false 时） */
export function providerOriginHint(providerId: string, origin: FieldOrigin | undefined): string {
  const where =
    origin === undefined
      ? "未定义"
      : origin.kind === "env"
        ? "环境变量"
        : origin.kind === "cli"
          ? "命令行参数"
          : (origin.path ?? (origin.kind === "user" ? "config.json" : "providers.json"));
  return `服务商 ${providerId} 定义在 ${where}，请编辑该处配置`;
}

/** 字段来源的界面文案（TUI 编辑页与 CLI 问答共用） */
export function modelFieldSourceText(source: ModelFieldSource): string {
  switch (source.kind) {
    case "upstream":
      return "上游";
    case "modelsDev":
      return "models.dev";
    case "user":
      return "用户编辑";
    case "config":
      switch (source.layer) {
        case "user":
          return `由 ${source.path ?? "config.json"} 决定`;
        case "project":
          return `由 ${source.path ?? "项目配置"} 决定`;
        case "env":
          return "由环境变量决定";
        case "cli":
          return "由命令行参数决定";
      }
      break;
    case "builtin":
      return "内置";
    case "default":
      return "默认";
    case "derived":
      return "按推理能力推导";
  }
}

interface FieldCtx {
  fields: ModelFieldOrigins["fields"];
  providerId: string;
  modelId: string;
  managed: boolean;
}

/** 字段的声明栈（按层序；栈顶 = 生效声明） */
function decls(ctx: FieldCtx, key: string): FieldDecl[] {
  return ctx.fields.get(ctx.providerId)?.get(ctx.modelId)?.get(key) ?? [];
}

/** 跳过 userModels 层的最新声明（「跟随」取值依据） */
function lastNonUserDecl(list: readonly FieldDecl[]): FieldDecl | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d !== undefined && d.origin.kind !== "userModels") return d;
  }
  return undefined;
}

/** 通用标量字段视图：声明层 → 来源标注；内置目录 → builtin；否则 default */
function scalarField<T>(
  ctx: FieldCtx,
  key: string,
  mergedValue: T | undefined,
  builtinValue: T | undefined,
  defaultValue: T | undefined,
  userValue: T | undefined,
): ModelField<T> {
  const list = decls(ctx, key);
  const top = list.at(-1);
  const lowerValue = (lastNonUserDecl(list)?.value ?? builtinValue ?? defaultValue) as
    T | undefined;
  const base = { editable: ctx.managed, lowerValue };
  if (top !== undefined) {
    const source = toSource(top.origin);
    return {
      ...base,
      value: mergedValue,
      source,
      editable: ctx.managed && source.kind !== "config",
      ...(userValue !== undefined ? { userValue } : {}),
    };
  }
  if (builtinValue !== undefined) {
    return {
      ...base,
      value: builtinValue,
      source: { kind: "builtin" },
      ...(userValue !== undefined ? { userValue } : {}),
    };
  }
  return {
    ...base,
    value: defaultValue,
    source: { kind: "default" },
    ...(userValue !== undefined ? { userValue } : {}),
  };
}

/**
 * 思考档位的声明链（ADR-0024 第 2 节档位链、providers.md ADR-0018 链）：
 * 推理为 none 时无档位；否则逐模型声明 > 推导全档。
 */
function resolveEffort(
  list: readonly FieldDecl[],
  reasoningValue: "none" | "hidden" | "visible" | undefined,
): { value: ReasoningEffortLevel[] | undefined; source: ModelFieldSource } {
  const top = list.at(-1);
  if (reasoningValue === "none") {
    return {
      value: undefined,
      source: top !== undefined ? toSource(top.origin) : { kind: "default" },
    };
  }
  if (top !== undefined) {
    return { value: top.value as ReasoningEffortLevel[] | undefined, source: toSource(top.origin) };
  }
  return { value: [...REASONING_EFFORT_LEVELS], source: { kind: "derived" } };
}

export interface ModelSettingsViewInput {
  providerId: string;
  /** 合并结果中的服务商条目（不存在则无清单模型） */
  entry: ProviderEntryConfig | undefined;
  /** 服务商条目是否在 providers.json（决定 readonly） */
  managed: boolean;
  /** providers.json 中该条目的 userModels（原样取出作 userValue） */
  userModels: Record<string, UserModelEntry> | undefined;
  /** 本次合并的逐字段来源表 */
  modelInfo: ModelFieldOrigins;
  /** 内置目录查询（可为空，此时 builtin 层视为不存在） */
  builtinModel?: BuiltinModelLookup | undefined;
}

/** 按 ADR-0024 第 2 节构清单模型的视图（按模型 id 排序） */
export function buildModelSettingsViews(input: ModelSettingsViewInput): ModelSettingsView[] {
  const { providerId, entry, managed, userModels, modelInfo, builtinModel } = input;
  const readonlyHint = managed
    ? undefined
    : providerOriginHint(providerId, modelInfo.providers.get(providerId));
  const views: ModelSettingsView[] = [];
  for (const modelId of Object.keys(entry?.models ?? {}).sort()) {
    const model = entry?.models?.[modelId];
    const userEntry = userModels?.[modelId];
    const builtin = builtinModel?.(providerId, modelId);
    const ctx: FieldCtx = { fields: modelInfo.fields, providerId, modelId, managed };
    const uCaps = userEntry?.capabilities;

    const effortDecls = decls(ctx, "capabilities.reasoningEffort");
    const explicitReasoning = decls(ctx, "capabilities.reasoning").length > 0;
    const inferredReasoning: ReasoningValue | undefined =
      !explicitReasoning &&
      effortDecls.at(-1)?.value instanceof Array &&
      (effortDecls.at(-1)?.value as unknown[]).length > 0
        ? "visible"
        : undefined;
    const reasoning = scalarField<ReasoningValue>(
      ctx,
      "capabilities.reasoning",
      model?.capabilities?.reasoning ?? inferredReasoning,
      builtin?.capabilities?.reasoning,
      inferredReasoning ?? "none",
      uCaps?.reasoning,
    );
    // 跳过用户编辑层，计算「跟随」时的档位。
    const lowerEffort = resolveEffort(
      effortDecls.filter((d) => d.origin.kind !== "userModels"),
      reasoning.lowerValue,
    ).value;
    const resolved = resolveEffort(effortDecls, reasoning.value);
    const reasoningEffort: ModelField<ReasoningEffortLevel[]> = {
      value: resolved.value,
      source: resolved.source,
      editable: managed && reasoning.value !== "none" && resolved.source.kind !== "config",
      lowerValue: lowerEffort,
      ...(uCaps?.reasoningEffort !== undefined ? { userValue: uCaps.reasoningEffort } : {}),
    };

    views.push({
      providerId,
      modelId,
      readonly: !managed,
      ...(readonlyHint !== undefined ? { readonlyHint } : {}),
      fields: {
        displayName: scalarField<string>(
          ctx,
          "displayName",
          model?.displayName,
          builtin?.displayName,
          undefined,
          userEntry?.displayName,
        ),
        contextWindow: scalarField<number>(
          ctx,
          "contextWindow",
          model?.contextWindow,
          builtin?.contextWindow,
          undefined,
          userEntry?.contextWindow,
        ),
        maxOutputTokens: scalarField<number>(
          ctx,
          "maxOutputTokens",
          model?.maxOutputTokens,
          builtin?.maxOutputTokens,
          undefined,
          userEntry?.maxOutputTokens,
        ),
        reasoning,
        imageInput: scalarField<boolean>(
          ctx,
          "capabilities.imageInput",
          model?.capabilities?.imageInput,
          builtin?.capabilities?.imageInput,
          false,
          uCaps?.imageInput,
        ),
        reasoningEffort,
      },
    });
  }
  return views;
}

/** 「不支持思考强度」档位列表的归一化（与 providers.md ADR-0018 链同口径） */
const FIELD_KEYS = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "imageInput",
  "reasoningEffort",
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

/** patch 里的键 → userModels 条目上的位置 */
function applyField(entry: UserModelEntry, key: FieldKey, v: unknown): void {
  const u = entry as Record<string, unknown>;
  if (key === "reasoning" || key === "imageInput" || key === "reasoningEffort") {
    const caps = { ...(entry.capabilities ?? {}) } as Record<string, unknown>;
    if (v === null) Reflect.deleteProperty(caps, key);
    else caps[key] = v;
    if (Object.keys(caps).length === 0) delete u.capabilities;
    else u.capabilities = caps;
    return;
  }
  if (v === null) Reflect.deleteProperty(u, key);
  else u[key] = v;
}

/**
 * 把补丁应用到 userModels 副本：undefined 值 = 保留，null = 清除用户编辑。
 * 清除后空的模型条目删除；整个 userModels 为空时返回 undefined（删字段）。
 */
export function applyModelPatch(
  userModels: Record<string, UserModelEntry> | undefined,
  modelId: string,
  patch: ModelSettingsPatch,
): Record<string, UserModelEntry> | undefined {
  const next: Record<string, UserModelEntry> = { ...(userModels ?? {}) };
  const entry: UserModelEntry = { ...(next[modelId] ?? {}) };
  for (const key of FIELD_KEYS) {
    const v = patch[key];
    if (v === undefined) continue;
    applyField(entry, key, v);
  }
  if (Object.keys(entry).length === 0) Reflect.deleteProperty(next, modelId);
  else next[modelId] = entry;
  return Object.keys(next).length === 0 ? undefined : next;
}

/** 来源为 config 的字段不能被用户编辑（返回报错文案；合法返回 undefined） */
export function configFieldError(
  view: ModelSettingsView,
  patch: ModelSettingsPatch,
): string | undefined {
  for (const key of FIELD_KEYS) {
    if (patch[key] === undefined) continue;
    const f = view.fields[key];
    if (f.source.kind !== "config") continue;
    const label = modelFieldSourceText(f.source);
    const name =
      key === "displayName"
        ? "显示名"
        : key === "contextWindow"
          ? "上下文长度"
          : key === "maxOutputTokens"
            ? "最大输出"
            : key === "reasoning"
              ? "推理"
              : key === "imageInput"
                ? "图片输入"
                : "思考档位";
    return `${name}${label}，不能在编辑页修改`;
  }
  return undefined;
}

/** patch 数值与枚举的合法性（抛错文案在 load.ts 包成 ConfigError） */
export function patchValueError(patch: ModelSettingsPatch): string | undefined {
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const v = patch[key];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v <= 0)) {
      return `${key === "contextWindow" ? "上下文长度" : "最大输出"}必须为正整数`;
    }
  }
  const r: unknown = patch.reasoning;
  if (r !== undefined && r !== null && r !== "none" && r !== "hidden" && r !== "visible") {
    return `推理只能为 none/hidden/visible`;
  }
  const e = patch.reasoningEffort as readonly string[] | null | undefined;
  if (e?.some((l) => !isReasoningEffortLevel(l)) === true) {
    return `思考档位只能是 ${REASONING_EFFORT_LEVELS.join("/")}`;
  }
  return undefined;
}

/**
 * 以"保存后的最终生效值"做的校验（candidate 视图）：
 * - 生效 maxOutputTokens > 生效 contextWindow → 拒绝；
 * - 生效 reasoning=none（来源 user/config）且用户档位非空 → 拒绝；
 * - 用户把推理设为 none 而生效档位来自 config 且非空 → 拒绝（写明决定方）。
 */
export function effectiveValueError(candidate: ModelSettingsView): string | undefined {
  const { contextWindow, maxOutputTokens, reasoning, reasoningEffort } = candidate.fields;
  if (
    contextWindow.value !== undefined &&
    maxOutputTokens.value !== undefined &&
    maxOutputTokens.value > contextWindow.value
  ) {
    return `最大输出 ${maxOutputTokens.value} 超过上下文长度 ${contextWindow.value}`;
  }
  if (reasoning.value === "none" && reasoning.source.kind === "user") {
    // 用户编辑 none：档位链只被手写配置豁免
    if (
      reasoningEffort.lowerValue !== undefined &&
      reasoningEffort.lowerValue.length > 0 &&
      reasoningEffort.source.kind === "config"
    ) {
      return `${modelFieldSourceText(reasoningEffort.source)}，不能把推理设为 none`;
    }
    if (reasoningEffort.userValue !== undefined && reasoningEffort.userValue.length > 0) {
      return `推理为 none 时不能保存非空的思考档位`;
    }
  }
  if (
    reasoning.value === "none" &&
    reasoning.source.kind === "config" &&
    reasoningEffort.userValue !== undefined &&
    reasoningEffort.userValue.length > 0
  ) {
    return `推理为 none 时不能保存非空的思考档位`;
  }
  return undefined;
}
