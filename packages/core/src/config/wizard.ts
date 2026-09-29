/**
 * 服务商配置向导的流程编排（provider-setup.md 第 1、6 节）：
 * 预设/模型列表/文件写入走注入的能力（provider 层与 RuntimeConfig），
 * 交互外壳（行式问答、TUI 弹层）由客户端实现 WizardIo。
 * 向导不发送模型请求（不消耗 token）：密钥、地址与模型 id 的有效性
 * 由会话中的首次真实请求检验，错误提示见 agent/turn.ts 的
 * providerFailureHint。config 不依赖 provider——fetchModels/presets
 * 与环境变量读取全部由调用方注入；fetchModels 抛出的错误可携带
 * 数字 status（ProviderUpstreamError），401/403 时提示密钥可能无效。
 */
import { isReasoningEffortLevel, REASONING_EFFORT_LEVELS } from "../protocol/index.js";
import { modelFieldSourceText } from "./model-settings.js";
import type {
  ModelOverrideShape,
  ModelSettingsPatch,
  ProviderEntryConfig,
  RuntimeConfig,
  UpstreamModelEntry,
} from "./types.js";

/** 单项输入/多选的附加渲染参数：hint 是提示下方的灰色小字说明 */
export interface WizardAskOpts {
  hint?: string | undefined;
}

export interface WizardMultiOpts extends WizardAskOpts {
  /**
   * "全否"选项下标（ADR-0019 第 2 条）：勾选它时其余勾选无效——
   * 用于"不支持思考强度"这类与其他项互斥的选项。
   */
  exclusiveIndex?: number | undefined;
}

/** 向导的输入输出抽象：nctrn setup 用真实 TTY；TUI 弹层与测试注入自己的实现 */
export interface WizardIo {
  /** 普通单行输入（回显）；hint 为提示下方的说明小字 */
  ask(prompt: string, opts?: WizardAskOpts): Promise<string>;
  /** 密钥输入：回显为 *（TTY raw mode / TUI 掩码框）；非 TTY 退化为普通读取 */
  askSecret(prompt: string, opts?: WizardAskOpts): Promise<string>;
  /**
   * 多选勾选（ADR-0018/0019）：返回选中项的下标（有序去重）；
   * 空数组 = 全部不选。CLI 输入逗号分隔编号，TUI 空格勾选回车确认。
   * opts.exclusiveIndex 标记"全否"项：实现方应保证它与其它项互斥。
   */
  chooseMulti(
    prompt: string,
    options: readonly string[],
    opts?: WizardMultiOpts,
  ): Promise<number[]>;
  /**
   * 瞬时进度行：会被后续输出覆盖，不进历史（TUI 渲染为忙碌行；
   * CLI 直接打印）。用于"正在获取模型列表…"这类进行中提示。
   */
  busy(text: string): void;
  /**
   * 已完成步骤的一行摘要（ADR-0019 第 4 条）：TUI 折叠为同行
   * "名称 x · 地址 y · 密钥已保存"；CLI 逐行打印。
   */
  step(text: string): void;
  print(text: string): void;
}

/** 向导取消（Ctrl+C / Ctrl+D / 列表选择越界） */
export class WizardAbort extends Error {
  constructor() {
    super("已取消");
    this.name = "WizardAbort";
  }
}

/** 预设形状（与 provider 层 ProviderPreset 结构兼容；客户端注入 listProviderPresets） */
export interface WizardPreset {
  id: string;
  label: string;
  type: "openai-compatible" | "anthropic";
  defaultName: string;
  baseURL?: string | undefined;
  defaultKeyEnv?: string | undefined;
  fetchableModels: boolean;
  /** 思考参数格式（ADR-0018）：写入条目的 thinking.format（openrouter → reasoning.effort） */
  thinkingFormat?: "openai" | "openrouter" | undefined;
  /** 密钥获取入口（控制台 URL）：密钥步骤的说明小字用它提示来源 */
  keyHint?: string | undefined;
}

export interface WizardFetchRequest {
  type: "openai-compatible" | "anthropic";
  baseURL?: string | undefined;
}

/** 向导编排依赖：客户端注入 provider 层能力与环境变量读取 */
export interface SetupWizardDeps {
  presets(): readonly WizardPreset[];
  /**
   * GET /models 模型列表；失败时抛出错误（约定可携带数字 `status`，
   * 401/403 被向导识别为"密钥可能无效"，其余错误一律退回手动输入）
   */
  fetchModels(req: WizardFetchRequest, key: string | undefined): Promise<UpstreamModelEntry[]>;
  env(name: string): string | undefined;
}

export interface WizardResult {
  providerId: string;
  /** 已登记到条目 models 的上游模型数（服务商页/CLI 结果行用） */
  modelCount: number;
}

function backendLabel(backend: string): string {
  switch (backend) {
    case "dpapi":
      return "Windows DPAPI";
    case "keychain":
      return "macOS 钥匙串";
    case "libsecret":
      return "Secret Service";
    default:
      return backend;
  }
}

/** 注入的 fetchModels 抛错约定：可携带数字 status（ProviderUpstreamError） */
function upstreamStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * 服务商配置向导（provider-setup.md 第 1 节）。
 * presetId 存在时跳过服务商选择（TUI 左栏 ○ 预设直达）。
 * v0.3 起向导只把服务商配上：不再询问模型与"设为默认"——模型选择
 * 统一走 /model（ADR-0019 第 3 条）；上游模型列表仍写入条目 models。
 */
export async function runProviderSetupWizard(
  io: WizardIo,
  config: RuntimeConfig,
  deps: SetupWizardDeps,
  opts?: { presetId?: string | undefined },
): Promise<WizardResult> {
  const presets = deps.presets();
  let preset: WizardPreset;
  if (opts?.presetId !== undefined) {
    const found = presets.find((p) => p.id === opts.presetId);
    if (found === undefined) throw new Error(`未知预设：${opts.presetId}`);
    preset = found;
  } else {
    const lines = presets.map((p, i) => `  ${i + 1}) ${p.label}`);
    io.print(`选择服务商：\n${lines.join("\n")}`);
    const pick = await io.ask("> ");
    const n = Number.parseInt(pick, 10);
    const chosen = presets[n - 1];
    if (chosen === undefined) throw new WizardAbort();
    preset = chosen;
  }

  // 名称：仅自定义预设询问（必填）；内置预设直接用 defaultName
  let providerId = preset.defaultName;
  if (providerId === "") {
    providerId = await io.ask("名称：", {
      hint: "该服务商在 providers.json、/model 与状态栏中的标识",
    });
    if (providerId === "") throw new WizardAbort();
  }
  io.step(`名称 ${providerId}`);

  // 自定义预设问服务地址
  let baseURL = preset.baseURL;
  if (baseURL === undefined && preset.type === "openai-compatible") {
    baseURL = await io.ask("服务地址：", {
      hint: "OpenAI 兼容端点，通常以 /v1 结尾（如 https://api.example.com/v1）",
    });
    if (baseURL === "") throw new WizardAbort();
  } else if (baseURL === undefined) {
    baseURL = await io.ask("服务地址：", { hint: "留空使用官方端点" });
    if (baseURL === "") baseURL = undefined;
  }
  io.step(`地址 ${baseURL ?? "官方端点"}`);

  // 密钥：后端可用时经凭据存储；不可用时退回环境变量方式
  const backend = config.credentials.backend();
  let key: string | undefined;
  let apiKeyEnv: string | undefined;
  if (backend !== "none") {
    key = await io.askSecret("API Key：", {
      hint:
        (preset.keyHint !== undefined ? `从 ${preset.keyHint} 获取；` : "") +
        "输入不回显；直接回车改用环境变量",
    });
    if (key !== "") {
      io.step("密钥已保存（凭据存储）");
      io.print(`密钥已交给 ${backendLabel(backend)} 加密保存`);
    } else {
      key = undefined;
    }
  }
  if (key === undefined) {
    const defEnv = preset.defaultKeyEnv ?? "NOCTURNE_API_KEY";
    const envName = await io.ask(`凭据环境变量名 [${defEnv}]：`, {
      hint: "该变量的值会作为请求凭据发送",
    });
    apiKeyEnv = envName !== "" ? envName : defEnv;
    io.step(`密钥来源：环境变量 ${apiKeyEnv}`);
    if (backend === "none") {
      io.print("系统凭据后端不可用，使用环境变量方式");
    }
  }

  // 凭据实际值：凭据存储路径用输入的 key；环境变量路径看变量当前是否已设置
  const effectiveKey = key ?? (apiKeyEnv !== undefined ? deps.env(apiKeyEnv) : undefined);

  // 模型列表：只获取不选择（v0.3）——上游声明的限额/能力写回条目 models；
  // 失败显示原因并继续后续步骤，保存后可用 /provider refresh 重试
  const fetchReq = {
    type: preset.type,
    ...(baseURL !== undefined ? { baseURL } : {}),
  };
  let upstreamModels: UpstreamModelEntry[] = [];
  if (preset.fetchableModels) {
    io.busy("正在获取模型列表…");
    try {
      upstreamModels = await deps.fetchModels(
        fetchReq,
        effectiveKey !== undefined && effectiveKey !== "" ? effectiveKey : undefined,
      );
      io.step(`已获取 ${upstreamModels.length} 个模型`);
    } catch (e) {
      const status = upstreamStatus(e);
      if (status === 401 || status === 403) {
        io.step(`! 获取模型列表失败（HTTP ${status}）：密钥可能无效`);
        io.print("保存后可用 /provider key 更新密钥，再 /provider refresh 重试");
      } else {
        const why =
          status !== undefined ? `HTTP ${status}` : e instanceof Error ? e.message : String(e);
        io.step(`! 获取模型列表失败（${why}）：模型将手动填写`);
        io.print("保存后可用 /provider refresh 重试");
      }
    }
  }

  // models 字段写入上游声明的能力/价格/限额/接口（provider-setup.md 第 7 节）
  const models: Record<string, ModelOverrideShape> = {};
  for (const m of upstreamModels) {
    models[m.id] = {
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
      ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
      // ADR-0026 第 2 节：上游 supported_endpoints 原文随条目保存
      ...(m.endpoints !== undefined ? { endpoints: m.endpoints } : {}),
    };
  }

  // thinking.format 是协议格式开关；能力和档位只按模型声明。
  const thinking: ProviderEntryConfig["thinking"] = {
    ...(preset.thinkingFormat !== undefined ? { format: preset.thinkingFormat } : {}),
  };

  const modelCount = upstreamModels.length;
  await config.saveSetupProvider(
    {
      id: providerId,
      type: preset.type,
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
      models,
      ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
      ...(modelCount > 0
        ? { source: "upstream" as const, fetchedAt: new Date().toISOString() }
        : {}),
    },
    {
      ...(key !== undefined ? { key } : {}),
    },
  );

  const modelsDevWarning = await config.refreshModelsDev();
  if (modelsDevWarning !== undefined) io.print(`! ${modelsDevWarning}`);

  io.print(`已保存 ${providerId}${modelCount > 0 ? `，${modelCount} 个模型` : ""}`);
  return { providerId, modelCount };
}

/**
 * /provider key <name>：更新单个服务商的密钥（provider-setup.md 第 1 节）。
 * 新密钥经 credentials.set 写入系统后端后即完成——不做连接测试，
 * 密钥有效性由下一次真实请求检验。
 */
export async function runProviderKeyWizard(
  io: WizardIo,
  config: RuntimeConfig,
  providerId: string,
): Promise<void> {
  const backend = config.credentials.backend();
  if (backend === "none") {
    io.print("! 系统凭据后端不可用，无法保存密钥；请改用 apiKeyEnv 环境变量方式");
    return;
  }
  const key = await io.askSecret(`新的 API Key（${providerId}）：`, {
    hint: "输入不回显；直接回车 = 取消",
  });
  if (key === "") {
    io.print("已取消（未输入密钥）");
    return;
  }
  await config.setCredential(providerId, key);
  io.print(`密钥已交给 ${backendLabel(backend)} 加密保存`);
}

// ── 模型设置编辑（ADR-0024 第 4 节） ─────────────────────

const MODEL_FIELD_LABELS = {
  displayName: "显示名",
  contextWindow: "上下文长度",
  maxOutputTokens: "最大输出",
  reasoning: "推理",
  imageInput: "图片输入",
  reasoningEffort: "思考档位",
  // ADR-0026 第 7 节：第七个字段「协议」
  protocol: "协议",
} as const;
type ModelFieldKey = keyof typeof MODEL_FIELD_LABELS;
const MODEL_FIELD_ORDER: readonly ModelFieldKey[] = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "imageInput",
  "reasoningEffort",
  "protocol",
];

/** 当前值的一行显示（用户未声明时显示生效值；未声明显示 "—"） */
function modelFieldText(key: ModelFieldKey, value: unknown): string {
  if (value === undefined) return key === "protocol" ? "协议不支持" : "—";
  if (key === "reasoning") return value === "none" ? "否" : "是";
  if (key === "imageInput") return value === true ? "是" : "否";
  if (key === "reasoningEffort")
    return Array.isArray(value) ? (value.length > 0 ? value.join(",") : "不支持") : "—";
  if (key === "protocol") {
    if (value === "openai-compatible") return "Chat Completions";
    if (value === "anthropic") return "Messages";
    return "—";
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}

function parseModelField(key: ModelFieldKey, input: string): unknown {
  const s = input.trim();
  if (s === "") return "";
  switch (key) {
    case "displayName":
      return s;
    case "contextWindow":
    case "maxOutputTokens": {
      const n = Number(s);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
    case "imageInput": {
      const t = s.toLowerCase();
      if (t === "y" || t === "yes" || t === "true" || t === "on") return true;
      if (t === "n" || t === "no" || t === "false" || t === "off") return false;
      return undefined;
    }
    case "reasoning":
      return s.toLowerCase() === "y" ? "visible" : s.toLowerCase() === "n" ? "none" : undefined;
    case "reasoningEffort": {
      if (s.toLowerCase() === "none") return [];
      const levels = s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== "");
      return levels.length > 0 && levels.every(isReasoningEffortLevel) ? levels : undefined;
    }
    case "protocol": {
      // ADR-0026 第 7 节：CLI 输入 chat / messages；- 在调用方处理
      const t = s.toLowerCase();
      if (t === "chat") return "openai-compatible";
      if (t === "messages") return "anthropic";
      return undefined;
    }
  }
}

/**
 * /provider model <服务商> <模型> 的行式问答（ADR-0024 第 4 节）：
 * 逐字段显示"当前值（来源）"，回车保留、`-` 清除用户编辑；只读字段
 * （来源为 config 或推理 none 锁定的档位）只显示不提问。收集完一次性
 * saveModelSettings——校验失败打印原因且不写文件。
 */
export async function runProviderModelWizard(
  io: WizardIo,
  config: RuntimeConfig,
  providerId: string,
  modelId: string,
  opts?: { workspaceRoot?: string | undefined },
): Promise<void> {
  const views = await config.listModelSettings(providerId, opts?.workspaceRoot);
  const view = views.find((v) => v.modelId === modelId);
  if (view === undefined) {
    io.print(`! 模型 "${modelId}" 不在服务商 "${providerId}" 的清单中`);
    return;
  }
  io.print(`编辑 ${providerId}/${modelId}（回车保留，- 清除用户编辑）`);
  if (view.readonly) {
    if (view.readonlyHint !== undefined) io.print(`! ${view.readonlyHint}`);
    for (const key of MODEL_FIELD_ORDER) {
      if (key === "reasoningEffort" && view.fields.reasoning.value === "none") continue;
      const f = view.fields[key];
      io.print(
        `  ${MODEL_FIELD_LABELS[key]}：${modelFieldText(key, f.value)}（${modelFieldSourceText(f.source, key)}）`,
      );
    }
    return;
  }
  const patch: ModelSettingsPatch = {};
  for (const key of MODEL_FIELD_ORDER) {
    const effectiveReasoning =
      patch.reasoning === null
        ? view.fields.reasoning.lowerValue
        : (patch.reasoning ?? view.fields.reasoning.value);
    if (key === "reasoningEffort" && effectiveReasoning === "none") continue;
    const f = view.fields[key];
    const shown = `${modelFieldText(key, f.userValue ?? f.value)}（${modelFieldSourceText(f.source, key)}）`;
    if (!f.editable) {
      io.print(`  ${MODEL_FIELD_LABELS[key]}：${shown}`);
      continue;
    }
    const answer = await io.ask(`  ${MODEL_FIELD_LABELS[key]} [${shown}]：`, {
      hint:
        key === "displayName"
          ? "留空 = 跟随下层值"
          : key === "imageInput"
            ? "y / n；- 清除用户编辑"
            : key === "reasoning"
              ? "y = 是 / n = 否；- 清除用户编辑"
              : key === "reasoningEffort"
                ? `逗号分隔（${REASONING_EFFORT_LEVELS.join(",")}）或 none = 不支持；- 清除用户编辑`
                : key === "protocol"
                  ? "chat / messages；- 清除用户编辑（跟随）"
                  : "正整数；- 清除用户编辑",
    });
    const t = answer.trim();
    if (t === "") continue;
    if (t === "-") {
      patch[key] = null;
      continue;
    }
    const parsed = parseModelField(key, t);
    if (parsed === undefined || parsed === "") {
      io.print(`! ${MODEL_FIELD_LABELS[key]} 的值 "${t}" 无效，未写入`);
      return;
    }
    (patch as Record<string, unknown>)[key] = parsed;
  }
  try {
    await config.saveModelSettings(providerId, modelId, patch, opts?.workspaceRoot);
  } catch (e) {
    io.print(`! 保存失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  io.print(`已保存 ${providerId}/${modelId}`);
}
