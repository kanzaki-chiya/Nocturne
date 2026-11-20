/**
 * 主进程被强杀后的子进程清理看门狗（ADR-0102）。
 *
 * 按需启动：本进程第一次登记子进程时才拉起一个 detached 看门狗进程；
 * 一个 Nocturne 进程最多同时运行一个看门狗。父进程通过 stdin 管道按行发送
 * `+<pid>` 登记、`-<pid>` 注销。父进程无论正常退出还是被强杀，OS 都会关闭
 * 管道写端，看门狗读到 EOF 后对仍登记的每个 PID 结束整棵进程树并退出。
 */
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import process from "node:process";

/** 看门狗内联脚本（CommonJS）：随 Core 代码一同打包，无需外部文件路径解析。 */
export const WATCHDOG_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const pidFile = process.env.NOCTURNE_WATCHDOG_PID_FILE;
if (pidFile) {
  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {}
}

const pids = new Set();
let buf = "";
let cleaning = false;
const KILL_TREE_TIMEOUT_MS = 15000;
const POSIX_GRACE_MS = 2000;
const POSIX_POLL_MS = 50;

function parseLine(raw) {
  const line = raw.trim();
  if (line.length < 2) return;
  const op = line[0];
  if (op !== "+" && op !== "-") return;
  const rest = line.slice(1);
  if (!/^\\d+$/.test(rest)) return;
  const pid = Number(rest);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (op === "+") pids.add(pid);
  else pids.delete(pid);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

function groupAlive(pid) {
  return processAlive(-pid) || processAlive(pid);
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return;
  } catch {}
  try {
    process.kill(pid, signal);
  } catch {}
}

function killWin32Tree(pid) {
  if (!processAlive(pid)) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (processAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {}
      finish();
    }, KILL_TREE_TIMEOUT_MS);
    killer.once("exit", finish);
    killer.once("error", finish);
  });
}

function killPosixTree(pid) {
  if (!groupAlive(pid)) return Promise.resolve();
  signalGroup(pid, "SIGTERM");
  if (!groupAlive(pid)) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = Date.now() + POSIX_GRACE_MS;
    const check = () => {
      if (!groupAlive(pid)) {
        resolve();
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        signalGroup(pid, "SIGKILL");
        resolve();
        return;
      }
      setTimeout(check, Math.min(POSIX_POLL_MS, left));
    };
    setTimeout(check, POSIX_POLL_MS);
  });
}

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (buf.length > 0) {
    parseLine(buf);
    buf = "";
  }
  const targets = Array.from(pids);
  if (targets.length === 0) {
    process.exit(0);
    return;
  }
  const killOne = process.platform === "win32" ? killWin32Tree : killPosixTree;
  Promise.all(targets.map(killOne)).finally(() => {
    process.exit(0);
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (cleaning) return;
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx >= 0) {
    parseLine(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    idx = buf.indexOf("\\n");
  }
});
process.stdin.once("end", cleanup);
process.stdin.once("close", cleanup);
process.stdin.once("error", cleanup);
process.stdin.resume();
`.trim();

/** 剥离可能干扰 `node -e` 看门狗启动与退出的宿主调试/覆盖率环境变量。 */
const STRIPPED_WATCHDOG_ENV = new Set([
  "NODE_OPTIONS",
  "NODE_DEBUG",
  "V8_COVERAGE",
  "NODE_V8_COVERAGE",
]);

function buildWatchdogEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const win32 = process.platform === "win32";
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const probe = win32 ? key.toUpperCase() : key;
    if (STRIPPED_WATCHDOG_ENV.has(probe)) continue;
    out[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      out[key] = value;
    }
  }
  return out;
}

export interface ProcessWatchdog {
  /** 登记一个受保护的子进程 PID（首次登记时按需启动看门狗；重复登记幂等） */
  register(pid: number): void;
  /** 注销一个已退出或已主动结束的子进程 PID（未登记时忽略，不启动看门狗） */
  unregister(pid: number): void;
}

export interface ProcessWatchdogController extends ProcessWatchdog {
  /** 当前运行中的看门狗 PID；未启动或已退出时为 undefined */
  pid(): number | undefined;
  /** 本地登记表中的活跃 PID 数量 */
  registeredCount(): number;
  /** 关闭管道写端并等待看门狗退出（测试用） */
  close(): Promise<void>;
}

export interface ProcessWatchdogOptions {
  /** 覆盖 Node 可执行路径（默认 process.execPath） */
  execPath?: string | undefined;
  /** 追加给看门狗进程的环境变量（测试用，如 NOCTURNE_WATCHDOG_PID_FILE） */
  env?: Record<string, string> | undefined;
  /** 每次拉起看门狗进程后的回调（测试用） */
  onSpawn?: ((pid: number | undefined) => void) | undefined;
}

interface ActiveWatchdog {
  child: ChildProcess;
  exited: Promise<void>;
}

export function createProcessWatchdog(
  options: ProcessWatchdogOptions = {},
): ProcessWatchdogController {
  const registered = new Set<number>();
  let active: ActiveWatchdog | undefined;

  const writeLine = (child: ChildProcess, line: string): void => {
    const stdin = child.stdin;
    if (stdin === null || stdin.destroyed || stdin.writableEnded) return;
    try {
      stdin.write(line, "utf8");
    } catch {
      // 管道已关闭时静默忽略
    }
  };

  const ensureStarted = (): ActiveWatchdog | undefined => {
    if (active !== undefined) return active;
    let child: ChildProcess;
    try {
      child = spawn(
        options.execPath ?? process.execPath,
        ["--input-type=commonjs", "-e", WATCHDOG_SCRIPT],
        {
          cwd: os.tmpdir(),
          env: buildWatchdogEnv(options.env),
          detached: true,
          windowsHide: true,
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
    } catch {
      return undefined;
    }

    child.stdin?.on("error", () => undefined);
    // 看门狗不能拖住父进程退出
    child.unref();
    const unrefableStdin = child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null;
    unrefableStdin?.unref?.();

    const exited = new Promise<void>((resolve) => {
      const clear = () => {
        if (active?.child === child) active = undefined;
        resolve();
      };
      child.once("exit", clear);
      child.once("error", clear);
    });

    active = { child, exited };
    options.onSpawn?.(child.pid);
    return active;
  };

  return {
    register(pid: number): void {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
      if (registered.has(pid)) return;
      registered.add(pid);
      const existed = active !== undefined;
      const current = ensureStarted();
      if (current === undefined) return;
      if (!existed) {
        // 首次启动或前一个看门狗意外退出后重建：同步全部活跃 PID
        for (const id of registered) {
          writeLine(current.child, `+${id}\n`);
        }
      } else {
        writeLine(current.child, `+${pid}\n`);
      }
    },

    unregister(pid: number): void {
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      if (!registered.delete(pid)) return;
      if (active === undefined) return;
      writeLine(active.child, `-${pid}\n`);
    },

    pid(): number | undefined {
      return active?.child.pid;
    },

    registeredCount(): number {
      return registered.size;
    },

    async close(): Promise<void> {
      const current = active;
      if (current === undefined) return;
      const stdin = current.child.stdin;
      if (stdin !== null && !stdin.destroyed) {
        try {
          stdin.end();
        } catch {
          // 已关闭
        }
      }
      await current.exited;
    },
  };
}

let sharedWatchdog: ProcessWatchdogController | undefined;

/** 进程级共享看门狗：同一 Nocturne 进程最多启动一个看门狗。 */
export function getSharedProcessWatchdog(): ProcessWatchdog {
  return (sharedWatchdog ??= createProcessWatchdog());
}
