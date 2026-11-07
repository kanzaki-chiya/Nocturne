import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPlatform } from "../src/platform/index.js";
import { BackgroundShells } from "../src/tools/background-shell.js";
import type { BackgroundShellTask } from "../src/protocol/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const cleanup = createProcessCleanup();
const roots: string[] = [];
const managers: BackgroundShells[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.discard();
  await cleanup.cleanup();
  await removeTempDirs(roots.splice(0));
});
async function setup(script: string, updated?: (task: BackgroundShellTask) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-shell-observer-"));
  roots.push(dir);
  const pidFile = path.join(dir, "pid.json");
  cleanup.watchPidFile(pidFile);
  const file = path.join(dir, "fixture.cjs");
  writeFileSync(
    file,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));\n${script}`,
  );
  const manager = new BackgroundShells({
    platform: cleanup.platform(createPlatform()),
    sessionsDir: dir,
    sessionId: "s",
    ...(updated ? { updated } : {}),
  });
  managers.push(manager);
  const task = await manager.start({
    command: `"${process.execPath}" "${file}"`,
    cwd: dir,
    callId: "call",
  });
  return { manager, task, pidFile };
}
it("observer offsets are independent of model reads and repeated reads are stable", async () => {
  const { manager, task, pidFile } = await setup(
    'console.log("first中文"); let sent=false; setInterval(()=>{if(!sent && require("node:fs").existsSync(require("node:path").join(__dirname,"release"))){sent=true; process.stdout.write("second");}},50);',
  );
  await vi.waitFor(async () =>
    expect((await manager.observe(task.taskId)).text).toContain("first中文"),
  );
  const first = await manager.observe(task.taskId);
  expect(first.start).toBe(0);
  expect(first.end).toBe(first.text.length);
  expect((await manager.output(task.taskId)).text).toBe(first.text);
  expect((await manager.output(task.taskId)).text).toBe("");
  for (let i = 0; i < 2; i++) {
    expect(await manager.observe(task.taskId, 0)).toMatchObject({
      text: first.text,
      start: 0,
      end: first.end,
    });
  }
  expect((await manager.observe(task.taskId, first.end)).text).toBe("");
  expect(await manager.observe(task.taskId, first.end + 100)).toMatchObject({
    start: first.end,
    end: first.end,
    text: "",
  });
  writeFileSync(path.join(path.dirname(pidFile), "release"), "go");
  await vi.waitFor(async () =>
    expect((await manager.observe(task.taskId, first.end)).text).toBe("second"),
  );
  const next = await manager.observe(task.taskId, first.end);
  expect(next).toMatchObject({ start: first.end, end: first.end + 6, text: "second" });
  expect((await manager.output(task.taskId)).text).toBe("second");
  expect((await manager.observe(task.taskId, first.end)).text).toBe("second");
  expect((await manager.observe(task.taskId, next.end)).text).toBe("");
  await manager.kill(task.taskId);
  expect((await manager.observe(task.taskId)).text).toBe(first.text + "second");
  const pid = JSON.parse(readFileSync(pidFile, "utf8")) as number;
  expect(() => process.kill(pid, 0)).toThrow();
}, 20000);
it("observer first read and large increments return the last 200000 characters with absolute offsets", async () => {
  const { manager, task } = await setup('process.stdout.write("a".repeat(210000) + "中文END");');
  await manager.settled();
  const first = await manager.observe(task.taskId);
  expect(first).toMatchObject({ start: 10005, end: 210005 });
  expect(first.text).toBe("a".repeat(199995) + "中文END");
  expect(await manager.observe(task.taskId, 1)).toEqual(first);
  expect((await manager.observe(task.taskId, 210000)).text).toBe("中文END");
  expect((await manager.output(task.taskId, "start")).text.length).toBeLessThan(31000);
});
it("running output emits throttled increasing outputChars and a final task update", async () => {
  const updates: { task: BackgroundShellTask; at: number }[] = [];
  const { manager, task, pidFile } = await setup(
    'let n=0; const timer=setInterval(()=>{process.stdout.write("中文" + n++ + "\\n"); if(n===35) clearInterval(timer);},50);',
    (item) => updates.push({ task: item, at: Date.now() }),
  );
  await manager.settled();
  const running = updates.filter((item) => item.task.status === "running");
  expect(running.length).toBeGreaterThan(2);
  expect(running[0]?.task.outputChars).toBe(0);
  for (let i = 1; i < running.length; i++) {
    expect(running[i]?.task.outputChars).toBeGreaterThan(running[i - 1]?.task.outputChars ?? -1);
    expect((running[i]?.at ?? 0) - (running[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(500);
  }
  const final = updates.at(-1)?.task;
  expect(final?.status).toBe("exited");
  expect(final?.outputChars).toBe(readFileSync(task.logPath, "utf8").length);
  expect(final?.outputChars).toBeGreaterThan(running.at(-1)?.task.outputChars ?? 0);
  const pid = JSON.parse(readFileSync(pidFile, "utf8")) as number;
  expect(() => process.kill(pid, 0)).toThrow();
}, 15000);
