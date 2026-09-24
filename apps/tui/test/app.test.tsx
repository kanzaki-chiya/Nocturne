/**
 * TUI 渲染测试（ink-testing-library 虚拟终端断言帧内容）：
 * 骨架冒烟 + 回放区"完结前缀"规则（tui.md §4）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";
import type { ToolEntry, ViewEntry } from "@nocturne/core/protocol";

import { App, splitCompletedPrefix } from "../src/app.js";
import { Transcript } from "../src/components/transcript.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

const ENV = { ascii: false, animated: false };

async function makeSession(): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  const runtime = await createRuntime({
    cwd: tmp("nct-tui-ws-"),
    sessionsDir: tmp("nct-tui-sd-"),
    providers: [new FakeProvider({ scripts: [] })],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  return { runtime, session };
}

const toolEntry = (callId: string, status: ToolEntry["status"]): ToolEntry => ({
  kind: "tool",
  key: `t:${callId}`,
  turnId: "turn-1",
  callId,
  name: "shell",
  seq: 1,
  status,
  input: { command: "echo hi" },
  subjects: [],
  permission: undefined,
  resolution: undefined,
  liveOutput: "",
  result: undefined,
});

const noticeEntry = (seq: number, message: string): ViewEntry => ({
  kind: "notice",
  key: `n:${seq}`,
  seq,
  subtype: "permission",
  message,
  payload: {},
});

describe("TUI", () => {
  it("骨架：渲染会话 id 与状态栏；Ctrl+C 退出", async () => {
    const { session, runtime } = await makeSession();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fake/fake-model");
    stdin.write("\x03"); // Ctrl+C：空闲退出
    await new Promise((r) => setTimeout(r, 50));
    unmount();
    await session.close();
  });

  it("完结前缀切分：未完结工具及其后条目不进回放区", () => {
    const entries: ViewEntry[] = [
      noticeEntry(1, "前置提示"),
      toolEntry("c1", "running"),
      noticeEntry(2, "权限：deny（rule）"),
      toolEntry("c2", "ok"),
    ];
    const { prefix, tail } = splitCompletedPrefix(entries);
    // running 工具是第一个未完结条目：前缀只有它之前的 notice
    expect(prefix).toHaveLength(1);
    expect(tail.map((e) => e.kind)).toEqual(["tool", "notice", "tool"]);
    // 全部完结时前缀 = 全部
    const done = splitCompletedPrefix([noticeEntry(1, "a"), toolEntry("c1", "ok")]);
    expect(done.prefix).toHaveLength(2);
    expect(done.tail).toHaveLength(0);
  });

  it("回放区只渲染完结前缀：运行中工具后的权限提示不进滚动区", () => {
    // 模拟 ask 路径 entries：[completed tool, running tool, permission notice]
    const entries: ViewEntry[] = [
      toolEntry("c0", "ok"),
      toolEntry("c1", "running"),
      noticeEntry(3, "权限：allow（user）"),
    ];
    const { prefix } = splitCompletedPrefix(entries);
    const { lastFrame, unmount } = render(
      createElement(Transcript, { entries: prefix, width: 80 }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("shell");
    expect(frame).not.toContain("权限：allow");
    unmount();
  });
});
