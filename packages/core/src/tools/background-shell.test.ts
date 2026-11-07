import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatform, type SpawnedProcess } from "../platform/index.js";
import { BackgroundShells } from "./background-shell.js";
import { createShellTool, shellTool } from "./builtin/shell.js";
import { shellTaskTools } from "./builtin/shell-tasks.js";
import type { ToolContext } from "./types.js";
import { createProcessCleanup, removeTempDirs } from "../../../../scripts/test/process-cleanup.mjs";

const cleanup = createProcessCleanup();
const platform = cleanup.platform(createPlatform());
const roots: string[] = [];
const managers: BackgroundShells[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) await manager.discard();
  await cleanup.cleanup();
  await removeTempDirs(roots.splice(0));
});
function setup(sessionId = "one") {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-bg-shell-"));
  roots.push(dir);
  const manager = new BackgroundShells({ platform, sessionsDir: dir, sessionId });
  managers.push(manager);
  return { manager, dir };
}
async function launch(manager: BackgroundShells, dir: string, script: string) {
  const file = path.join(dir, "command.cjs");
  await platform.fs.writeFile(file, script);
  return manager.start({ command: `"${process.execPath}" "${file}"`, cwd: dir, callId: "call" });
}
describe("ADR-0083 background shell", () => {
  it("returns immediately, keeps running and writes decoded output to the log", async () => {
    const { manager, dir } = setup();
    const started = await launch(
      manager,
      dir,
      'console.log("中文-ready"); setInterval(()=>{},1000);',
    );
    expect(started.background).toBe(true);
    expect(started.logPath).toBe(path.join(dir, "one.tasks", `${started.taskId}.log`));
    await vi.waitFor(async () =>
      expect(await platform.fs.readTextFile(started.logPath)).toContain("中文-ready"),
    );
    expect(manager.list()[0]?.status).toBe("running");
  });
  it("reads only new output, since start rereads, lists all and truncates with log path", async () => {
    const { manager, dir } = setup();
    const started = await launch(manager, dir, 'console.log("first"); setInterval(()=>{},1000);');
    await vi.waitFor(async () =>
      expect((await manager.output(started.taskId)).text).toContain("first"),
    );
    expect((await manager.output(started.taskId)).text).toBe("");
    expect((await manager.output(started.taskId, "start")).text).toContain("first");
    await platform.fs.appendFile(started.logPath, "x".repeat(40000));
    const output = await manager.output(started.taskId);
    expect(output.text.length).toBeLessThan(31000);
    expect(output.text).toContain(started.logPath);
    expect(manager.list()).toHaveLength(1);
    const other = setup("two").manager;
    await expect(other.output(started.taskId)).rejects.toThrow();
    await expect(other.kill(started.taskId)).rejects.toThrow();
  });
  it("kills its process tree and settles killed", async () => {
    const { manager, dir } = setup();
    const pidFile = path.join(dir, "tree.json");
    cleanup.watchPidFile(pidFile);
    const started = await launch(
      manager,
      dir,
      `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid })); console.log("ready"); setInterval(()=>{},1000);`,
    );
    await vi.waitFor(async () =>
      expect(await platform.fs.readTextFile(started.logPath)).toContain("ready"),
    );
    const pids = JSON.parse(await platform.fs.readTextFile(pidFile)) as {
      parent: number;
      child: number;
    };
    await manager.kill(started.taskId);
    expect(manager.list()[0]?.status).toBe("killed");
    for (const pid of Object.values(pids)) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 20000);
  it("shell_output respects maxModelChars and retains log path", async () => {
    const { manager, dir } = setup();
    const started = await launch(manager, dir, 'console.log("x".repeat(40000));');
    await manager.settled();
    const tool = shellTaskTools(manager)[0];
    if (!tool) throw new Error("missing tool");
    const output = await tool.execute({ id: started.taskId }, {} as unknown as ToolContext);
    expect(output.modelContent.length).toBeLessThan(31000);
    expect((output.output as { text: string }).text).toContain(started.logPath);
  });
  it("explicit timeout terminates the command", async () => {
    const { manager, dir } = setup();
    const file = path.join(dir, "timeout.cjs");
    await platform.fs.writeFile(file, "setInterval(()=>{},1000);");
    await manager.start({
      command: `"${process.execPath}" "${file}"`,
      cwd: dir,
      callId: "timeout",
      timeoutMs: 300,
    });
    await manager.settled();
    expect(manager.list()[0]?.status).toBe("timeout");
  });
  it("has no default timeout past two minutes (fake clock)", async () => {
    vi.useFakeTimers();
    const { manager, dir } = setup();
    const kill = vi.fn(async () => undefined);
    let resolve!: (value: {
      code: number;
      signal: null;
      timedOut: boolean;
      killed: boolean;
    }) => void;
    const proc: SpawnedProcess = {
      pid: 123,
      stdout: (async function* () {
        yield "ready";
      })(),
      stderr: (async function* () {
        yield "";
      })(),
      wait: () =>
        new Promise((done) => {
          resolve = done;
        }),
      kill,
      detachOutput: vi.fn(),
    };
    const spawn = vi.spyOn(platform.process, "spawnShell").mockReturnValue(proc);
    try {
      await manager.start({ command: "fixture", cwd: dir, callId: "call" });
      await vi.advanceTimersByTimeAsync(121000);
      expect(spawn.mock.calls[0]?.[1]?.timeoutMs).toBeUndefined();
      expect(kill).not.toHaveBeenCalled();
      resolve({ code: 0, signal: null, timedOut: false, killed: false });
      await manager.settled();
    } finally {
      spawn.mockRestore();
    }
  });
  it("disabled schema and description omit background and name", () => {
    expect(JSON.stringify(shellTool.inputSchema)).not.toMatch(/background|"name"/);
    expect(shellTool.description).not.toContain("background");
    const { manager } = setup();
    const enabled = createShellTool(manager);
    expect(JSON.stringify(enabled.inputSchema)).toContain("background");
    expect(JSON.stringify(enabled.inputSchema)).toContain('"name"');
  });
});
