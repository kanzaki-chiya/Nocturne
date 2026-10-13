import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { createProcessRunner } from "./process.js";
import { removeTempDirs } from "../../../../scripts/test/process-cleanup.mjs";

const spawned = vi.hoisted(() => ({ calls: [] as { command: string; args: string[] }[] }));

// 记录 pipeInvocation 交给 spawn 的命令，但不真的启动进程。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      if ((options.stdio as string[] | undefined)?.[0] === "pipe") {
        spawned.calls.push({ command, args });
        return actual.spawn(process.execPath, ["-e", ""], { ...options, cwd: undefined });
      }
      return actual.spawn(command, args, options);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-resolve-"));
  spawned.calls.length = 0;
});
afterEach(async () => {
  await removeTempDirs([root]);
});

async function resolveCommand(command: string): Promise<{ command: string; args: string[] }> {
  const proc = createProcessRunner().spawnPipe(command, ["--version"], {
    cwd: root,
    env: { PATH: path.join(root, "bin"), PATHEXT: ".CMD;;.cmd;.EXE" },
  });
  await proc.wait();
  const call = spawned.calls.at(-1);
  if (call === undefined) throw new Error("spawn 未被调用");
  return call;
}

describe.runIf(process.platform === "win32")("Windows spawnPipe 命令解析", () => {
  it("只有无扩展名 npx 时按找不到命令结算，不交给 spawn", async () => {
    await fs.mkdir(path.join(root, "bin"));
    await fs.writeFile(path.join(root, "bin", "npx"), "#!/bin/sh\n");
    const proc = createProcessRunner().spawnPipe("npx", ["--version"], {
      cwd: root,
      env: { PATH: path.join(root, "bin"), PATHEXT: ".CMD;.EXE" },
    });
    expect(proc.pid).toBe(-1);
    expect(await proc.wait()).toMatchObject({ code: null, signal: null });
    expect(await proc.exited()).toMatchObject({ code: null });
    expect(spawned.calls).toEqual([]);
  });

  it("npx 与 npx.cmd 并存时经 cmd 调用 npx.cmd", async () => {
    await fs.mkdir(path.join(root, "bin"));
    await fs.writeFile(path.join(root, "bin", "npx"), "#!/bin/sh\n");
    await fs.writeFile(path.join(root, "bin", "npx.cmd"), "@echo off\r\n");
    const call = await resolveCommand("npx");
    expect(call.args.at(-1)?.toLowerCase()).toContain(
      path.join(root, "bin", "npx.cmd").replaceAll(" ", "^ ").toLowerCase(),
    );
  });

  it("显式 npx.cmd 行为不变", async () => {
    await fs.mkdir(path.join(root, "bin"));
    await fs.writeFile(path.join(root, "bin", "npx"), "#!/bin/sh\n");
    await fs.writeFile(path.join(root, "bin", "npx.cmd"), "@echo off\r\n");
    const call = await resolveCommand("npx.cmd");
    expect(call.args.at(-1)?.toLowerCase()).toContain(
      path.join(root, "bin", "npx.cmd").replaceAll(" ", "^ ").toLowerCase(),
    );
  });
});
