import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { spawn as nodeSpawn } from "node:child_process";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";

import { App } from "../src/app.js";
import { runTui } from "../src/index.js";
import type { MouseEvent, MouseSource } from "../src/mouse.js";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-reasoning-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause();
  }
}
const scripts = [
  [
    { type: "reasoning_delta" as const, text: "第一轮完整思考" },
    { type: "text_delta" as const, text: "第一轮回答" },
    { type: "finish" as const, reason: "stop" as const },
  ],
  [
    ...Array.from({ length: 90 }, (_, i) => [
      { type: "reasoning_delta" as const, text: `第${String(i).padStart(3, "0")}行\n` },
      { type: "wait" as const, ms: 15 },
    ]).flat(),
    { type: "text_delta" as const, text: "第二轮回答" },
    { type: "finish" as const, reason: "stop" as const },
  ],
];
async function makeSession() {
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [new FakeProvider({ scripts })],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  return { runtime, session };
}

function fakeMouse(): MouseSource & { emit: (event: MouseEvent) => void } {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

it("Ctrl+O 默认最近轮，左右到头不循环；翻阅后停住、回到底部恢复跟随，返回保留草稿", async () => {
  const { runtime, session } = await makeSession();
  const layouts: string[] = [];
  const mouse = fakeMouse();
  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      session,
      runtime,
      env: { ascii: false, animated: false },
      mouse,
      onOutputLayout: (_rows: number, page: string) => layouts.push(page),
    }),
  );
  await pause(60);
  stdin.write("草稿");
  await session.submit({ text: "第一问" });
  const second = session.submit({ text: "第二问" });
  await waitFor(() => (lastFrame() ?? "").includes("思考中"));
  stdin.write("\x0f");
  await waitFor(() => (lastFrame() ?? "").includes("思考 · 第 2/2 轮"));
  expect(layouts).toContain("reasoning-1");
  stdin.write("\x1b[C");
  await pause();
  expect(lastFrame()).toContain("第 2/2 轮");
  stdin.write("\x1b[D");
  await waitFor(() => (lastFrame() ?? "").includes("第 1/2 轮"));
  expect(lastFrame()).toContain("第一轮完整思考");
  stdin.write("\x1b[D");
  await pause();
  expect(lastFrame()).toContain("第 1/2 轮");
  stdin.write("\x1b[C");
  await waitFor(() => (lastFrame() ?? "").includes("第 2/2 轮"));
  await waitFor(() => (lastFrame() ?? "").includes("第060行"));
  stdin.write("\x1b[5~");
  await pause();
  expect(lastFrame()).not.toContain("第060行");
  mouse.emit({ type: "wheel", dir: "up", x: 1, y: 10 });
  await pause();
  await second;
  expect(lastFrame()).not.toContain("第089行");
  stdin.write("\x1b[1;5F");
  await waitFor(() => (lastFrame() ?? "").includes("第089行"));
  stdin.write("\x0f");
  await waitFor(() => !(lastFrame() ?? "").includes("思考 · 第"));
  expect(lastFrame()).toContain("草稿");
  expect(layouts.at(-1)).toBe("conversation");
  unmount();
  await session.close();
}, 15000);

it("思考页拖动选中复制的是正文；Esc 先清选区再返回", async () => {
  const { runtime, session } = await makeSession();
  await session.submit({ text: "第一问" });
  const mouse = fakeMouse();
  const copied: string[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough();
    child.stdin.on("data", (data) => copied.push(String(data)));
    child.stdin.on("finish", () => child.emit("exit", 0));
    return child;
  }) as unknown as typeof nodeSpawn;
  const oob = vi.fn(() => true);
  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      session,
      runtime,
      env: { ascii: false, animated: false },
      mouse,
      copySpawn: spawn,
      writeOob: oob,
    }),
  );
  await pause(60);
  stdin.write("\x0f");
  await waitFor(() => (lastFrame() ?? "").includes("第一轮完整思考"));
  const y =
    (lastFrame() ?? "").split("\n").findIndex((line) => line.includes("第一轮完整思考")) + 1;
  expect(y).toBeGreaterThan(1);
  mouse.emit({ type: "press", button: 0, x: 1, y });
  mouse.emit({ type: "drag", button: 0, x: 17, y });
  await pause(60);
  mouse.emit({ type: "release", button: 0, x: 17, y });
  await waitFor(() => copied.length > 0);
  expect(copied.join("")).toContain("第一轮完整思考");
  expect(oob).toHaveBeenCalled();
  const count = copied.length;
  stdin.write("\x03");
  await waitFor(() => copied.length > count);
  expect(lastFrame()).toContain("思考 · 第 1/1 轮");
  mouse.emit({ type: "press", button: 0, x: 1, y });
  mouse.emit({ type: "drag", button: 0, x: 17, y });
  stdin.write("\x1b");
  await pause(80);
  expect(lastFrame()).toContain("思考 · 第 1/1 轮");
  stdin.write("\x1b");
  await waitFor(() => !(lastFrame() ?? "").includes("思考 · 第"));
  unmount();
  await session.close();
}, 10000);

it("没有思考时只提示；inline 思考页临时进入并退出备用屏", async () => {
  const { runtime, session } = await makeSession();
  const empty = render(
    createElement(App, { session, runtime, env: { ascii: false, animated: false } }),
  );
  await pause(50);
  empty.stdin.write("\x0f");
  await waitFor(() => (empty.lastFrame() ?? "").includes("本会话还没有思考内容"));
  expect(empty.lastFrame()).not.toContain("思考 · 第");
  empty.unmount();
  await session.submit({ text: "第一问" });

  const writes: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  const stderr = new EventEmitter() as NodeJS.WriteStream;
  stderr.write = (() => true) as NodeJS.WriteStream["write"];
  const stdin = new EventEmitter() as NodeJS.ReadStream & { send: (text: string) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const input: string[] = [];
  stdin.read = () => input.shift() ?? null;
  stdin.send = (text) => {
    input.push(text);
    stdin.emit("readable");
  };
  const done = runTui({ session }, runtime, {
    stdin,
    stdout,
    stderr,
    inline: true,
    patchConsole: false,
  });
  await pause(80);
  stdin.send("\x0f");
  await waitFor(() => writes.join("").includes("\x1b[?1049h"));
  await waitFor(() => writes.join("").includes("思考 · 第 1/1 轮"));
  stdin.send("\x1b");
  await waitFor(() => writes.join("").includes("\x1b[?1049l"));
  stdin.send("\x04");
  await done;
  await session.close();
}, 10000);

it("权限确认框打开时 Ctrl+O 不遮挡确认", async () => {
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    interactive: true,
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "reasoning_delta", text: "需要写入前先思考" },
            {
              type: "tool_call",
              toolCallId: "w1",
              name: "write",
              input: { path: "x.txt", content: "x" },
            },
            { type: "finish", reason: "tool_calls" },
          ],
        ],
      }),
    ],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  const { lastFrame, stdin, unmount } = render(
    createElement(App, { session, runtime, env: { ascii: false, animated: false } }),
  );
  await pause(60);
  const turn = session.submit({ text: "写入" });
  await waitFor(() => events.includes("permission.requested"));
  stdin.write("\x0f");
  await pause(60);
  expect(lastFrame()).not.toContain("思考 · 第");
  expect(events).toContain("permission.requested");
  session.interrupt();
  await turn;
  unmount();
  await session.close();
}, 10000);
