import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createProcessRunner } from "./process.js";
import { createProcessWatchdog, WATCHDOG_SCRIPT } from "./watchdog.js";
import {
  createProcessCleanup,
  killPidTree,
  removeTempDirs,
} from "../../../../scripts/test/process-cleanup.mjs";

const cleanup = createProcessCleanup();
let root: string;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM"
    );
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

function spawnTracked(
  args: string[],
  options: { cwd?: string; detached?: boolean; stdio?: "ignore" | ["pipe", "pipe", "pipe"] } = {},
): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? root,
    detached: options.detached ?? process.platform !== "win32",
    windowsHide: true,
    stdio: options.stdio ?? "ignore",
  });
  cleanup.trackChild(child);
  return child;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-watchdog-"));
});

afterEach(async () => {
  await cleanup.cleanup();
  await removeTempDirs([root]);
});

describe("ProcessWatchdog", () => {
  it("没有任何登记时不启动看门狗；注销不存在或非法 PID 也不启动", async () => {
    const spawns: (number | undefined)[] = [];
    const wd = createProcessWatchdog({
      onSpawn: (pid) => spawns.push(pid),
    });
    expect(wd.pid()).toBeUndefined();
    expect(wd.registeredCount()).toBe(0);

    wd.unregister(999_999);
    wd.unregister(0);
    wd.unregister(-1);
    wd.register(0);
    wd.register(-5);
    wd.register(Number.NaN);
    wd.register(process.pid);

    expect(spawns).toEqual([]);
    expect(wd.pid()).toBeUndefined();
    expect(wd.registeredCount()).toBe(0);
    await wd.close();
  });

  it("支持登记、重复登记幂等、注销与注销不存在的 PID，且最多启动一个看门狗", async () => {
    const spawns: (number | undefined)[] = [];
    const pidFile = path.join(root, "wd.pid");
    const wd = createProcessWatchdog({
      env: { NOCTURNE_WATCHDOG_PID_FILE: pidFile },
      onSpawn: (pid) => spawns.push(pid),
    });

    const victim = spawnTracked(["-e", "setInterval(() => {}, 1000)"]);
    const victimPid = victim.pid;
    expect(victimPid).toBeGreaterThan(0);
    if (victimPid === undefined) throw new Error("victim pid 缺失");

    try {
      wd.register(victimPid);
      // 重复登记不重复启动看门狗，也不增加计数
      wd.register(victimPid);
      expect(spawns).toHaveLength(1);
      expect(wd.registeredCount()).toBe(1);
      const wdPid = wd.pid();
      expect(wdPid).toBeGreaterThan(0);
      if (wdPid === undefined) throw new Error("watchdog pid 缺失");

      await waitUntil(async () => {
        try {
          const text = await fs.readFile(pidFile, "utf8");
          return Number(text.trim()) === wdPid;
        } catch {
          return false;
        }
      }, "看门狗写入 PID 文件");

      // 注销不存在的 PID 不报错、不影响已有登记
      wd.unregister(999_998);
      expect(wd.registeredCount()).toBe(1);

      // 注销已登记 PID 后，重复注销幂等；EOF 后已注销进程保持存活（不会误杀）
      wd.unregister(victimPid);
      wd.unregister(victimPid);
      expect(wd.registeredCount()).toBe(0);

      await wd.close();
      await waitUntil(() => !alive(wdPid), "看门狗在空表 EOF 后退出");
      expect(alive(victimPid)).toBe(true);
    } finally {
      await wd.close();
      await killPidTree(victimPid);
    }
  }, 25_000);

  it("EOF 后结束全部登记进程树（含孙进程）并自己退出", async () => {
    const wdPidFile = path.join(root, "wd.pid");
    const treeFile = path.join(root, "tree.json");
    cleanup.watchPidFile(treeFile);
    const wd = createProcessWatchdog({
      env: { NOCTURNE_WATCHDOG_PID_FILE: wdPidFile },
    });

    // 启动两个会派生孙进程的假进程
    const treeFile2 = path.join(root, "tree2.json");
    cleanup.watchPidFile(treeFile2);
    const spawnTreeScript = (outFile: string) =>
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
        `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

    spawnTracked(["-e", spawnTreeScript(treeFile)]);
    spawnTracked(["-e", spawnTreeScript(treeFile2)]);

    const readTree = async (file: string): Promise<{ parent: number; child: number }> => {
      await waitUntil(
        async () => {
          try {
            const text = await fs.readFile(file, "utf8");
            const parsed = JSON.parse(text) as { parent?: number; child?: number };
            return typeof parsed.parent === "number" && typeof parsed.child === "number";
          } catch {
            return false;
          }
        },
        `等待树文件 ${path.basename(file)}`,
      );
      return JSON.parse(await fs.readFile(file, "utf8")) as { parent: number; child: number };
    };

    const t1 = await readTree(treeFile);
    const t2 = await readTree(treeFile2);
    expect(alive(t1.parent)).toBe(true);
    expect(alive(t1.child)).toBe(true);
    expect(alive(t2.parent)).toBe(true);
    expect(alive(t2.child)).toBe(true);

    wd.register(t1.parent);
    wd.register(t2.parent);
    const wdPid = wd.pid();
    expect(wdPid).toBeGreaterThan(0);
    if (wdPid === undefined) throw new Error("watchdog pid 缺失");

    // 等看门狗就绪后关闭管道写端触发 EOF
    await waitUntil(async () => {
      try {
        return Number((await fs.readFile(wdPidFile, "utf8")).trim()) === wdPid;
      } catch {
        return false;
      }
    }, "看门狗就绪");

    await wd.close();

    await waitUntil(
      () => !alive(t1.parent) && !alive(t1.child) && !alive(t2.parent) && !alive(t2.child),
      "所有登记的进程与孙进程均被看门狗终止",
      15_000,
    );
    await waitUntil(() => !alive(wdPid), "看门狗清理后自行退出", 5_000);
  }, 30_000);

  it("管道写端不被子进程和孙进程继承：强杀父进程后看门狗仍能读到 EOF 并清理进程树", async () => {
    const stateFile = path.join(root, "inherit-state.json");
    const wdPidFile = path.join(root, "inherit-wd.pid");
    cleanup.watchPidFile(stateFile);

    // 模拟真实宿主进程：
    // 1. 拉起看门狗（打开看门狗 stdin 管道写端）；
    // 2. 启动一个会忽略 stdin EOF、且继续派生孙进程的假 MCP 服务器，以及一个未登记的旁观子进程（同样派生孙进程）；
    // 3. 把假服务器 PID 登记给看门狗，写状态文件后挂起等待被外部强杀。
    // 若看门狗管道写端被任一子进程或孙进程继承，则强杀父进程后写端仍开着，
    // 看门狗永远收不到 EOF，假服务器和孙进程也就永远不会被清理、测试必然超时。
    const hostScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const watchdogScript = ${JSON.stringify(WATCHDOG_SCRIPT)};`,
      `const wdPidFile = ${JSON.stringify(wdPidFile)};`,
      `const stateFile = ${JSON.stringify(stateFile)};`,
      'const wd = spawn(process.execPath, ["--input-type=commonjs", "-e", watchdogScript], {',
      "  detached: true,",
      "  windowsHide: true,",
      '  stdio: ["pipe", "ignore", "ignore"],',
      "  env: { ...process.env, NOCTURNE_WATCHDOG_PID_FILE: wdPidFile },",
      "});",
      "wd.unref();",
      "const serverScript = [",
      "  'const { spawn } = require(\"node:child_process\");',",
      '  \'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", windowsHide: true });\',',
      "  \"process.stdin.on('error', () => {});\",",
      "  \"process.stdout.on('error', () => {});\",",
      '  "process.stdin.resume();",',
      "  \"process.stdin.on('end', () => {});\",",
      "  \"process.stdout.write(String(child.pid) + '\\\\n');\",",
      '  "setInterval(() => {}, 1000);",',
      '].join("\\n");',
      'const server = spawn(process.execPath, ["-e", serverScript], {',
      "  detached: true,",
      "  windowsHide: true,",
      '  stdio: ["pipe", "pipe", "pipe"],',
      "});",
      // 再起一个未登记但同样继承 stdio 语义、派生孙进程的旁观子进程：
      // 用 detached: true 避免被 Windows libuv Job 连坐清理，确保它和孙进程在宿主死后依然活着，
      // 从而真实证明它们都没有继承看门狗管道的写端。
      'const bystander = spawn(process.execPath, ["-e", serverScript], {',
      "  detached: true,",
      "  windowsHide: true,",
      '  stdio: ["pipe", "pipe", "pipe"],',
      "});",
      "function readFirstPid(proc) {",
      "  return new Promise((resolve) => {",
      '    let buf = "";',
      '    proc.stdout.setEncoding("utf8");',
      '    proc.stdout.on("data", (chunk) => {',
      "      buf += chunk;",
      '      const nl = buf.indexOf("\\n");',
      "      if (nl >= 0) resolve(Number(buf.slice(0, nl).trim()));",
      "    });",
      "  });",
      "}",
      "Promise.all([readFirstPid(server), readFirstPid(bystander)]).then(([serverChild, bystanderChild]) => {",
      '  wd.stdin.write("+" + server.pid + "\\n");',
      "  fs.writeFileSync(stateFile, JSON.stringify({",
      "    host: process.pid,",
      "    watchdog: wd.pid,",
      "    server: server.pid,",
      "    serverChild,",
      "    bystander: bystander.pid,",
      "    bystanderChild,",
      "  }));",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const host = spawn(process.execPath, ["-e", hostScript], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let hostStderr = "";
    host.stderr?.on("data", (chunk: Buffer) => {
      hostStderr += chunk.toString("utf8");
    });

    let state:
      | {
          host: number;
          watchdog: number;
          server: number;
          serverChild: number;
          bystander: number;
          bystanderChild: number;
        }
      | undefined;

    try {
      await waitUntil(async () => {
        try {
          const raw = await fs.readFile(stateFile, "utf8");
          state = JSON.parse(raw) as typeof state;
          const wdRaw = await fs.readFile(wdPidFile, "utf8");
          return Boolean(state && Number(wdRaw.trim()) === state.watchdog);
        } catch {
          return false;
        }
      }, `宿主与看门狗就绪（stderr=${hostStderr}）`);

      expect(state).toBeDefined();
      if (state === undefined) throw new Error("state 缺失");
      const s = state;
      expect(alive(s.host)).toBe(true);
      expect(alive(s.watchdog)).toBe(true);
      expect(alive(s.server)).toBe(true);
      expect(alive(s.serverChild)).toBe(true);
      expect(alive(s.bystander)).toBe(true);
      expect(alive(s.bystanderChild)).toBe(true);

      // 只强杀宿主进程本体（Windows 用 taskkill /F 不带 /T，POSIX 用 SIGKILL）
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(s.host), "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await once(killer, "exit");
      } else {
        host.kill("SIGKILL");
      }
      await waitUntil(() => !alive(s.host), "宿主进程已结束", 5_000);

      // 即使旁观子进程及其孙进程仍活着，看门狗仍必须立即读到 EOF，
      // 清理登记的假服务器与孙进程，然后自行退出。
      await waitUntil(
        () => !alive(s.server) && !alive(s.serverChild) && !alive(s.watchdog),
        "强杀宿主后看门狗读到 EOF、清理假服务器及孙进程并退出",
        10_000,
      );
      // 旁观者及其孙进程未登记，仍存活（证明未被连坐误杀，且活着期间没有占住看门狗管道写端）
      expect(alive(s.bystander)).toBe(true);
      expect(alive(s.bystanderChild)).toBe(true);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      if (state) {
        await killPidTree(state.bystander);
        await killPidTree(state.bystanderChild);
        await killPidTree(state.server);
        await killPidTree(state.serverChild);
        await killPidTree(state.watchdog);
      }
    }
  }, 30_000);

  it("看门狗 unref 不拖住父进程自然退出，父进程退出后看门狗也随之退出", async () => {
    const wdPidFile = path.join(root, "unref-wd.pid");
    const hostScript = [
      'const { spawn } = require("node:child_process");',
      `const watchdogScript = ${JSON.stringify(WATCHDOG_SCRIPT)};`,
      `const wdPidFile = ${JSON.stringify(wdPidFile)};`,
      'const wd = spawn(process.execPath, ["--input-type=commonjs", "-e", watchdogScript], {',
      "  detached: true,",
      "  windowsHide: true,",
      '  stdio: ["pipe", "ignore", "ignore"],',
      "  env: { ...process.env, NOCTURNE_WATCHDOG_PID_FILE: wdPidFile },",
      "});",
      "wd.unref();",
      "if (wd.stdin && typeof wd.stdin.unref === 'function') wd.stdin.unref();",
      // 登记再注销一个假 PID，随后不调用 process.exit()，依靠事件循环自然排空退出
      'wd.stdin.write("+123456\\n-123456\\n");',
      "setTimeout(() => {}, 300);",
    ].join("\n");

    const host = spawn(process.execPath, ["-e", hostScript], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
    });

    const exited = await Promise.race([
      once(host, "exit").then(([code]) => ({ done: true, code })),
      delay(5_000).then(() => ({ done: false, code: null })),
    ]);
    if (!exited.done) host.kill("SIGKILL");
    expect(exited.done).toBe(true);
    expect(exited.code).toBe(0);

    // 若看门狗已写 PID 文件，确认它已随父进程退出而消失
    try {
      const wdPid = Number((await fs.readFile(wdPidFile, "utf8")).trim());
      if (wdPid > 0) {
        await waitUntil(() => !alive(wdPid), "父进程正常退出后看门狗随之退出", 5_000);
      }
    } catch {
      // 父进程 300ms 退出时看门狗可能尚未落盘就已收到 EOF 退出，同样正常
    }
  }, 15_000);

  it("createProcessRunner 的 guardOrphan 仅在显式开启时登记，退出与 kill 时立即注销", async () => {
    const registered: number[] = [];
    const unregistered: number[] = [];
    const spyWatchdog = {
      register: vi.fn((pid: number) => registered.push(pid)),
      unregister: vi.fn((pid: number) => unregistered.push(pid)),
    };
    const runner = createProcessRunner({ watchdog: spyWatchdog });

    // 1. 不设 guardOrphan：不触发任何登记
    const plain = runner.spawn(process.execPath, ["-e", "process.exit(0)"]);
    await plain.wait();
    expect(spyWatchdog.register).not.toHaveBeenCalled();

    // 2. 开启 guardOrphan 的 spawnPipe：启动即登记，正常退出立即注销
    const pipeProc = runner.spawnPipe(process.execPath, ["-e", "process.exit(0)"], {
      guardOrphan: true,
    });
    expect(registered).toContain(pipeProc.pid);
    await pipeProc.wait();
    await waitUntil(() => unregistered.includes(pipeProc.pid), "pipe 正常退出后注销");

    // 3. 开启 guardOrphan 的 spawnShell：启动即登记，主动 kill 后立即注销
    const shellProc = runner.spawnShell(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, {
      guardOrphan: true,
    });
    expect(registered).toContain(shellProc.pid);
    await shellProc.kill();
    expect(unregistered).toContain(shellProc.pid);
  }, 20_000);
});
