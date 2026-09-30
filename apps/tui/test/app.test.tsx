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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Runtime, type RuntimeSession } from "@nocturne/core";
import {
  createSessionView,
  type PendingPermission,
  type ToolEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";

import { App, splitCompletedPrefix } from "../src/app.js";
import { captureConsole } from "../src/console-capture.js";
import { PermissionDialog } from "../src/components/permission-dialog.js";
import { StatusBar } from "../src/components/status-bar.js";
import { ToolRow } from "../src/components/tool-row.js";
import { Transcript } from "../src/components/transcript.js";
import { TuiEnvContext } from "../src/env.js";
import type { SwitchSessionFn } from "../src/types.js";

const tmpRoots: string[] = [];
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp("nct-tui-home-")));
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
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor 超时");
    await pause(20);
  }
}
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
  it.each([false, true])("/settings 整帧打开并取消返回对话（inline=%s）", async (inline) => {
    const { runtime, session } = await makeSession();
    const screen = render(createElement(App, { session, runtime, env: ENV, inline }));
    await waitFor(() => (screen.lastFrame() ?? "").includes("fake-model"));
    await pause(100);
    screen.stdin.write("/settings");
    screen.stdin.write("\r");
    await waitFor(() => (screen.lastFrame() ?? "").includes("/settings 设置"));
    expect(screen.lastFrame()).toContain("在 /model 页设置");
    expect(screen.lastFrame()).not.toContain("上下文");
    await pause(100);
    screen.stdin.write("\x1b");
    await waitFor(
      () =>
        !(screen.lastFrame() ?? "").includes("/settings 设置") &&
        (screen.lastFrame() ?? "").includes("fake-model"),
    );
    screen.unmount();
    await session.close();
  });

  it.each(["/new", "/resume other"])("提交准备中立刻 %s：拒绝切换", async (cmd) => {
    const { runtime, session } = await makeSession();
    let finish!: (reason: "aborted") => void;
    const submit = vi.spyOn(session, "submit").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const newSession = vi.fn(async () => ({ kind: "busy" as const }));
    const switchSession = vi.fn(async () => ({ kind: "busy" as const }));
    const { stdin, lastFrame, unmount } = render(
      createElement(App, {
        session,
        runtime,
        env: ENV,
        newSession,
        switchSession,
      }),
    );
    await pause(60);
    stdin.write("hello");
    stdin.write("\r");
    await waitFor(() => submit.mock.calls.length === 1);
    stdin.write(cmd);
    stdin.write("\r");
    await pause(100);
    expect(newSession).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("会话忙");
    finish("aborted");
    unmount();
    await session.close();
  });

  it("/new 切换等待中拒绝新提交", async () => {
    const { runtime, session } = await makeSession();
    let finish!: (value: { kind: "busy" }) => void;
    const newSession = vi.fn(
      () =>
        new Promise<{ kind: "busy" }>((resolve) => {
          finish = resolve;
        }),
    );
    const submit = vi.spyOn(session, "submit");
    const { stdin, lastFrame, unmount } = render(
      createElement(App, {
        session,
        runtime,
        env: ENV,
        newSession,
      }),
    );
    await pause(60);
    stdin.write("/new");
    stdin.write("\r");
    await waitFor(() => newSession.mock.calls.length === 1);
    stdin.write("must not submit");
    stdin.write("\r");
    await pause(80);
    expect(submit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("正在切换会话");
    finish({ kind: "busy" });
    await waitFor(() => !(lastFrame() ?? "").includes("正在切换会话"));
    unmount();
    await session.close();
  });

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

  it("权限框里 Shift+Tab（\\x1B[Z）反向移动焦点，不切思考档位", async () => {
    const pending: PendingPermission = {
      requestId: "p1",
      callId: "c1",
      toolName: "shell",
      subjects: [{ kind: "shell", target: "rm -rf x" }],
      reason: "需要确认",
      options: ["allow_once", "allow_session", "deny_stop"],
    };
    const reply = vi.fn();
    const { stdin, unmount } = render(
      inEnv(createElement(PermissionDialog, { pending, active: true, onReply: reply, width: 80 })),
    );
    await pause();
    // Shift+Tab：焦点 0 → 末位 deny_stop；Enter 激活 → 拒绝并停止
    stdin.write("\x1b[Z");
    await pause();
    stdin.write("\r");
    await pause();
    expect(reply).toHaveBeenCalledWith({ decision: "deny", stop: true });
    unmount();
  });

  it("Shift+Tab（\\x1B[Z）循环思考档位：状态栏档位段随之更新", async () => {
    const runtime = await createRuntime({
      cwd: tmp("nct-tui-ws-"),
      sessionsDir: tmp("nct-tui-sd-"),
      providers: [
        new FakeProvider({
          scripts: [],
          models: [
            {
              ref: { provider: "fake", model: "fake-1" },
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              capabilities: {
                toolCalls: true,
                parallelToolCalls: true,
                reasoning: "visible",
                imageInput: false,
                promptCache: false,
                reasoningEffort: ["low", "high"],
              },
            },
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("思考:off"));
    // 可用档位 [low, high]：off → low → high → off 循环
    expect(lastFrame()).toContain("思考:off");
    stdin.write("\x1b[Z");
    await waitFor(() => (lastFrame() ?? "").includes("思考:low"));
    expect(lastFrame()).toContain("思考:low");
    stdin.write("\x1b[Z");
    await waitFor(() => (lastFrame() ?? "").includes("思考:high"));
    expect(lastFrame()).toContain("思考:high");
    stdin.write("\x1b[Z");
    await waitFor(() => (lastFrame() ?? "").includes("思考:off"));
    expect(lastFrame()).toContain("思考:off");
    unmount();
    await session.close();
  });

  it("Turn 中 Shift+Tab 切档：状态栏显示 旧档→新档，Turn 结束后只剩新档", async () => {
    // wait 事件保留 Turn 进行中窗口，避免整例被固定等待耗尽。
    const runtime = await createRuntime({
      cwd: tmp("nct-tui-ws-"),
      sessionsDir: tmp("nct-tui-sd-"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "wait", ms: 500 },
              { type: "text_delta", text: "done" },
              { type: "finish", reason: "stop" },
            ],
          ],
          models: [
            {
              ref: { provider: "fake", model: "fake-1" },
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              capabilities: {
                toolCalls: true,
                parallelToolCalls: true,
                reasoning: "visible",
                imageInput: false,
                promptCache: false,
                reasoningEffort: ["low", "high"],
              },
            },
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("思考:off"));
    expect(lastFrame()).toContain("思考:off");
    // 提交后不 await：Turn 进行中
    const done = session.submit({ text: "长跑" });
    await waitFor(() => (lastFrame() ?? "").includes("长跑"));
    // 进行中 Shift+Tab：off → low，状态栏显示"旧档→新档"（ADR-0019）
    stdin.write("\x1b[Z");
    await waitFor(() => (lastFrame() ?? "").includes("思考:off→low"));
    expect(lastFrame()).toContain("思考:off→low");
    await done;
    await waitFor(
      () => (lastFrame() ?? "").includes("思考:low") && !(lastFrame() ?? "").includes("off→"),
    );
    // Turn 结束：只剩新档位
    expect(lastFrame()).toContain("思考:low");
    expect(lastFrame()).not.toContain("→");
    unmount();
    await session.close();
  });

  it("模型未声明可用档位：状态栏不显示档位段，Shift+Tab 不插入提示", async () => {
    const { session, runtime } = await makeSession(); // fake-model 未声明 reasoningEffort
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await pause(60);
    expect(lastFrame()).not.toContain("思考:");
    stdin.write("\x1b[Z");
    await pause(80);
    expect(lastFrame()).not.toContain("未声明可用思考档位");
    expect(lastFrame()).not.toContain("思考:");
    unmount();
    await session.close();
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

  it("全屏接管的 console 输出显示为对话区提示行，不压进输入行", async () => {
    const { runtime, session } = await makeSession();
    const target = { ...console } as Console;
    const cap = captureConsole(target);
    target.error("(node:9) TestWarning: early\n(Use `node --trace-warnings ...`)");
    const screen = render(
      createElement(App, { session, runtime, env: ENV, consoleLines: cap.lines }),
    );
    await waitFor(() => (screen.lastFrame() ?? "").includes("fake-model"));
    target.warn("late warning");
    await waitFor(() => (screen.lastFrame() ?? "").includes("! late warning"));
    const lines = (screen.lastFrame() ?? "").split("\n");
    expect(lines.some((l) => l.startsWith("! (node:9) TestWarning: early"))).toBe(true);
    expect(lines.some((l) => l.includes("trace-warnings"))).toBe(false);
    expect(lines.at(-1)).toContain("idle");
    screen.unmount();
    cap.restore();
    await session.close();
  });

  it("状态栏显示本会话累计缓存命中率，宽度不够时先去目录再去缓存", () => {
    const view = createSessionView();
    view.config.model = { provider: "fake", model: "m" };
    view.config.permissionPreset = "default";
    view.meta = {
      cwd: "Z:/some/fairly/long/workspace/path",
      workspaceRoot: "Z:/some",
      formatVersion: 1,
      nocturneVersion: "0.0.0",
    };
    const frameAt = (width: number) => {
      const { lastFrame, unmount } = render(
        inEnv(createElement(StatusBar, { view, width, context: { used: 1000, limit: 1_000_000 } })),
      );
      const frame = lastFrame() ?? "";
      unmount();
      return frame;
    };
    expect(frameAt(120)).toContain("缓存 0% • 0.1% / 1M");
    view.usage = { inputTokens: 40_000, outputTokens: 100, cacheReadTokens: 30_000 };
    const wide = frameAt(120);
    expect(wide).toContain("fairly");
    expect(wide).toContain("缓存 75% • 0.1% / 1M");
    const mid = frameAt(80);
    expect(mid).not.toContain("fairly");
    expect(mid).toContain("缓存 75% • 0.1% / 1M");
    const narrow = frameAt(42);
    expect(narrow).not.toContain("缓存");
    expect(narrow).toContain("0.1% / 1M");
    // 进行中 Turn：已写入的 assistant 消息用量即时计入，不等 turn.completed
    view.currentTurn = { turnId: "t2", turnIndex: 2 };
    view.entries = [
      {
        kind: "assistant",
        key: "a1",
        turnId: "t2",
        messageId: "m1",
        seq: 1,
        text: "",
        reasoning: "",
        toolCalls: [],
        model: { provider: "fake", model: "m" },
        usage: { inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 58_000 },
        finishReason: "tool_calls",
      },
    ];
    expect(frameAt(120)).toContain("缓存 88%");
  });

  it("窄于 40 列：状态栏保留任务进度，权限框隐藏原因", () => {
    const view = createSessionView();
    view.config.model = { provider: "fake", model: "long-model" };
    view.config.permissionPreset = "default";
    view.todos = [{ text: "第一步", status: "in_progress" }];
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
          createElement(StatusBar, { view, width: 32, context: { used: 0 } }),
        ),
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("idle");
    expect(frame).toContain("任务 0/1");
    expect(frame).not.toContain("很长的审批原因");
    expect(frame).not.toContain("long-model");
    expect(frame).not.toContain("default");
    unmount();
  });

  it("骨架：渲染会话 id 与状态栏；Ctrl+C 退出", async () => {
    const { session, runtime } = await makeSession();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("fake-model"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fake-model");
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
    await waitFor(() => (lastFrame() ?? "").includes("fake-1"));
    stdin.write(`/resume ${s2id}`); // 单 data 事件视为一次粘贴；回车单独发
    stdin.write("\r");
    await waitFor(
      () =>
        (lastFrame() ?? "").includes("已切换到会话") &&
        (lastFrame() ?? "").includes("来自 s2 的回答"),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已切换到会话");
    expect(frame).toContain("来自 s2 的回答"); // 新会话持久日志已重放
    unmount();
    await s1.close();
  });

  it("inline：/new 与 /clear 换入空会话，保留旧对话和分隔行", async () => {
    const { session, runtime } = await makeSession();
    const created: RuntimeSession[] = [];
    const newSession = vi.fn(async () => {
      const next = await runtime.createSession({ model: "fake/fake-model" });
      created.push(next);
      return { kind: "ok" as const, session: next };
    });
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, newSession, inline: true }),
    );
    await pause(60);
    // 每次切换等到分隔行出现且输入框解除「正在切换」再发下一条：
    // 固定间隔在系统计时器粒度粗（约 15.6ms）时不够，切换尚未完成就会被拒
    for (const [i, cmd] of ["/new", "/clear"].entries()) {
      stdin.write(cmd);
      stdin.write("\r");
      await vi.waitFor(
        () => {
          expect(created).toHaveLength(i + 1);
          const frame = lastFrame() ?? "";
          expect(frame).toContain(`新会话 ${created[i]?.id}`);
          expect(frame).not.toContain("正在切换会话");
        },
        { timeout: 3000, interval: 20 },
      );
    }
    expect(newSession).toHaveBeenCalledTimes(2);
    expect(lastFrame()).toContain(`新会话 ${created[0]?.id}`);
    expect(lastFrame()).toContain(`新会话 ${created[1]?.id}`);
    unmount();
    await session.close();
    for (const next of created) await next.close();
  });

  it("全屏：/new 视口换成新会话，欢迎区重现且翻阅清空", async () => {
    const runtime = await createRuntime({
      cwd: tmp("nct-tui-ws-"),
      sessionsDir: tmp("nct-tui-sd-"),
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: `${"甲\n".repeat(30)}旧回答` },
              { type: "finish", reason: "stop" },
            ],
            [
              { type: "text_delta", text: "新回答" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const created: RuntimeSession[] = [];
    const newSession = vi.fn(async () => {
      const next = await runtime.createSession({ model: "fake/fake-model" });
      created.push(next);
      return { kind: "ok" as const, session: next };
    });
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session, runtime, env: ENV, newSession }),
    );
    await pause(60);
    await session.submit({ text: "旧问题" });
    await waitFor(() => (lastFrame() ?? "").includes("旧回答"));
    stdin.write("\x1b[5~");
    await waitFor(() => (lastFrame() ?? "").includes("已向上翻阅"));
    stdin.write("/new");
    stdin.write("\r");
    await waitFor(() => created.length === 1);
    await waitFor(
      () => (lastFrame() ?? "").includes("Nocturne") && !(lastFrame() ?? "").includes("旧回答"),
    );
    const frame = lastFrame() ?? "";
    // 旧对话整体换出：欢迎区重新出现，翻阅提示与旧内容都不在
    expect(frame).toContain("Nocturne");
    expect(frame).not.toContain("旧回答");
    expect(frame).not.toContain("已向上翻阅");
    await created[0]?.submit({ text: "新问题" });
    await waitFor(() => (lastFrame() ?? "").includes("新回答"));
    unmount();
    await session.close();
    for (const next of created) await next.close();
  });

  it("/resume 列表只显示当前目录的会话", async () => {
    const sessionsDir = tmp("nct-tui-sd-");
    const mk = (cwd: string) =>
      createRuntime({ cwd, sessionsDir, providers: [new FakeProvider({ scripts: [] })] });
    const runtime = await mk(tmp("nct-tui-ws-"));
    const other = await mk(tmp("nct-tui-other-"));
    const s1 = await runtime.createSession({ model: "fake/fake-model" });
    const elsewhere = await other.createSession({ model: "fake/fake-model" });
    await elsewhere.close();
    const { lastFrame, stdin, unmount } = render(
      createElement(App, { session: s1, runtime, env: ENV, switchSession: vi.fn() }),
    );
    await pause(50);
    stdin.write("/resume");
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("切换到会话（当前目录）"));
    await waitFor(() => (lastFrame() ?? "").includes(s1.id));
    expect(lastFrame()).not.toContain(elsewhere.id);
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
    await waitFor(
      () => (lastFrame() ?? "").includes("切换到会话") && (lastFrame() ?? "").includes(s2id),
    );
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
    await waitFor(
      () => switcher.mock.calls.length > 0 && (lastFrame() ?? "").includes("已切换到会话"),
    );
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
    await waitFor(() => (lastFrame() ?? "").includes("fake/fake-1"));
    // 首帧出现后页面的按键订阅在 effect 里才挂上，留一点时间再打字
    await pause(100);
    const frame = lastFrame() ?? "";
    // 备用屏内渲染模型选择页：搜索框 + 模型行
    expect(frame).toContain("搜索");
    expect(frame).toContain("fake/fake-1");
    // 输入字符 → 搜索过滤
    stdin.write("zzz");
    await waitFor(() => (lastFrame() ?? "").includes("无匹配"));
    // Esc 清搜索 → 再 Esc 关闭回主屏
    stdin.write("\x1b");
    await waitFor(() => !(lastFrame() ?? "").includes("无匹配"));
    stdin.write("\x1b");
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    expect(lastFrame()).toContain("idle");
    unmount();
    await session.close();
  });

  it("/provider 无参打开全屏服务商页：预设列表 + 过滤 + Esc 返回", async () => {
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
    await waitFor(() => (lastFrame() ?? "").includes("○"));
    // 首帧出现后页面的按键订阅在 effect 里才挂上，留一点时间再打字
    await pause(100);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("服务商");
    expect(frame).toContain("过滤");
    // 未配置的预设服务商以 ○ 列出
    expect(frame).toContain("○");
    // 打字过滤 → 无匹配
    stdin.write("zzz");
    await waitFor(() => (lastFrame() ?? "").includes("无匹配"));
    // Esc 清过滤 → 再 Esc 关闭回主屏
    stdin.write("\x1b");
    await waitFor(() => !(lastFrame() ?? "").includes("无匹配"));
    stdin.write("\x1b");
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    expect(lastFrame()).toContain("idle");
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
