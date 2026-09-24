/**
 * nctrn setup 与 /provider add 共用的服务商配置向导（provider-setup.md 第 1、6 节）。
 * 交互外壳在 CLI：预设/模型列表/连接测试/文件写入全部走 Core 公开 API。
 * 密钥输入不回显（TTY 下 raw mode 逐字符读），也永远不出现在命令行参数里。
 */
import {
  fetchModels,
  listProviderPresets,
  testProviderConnection,
  type ModelOverrideShape,
  type ProviderPreset,
  type RuntimeConfig,
  type UpstreamModelInfo,
} from "@nocturne/core";

/** 向导的输入输出抽象：nctrn setup 用真实 TTY；测试与 TUI 弹层注入自己的实现 */
export interface WizardIo {
  /** 普通单行输入（回显） */
  ask(prompt: string): Promise<string>;
  /** 密钥输入：回显为 *（TTY raw mode）；非 TTY 退化为普通读取 */
  askSecret(prompt: string): Promise<string>;
  print(text: string): void;
}

/** 向导取消（Ctrl+C / Ctrl+D / 空输入在不允许空的步骤不会触发） */
export class WizardAbort extends Error {
  constructor() {
    super("已取消");
    this.name = "WizardAbort";
  }
}

// ── 终端输入实现 ──────────────────────────────────────────

type Stdin = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

/** TTY raw mode 逐字符读一行；echo=false 时回显 * */
async function readLineRaw(stdin: Stdin, echo: boolean): Promise<string> {
  const inAny = stdin as NodeJS.ReadStream;
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          cleanup();
          reject(new WizardAbort());
          return;
        }
        if (ch === "\u0004" || ch === "\u001a") {
          // Ctrl+D / Ctrl+Z
          cleanup();
          reject(new WizardAbort());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (echo) process.stdout.write("\b \b");
            else process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // 忽略其余控制字符
        buf += ch;
        if (echo) process.stdout.write(ch);
        else process.stdout.write("*");
      }
    };
    const cleanup = (): void => {
      inAny.off("data", onData);
      inAny.pause();
      inAny.setRawMode(false);
    };
    inAny.setRawMode(true);
    inAny.resume();
    inAny.on("data", onData);
  });
}

/** 非 TTY：按行读（readline 逐行；测试管道友好） */
async function readLineStream(stdin: Stdin): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    for await (const line of rl) return line;
    return undefined;
  } finally {
    rl.close();
  }
}

/** nctrn setup / /provider add 的终端实现 */
export function createWizardIo(stdin: Stdin, stdout: NodeJS.WritableStream): WizardIo {
  const tty = stdin.isTTY === true;
  return {
    ask: async (prompt) => {
      stdout.write(prompt);
      const line = tty ? await readLineRaw(stdin, true) : await readLineStream(stdin);
      if (line === undefined) throw new WizardAbort();
      return line.trim();
    },
    askSecret: async (prompt) => {
      stdout.write(prompt);
      const line = tty ? await readLineRaw(stdin, false) : await readLineStream(stdin);
      if (line === undefined) throw new WizardAbort();
      return line.trim();
    },
    print: (text) => {
      stdout.write(`${text}\n`);
    },
  };
}

// ── 向导流程 ─────────────────────────────────────────────

export interface WizardResult {
  providerId: string;
  /** 选中的模型（"provider/model" 全形）；向导可能只配置不选模型 */
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

function translateConnError(kind: string, message: string): string {
  switch (kind) {
    case "auth":
      return `密钥无效（${message}）`;
    case "network":
    case "timeout":
      return `地址不通（${message}）`;
    case "invalid_request":
      return `模型 id 或地址路径有误（${message}）`;
    default:
      return message;
  }
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
  opts?: { presetId?: string | undefined },
): Promise<WizardResult> {
  const presets = listProviderPresets();
  let preset: ProviderPreset;
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
  const effectiveKey = key ?? (apiKeyEnv !== undefined ? process.env[apiKeyEnv] : undefined);

  // 模型列表：可自动获取时编号选择；失败/不支持退回手动输入
  const fetchReq = {
    type: preset.type,
    ...(baseURL !== undefined ? { baseURL } : {}),
  };
  let upstreamModels: UpstreamModelInfo[] = [];
  if (preset.fetchableModels && effectiveKey !== undefined && effectiveKey !== "") {
    io.print("正在获取模型列表…");
    try {
      upstreamModels = await fetchModels(fetchReq, effectiveKey);
    } catch {
      io.print("! 模型列表获取失败，改用手动输入");
    }
  } else if (preset.fetchableModels) {
    io.print("正在获取模型列表…");
    try {
      upstreamModels = await fetchModels(fetchReq, undefined);
    } catch {
      io.print("! 模型列表获取失败，改用手动输入");
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

  // 连接测试：只在有实际凭据时进行；失败问"仍然保存？[y/N]"（默认不保存）
  if (effectiveKey !== undefined && effectiveKey !== "" && preset.fetchableModels) {
    io.print("正在测试连接…");
    const test = await testProviderConnection(fetchReq, effectiveKey);
    if (test.ok) {
      io.print(`成功（${test.latencyMs}ms，${test.modelCount} 个模型）`);
    } else {
      io.print(`! ${translateConnError(test.error.kind, test.error.message)}`);
      const keep = await io.ask("仍然保存？[y/N] ");
      if (!/^y(es)?$/i.test(keep.trim())) throw new WizardAbort();
    }
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
  if (upstreamModels.length === 0 || !(modelId in models)) {
    // 手动输入或上游没列出的模型也登记空条目
    models[modelId] = models[modelId] ?? {};
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
 * /provider add 的会话内流程（provider-setup.md 第 1 节）：向导 → 重载配置
 * → updateProviders → 询问"切换当前会话到该模型？[Y/n]"（默认切换）。
 */
export async function runAddWizardInSession(
  io: WizardIo,
  ctx: {
    config: RuntimeConfig;
    session: { setModel(input: string): Promise<void> };
    reloadConfig: () => Promise<RuntimeConfig>;
    updateProviders: (rc: RuntimeConfig) => void;
  },
): Promise<void> {
  const res = await runProviderSetupWizard(io, ctx.config);
  ctx.updateProviders(await ctx.reloadConfig());
  if (res.model !== undefined) {
    const sw = await io.ask(`切换当前会话到 ${res.model}？[Y/n] `);
    if (yesDefault(sw)) {
      await ctx.session.setModel(res.model);
      io.print(`已切换为 ${res.model}`);
    }
  }
}

/**
 * /provider key <name> 的会话内流程：密钥向导 → 重载配置 → updateProviders。
 */
export async function runKeyWizardInSession(
  io: WizardIo,
  ctx: {
    config: RuntimeConfig;
    providerId: string;
    reloadConfig: () => Promise<RuntimeConfig>;
    updateProviders: (rc: RuntimeConfig) => void;
  },
): Promise<void> {
  await runProviderKeyWizard(io, ctx.config, ctx.providerId);
  ctx.updateProviders(await ctx.reloadConfig());
}

/**
 * /provider key <name>：更新单个服务商的密钥（provider-setup.md 第 1 节）。
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

  // 重新测试连接（条目带 baseURL/类型才测）
  const entry = config.base.providers.find((p) => p.id === providerId);
  if (entry !== undefined) {
    io.print("正在测试连接…");
    const test = await testProviderConnection(
      {
        type: entry.type ?? "openai-compatible",
        ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
        ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      },
      key,
    );
    io.print(
      test.ok
        ? `成功（${test.latencyMs}ms）`
        : `! ${translateConnError(test.error.kind, test.error.message)}（密钥已保存）`,
    );
  }
}
