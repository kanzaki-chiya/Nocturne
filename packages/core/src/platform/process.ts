/**
 * 子进程能力（tool-api.md：ToolContext.process）。
 * Phase 1 没有内置 shell 工具，但接口必须就位：启动、流式输出、
 * AbortSignal 传播、进程树终止、超时。
 */
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import type { Readable } from "node:stream";

export interface SpawnOptions {
  cwd?: string | undefined;
  /** 叠加在进程环境之上的变量 */
  env?: Record<string, string> | undefined;
  /** 中止时终止整个进程树 */
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface PipeSpawnOptions extends SpawnOptions {
  /**
   * 子进程环境基线（mcp.md 第 2 节）：
   * - "inherit"（默认）：process.env 之上叠加 env——Hook 是用户自己的脚本，继承完整环境；
   * - "minimal"：只给平台白名单基线（PATH、HOME/USERPROFILE、SystemRoot、TEMP 等），
   *   env 在白名单之上叠加——第三方 MCP 服务器拿不到 Provider API Key 等敏感变量。
   */
  envMode?: "inherit" | "minimal" | undefined;
}

/**
 * 双向管道子进程：stdin 可写、stdout 为原始字节流（结构化协议自行解码）、
 * stderr 为解码文本（进诊断）。MCP stdio 传输与 Hook 命令共用。
 */
export interface PipeProcess {
  readonly pid: number;
  readonly stdin: { write(chunk: string): void; end(): void };
  /** 原始字节流（不做控制台代码页解码） */
  readonly stdoutRaw: AsyncIterable<Buffer>;
  readonly stderr: AsyncIterable<string>;
  wait(): Promise<ProcessExit>;
  kill(): Promise<void>;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
}

export interface SpawnedProcess {
  readonly pid: number;
  /**
   * 子进程输出文本流。Windows 控制台程序按 OEM 代码页输出（如 zh-CN 的
   * GBK），POSIX 按 UTF-8：统一按"控制台代码页 → WHATWG 编码"流式解码，
   * 保证终端显示与模型读到的内容都不乱码（tools.md 第 6 节 shell）。
   */
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  wait(): Promise<ProcessExit>;
  /** 终止进程树（Windows: taskkill /T；POSIX: 进程组信号） */
  kill(): Promise<void>;
}

export interface ProcessRunner {
  spawn(command: string, args: string[], options?: SpawnOptions): SpawnedProcess;
  /**
   * 经系统 shell 执行命令行（tools.md 第 6 节 shell 工具）：
   * Windows 用 %COMSPEC%（通常 cmd.exe）`/d /s /c`；POSIX 用 /bin/sh -c。
   * NOCTURNE_SHELL 仅替换可执行文件，参数形态按平台不变。
   */
  spawnShell(command: string, options?: SpawnOptions): SpawnedProcess;
  /**
   * 双向管道子进程（hooks.md / mcp.md）：stdin 可写、stdout 为原始字节、
   * stderr 为解码文本。envMode:"minimal" 用于第三方 MCP 服务器的环境隔离。
   */
  spawnPipe(command: string, args: string[], options?: PipeSpawnOptions): PipeProcess;
}

/**
 * "minimal" 模式的子进程环境白名单（mcp.md 第 2 节，参照 MCP SDK 的
 * getDefaultEnvironment()）：只含运行进程所必需的定位/临时/语言变量，
 * 不含任何凭据形变量。POSIX 追加 LC_* / XDG_* 前缀。
 */
const MINIMAL_ENV_POSIX = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
]);

const MINIMAL_ENV_WIN32 = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "LOGONSERVER",
  "PUBLIC",
  "DRIVERDATA",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PSMODULEPATH",
  "SESSIONNAME",
]);

function minimalEnvironment(): Record<string, string> {
  const win32 = process.platform === "win32";
  const allow = win32 ? MINIMAL_ENV_WIN32 : MINIMAL_ENV_POSIX;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const probe = win32 ? key.toUpperCase() : key;
    if (allow.has(probe) || (!win32 && (probe.startsWith("LC_") || probe.startsWith("XDG_")))) {
      out[key] = value;
    }
  }
  return out;
}

/** Windows 下取 shell 可执行文件：NOCTURNE_SHELL > %COMSPEC% > cmd.exe */
export function shellExecutable(platform: NodeJS.Platform = process.platform): string {
  const override = process.env.NOCTURNE_SHELL;
  if (override !== undefined && override.length > 0) return override;
  if (platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return "/bin/sh";
}

/** Windows 控制台代码页 → WHATWG 编码 label；未映射的代码页回退 UTF-8 */
const CONSOLE_CODEPAGE_LABELS: Record<number, string> = {
  65001: "utf-8",
  936: "gbk",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  874: "windows-874",
  866: "ibm866",
  20866: "koi8-r",
  21866: "koi8-u",
  10000: "macintosh",
  // WHATWG 中 us-ascii 与 iso-8859-1 的解码实现即 windows-1252
  20127: "windows-1252",
  28591: "windows-1252",
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28603: "iso-8859-13",
  28605: "iso-8859-15",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
};

export function codepageToEncodingLabel(codepage: number): string {
  return CONSOLE_CODEPAGE_LABELS[codepage] ?? "utf-8";
}

const CHCP_TIMEOUT_MS = 3_000;

/**
 * 读取 Windows 控制台输出代码页（chcp.com，输出形如 "Active code page: 936"，
 * 本地化文本中数字仍是 ASCII）。无法探测时返回 undefined。
 */
function readConsoleCodepage(): Promise<number | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("chcp.com", [], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      resolve(undefined);
    }, CHCP_TIMEOUT_MS);
    timer.unref();
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once("close", () => {
      clearTimeout(timer);
      const m = /(\d+)/.exec(Buffer.concat(chunks).toString("latin1"));
      resolve(m === null ? undefined : Number(m[1]));
    });
  });
}

/**
 * 决定子进程输出的解码方式：
 * NOCTURNE_CONSOLE_ENCODING（任意 WHATWG label）> Windows chcp 代码页 > UTF-8。
 */
async function detectConsoleEncoding(): Promise<string> {
  const override = process.env.NOCTURNE_CONSOLE_ENCODING;
  if (override !== undefined && override.length > 0) {
    try {
      new TextDecoder(override);
      return override;
    } catch {
      return "utf-8";
    }
  }
  const cp = await readConsoleCodepage();
  return cp === undefined ? "utf-8" : codepageToEncodingLabel(cp);
}

/**
 * 每条流独立的 TextDecoder：流式解码会在解码器内缓存跨界字符，两条流不能共享实例。
 * 注意：编码探测（chcp.com）是异步的，若在迭代开始前才挂载 stdout 监听，
 * 短命的子进程可能在解码器就绪前退出并丢数据——因此创建时立即以 flowing
 * 模式捕获原始字节，消费侧再逐块解码（保留流式 progress 语义）。
 */
function decodeOutput(stream: Readable, encoding: Promise<string>): AsyncIterable<string> {
  const pending: Buffer[] = [];
  const state: { ended: boolean; failure: Error | undefined } = {
    ended: false,
    failure: undefined,
  };
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  stream.on("data", (chunk: Buffer) => {
    pending.push(chunk);
    notify();
  });
  stream.once("end", () => {
    state.ended = true;
    notify();
  });
  stream.once("error", (error: Error) => {
    state.failure = error;
    state.ended = true;
    notify();
  });
  return (async function* (): AsyncGenerator<string> {
    const decoder = new TextDecoder(await encoding);
    for (;;) {
      let chunk: Buffer | undefined;
      while ((chunk = pending.shift()) !== undefined) {
        const text = decoder.decode(chunk, { stream: true });
        if (text !== "") yield text;
      }
      if (state.failure !== undefined) throw state.failure;
      if (state.ended) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  })();
}

/**
 * 原始字节捕获（spawnPipe 的 stdout）：与 decodeOutput 同一套
 * 立即捕获 + 唤醒模式，避免短命子进程在消费前丢数据。
 */
function rawOutput(stream: Readable): AsyncIterable<Buffer> {
  const pending: Buffer[] = [];
  const state: { ended: boolean; failure: Error | undefined } = {
    ended: false,
    failure: undefined,
  };
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  stream.on("data", (chunk: Buffer) => {
    pending.push(chunk);
    notify();
  });
  stream.once("end", () => {
    state.ended = true;
    notify();
  });
  stream.once("error", (error: Error) => {
    state.failure = error;
    state.ended = true;
    notify();
  });
  return (async function* (): AsyncGenerator<Buffer> {
    for (;;) {
      let chunk: Buffer | undefined;
      while ((chunk = pending.shift()) !== undefined) {
        yield chunk;
      }
      if (state.failure !== undefined) throw state.failure;
      if (state.ended) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
}

/** spawn / spawnPipe 共用的生命周期：signal 中止、超时、wait()、进程树 kill */
function attachLifecycle(
  child: ChildProcess,
  options: SpawnOptions,
): { wait: () => Promise<ProcessExit>; kill: () => Promise<void> } {
  let timedOut = false;
  let killed = false;
  const kill = () => {
    killed = true;
    return killTree(child);
  };

  if (options.signal !== undefined) {
    const onAbort = () => {
      void kill();
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      void kill();
    }, options.timeoutMs);
    timer.unref();
  }

  const waitPromise = new Promise<ProcessExit>((resolve) => {
    child.once("error", () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, killed });
    });
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, signal, timedOut, killed });
    });
  });
  return { wait: () => waitPromise, kill };
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("exit", () => {
        resolve();
      });
      killer.once("error", () => {
        resolve();
      });
    });
  } else {
    try {
      // spawn(detached: true) 使子进程成为进程组组长，可整组终止
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  }
}

export function createProcessRunner(): ProcessRunner {
  // 控制台代码页探测只做一次，全部子进程共享同一个编码结论
  let encodingPromise: Promise<string> | undefined;
  const consoleEncoding = (): Promise<string> => (encodingPromise ??= detectConsoleEncoding());

  const spawnImpl = (
    command: string,
    args: string[],
    options: SpawnOptions,
    verbatimArgs: boolean,
  ): SpawnedProcess => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      windowsVerbatimArguments: verbatimArgs,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 不设 setEncoding：原始字节流经控制台代码页对应的 TextDecoder 流式解码，
    // 避免 GBK 等本地编码被按 UTF-8 解成乱码
    const encoding = consoleEncoding();
    const stdout = decodeOutput(child.stdout, encoding);
    const stderr = decodeOutput(child.stderr, encoding);
    const { wait, kill } = attachLifecycle(child, options);

    return {
      pid: child.pid ?? -1,
      stdout,
      stderr,
      wait,
      kill,
    };
  };

  return {
    spawn: (command, args, options = {}) => spawnImpl(command, args, options, false),
    spawnShell(command, options = {}) {
      if (process.platform === "win32") {
        // cmd /d /s /c "<命令>"：verbatim 传参 + /s 剥掉外层引号，命令原文含引号不受影响
        return spawnImpl(
          shellExecutable("win32"),
          ["/d", "/s", "/c", `"${command}"`],
          options,
          true,
        );
      }
      return spawnImpl(shellExecutable(), ["-c", command], options, false);
    },
    spawnPipe(command, args, options = {}) {
      const base = options.envMode === "minimal" ? minimalEnvironment() : process.env;
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...base, ...options.env },
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const encoding = consoleEncoding();
      const { wait, kill } = attachLifecycle(child, options);
      const stdin = child.stdin;
      return {
        pid: child.pid ?? -1,
        stdin: {
          write(chunk: string) {
            if (!stdin.destroyed) stdin.write(chunk, "utf8");
          },
          end() {
            if (!stdin.destroyed) stdin.end();
          },
        },
        stdoutRaw: rawOutput(child.stdout),
        stderr: decodeOutput(child.stderr, encoding),
        wait,
        kill,
      };
    },
  };
}
