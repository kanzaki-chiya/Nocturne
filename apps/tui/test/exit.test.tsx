/**
 * 退出路径：普通屏幕保留回滚区，再追加继续提示。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";
import type { FakeScript } from "@nocturne/core";

import { runTui } from "../src/index.js";
import { sessionSavedLine } from "../src/exit-note.js";

const tmpRoots: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp("nct-tui-home-")));
afterEach(() => {
  vi.unstubAllEnvs();
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

async function openSession(
  scripts?: FakeScript[],
): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  const root = mkdtempSync(path.join(tmpdir(), "nct-exit-"));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), "nct-exit-sd-"));
  tmpRoots.push(root, sessionsDir);
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir,
    providers: [
      new FakeProvider({
        scripts: scripts ?? [
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
      inline: true,
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
      inline: true,
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
      inline: true,
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
      inline: true,
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
      inline: true,
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
      inline: true,
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

const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

describe("全屏退出（默认模式）", () => {
  it("提交准备中 Ctrl+D 等待中断收束后退出", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    let finish!: (reason: "aborted") => void;
    const submit = vi.spyOn(session, "submit").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const interrupt = vi.spyOn(session, "interrupt");
    let exited = false;
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    }).then(() => {
      exited = true;
    });
    await waitFor(() => io.stdoutChunks.join("").includes("Nocturne"));
    await new Promise((r) => setTimeout(r, 80));
    io.stdin.write("hello");
    await waitFor(() => io.stdoutChunks.join("").includes("hello"));
    io.stdin.write("\r");
    await waitFor(() => submit.mock.calls.length === 1);
    io.stdin.write("\x04");
    await waitFor(() => interrupt.mock.calls.length === 1);
    expect(exited).toBe(false);
    finish("aborted");
    await done;
    expect(io.stdoutChunks.join("")).not.toContain("会话持久化失败");
    await session.close();
  }, 12000);

  it("退出只导出折叠思考行与欢迎文字", async () => {
    const { runtime, session } = await openSession([
      [
        { type: "reasoning_delta", text: "先想想" },
        { type: "text_delta", text: "正文" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes("Nocturne"));
    await session.submit({ text: "问题" });
    io.stdin.write("\x04");
    await done;
    const output = io.stdoutChunks.join("");
    const after = output.slice(output.indexOf("\x1b[?1049l"));
    expect(after).toContain("∴ 思考了 0s（Ctrl+O 查看）");
    expect(after).not.toContain("先想想");
    expect(after).not.toContain("（思考）");
    expect(after).toContain("正文");
    expect(after).toContain("Nocturne");
    expect(after).not.toMatch(/[▀▄█]/);
    await session.close();
  });

  it("进备用屏后开鼠标；退出先关鼠标再回主屏；对话与继续提示落到主屏", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes("Nocturne"));
    await session.submit({ text: "测试分段" });
    await waitFor(() => io.stdoutChunks.join("").includes("第二段"));
    io.stdin.write("\x04");
    await done;
    const text = io.stdoutChunks.join("");
    const enterAt = text.indexOf("\x1b[?1049h");
    const mouseOn = text.indexOf(MOUSE_ON);
    expect(enterAt).toBeGreaterThan(-1);
    expect(mouseOn).toBeGreaterThan(enterAt); // 先备屏后开鼠标
    const mouseOff = text.indexOf(MOUSE_OFF);
    const leaveAt = text.indexOf("\x1b[?1049l");
    expect(mouseOff).toBeGreaterThan(-1);
    expect(leaveAt).toBeGreaterThan(mouseOff); // 先关鼠标再回主屏
    const after = text.slice(leaveAt);
    expect(after).toContain("第二段"); // 对话按纯文本行打回主屏
    expect(after).toContain(sessionSavedLine(session.id));
    expect(io.stderrChunks.join("")).toBe("");
    await session.close();
  });

  it("未捕获异常：鼠标关闭仍在回主屏之前", async () => {
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
    await waitFor(() => io.stdoutChunks.join("").includes("Nocturne"));
    process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    await done;
    expect(crashed).toBe(true);
    const text = io.stdoutChunks.join("");
    const mouseOff = text.indexOf(MOUSE_OFF);
    const leaveAt = text.indexOf("\x1b[?1049l");
    expect(mouseOff).toBeGreaterThan(-1);
    expect(leaveAt).toBeGreaterThan(mouseOff);
    expect(text.slice(leaveAt)).toContain(sessionSavedLine(session.id));
    expect(io.stderrChunks.join("")).toContain("boom");
    await session.close();
  });

  it("stdin 进入 Ink 前摘除 SGR 鼠标序列：滚轮翻阅、字节不进输入框", async () => {
    const { runtime, session } = await openSession();
    const io = ttyPair();
    const done = runTui({ session }, runtime, {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      patchConsole: false,
    });
    await waitFor(() => io.stdoutChunks.join("").includes("Nocturne"));
    // 滚轮序列与普通按键字节混在同一块里：按键进输入框，鼠标序列被摘除
    io.stdin.write("\x1b[<65;10;5Mxyz");
    await waitFor(() => io.stdoutChunks.join("").includes("xyz"));
    const text = io.stdoutChunks.join("");
    expect(text).not.toContain("<65;");
    expect(text).not.toContain("10;5M");
    io.stdin.write("\x03");
    await done;
    await session.close();
  });
});
