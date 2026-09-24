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
import type { SwitchSessionFn } from "../src/types.js";

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

  it("/resume <id> 切换：分隔线进回放区，新会话日志重放", async () => {
    const runtime = await createRuntime({
      cwd: tmp("nct-tui-ws-"),
      sessionsDir: tmp("nct-tui-sd-"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "来自 s2 的回答" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    // s2 先跑一个 Turn 留下持久日志，关闭释放锁
    const s2 = await runtime.createSession({ model: "fake/fake-1" });
    await s2.submit({ text: "hi" });
    const s2id = s2.id;
    await s2.close();
    const s1 = await runtime.createSession({ model: "fake/fake-1" });

    const switcher: SwitchSessionFn = async (id) =>
      id === s2id
        ? { kind: "ok", session: await runtime.resumeSession(id) }
        : { kind: "error", message: "不存在" };

    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session: s1, runtime, env: ENV, switchSession: switcher }),
    );
    await new Promise((r) => setTimeout(r, 50)); // 等 useInput 订阅挂载
    stdin.write(`/resume ${s2id}`); // 单 data 事件视为一次粘贴；回车单独发
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 300));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已切换到会话");
    expect(frame).toContain("来自 s2 的回答"); // 新会话持久日志已重放
    unmount();
    await s1.close();
  });

  it("/resume 失败：错误进提示行，不换会话", async () => {
    const { session, runtime } = await makeSession();
    const switcher: SwitchSessionFn = () =>
      Promise.resolve({ kind: "error", message: "会话被另一个进程占用" });
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, switchSession: switcher }),
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("/resume sX");
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("占用");
    expect(frame).not.toContain("已切换到会话");
    unmount();
    await session.close();
  });
});
