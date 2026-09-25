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
import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from "../protocol/index.js";
import type {
  ModelOverrideShape,
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

  // 思考档位（ADR-0019 第 2 条，交互形式调整；ADR-0018 规则不变）：
  // 上游 /models 未声明思考能力时，单步多选勾选档位——首项"不支持
  // 思考强度"与其余档位互斥，什么都不勾同样等于不支持。勾选结果写
  // 在服务商条目 thinking.levels（source:"user"），作为该服务商所有
  // 模型的默认档位——逐模型声明仍可覆盖（providers.md 第 3 节）
  const upstreamDeclaresThinking = upstreamModels.some(
    (m) => m.capabilities?.reasoning !== undefined && m.capabilities.reasoning !== "none",
  );
  let thinkingLevels: ReasoningEffortLevel[] | undefined;
  if (!upstreamDeclaresThinking) {
    const picked = await io.chooseMulti(
      "思考强度档位：",
      ["不支持思考强度", ...REASONING_EFFORT_LEVELS],
      {
        hint: "上游未声明思考能力；空格勾选，Enter 确认（不勾或勾第一项 = 不支持）",
        exclusiveIndex: 0,
      },
    );
    const levels = picked.includes(0)
      ? []
      : picked
          .map((i) => REASONING_EFFORT_LEVELS[i - 1])
          .filter((l): l is ReasoningEffortLevel => l !== undefined);
    if (levels.length > 0) thinkingLevels = levels;
    io.step(levels.length > 0 ? `思考档位 ${levels.join(" / ")}` : "不支持思考强度");
  }

  // models 字段写入上游声明的能力/价格/限额（provider-setup.md 第 7 节）
  const models: Record<string, ModelOverrideShape> = {};
  for (const m of upstreamModels) {
    models[m.id] = {
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
      ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
    };
  }

  // thinking 兼容开关：format 由预设自动填写（用户不需要选）；
  // levels 只在用户勾选时写入并标 source:"user"
  const thinking: ProviderEntryConfig["thinking"] = {
    ...(preset.thinkingFormat !== undefined ? { format: preset.thinkingFormat } : {}),
    ...(thinkingLevels !== undefined ? { levels: thinkingLevels, source: "user" as const } : {}),
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

/**
 * /provider thinking <name>（provider-setup.md 第 1 节；ADR-0019 第 2 条）：
 * 对已配置的服务商重走"思考档位"步骤——单步多选，首项"不支持思考强度"
 * 互斥；空勾选或勾第一项 → 清除用户声明（模型级声明与能力标记推导不受影响）。
 */
export async function runProviderThinkingWizard(
  io: WizardIo,
  config: RuntimeConfig,
  providerId: string,
): Promise<void> {
  const picked = await io.chooseMulti(
    `服务商 ${providerId} 的思考档位：`,
    ["不支持思考强度", ...REASONING_EFFORT_LEVELS],
    {
      hint: "空格勾选，Enter 确认；不勾或勾第一项 = 清除声明",
      exclusiveIndex: 0,
    },
  );
  const levels = picked.includes(0)
    ? []
    : picked
        .map((i) => REASONING_EFFORT_LEVELS[i - 1])
        .filter((l): l is ReasoningEffortLevel => l !== undefined);
  await config.saveSetupThinking(providerId, levels.length > 0 ? levels : undefined);
  io.print(
    levels.length > 0
      ? `已保存 ${providerId} 的思考档位：${levels.join(" / ")}（该服务商所有模型的默认档位）`
      : `已清除 ${providerId} 的思考档位声明`,
  );
}
