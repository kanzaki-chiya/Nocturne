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
  runProviderSetupWizard as coreSetupWizard,
  testProviderConnection,
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
        if (ch === "\u0003" || ch === "\u0004" || ch === "\u001a") {
          // Ctrl+C / Ctrl+D / Ctrl+Z
          cleanup();
          reject(new WizardAbort());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // 忽略其余控制字符
        buf += ch;
        process.stdout.write(echo ? ch : "*");
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

/** CLI 侧的向导依赖注入：provider 层能力 + 进程环境变量 */
export function cliWizardDeps(
  env: (name: string) => string | undefined = (n) => process.env[n],
): SetupWizardDeps {
  return {
    presets: () => listProviderPresets(),
    fetchModels: (req, key) => fetchModels(req, key),
    testConnection: (req, key) => testProviderConnection(req, key),
    env,
  };
}

/** nctrn setup / /provider add：注入 CLI 依赖后跑 Core 向导编排 */
export async function runProviderSetupWizard(
  io: WizardIo,
  config: RuntimeConfig,
  opts?: { presetId?: string | undefined },
) {
  return await coreSetupWizard(io, config, cliWizardDeps(), opts);
}

/** /provider key <name> */
export async function runProviderKeyWizard(
  io: WizardIo,
  config: RuntimeConfig,
  providerId: string,
): Promise<void> {
  await coreKeyWizard(io, config, cliWizardDeps(), providerId);
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
    if (!/^n(o)?$/i.test(sw.trim())) {
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
