import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessCleanup, removeTempDirs } from "./process-cleanup.mjs";

const processes = createProcessCleanup();
const roots = [];
afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs(roots.splice(0));
});

it("清理启动时登记的进程和 PID 文件中的脱离树后代，之后可删目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nct-cleanup-"));
  roots.push(root);
  const file = path.join(root, "orphan.pid");
  processes.watchPidFile(file);
  await writeFile(
    path.join(root, "parent.cjs"),
    `
    const {spawn}=require("node:child_process");
    const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});
    require("node:fs").writeFileSync("orphan.pid",String(child.pid));
    child.unref();
    setInterval(()=>{},1000);
  `,
  );
  const parent = processes.trackChild(
    spawn(process.execPath, ["parent.cjs"], { cwd: root, stdio: "ignore", windowsHide: true }),
  );
  const pid = await vi.waitFor(async () => Number(await readFile(file, "utf8")), { timeout: 2000 });
  // No explicit registration after the wait: PID-file fallback must be sufficient.
  await processes.cleanup();
  expect(() => process.kill(parent.pid, 0)).toThrow();
  expect(() => process.kill(pid, 0)).toThrow();
  await removeTempDirs([root]);
});

it("一个登记句柄清理失败也继续清理其他句柄，最后报告错误", async () => {
  const first = {
    kill: vi.fn(async () => {
      throw new Error("fixture");
    }),
    detachOutput: vi.fn(),
  };
  const second = { kill: vi.fn(async () => undefined), detachOutput: vi.fn() };
  processes.track(first);
  processes.track(second);
  await expect(processes.cleanup()).rejects.toThrow("Fixture process cleanup failed");
  expect(first.detachOutput).toHaveBeenCalledOnce();
  expect(second.kill).toHaveBeenCalledOnce();
  expect(second.detachOutput).toHaveBeenCalledOnce();
});
