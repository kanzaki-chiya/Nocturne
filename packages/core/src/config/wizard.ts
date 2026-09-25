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
import type { ModelOverrideShape, RuntimeConfig, UpstreamModelEntry } from "./types.js";

/** 向导的输入输出抽象：nctrn setup 用真实 TTY；TUI 弹层与测试注入自己的实现 */
export interface WizardIo {
  /** 普通单行输入（回显） */
  ask(prompt: string): Promise<string>;
  /** 密钥输入：回显为 *（TTY raw mode / TUI 掩码框）；非 TTY 退化为普通读取 */
  askSecret(prompt: string): Promise<string>;
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
  /** 选中的模型（"provider/model" 全形） */
  model?: string | undefined;
  setDefault: boolean;
}

const yesDefault = (a: string): boolean => !/^n(o)?$/i.test(a.trim());

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
 * presetId 存在时跳过服务商选择（TUI 左栏 ○ 预设直达）；返回选中结果，
 * 是否 setModel 由调用方决定（nctrn setup 直接落默认模型字段；/provider add
 * 另问"切换当前会话"）。
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

  // 名称：预设建议名可直接回车；自定义预设必填
  const nameAnswer = await io.ask(
    `名称${preset.defaultName !== "" ? ` [${preset.defaultName}]` : ""}：`,
  );
  const providerId = nameAnswer !== "" ? nameAnswer : preset.defaultName;
  if (providerId === "") throw new WizardAbort();

  // 自定义预设问服务地址
  let baseURL = preset.baseURL;
  if (baseURL === undefined && preset.type === "openai-compatible") {
    baseURL = await io.ask("服务地址（如 https://api.example.com/v1）：");
    if (baseURL === "") throw new WizardAbort();
  } else if (baseURL === undefined) {
    baseURL = await io.ask("服务地址（留空用官方端点）：");
    if (baseURL === "") baseURL = undefined;
  }

  // 密钥：后端可用时经凭据存储；不可用时退回环境变量方式
  const backend = config.credentials.backend();
  let key: string | undefined;
  let apiKeyEnv: string | undefined;
  if (backend !== "none") {
    key = await io.askSecret("API Key（输入不回显；直接回车表示改用环境变量）：");
    if (key !== "") {
      io.print(`密钥已交给 ${backendLabel(backend)} 加密保存`);
    } else {
      key = undefined;
    }
  }
  if (key === undefined) {
    const defEnv = preset.defaultKeyEnv ?? "NOCTURNE_API_KEY";
    const envName = await io.ask(`凭据环境变量名 [${defEnv}]：`);
    apiKeyEnv = envName !== "" ? envName : defEnv;
    if (backend === "none") {
      io.print("系统凭据后端不可用，使用环境变量方式");
    }
  }

  // 凭据实际值：凭据存储路径用输入的 key；环境变量路径看变量当前是否已设置
  const effectiveKey = key ?? (apiKeyEnv !== undefined ? deps.env(apiKeyEnv) : undefined);

  // 模型列表：可自动获取时编号选择；失败/不支持退回手动输入
  const fetchReq = {
    type: preset.type,
    ...(baseURL !== undefined ? { baseURL } : {}),
  };
  let upstreamModels: UpstreamModelEntry[] = [];
  if (preset.fetchableModels) {
    io.print("正在获取模型列表…");
    try {
      upstreamModels = await deps.fetchModels(
        fetchReq,
        effectiveKey !== undefined && effectiveKey !== "" ? effectiveKey : undefined,
      );
    } catch (e) {
      const status = upstreamStatus(e);
      if (status === 401 || status === 403) {
        io.print(
          "! 密钥可能无效（获取模型列表被拒绝），改用手动输入；保存后可随时用 /provider key 更新密钥",
        );
      } else {
        io.print("! 模型列表获取失败，改用手动输入");
      }
    }
  }

  let modelId: string;
  if (upstreamModels.length > 0) {
    const lines = upstreamModels.map((m, i) => `  ${i + 1}) ${m.id}`);
    io.print(lines.join("\n"));
    const pick = await io.ask("选择模型，或直接输入模型 id：> ");
    const n = Number.parseInt(pick, 10);
    modelId = upstreamModels[n - 1]?.id ?? pick;
    if (modelId === "") throw new WizardAbort();
  } else {
    modelId = await io.ask("模型 id：");
    if (modelId === "") throw new WizardAbort();
  }

  const fullModel = `${providerId}/${modelId}`;
  const setDefault = yesDefault(await io.ask("设为默认模型？[Y/n] "));

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
  if (!(modelId in models)) {
    // 手动输入或上游没列出的模型也登记空条目
    models[modelId] = {};
  }

  await config.saveSetupProvider(
    {
      id: providerId,
      type: preset.type,
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
      models,
      ...(upstreamModels.length > 0
        ? { source: "upstream" as const, fetchedAt: new Date().toISOString() }
        : {}),
    },
    {
      ...(key !== undefined ? { key } : {}),
      ...(setDefault ? { defaultModel: fullModel } : {}),
    },
  );

  io.print(`已保存：服务商 ${providerId}、模型 ${fullModel}${setDefault ? "（默认）" : ""}`);
  return { providerId, model: fullModel, setDefault };
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
  const key = await io.askSecret(`新的 API Key（${providerId}，输入不回显）：`);
  if (key === "") {
    io.print("已取消（未输入密钥）");
    return;
  }
  await config.setCredential(providerId, key);
  io.print(`密钥已交给 ${backendLabel(backend)} 加密保存`);
}
