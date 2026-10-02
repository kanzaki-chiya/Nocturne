/**
 * nctrn setup 与 /provider add 的终端输入实现（provider-setup.md 第 1、6 节）。
 * 向导编排在 Core（runProviderSetupWizard/runProviderKeyWizard）；
 * 这里提供 TTY raw mode 的 WizardIo（密钥输入回显为 *）与 provider 层能力注入。
 * 密钥永远不出现在命令行参数里。
 */
import {
  fetchModels,
  listProviderPresets,
  runProviderKeyWizard as coreKeyWizard,
  runProviderModelWizard as coreModelWizard,
  runProviderSetupWizard as coreSetupWizard,
  type RuntimeConfig,
  type SetupWizardDeps,
  type WizardIo,
} from "@nocturne/core";

import { WizardAbort } from "@nocturne/core";
export type { WizardIo } from "@nocturne/core";
export { WizardAbort } from "@nocturne/core";

type Stdin = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

/** TTY raw mode 逐字符读一行；echo=false 时回显 * */
async function readLineRaw(
  stdin: Stdin,
  echo: boolean,
  stdout: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<string> {
  const inAny = stdin as NodeJS.ReadStream;
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004" || ch === "\u001a" || ch === "\u001b") {
          // Ctrl+C / Ctrl+D / Ctrl+Z
          cleanup();
          reject(new WizardAbort());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // 忽略其余控制字符
        buf += ch;
        stdout.write(echo ? ch : "*");
      }
    };
    const cleanup = (): void => {
      inAny.off("data", onData);
      inAny.pause();
      inAny.setRawMode(false);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new WizardAbort());
    };
    signal.addEventListener("abort", abort, { once: true });
    inAny.setRawMode(true);
    inAny.resume();
    inAny.on("data", onData);
  });
}

/** 非 TTY：按行读（readline 逐行；测试管道友好） */
async function readLineStream(stdin: Stdin, signal: AbortSignal): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: stdin, terminal: false, signal });
  try {
    for await (const line of rl) return line;
    return undefined;
  } finally {
    rl.close();
  }
}

/** nctrn setup / /provider add 的终端实现 */
export function createWizardIo(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
): WizardIo & { cancelPending(): void } {
  const tty = stdin.isTTY === true;
  let pending: AbortController | undefined;
  const read = (echo: boolean) => {
    pending = new AbortController();
    return tty
      ? readLineRaw(stdin, echo, stdout, pending.signal)
      : readLineStream(stdin, pending.signal);
  };
  const writeHint = (hint: string | undefined): void => {
    if (hint !== undefined && hint !== "") stdout.write(`  ${hint}\n`);
  };
  return {
    cancelPending: () => {
      pending?.abort();
      pending = undefined;
    },
    ask: async (prompt, opts) => {
      writeHint(opts?.hint);
      stdout.write(prompt);
      const line = await read(true);
      if (line === undefined) throw new WizardAbort();
      return line.trim();
    },
    askSecret: async (prompt, opts) => {
      writeHint(opts?.hint);
      stdout.write(prompt);
      const line = await read(false);
      if (line === undefined) throw new WizardAbort();
      return line.trim();
    },
    busy: (text) => {
      // 逐行终端没有可覆盖行：瞬时提示直接打印（下一行输出自然滚动）
      stdout.write(`${text}\n`);
    },
    step: (text) => {
      stdout.write(`${text}\n`);
    },
    chooseMulti: async (prompt, options, opts) => {
      writeHint(opts?.hint);
      // 逗号分隔编号（provider-setup.md 第 1 节，ADR-0018）；非法输入重问
      stdout.write(`${prompt}\n`);
      options.forEach((opt, i) => {
        stdout.write(`  ${i + 1}) ${opt}\n`);
      });
      for (;;) {
        stdout.write("编号（逗号分隔，如 2,3,4；空 = 不选）：");
        const line = await read(true);
        if (line === undefined) throw new WizardAbort();
        const trimmed = line.trim();
        if (trimmed === "") return [];
        const nums = trimmed.split(/[，,\s]+/).map((s) => Number.parseInt(s, 10));
        if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)) {
          return [...new Set(nums.map((n) => n - 1))].sort((a, b) => a - b);
        }
        stdout.write("! 无效输入：请输入 1-" + String(options.length) + " 之间的编号\n");
      }
    },
    print: (text) => {
      stdout.write(`${text}\n`);
    },
  };
}

/** CLI 侧的向导依赖注入：provider 层能力 + 进程环境变量 */
export function cliWizardDeps(
  env: (name: string) => string | undefined = (n) => process.env[n],
  config?: RuntimeConfig,
): SetupWizardDeps {
  return {
    presets: () => listProviderPresets(),
    fetchModels: (req, key) => fetchModels(req, key),
    env,
    ...(config
      ? {
          login: async (entry, io) => {
            const { runProviderLogin } = await import("@nocturne/tui/provider-login");
            await runProviderLogin(config, entry.id, io, { entry });
          },
        }
      : {}),
  };
}

/** nctrn setup / /provider add：注入 CLI 依赖后跑 Core 向导编排 */
export async function runProviderSetupWizard(
  io: WizardIo,
  config: RuntimeConfig,
  opts?: { presetId?: string | undefined },
) {
  return await coreSetupWizard(io, config, cliWizardDeps(undefined, config), opts);
}

/** /provider key <name> */
export async function runProviderKeyWizard(
  io: WizardIo,
  config: RuntimeConfig,
  providerId: string,
): Promise<void> {
  await coreKeyWizard(io, config, providerId);
}

/**
 * /provider add 的会话内流程（provider-setup.md 第 1 节）：向导 → 重载配置
 * → updateProviders → 提示用 /model 选择模型（v0.3 起向导不选模型，
 * 也不再询问"切换当前会话"）。
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
  await runProviderSetupWizard(io, ctx.config);
  ctx.updateProviders(await ctx.reloadConfig());
  io.print("服务商已就绪——用 /model 选择模型");
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
 * /provider model <服务商> <模型> 的会话内流程（ADR-0024 第 4 节）：
 * 行式问答 → saveModelSettings → 重载配置 → updateProviders。
 */
export async function runModelWizardInSession(
  io: WizardIo,
  ctx: {
    config: RuntimeConfig;
    providerId: string;
    modelId: string;
    workspaceRoot?: string | undefined;
    reloadConfig: () => Promise<RuntimeConfig>;
    updateProviders: (rc: RuntimeConfig) => void;
  },
): Promise<void> {
  await coreModelWizard(io, ctx.config, ctx.providerId, ctx.modelId, {
    workspaceRoot: ctx.workspaceRoot,
  });
  ctx.updateProviders(await ctx.reloadConfig());
}
