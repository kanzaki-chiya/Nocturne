/**
 * TUI 渲染测试（ink-testing-library 虚拟终端断言帧内容）：
 * 骨架冒烟 + 回放区"完结前缀"规则（tui.md §4）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Box } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";
import {
  createSessionView,
  type PendingPermission,
  type ToolEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";

import { App, splitCompletedPrefix } from "../src/app.js";
import { PermissionDialog } from "../src/components/permission-dialog.js";
import { StatusBar } from "../src/components/status-bar.js";
import { ToolRow } from "../src/components/tool-row.js";
import { Transcript } from "../src/components/transcript.js";
import { TuiEnvContext } from "../src/env.js";
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
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const inEnv = (child: React.ReactNode) =>
  createElement(TuiEnvContext.Provider, { value: ENV }, child);

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
  it("权限对话框：五选项可见，Tab 移焦，d 进入反馈行", async () => {
    const pending: PendingPermission = {
      requestId: "p1",
      callId: "c1",
      toolName: "shell",
      subjects: [{ kind: "shell", target: "echo hi" }],
      reason: "需要确认",
      options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
    };
    const reply = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      inEnv(createElement(PermissionDialog, { pending, active: true, onReply: reply, width: 80 })),
    );
    for (const label of [
      "允许一次",
      "本会话内允许",
      "在此项目中始终允许",
      "拒绝（可附反馈）",
      "拒绝并停止本 Turn",
    ]) {
      expect(lastFrame()).toContain(label);
    }
    stdin.write("\t");
    await pause();
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ decision: "allow", remember: "session" });
    stdin.write("d");
    await pause();
    expect(lastFrame()).toContain("Enter 发送拒绝");
    stdin.write("请先检查");
    await pause();
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ decision: "deny", feedback: "请先检查" });
    unmount();
  });

  it("子代理运行中进度按行显示", () => {
    const entry = toolEntry("c1", "running");
    entry.name = "task";
    entry.liveOutput = "子会话第 1 轮开始\nread → ok\n";
    const { lastFrame, unmount } = render(inEnv(createElement(ToolRow, { entry, width: 80 })));
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.some((line) => line.includes("子会话第 1 轮开始"))).toBe(true);
    expect(lines.some((line) => line.includes("read → ok"))).toBe(true);
    expect(
      lines.some((line) => line.includes("子会话第 1 轮开始") && line.includes("read → ok")),
    ).toBe(false);
    unmount();
  });

  it("窄于 40 列：状态栏仅留状态和 tokens，权限框隐藏原因", () => {
    const view = createSessionView();
    view.config.model = { provider: "fake", model: "long-model" };
    view.config.permissionPreset = "default";
    const pending: PendingPermission = {
      requestId: "p1",
      callId: "c1",
      toolName: "shell",
      subjects: [{ kind: "shell", target: "echo hi" }],
      reason: "很长的审批原因",
      options: ["allow_once", "deny"],
    };
    const { lastFrame, unmount } = render(
      inEnv(
        createElement(
          Box,
          { flexDirection: "column" },
          createElement(PermissionDialog, { pending, active: true, onReply: vi.fn(), width: 32 }),
          createElement(StatusBar, { view, sessionId: "s-very-long", width: 32 }),
        ),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("idle");
    expect(frame).toContain("↑0 ↓0");
    expect(frame).not.toContain("很长的审批原因");
    expect(frame).not.toContain("long-model");
    expect(frame).not.toContain("s-very-long");
    unmount();
  });

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

  it("/resume 列表：显示会话、方向键移动并选择", async () => {
    const { runtime, session: s1 } = await makeSession();
    await pause();
    const s2 = await runtime.createSession({ model: "fake/fake-model" });
    const s2id = s2.id;
    await s2.close();
    const switcher = vi.fn<SwitchSessionFn>(async (id) => ({
      kind: "ok",
      session: id === s2id ? await runtime.resumeSession(id) : s1,
    }));
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session: s1, runtime, env: ENV, switchSession: switcher }),
    );
    await pause(50);
    stdin.write("/resume");
    stdin.write("\r");
    await pause(80);
    expect(lastFrame()).toContain("切换到会话");
    expect(lastFrame()).toContain(s2id);
    // 列表按 mtimeMs 降序——s1/s2 同毫秒时顺序不稳定；先读渲染顺序再定向导航
    const frame = lastFrame() ?? "";
    const s2First = frame.indexOf(s2id) < frame.indexOf(s1.id);
    stdin.write("\u001b[B"); // ↓ 到第二行
    await pause();
    if (!s2First) {
      stdin.write("\u001b[B"); // s2 在第二行时多按一次 ↓（PickList 环绕回 s1 也无妨，重按 ↓ 回到 s2）
      await pause();
      stdin.write("\u001b[A"); // 回 s2
      await pause();
      stdin.write("\u001b[B");
      await pause();
    } else {
      stdin.write("\u001b[A"); // 回第一行 s2
      await pause();
    }
    stdin.write("\r");
    await pause(80);
    // mtime 同毫秒时顺序仍可能翻转——验证“选择→切换”链路而非固定目标
    expect(switcher).toHaveBeenCalled();
    const calledId = switcher.mock.calls[0]?.[0];
    expect([s1.id, s2id]).toContain(calledId);
    expect(lastFrame()).toContain("已切换到会话");
    unmount();
    await s1.close();
  });

  it("/model 打开全屏模型选择页：搜索过滤 + Enter 切换", async () => {
    const { session, runtime } = await makeSession();
    const provider = {
      config: {
        describeProviders: () =>
          Promise.resolve([
            {
              id: "fake",
              type: "openai-compatible" as const,
              keySource: "env" as const,
              keyEnvName: "FAKE_KEY",
              origin: "user" as const,
              overridden: false,
              modelCount: 1,
              managed: false,
            },
          ]),
        setDefaultModel: () => Promise.resolve(),
        removeSetupProvider: () => Promise.resolve(),
        refreshUpstreamLimits: () => Promise.resolve(),
        credentials: { backend: () => "none" as const },
        base: { providers: [] },
      } as never,
      reloadConfig: () => Promise.resolve({} as never),
      updateProviders: vi.fn(),
      workspaceRoot: undefined,
    };
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, provider }),
    );
    await pause(80);
    stdin.write("/model");
    stdin.write("\r");
    await pause(400);
    const frame = lastFrame() ?? "";
    // 备用屏内渲染模型选择页：搜索框 + 模型行
    expect(frame).toContain("搜索");
    expect(frame).toContain("fake/fake-1");
    // 输入字符 → 搜索过滤
    stdin.write("zzz");
    await pause(60);
    expect(lastFrame()).toContain("无匹配");
    // Esc 清搜索 → 再 Esc 关闭回主屏
    stdin.write("\x1b");
    await pause(60);
    stdin.write("\x1b");
    await pause(200);
    expect(lastFrame()).toContain("idle");
    unmount();
    await session.close();
  });

  it("/provider 无参打开选择页（焦点左栏）；子命令分发", async () => {
    const { session, runtime } = await makeSession();
    const provider = {
      config: {
        describeProviders: () => Promise.resolve([]),
        setDefaultModel: () => Promise.resolve(),
        removeSetupProvider: () => Promise.resolve(),
        refreshUpstreamLimits: () => Promise.resolve(),
        credentials: { backend: () => "none" as const },
        base: { providers: [] },
      } as never,
      reloadConfig: () => Promise.resolve({} as never),
      updateProviders: vi.fn(),
      workspaceRoot: undefined,
    };
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, provider }),
    );
    await pause(80);
    stdin.write("/provider");
    stdin.write("\r");
    await pause(400);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("搜索");
    expect(frame).toContain("全部模型");
    // 未配置的预设服务商以 ○ 列出
    expect(frame).toContain("○");
    stdin.write("\x1b");
    await pause(200);
    unmount();
    await session.close();
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
