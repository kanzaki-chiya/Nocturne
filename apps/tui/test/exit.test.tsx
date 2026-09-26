/**
 * 退出路径：先恢复主屏（Ink 备用屏退出序列），再打印继续提示。
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
    providers: [new FakeProvider({ scripts: [] })],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  return { runtime, session };
}

function restoredBeforeMessage(chunks: string[], id: string): void {
  const text = chunks.join("");
  const exitAt = text.lastIndexOf("\x1b[?1049l");
  const msg = sessionSavedLine(id);
  const msgAt = text.indexOf(msg);
  expect(exitAt).toBeGreaterThanOrEqual(0);
  expect(msgAt).toBeGreaterThan(exitAt);
}

describe("退出恢复主屏", () => {
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
    restoredBeforeMessage(io.stdoutChunks, session.id);
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
    restoredBeforeMessage(io.stdoutChunks, session.id);
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
    restoredBeforeMessage(io.stdoutChunks, session.id);
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
    restoredBeforeMessage(io.stdoutChunks, session.id);
    await session.close();
  });
});
