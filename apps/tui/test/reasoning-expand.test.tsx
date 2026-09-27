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
  const dir = mkdtempSync(path.join(tmpdir(), "nct-expand-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function makeSession() {
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "reasoning_delta", text: "完整思考第一行\n完整思考第二行" },
            { type: "text_delta", text: "回答" },
            { type: "finish", reason: "stop" },
          ],
        ],
      }),
    ],
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

it("全屏 Ctrl+O 原位展开/收起，保留草稿并恢复常驻状态提示", async () => {
  const { runtime, session } = await makeSession();
  await session.submit({ text: "提问" });
  const pages: string[] = [];
  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      session,
      runtime,
      env: { ascii: false, animated: false },
      onOutputLayout: (_rows, page) => pages.push(page),
    }),
  );
  await vi.waitFor(() => expect(lastFrame()).toContain("Ctrl+O 展开"));
  stdin.write("草稿");
  stdin.write("\x0f");
  await vi.waitFor(() => expect(lastFrame()).toContain("  完整思考第一行"));
  expect(lastFrame()).toContain("回答");
  expect(lastFrame()).toContain("草稿");
  expect(lastFrame()).toContain("思考已展开（Ctrl+O 收起）");
  expect(pages.at(-1)).toBe("conversation");
  stdin.write("\x0f");
  await vi.waitFor(() => expect(lastFrame()).toContain("Ctrl+O 展开"));
  expect(lastFrame()).not.toContain("  完整思考第一行");
  unmount();
  await session.close();
});

it("展开思考的拖动复制去掉显示缩进", async () => {
  const { runtime, session } = await makeSession();
  await session.submit({ text: "提问" });
  const mouse = fakeMouse();
  const copied: string[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough();
    child.stdin.on("data", (data) => copied.push(String(data)));
    child.stdin.on("finish", () => child.emit("exit", 0));
    return child;
  }) as unknown as typeof nodeSpawn;
  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      session,
      runtime,
      env: { ascii: false, animated: false },
      mouse,
      copySpawn: spawn,
      writeOob: () => true,
    }),
  );
  await vi.waitFor(() => expect(lastFrame()).toContain("Ctrl+O 展开"));
  stdin.write("\x0f");
  await vi.waitFor(() => expect(lastFrame()).toContain("  完整思考第一行"));
  const y =
    (lastFrame() ?? "").split("\n").findIndex((line) => line.includes("完整思考第一行")) + 1;
  mouse.emit({ type: "press", button: 0, x: 1, y });
  mouse.emit({ type: "drag", button: 0, x: 20, y });
  await new Promise<void>((resolve) => setTimeout(resolve, 60)); // 等选区状态提交，与现有鼠标测试一致
  mouse.emit({ type: "release", button: 0, x: 20, y });
  await vi.waitFor(() => expect(copied.length).toBeGreaterThan(0));
  expect(copied.join("")).toContain("完整思考第一行");
  expect(copied.join("")).not.toContain("  完整思考第一行");
  await vi.waitFor(() => expect(lastFrame()).toContain("已复制"));
  await vi.waitFor(() => expect(lastFrame()).toContain("思考已展开（Ctrl+O 收起）"), {
    timeout: 4000,
  });
  unmount();
  await session.close();
});

it("没有思考时只提示；inline 完整记录进出临时备用屏", async () => {
  const { runtime, session } = await makeSession();
  const empty = render(
    createElement(App, { session, runtime, env: { ascii: false, animated: false } }),
  );
  await vi.waitFor(() => expect(empty.lastFrame()).toBeTruthy());
  empty.stdin.write("\x0f");
  await vi.waitFor(() => expect(empty.lastFrame()).toContain("本会话还没有思考内容"));
  empty.unmount();
  await session.submit({ text: "提问" });

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
  await vi.waitFor(() => expect(writes.join("")).toContain("Ctrl+O 展开"));
  stdin.send("草稿");
  await vi.waitFor(() => expect(writes.join("")).toContain("草稿"));
  stdin.send("\x0f");
  await vi.waitFor(() => expect(writes.join("")).toContain("\x1b[?1049h"));
  await vi.waitFor(() => expect(writes.join("")).toContain("完整记录"));
  await vi.waitFor(() => expect(writes.join("")).toContain("完整思考第一行"));
  stdin.send("\x1b");
  await vi.waitFor(() => expect(writes.join("")).toContain("\x1b[?1049l"));
  expect(writes.join("")).toContain("草稿");
  stdin.send("\x04");
  await done;
  await session.close();
}, 10000);
