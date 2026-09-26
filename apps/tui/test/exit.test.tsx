/**
 * 退出路径：普通屏幕保留回滚区，再追加继续提示。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";

import { runTui } from "../src/index.js";
import { sessionSavedLine } from "../src/exit-note.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function ttyPair() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  const stderr = new EventEmitter() as NodeJS.WriteStream;
  stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  const stdin = new EventEmitter() as NodeJS.ReadStream & { write: (d: string) => void };
  stdin.isTTY = true;
  let pending: string | null = null;
  stdin.setRawMode = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  stdin.read = (() => {
    const data = pending;
    pending = null;
    return data;
  }) as NodeJS.ReadStream["read"];
  stdin.write = ((data: string) => {
    pending = data;
    stdin.emit("readable");
    stdin.emit("data", data);
    return true;
  }) as NodeJS.ReadStream["write"] & ((d: string) => void);
  return { stdin, stdout, stderr, stdoutChunks, stderrChunks };
}

async function openSession(): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  const root = mkdtempSync(path.join(tmpdir(), "nct-exit-"));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), "nct-exit-sd-"));
  tmpRoots.push(root, sessionsDir);
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir,
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "text_delta", text: "第一段\n\n" },
            { type: "wait", ms: 80 },
            { type: "text_delta", text: "第二段" },
            { type: "finish", reason: "stop" },
          ],
        ],
      }),
    ],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  return { runtime, session };
}

function preservedBeforeMessage(chunks: string[], id: string): void {
  const text = chunks.join("");
  const msg = sessionSavedLine(id);
  const msgAt = text.indexOf(msg);
  expect(text).not.toContain("\x1b[?1049h");
  expect(msgAt).toBeGreaterThan(0);
  expect(text.slice(0, msgAt)).toContain("Nocturne");
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("退出保留回滚区", () => {
  it("流式完成块晋升后仍追加后续内容，退出不清屏", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 80));
    await session.submit({ text: "测试分段" });
    const output = io.stdoutChunks.join("");
    expect(output).toContain("第一段");
    expect(output).toContain("第二段");
    expect(output).not.toContain("\x1b[2J");
    io.stdin.write("\x04");
    await done;
    preservedBeforeMessage(io.stdoutChunks, session.id);
    await session.close();
  });

  it("模型页反复切屏，主屏回滚区仍在", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const provider = {
      workspaceRoot: "test",
      config: { describeProviders: () => Promise.resolve([]) },
      reloadConfig: () => Promise.resolve({}),
      updateProviders: () => undefined,
    } as never;
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      provider,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes("Nocturne"));
    for (let i = 1; i <= 5; i++) {
      io.stdin.write("/model");
      io.stdin.write("\r");
      await waitFor(() => io.stdoutChunks.join("").split("\x1b[?1049h").length - 1 === i);
      io.stdin.write("\x1b");
      await waitFor(() => io.stdoutChunks.join("").split("\x1b[?1049l").length - 1 === i);
    }
    io.stdin.write("\x04");
    await done;
    expect(io.stdoutChunks.join("")).toContain("Nocturne");
    preservedBeforeMessage(
      io.stdoutChunks.filter((c) => !c.includes("\x1b[?1049h")),
      session.id,
    );
    await session.close();
  });

  it("/exit", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      exitProcess: () => undefined,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 120));
    io.stdin.write("/exit");
    io.stdin.write("\r");
    await done;
    preservedBeforeMessage(io.stdoutChunks, session.id);
    await session.close();
  });

  it("Ctrl+D", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      exitProcess: () => undefined,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 120));
    io.stdin.write("\x04");
    await done;
    preservedBeforeMessage(io.stdoutChunks, session.id);
    await session.close();
  });

  it("空闲 Ctrl+C", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      exitProcess: () => undefined,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 120));
    io.stdin.write("\x03");
    await done;
    preservedBeforeMessage(io.stdoutChunks, session.id);
    await session.close();
  });

  it("未捕获异常也恢复主屏并打印提示", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    let crashed = false;
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      exitProcess: () => {
        crashed = true;
      },
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 80));
    process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    await done;
    expect(crashed).toBe(true);
    preservedBeforeMessage(io.stdoutChunks, session.id);
    await session.close();
  });
});
