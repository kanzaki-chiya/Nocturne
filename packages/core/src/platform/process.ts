/**
 * 子进程能力（tool-api.md：ToolContext.process）。
 * Phase 1 没有内置 shell 工具，但接口必须就位：启动、流式输出、
 * AbortSignal 传播、进程树终止、超时。
 */
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

export interface SpawnOptions {
  cwd?: string | undefined;
  /** 叠加在进程环境之上的变量 */
  env?: Record<string, string> | undefined;
  /** 中止时终止整个进程树 */
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
}

export interface SpawnedProcess {
  readonly pid: number;
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
}

/** Windows 下取 shell 可执行文件：NOCTURNE_SHELL > %COMSPEC% > cmd.exe */
export function shellExecutable(platform: NodeJS.Platform = process.platform): string {
  const override = process.env.NOCTURNE_SHELL;
  if (override !== undefined && override.length > 0) return override;
  if (platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return "/bin/sh";
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

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
        resolve({ code: null, signal: null, timedOut, killed });
      });
      child.once("close", (code, signal) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve({ code, signal, timedOut, killed });
      });
    });

    return {
      pid: child.pid ?? -1,
      stdout: child.stdout as AsyncIterable<string>,
      stderr: child.stderr as AsyncIterable<string>,
      wait: () => waitPromise,
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
  };
}
