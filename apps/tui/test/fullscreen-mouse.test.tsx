/**
 * 全屏鼠标交互（App 级，注入假 MouseSource）：
 * 滚轮翻阅、拖动选区反色、松开复制（OSC 52 + 系统剪贴板）、
 * 选区存在时 Ctrl+C 复制不退出、Esc 先清选区。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { spawn as nodeSpawn } from "node:child_process";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";

import { App } from "../src/app.js";
import type { MouseEvent, MouseSource } from "../src/mouse.js";

const tmpRoots: string[] = [];
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp("nct-mouse-home-")));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};
const ENV = { ascii: false, animated: false };
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}

async function longSession(): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  const runtime = await createRuntime({
    cwd: tmp("nct-mouse-ws-"),
    sessionsDir: tmp("nct-mouse-sd-"),
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "text_delta", text: `${"甲\n".repeat(30)}末尾标记` },
            { type: "finish", reason: "stop" },
          ],
          [
            { type: "text_delta", text: "二轮" },
            { type: "finish", reason: "stop" },
          ],
        ],
      }),
    ],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  return { runtime, session };
}

function fakeMouse(): MouseSource & { emit: (ev: MouseEvent) => void } {
  const listeners = new Set<(ev: MouseEvent) => void>();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emit(ev) {
      for (const fn of listeners) fn(ev);
    },
  };
}

function okSpawn() {
  const calls: { cmd: string; input: string }[] = [];
  const spawn = ((cmd: string) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", (d) => {
      input += String(d);
    });
    child.stdin.on("finish", () => {
      calls.push({ cmd, input });
      child.emit("exit", 0);
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

// 用例内部都按渲染条件等待；单独运行 0.5–3 秒，全量并发下会被拖慢到 5 秒以上，
// 这里放宽的只是单个用例的总时长上限，不是等待时序
describe("全屏鼠标", { timeout: 15_000 }, () => {
  it("大 diff 的省略行单击展开、再次单击收起，翻阅位置仍落在 diff", async () => {
    const { runtime, session } = await longSession();
    const mouse = fakeMouse();
    const { lastFrame, unmount, frames } = render(
      createElement(App, { session, runtime, env: ENV, mouse }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    const diff = `@@ -0,0 +1,50 @@\n${Array.from({ length: 50 }, (_, i) => `+line${i + 1}`).join("\n")}`;
    await session.session.emit("tool.started", {
      callId: "diff-1",
      name: "write",
      input: { path: "a.ts", content: "" },
      subjects: [],
      permission: { action: "allow", source: "rule" },
    });
    await session.session.emit("tool.completed", {
      callId: "diff-1",
      name: "write",
      status: "ok",
      modelContent: "已创建 a.ts",
      output: { path: "a.ts", created: true, diff },
    });
    await waitFor(() => (lastFrame() ?? "").includes("line50"));
    const clickMore = () => {
      const y =
        (lastFrame() ?? "")
          .split("\n")
          .findIndex((line) => line.includes("单击收起") || line.includes("还有 10 行")) + 1;
      expect(y).toBeGreaterThan(0);
      mouse.emit({ type: "press", button: 0, x: 4, y });
      mouse.emit({ type: "release", button: 0, x: 4, y });
    };
    // 帧写出后立即点击/滚动，覆盖被动 effect 尚未运行时再次输入的时序。
    const push = frames.push.bind(frames);
    let clicked = false;
    let anchored: string | undefined;
    frames.push = (...next) => {
      const count = push(...next);
      const frame = next.at(-1) ?? "";
      if (!clicked && frame.includes("还有 10 行")) {
        clicked = true;
        queueMicrotask(clickMore);
      } else if (clicked && anchored === undefined && frame.split("\n")[0]?.includes("write")) {
        anchored = frame;
        queueMicrotask(() => mouse.emit({ type: "wheel", dir: "down", x: 1, y: 1 }));
      }
      return count;
    };
    for (let i = 0; i < 15 && !clicked; i++) {
      const before = lastFrame();
      mouse.emit({ type: "wheel", dir: "up", x: 1, y: 1 });
      await waitFor(() => lastFrame() !== before);
    }
    await waitFor(() => anchored !== undefined);
    await waitFor(() => (lastFrame() ?? "").split("\n")[0]?.includes("line2") === true);
    frames.push = push;
    // 省略行对应的工具标题原本在视口之上，展开时标题成为新的顶部。
    expect(anchored?.split("\n")[0]).toContain("write");
    expect(lastFrame()).not.toContain("有新内容");
    for (let i = 0; i < 15 && !(lastFrame() ?? "").includes("单击收起"); i++) {
      const before = lastFrame();
      mouse.emit({ type: "wheel", dir: "down", x: 1, y: 1 });
      await waitFor(() => lastFrame() !== before);
    }
    clickMore();
    await waitFor(() => (lastFrame() ?? "").split("\n")[0]?.includes("write") === true);
    for (let i = 0; i < 15 && !(lastFrame() ?? "").includes("还有 10 行"); i++) {
      const before = lastFrame();
      mouse.emit({ type: "wheel", dir: "down", x: 1, y: 1 });
      await waitFor(() => lastFrame() !== before);
    }
    expect(lastFrame()).toContain("还有 10 行");
    unmount();
    await session.close();
  });

  it("滚轮翻阅出提示并停在原处，滚回底部提示消失", async () => {
    const { runtime, session } = await longSession();
    const mouse = fakeMouse();
    const { lastFrame, unmount } = render(
      createElement(App, { session, runtime, env: ENV, mouse }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    await session.submit({ text: "长" });
    await waitFor(() => (lastFrame() ?? "").includes("末尾标记"));
    mouse.emit({ type: "wheel", dir: "up", x: 1, y: 1 });
    mouse.emit({ type: "wheel", dir: "up", x: 1, y: 1 });
    await waitFor(() => (lastFrame() ?? "").includes("已向上翻阅"));
    expect(lastFrame()).not.toContain("末尾标记");
    // 新内容到达 → 提示换为"有新内容"
    await session.submit({ text: "又一问" });
    await waitFor(() => (lastFrame() ?? "").includes("有新内容"));
    for (let i = 0; i < 12; i++) mouse.emit({ type: "wheel", dir: "down", x: 1, y: 1 });
    await waitFor(() => (lastFrame() ?? "").includes("二轮"));
    expect(lastFrame()).not.toContain("有新内容");
    expect(lastFrame()).not.toContain("已向上翻阅");
    unmount();
    await session.close();
  });

  it("拖动选区反色，松开即复制（OSC 52 + 系统剪贴板）", async () => {
    const { runtime, session } = await longSession();
    const mouse = fakeMouse();
    const { spawn, calls } = okSpawn();
    const oob = vi.fn(() => true);
    const { lastFrame, unmount } = render(
      createElement(App, {
        session,
        runtime,
        env: ENV,
        mouse,
        copySpawn: spawn,
        writeOob: oob,
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    await session.submit({ text: "复制目标" });
    await waitFor(() => (lastFrame() ?? "").includes("末尾标记"));
    // 视口底部往上找"末尾标记"所在行；拖动选中它
    const frame = lastFrame() ?? "";
    const rowInFrame = frame.split("\n").findIndex((l) => l.includes("末尾标记"));
    expect(rowInFrame).toBeGreaterThan(-1);
    const y = rowInFrame + 1; // SGR 坐标 1 基
    mouse.emit({ type: "press", button: 0, x: 1, y });
    mouse.emit({ type: "drag", button: 0, x: 10, y });
    mouse.emit({ type: "release", button: 0, x: 10, y });
    await waitFor(() => (lastFrame() ?? "").includes("已复制"));
    // 两行路都走了：OSC 52 与系统剪贴板
    expect(oob).toHaveBeenCalledWith(expect.stringMatching(/^\x1b\]52;c;[A-Za-z0-9+/=]+\x07$/));
    expect(calls.length).toBe(1);
    expect(calls[0]?.input).toContain("末尾标记");
    unmount();
    await session.close();
  });

  it("选区跨过空行时空行保持行高，下方内容不上移", async () => {
    const runtime = await createRuntime({
      cwd: tmp("nct-mouse-ws-"),
      sessionsDir: tmp("nct-mouse-sd-"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "末尾标记" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const mouse = fakeMouse();
    const { spawn } = okSpawn();
    const { lastFrame, unmount } = render(
      createElement(App, {
        session,
        runtime,
        env: ENV,
        mouse,
        copySpawn: spawn,
        writeOob: () => true,
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    // 用户消息原样显示，段间空行各占一行
    await session.submit({ text: "第一段\n\n第二段\n\n第三段" });
    await waitFor(() => (lastFrame() ?? "").includes("末尾标记"));
    const rowOf = (text: string): number =>
      (lastFrame() ?? "").split("\n").findIndex((l) => l.includes(text));
    const top = rowOf("第一段");
    const tail = rowOf("末尾标记");
    const second = rowOf("第二段");
    const third = rowOf("第三段");
    expect(second - top).toBe(2);
    mouse.emit({ type: "press", button: 0, x: 1, y: top + 1 });
    mouse.emit({ type: "drag", button: 0, x: 4, y: tail + 1 });
    await pause(150); // 测试帧不带颜色码，选区反色不可见；等选区提交进状态并重绘
    // 选区覆盖三个空行时，内容行的位置与未选中时一致
    expect(rowOf("第一段")).toBe(top);
    expect(rowOf("第二段")).toBe(second);
    expect(rowOf("第三段")).toBe(third);
    expect(rowOf("末尾标记")).toBe(tail);
    unmount();
    await session.close();
  });

  it("拖到视口第一行时持续向上滚动并扩展选区", async () => {
    const { runtime, session } = await longSession();
    const mouse = fakeMouse();
    const { spawn, calls } = okSpawn();
    const { lastFrame, unmount } = render(
      createElement(App, { session, runtime, env: ENV, mouse, copySpawn: spawn }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    await session.submit({ text: "起点问题" });
    await waitFor(() => (lastFrame() ?? "").includes("末尾标记"));
    expect(lastFrame()).not.toContain("› 起点问题");
    const y = (lastFrame() ?? "").split("\n").findIndex((l) => l.includes("末尾标记")) + 1;
    mouse.emit({ type: "press", button: 0, x: 1, y });
    // 终端报告的坐标最小为 1：拖出上沿时也只会报第一行
    mouse.emit({ type: "drag", button: 0, x: 1, y: 1 });
    // 自动滚动每步都重绘整段长对话；全量并发时 CPU 紧张，滚到顶可能超过 5s
    await waitFor(() => (lastFrame() ?? "").includes("› 起点问题"), 15_000);
    await waitFor(() => (lastFrame() ?? "").split("\n")[0]?.includes("Nocturne") === true);
    mouse.emit({ type: "release", button: 0, x: 1, y: 1 });
    await waitFor(() => calls.length === 1);
    expect(calls[0]?.input).toContain("起点问题");
    unmount();
    await session.close();
  }, 30_000);

  it("选区存在时 Ctrl+C 复制不退出；Esc 先清选区", async () => {
    const { runtime, session } = await longSession();
    const mouse = fakeMouse();
    const { spawn } = okSpawn();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, mouse, copySpawn: spawn }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    await session.submit({ text: "问题" });
    await waitFor(() => (lastFrame() ?? "").includes("末尾标记"));
    const frame = lastFrame() ?? "";
    const y = frame.split("\n").findIndex((l) => l.includes("末尾标记")) + 1;
    mouse.emit({ type: "press", button: 0, x: 1, y });
    mouse.emit({ type: "drag", button: 0, x: 4, y });
    await pause(40);
    // Ctrl+C：复制 + 清高亮，界面仍在（输入照常，未退出）
    stdin.write("\x03");
    await waitFor(() => (lastFrame() ?? "").includes("已复制"));
    stdin.write("还活着");
    await waitFor(() => (lastFrame() ?? "").includes("› 还活着"));
    expect(lastFrame()).toContain("› 还活着");
    // 等第一次复制的状态栏提示过期（2s），避免与下一次断言串扰
    await waitFor(() => !(lastFrame() ?? "").includes("已复制"));
    // 再建选区 → Esc：只清选区，不中断不退出；随后 Ctrl+C 才退出
    mouse.emit({ type: "press", button: 0, x: 1, y });
    mouse.emit({ type: "drag", button: 0, x: 4, y });
    await pause(40);
    stdin.write("\x1b");
    await pause(120);
    expect(lastFrame()).not.toContain("已复制"); // Esc 未触发复制
    stdin.write("\x03");
    // 无选区时 Ctrl+C = 退出：之后的输入不再进入输入框
    stdin.write("探针");
    await pause(60);
    expect(lastFrame()).not.toContain("探针");
    unmount();
    await session.close();
  });

  it("单击只清除选区不复制", async () => {
    const { runtime, session } = await longSession();
    const mouse = fakeMouse();
    const { spawn, calls } = okSpawn();
    const { lastFrame, unmount } = render(
      createElement(App, { session, runtime, env: ENV, mouse, copySpawn: spawn }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("v0.4.0"));
    await session.submit({ text: "问题" });
    await waitFor(() => (lastFrame() ?? "").includes("末尾标记"));
    mouse.emit({ type: "press", button: 0, x: 3, y: 2 });
    mouse.emit({ type: "release", button: 0, x: 3, y: 2 });
    await pause(60);
    expect(lastFrame()).not.toContain("已复制");
    expect(calls).toHaveLength(0);
    unmount();
    await session.close();
  });
});
