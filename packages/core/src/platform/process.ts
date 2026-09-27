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
  /**
   * 从继承的环境中剔除这些变量名（provider-setup.md 第 3、4 节）：
   * Windows 大小写不敏感匹配。用于 shell 工具剥离凭据变量、
   * 以及凭据后端子进程去掉 PSModulePath 等会污染后端的变量。
   */
  envStrip?: readonly string[] | undefined;
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
   * 子进程输出文本流。非 UTF-8 控制台逐行优先识别 UTF-8，失败后按
   * 控制台代码页解码；显式覆盖编码时完全遵循覆盖值（tools.md 第 6 节）。
   */
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  wait(): Promise<ProcessExit>;
  /** 终止进程树（Windows: taskkill /T；POSIX: 进程组信号） */
  kill(): Promise<void>;
  /**
   * 放弃继续读取输出：销毁底层 stdout/stderr，已捕获字节按原解码规则
   * 冲刷后两个 AsyncIterable 正常结束（不记为 error）。幂等。用于直接
   * 子进程已退出、但输出管道仍被其后代占用的场景（tools.md 第 6 节）。
   */
  detachOutput(): void;
}

export interface ProcessRunner {
  spawn(command: string, args: string[], options?: SpawnOptions): SpawnedProcess;
  /**
   * 经系统 shell 执行命令行（tools.md 第 6 节 shell 工具）：
   * Windows 用 %COMSPEC%（通常 cmd.exe）`/d /s /c`；POSIX 用 /bin/sh -c。
   * NOCTURNE_SHELL 仅替换可执行文件，参数形态按平台不变。
   * wait() 在 shell 本体 exit 时结算，不等 stdio 的 close——孙进程可能
   * 继承并继续占用输出管道；届时用 detachOutput() 结束读取。
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

/** 从继承环境基线中剔除 envStrip 变量名（Windows 大小写不敏感） */
function stripEnvVars(
  base: Record<string, string | undefined>,
  strip: readonly string[] | undefined,
): Record<string, string | undefined> {
  if (strip === undefined || strip.length === 0) return base;
  const win32 = process.platform === "win32";
  const deny = new Set(strip.map((n) => (win32 ? n.toUpperCase() : n)));
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (deny.has(win32 ? key.toUpperCase() : key)) continue;
    out[key] = value;
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

/** Shell 工具与环境提示共用参数形态，避免提示中的语法与实际执行漂移。 */
export function shellArguments(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "win32" ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];
}

export function shellCommandDescription(platform: NodeJS.Platform = process.platform): string {
  const executable = shellExecutable(platform);
  const args = shellArguments("<command>", platform);
  const name = executable.split(/[\\/]/).at(-1)?.toLowerCase();
  const syntax =
    name === "cmd" || name === "cmd.exe"
      ? ": use cmd syntax, not bash or PowerShell. `&` runs commands in sequence, not in the background; run long-running commands directly and raise timeoutMs when needed. findstr patterns use the console code page and cannot match non-ASCII text in UTF-8 output; use ASCII patterns only"
      : name === "sh"
        ? ": use POSIX sh syntax"
        : "";
  const invocation = platform === "win32" ? args.join(" ") : `${args[0]} "${args[1]}"`;
  return `Commands run with ${executable} ${invocation}${syntax}`;
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
interface OutputEncoding {
  label: string;
  forced: boolean;
}

async function detectConsoleEncoding(): Promise<OutputEncoding> {
  const override = process.env.NOCTURNE_CONSOLE_ENCODING;
  if (override !== undefined && override.length > 0) {
    try {
      new TextDecoder(override);
      return { label: override, forced: true };
    } catch {
      return { label: "utf-8", forced: true };
    }
  }
  const cp = await readConsoleCodepage();
  return { label: cp === undefined ? "utf-8" : codepageToEncodingLabel(cp), forced: false };
}

/**
 * 仅保留被截断的 UTF-8 末尾，最长 3 字节；长行冲刷时避免拆坏多字节字符。
 */
function incompleteUtf8Tail(bytes: Buffer): number {
  for (let start = Math.max(0, bytes.length - 3); start < bytes.length; start++) {
    const lead = bytes[start];
    if (lead === undefined) continue;
    const size =
      lead >= 0xc2 && lead <= 0xdf
        ? 2
        : lead >= 0xe0 && lead <= 0xef
          ? 3
          : lead >= 0xf0 && lead <= 0xf4
            ? 4
            : 0;
    if (size === 0 || bytes.length - start >= size) continue;
    if (bytes.subarray(start + 1).every((byte) => (byte & 0xc0) === 0x80))
      return bytes.length - start;
  }
  return 0;
}

/**
 * 创建时立即以 flowing 模式捕获原始字节，避免异步 chcp 探测期间短命进程丢数据。
 * stdout/stderr 各有独立队列和解码状态；MCP stdout 另走 rawOutput。
 * 完整行用 fatal UTF-8 探测；无换行尾巴 50ms 空闲或超过 8KB 时冲刷，
 * 保留至多 3 字节的 UTF-8 截断后缀，继续逐块上报 tool.progress。
 */
export function decodeOutput(
  stream: Readable,
  encoding: Promise<OutputEncoding>,
): AsyncIterable<string> {
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
  // destroy()（detachOutput）只发 close 不发 end：按正常结束冲刷 pending
  stream.once("close", () => {
    state.ended = true;
    notify();
  });
  return (async function* (): AsyncGenerator<string> {
    const { label, forced } = await encoding;
    if (!forced && new TextDecoder(label).encoding !== "utf-8") {
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      const fallback = new TextDecoder(label);
      const decode = (bytes: Buffer): string => {
        try {
          return utf8.decode(bytes);
        } catch {
          return fallback.decode(bytes);
        }
      };
      let tail: Buffer = Buffer.alloc(0);
      for (;;) {
        let chunk: Buffer | undefined;
        while ((chunk = pending.shift()) !== undefined) {
          tail = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
          let end: number;
          while ((end = tail.indexOf(0x0a)) !== -1) {
            const text = decode(tail.subarray(0, end + 1));
            tail = tail.subarray(end + 1);
            if (text !== "") yield text;
          }
          if (tail.length > 8192) {
            const keep = incompleteUtf8Tail(tail);
            const text = decode(tail.subarray(0, tail.length - keep));
            tail = tail.subarray(tail.length - keep);
            if (text !== "") yield text;
          }
        }
        if (state.failure !== undefined) throw state.failure;
        if (state.ended) break;
        let timer: NodeJS.Timeout | undefined;
        const idle = await new Promise<boolean>((resolve) => {
          wake = () => {
            resolve(false);
          };
          if (tail.length > incompleteUtf8Tail(tail)) {
            timer = setTimeout(() => {
              wake = undefined;
              resolve(true);
            }, 50);
          }
        });
        if (timer !== undefined) clearTimeout(timer);
        if (idle && pending.length === 0) {
          const keep = incompleteUtf8Tail(tail);
          const text = decode(tail.subarray(0, tail.length - keep));
          tail = tail.subarray(tail.length - keep);
          if (text !== "") yield text;
        }
      }
      if (tail.length > 0) yield decode(tail);
      return;
    }
    const decoder = new TextDecoder(label);
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

/**
 * spawn / spawnPipe 共用的生命周期：signal 中止、超时、wait()、进程树 kill。
 * waitEvent 默认 "close"（stdio 全部关闭才结算）；spawnShell 传 "exit"——
 * close 会被继承了输出管道的后台孙进程无限期拖住（tools.md 第 6 节）。
 */
function attachLifecycle(
  child: ChildProcess,
  options: SpawnOptions,
  waitEvent: "exit" | "close" = "close",
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
    child.once(waitEvent, (code: number | null, signal: NodeJS.Signals | null) => {
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
  let encodingPromise: Promise<OutputEncoding> | undefined;
  const consoleEncoding = (): Promise<OutputEncoding> =>
    (encodingPromise ??= detectConsoleEncoding());

  const spawnImpl = (
    command: string,
    args: string[],
    options: SpawnOptions,
    verbatimArgs: boolean,
    waitEvent: "exit" | "close",
  ): SpawnedProcess => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...stripEnvVars(process.env, options.envStrip), ...options.env },
      windowsHide: true,
      windowsVerbatimArguments: verbatimArgs,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 不设 setEncoding：保留原始字节供逐行 UTF-8/控制台编码判定。
    const encoding = consoleEncoding();
    const stdout = decodeOutput(child.stdout, encoding);
    const stderr = decodeOutput(child.stderr, encoding);
    const { wait, kill } = attachLifecycle(child, options, waitEvent);
    let detached = false;

    return {
      pid: child.pid ?? -1,
      stdout,
      stderr,
      wait,
      kill,
      detachOutput() {
        if (detached) return;
        detached = true;
        child.stdout.destroy();
        child.stderr.destroy();
      },
    };
  };

  return {
    spawn: (command, args, options = {}) => spawnImpl(command, args, options, false, "close"),
    spawnShell(command, options = {}) {
      if (process.platform === "win32") {
        // cmd /d /s /c "<命令>"：verbatim 传参 + /s 剥掉外层引号，命令原文含引号不受影响
        return spawnImpl(
          shellExecutable("win32"),
          shellArguments(command, "win32"),
          options,
          true,
          "exit",
        );
      }
      return spawnImpl(shellExecutable(), shellArguments(command), options, false, "exit");
    },
    spawnPipe(command, args, options = {}) {
      const base =
        options.envMode === "minimal"
          ? minimalEnvironment()
          : stripEnvVars(process.env, options.envStrip);
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
