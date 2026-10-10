/**
 * SessionView reducer 测试（view.md §8）：场景矩阵 × {实时事件流, 仅持久事件重放}
 * 在收敛点断言重放等价（V1），另测不变量 V2–V8。
 * 事件序列由真实 Runtime + FakeProvider 驱动（真实发出顺序），完全离线。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, ProviderError, type FakeScript } from "../src/provider/index.js";
import type {
  DurableEvent,
  EphemeralEvent,
  McpServerPayload,
  PermissionRequestedPayload,
  RuntimeEvent,
  SessionView,
} from "../src/protocol/index.js";
import {
  createSessionView,
  reduceSessionView,
  replaySessionView,
  sessionUsageSoFar,
  type ToolEntry,
} from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";
import type * as platformModule from "../src/platform/platform.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const tmpRoots: string[] = [];
const processes = createProcessCleanup();
vi.mock("../src/platform/platform.js", async (original) => {
  const module = await original<typeof platformModule>();
  return { ...module, createPlatform: () => processes.platform(module.createPlatform()) };
});

afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
});

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

async function makeRuntime(
  scripts: FakeScript[],
  options?: { interactive?: boolean; preset?: string },
): Promise<{ runtime: Runtime; ws: string; provider: FakeProvider }> {
  const ws = makeTmpDir("nct-view-ws-");
  const sessionsDir = makeTmpDir("nct-view-sessions-");
  const provider = new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [provider],
    interactive: options?.interactive,
  });
  return { runtime, ws, provider };
}

const newSession = (runtime: Runtime, preset?: string) =>
  runtime.createSession({
    model: "fake/fake-model",
    ...(preset !== undefined ? { permissionPreset: preset } : {}),
  });

/** 实时路径：订阅事件流归约 */
function liveView(events: RuntimeEvent[]): SessionView {
  const view = createSessionView();
  for (const e of events) reduceSessionView(view, e);
  return view;
}

/** 收敛点重放等价（V1）：排除 revision、notices 与 mcpServers（view.md §6） */
function assertConvergedEqual(view: SessionView, durable: readonly DurableEvent[]): void {
  const replay = replaySessionView(durable);
  const strip = (v: SessionView) => {
    const { revision: _r, notices: _n, mcpServers: _m, ...rest } = v;
    return rest;
  };
  expect(strip(view)).toEqual(strip(replay));
}

/** V8：收敛点瞬态字段归零 */
function assertConverged(view: SessionView): void {
  expect(view.currentTurn).toBeUndefined();
  expect(view.pendingPermission).toBeUndefined();
  expect(view.live.assistants).toEqual([]);
  expect(view.live.tools).toEqual([]);
  expect(view.status).toBe("idle");
  expect(view.retry).toBeUndefined();
  for (const e of view.entries) {
    if (e.kind === "tool") expect(e.liveOutput).toBe("");
  }
}

/**
 * 订阅前已落盘的事件（session.created、恢复修复）客户端只能经 durableEvents()
 * 回放获得——这正是真实客户端路径：先回放日志，再订阅实时事件（view.md §6）。
 */
function collect(session: RuntimeSession): { pre: DurableEvent[]; events: RuntimeEvent[] } {
  const pre = [...session.durableEvents()];
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return { pre, events };
}

function viewFrom(
  session: RuntimeSession,
  pre: DurableEvent[],
  events: RuntimeEvent[],
): SessionView {
  const view = replaySessionView(pre);
  for (const e of events) reduceSessionView(view, e);
  return view;
}

const durableOf = (session: RuntimeSession) => session.durableEvents();

const toolEntries = (view: SessionView): ToolEntry[] =>
  view.entries.filter((e): e is ToolEntry => e.kind === "tool");

const V5 = (view: SessionView) =>
  expect(JSON.parse(JSON.stringify(view)) as SessionView).toEqual(
    JSON.parse(JSON.stringify(view)) as SessionView,
  );

describe("SessionView reducer", () => {
  it.each<["prune" | "summary", string]>([
    ["prune", "已省略较早的工具输出"],
    ["summary", "上下文已压缩为摘要"],
  ])("context.compacted(%s) 回执按种类写文案，payload 原样保留", (kind, text) => {
    const payload = { kind, throughSeq: 7 };
    const view = createSessionView();
    reduceSessionView(view, {
      type: "context.compacted",
      sessionId: "s",
      seq: 8,
      time: "2026-10-08T01:02:03.000Z",
      payload,
    } as DurableEvent);
    const notice = view.entries.find((entry) => entry.kind === "notice");
    expect(notice?.kind === "notice" && notice.message).toBe(text);
    expect(notice?.kind === "notice" && notice.payload).toEqual(payload);
  });

  it("助手条目时间来自持久事件，实时归约与重放确定一致", () => {
    const event: DurableEvent = {
      type: "message.assistant",
      sessionId: "s",
      turnId: "t",
      seq: 1,
      time: "2026-10-08T01:02:03.000Z",
      payload: {
        messageId: "m",
        content: [{ type: "text", text: "答" }],
        toolCalls: [],
        model: { provider: "fake", model: "m" },
        finishReason: "stop",
      },
    };
    const view = createSessionView();
    reduceSessionView(view, event);
    expect(view.entries[0]).toMatchObject({ kind: "assistant", time: event.time });
    expect(replaySessionView([event]).entries).toEqual(view.entries);
  });

  it("info 进度在 TUI 视图中逐条分行，stdout 半行继续拼接", () => {
    const view = createSessionView();
    reduceSessionView(view, {
      type: "tool.started",
      sessionId: "s",
      seq: 1,
      time: "",
      turnId: "t",
      payload: {
        callId: "c",
        name: "task",
        input: {},
        subjects: [],
        permission: { action: "allow", source: "rule" },
      },
    });
    const progress = (stream: "stdout" | "info", chunk: string) => {
      reduceSessionView(view, {
        type: "tool.progress",
        sessionId: "s",
        runId: "r",
        eseq: 1,
        afterSeq: 1,
        time: "",
        turnId: "t",
        payload: { callId: "c", stream, chunk },
      });
    };
    progress("stdout", "半");
    progress("stdout", "行");
    progress("info", "第 1 轮");
    progress("info", "read → ok");
    expect(toolEntries(view)[0]?.liveOutput).toBe("半行\n第 1 轮\nread → ok\n");
  });

  it("场景1：纯文本 Turn（text + reasoning delta）", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "reasoning_delta", text: "想一下" },
        { type: "text_delta", text: "你好，" },
        { type: "text_delta", text: "世界" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    expect(await session.submit({ text: "打个招呼" })).toBe("done");

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    expect(view.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
    const a = view.entries[1];
    expect(a?.kind === "assistant" && a.text).toBe("你好，世界");
    expect(a?.kind === "assistant" && a.reasoning).toBe("想一下");
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(view.lastTurn?.reason).toBe("done");
    expect(view.turnCount).toBe(1);
    assertConvergedEqual(view, durableOf(session));
    V5(view);
    await session.close();
  });

  it("sessionUsageSoFar：进行中 Turn 每步结束即计入，不等 turn.completed", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "text_delta", text: "一" },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 50 } },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "tool_call", toolCallId: "c1", name: "read", input: { path: "missing.txt" } },
        { type: "usage", usage: { inputTokens: 1000, outputTokens: 2, cacheReadTokens: 900 } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "二" },
        { type: "usage", usage: { inputTokens: 2000, outputTokens: 3, cacheReadTokens: 1900 } },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await newSession(runtime);
    const view = replaySessionView([...session.durableEvents()]);
    const seen: { type: string; usage: ReturnType<typeof sessionUsageSoFar> }[] = [];
    session.subscribe((e) => {
      reduceSessionView(view, e);
      seen.push({ type: e.type, usage: sessionUsageSoFar(view) });
    });
    expect(sessionUsageSoFar(view)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(await session.submit({ text: "第一轮" })).toBe("done");
    seen.length = 0;
    expect(await session.submit({ text: "第二轮" })).toBe("done");

    // 第二轮第一步写入后、Turn 结束前：上一轮累计 + 本步用量
    const firstStep = seen.findIndex((s) => s.type === "message.assistant");
    const completed = seen.findIndex((s) => s.type === "turn.completed");
    expect(firstStep).toBeGreaterThanOrEqual(0);
    expect(firstStep).toBeLessThan(completed);
    expect(seen[firstStep]?.usage).toEqual({
      inputTokens: 1100,
      outputTokens: 3,
      cacheReadTokens: 950,
    });
    // Turn 结束后就是 view.usage
    expect(sessionUsageSoFar(view)).toBe(view.usage);
    expect(view.usage).toEqual({ inputTokens: 3100, outputTokens: 6, cacheReadTokens: 2850 });
    await session.close();
  });

  it("场景2：工具调用 ask→允许（input.delta → requested → resolved → started → progress → completed）", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          { type: "tool_call_delta", toolCallId: "p1", name: "shell", argsDelta: '{"command":"ec' },
          { type: "tool_call_delta", toolCallId: "p1", name: "shell", argsDelta: 'ho hi"}' },
          { type: "tool_call", toolCallId: "p1", name: "shell" },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "已执行" },
          { type: "finish", reason: "stop" },
        ],
      ],
      { interactive: true },
    );
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, { decision: "allow" });
      }
    });

    expect(await session.submit({ text: "echo" })).toBe("done");

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    const tool = toolEntries(view)[0];
    expect(tool?.status).toBe("ok");
    expect(tool?.name).toBe("shell");
    expect(tool?.permission?.source).toBe("user");
    expect(tool?.result?.modelContent).toContain("exit code 0");
    // 运行期 stdout 经 progress 进入 liveOutput，完结后清空（exit code 见 output）
    expect((tool?.result?.output as { exitCode?: number })?.exitCode).toBe(0);
    // 进度事件确实发出过且已清空
    expect(events.some((e) => e.type === "tool.progress")).toBe(true);
    expect(tool?.liveOutput).toBe("");
    // 权限 notice 条目存在
    const notice = view.entries.find((e) => e.kind === "notice" && e.subtype === "permission");
    expect(notice?.kind === "notice" && notice.message).toContain("allow");
    assertConvergedEqual(view, durableOf(session));
    V5(view);
    await session.close();
  });

  it("场景3：规则拒绝（无 requested/started；resolved → completed(denied)）", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          {
            type: "tool_call",
            toolCallId: "p1",
            name: "edit",
            input: { path: "a.txt", old: "o", new: "x" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      { interactive: true },
    );
    // read-only 预设：edit 由规则直接拒绝
    const session = await newSession(runtime, "read-only");
    const { pre, events } = collect(session);
    await session.submit({ text: "改文件" });

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    const tool = toolEntries(view)[0];
    expect(tool?.status).toBe("denied");
    expect(tool?.resolution?.source).toBe("rule");
    expect(tool?.result?.status).toBe("denied");
    assertConvergedEqual(view, durableOf(session));
    await session.close();
  });

  it("场景4：ask 拒绝 d（带反馈）", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "p1", name: "shell", input: { command: "echo hi" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      { interactive: true },
    );
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, {
          decision: "deny",
          feedback: "别删这个目录",
        });
      }
    });
    await session.submit({ text: "清理" });

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    const tool = toolEntries(view)[0];
    expect(tool?.status).toBe("denied");
    expect(tool?.resolution?.action).toBe("deny");
    expect(tool?.resolution?.feedback).toBe("别删这个目录");
    const notice = view.entries.find((e) => e.kind === "notice" && e.subtype === "permission");
    expect(notice?.kind === "notice" && notice.message).toContain("deny");
    assertConvergedEqual(view, durableOf(session));
    await session.close();
  });

  it("场景5：ask 拒绝并停止 x（completed(denied) → turn.completed(aborted)）", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "p1", name: "shell", input: { command: "echo a" } },
          { type: "tool_call", toolCallId: "p2", name: "shell", input: { command: "echo b" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      { interactive: true },
    );
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, { decision: "deny", stop: true });
      }
    });
    expect(await session.submit({ text: "两步" })).toBe("aborted");

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    expect(view.lastTurn?.reason).toBe("aborted");
    // 第二个调用（p2）未执行：Turn 收尾补 completed(cancelled)
    const tools = toolEntries(view);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.status).toBe("denied");
    expect(tools[1]?.status).toBe("cancelled");
    assertConvergedEqual(view, durableOf(session));
    await session.close();
  });

  it("场景6：实时中断（ask 等待中 Ctrl+C → resolved(cancelled) → completed(cancelled) → aborted）", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "p1", name: "shell", input: { command: "echo a" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      { interactive: true },
    );
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") session.interrupt();
    });
    expect(await session.submit({ text: "跑一下" })).toBe("aborted");

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    const tool = toolEntries(view)[0];
    expect(tool?.status).toBe("cancelled");
    expect(tool?.resolution?.source).toBe("cancelled");
    expect(view.lastTurn?.reason).toBe("aborted");
    assertConvergedEqual(view, durableOf(session));
    await session.close();
  });

  it("场景7：进程在 ask 等待中被杀 → 恢复补写 interrupted + process_exited", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "p1", name: "shell", input: { command: "echo a" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      { interactive: true },
    );
    const session = await newSession(runtime);
    const submitDone = session.submit({ text: "跑一下" });
    void submitDone.catch(() => undefined);
    // 等 requested 落盘后模拟崩溃：直接关底层 Session（不写 resolved，不放回 gate）
    await new Promise<void>((resolve) => {
      session.subscribe((e) => {
        if (e.type === "permission.requested") resolve();
      });
    });
    await internalSession(session).close();
    // 提交 Promise 悬挂（gate 无回复）；不等待

    const restored = await runtime.resumeSession(session.id);
    const { events: events2 } = collect(restored);
    const view = replaySessionView(restored.durableEvents());
    assertConverged(view);
    const tool = toolEntries(view)[0];
    expect(tool?.status).toBe("interrupted");
    const turnEnd = view.entries.find((e) => e.kind === "notice" && e.subtype === "turn_end");
    expect(turnEnd?.kind === "notice" && turnEnd.message).toContain("进程退出");
    expect(view.lastTurn?.recovered).toBe(true);
    expect(view.lastTurn?.reason).toBe("error");
    assertConvergedEqual(view, durableOf(restored));
    expect(events2.length).toBe(0); // 修复事件已在日志中，订阅无新增
    await restored.close();
  });

  it("场景8：多轮 + config_changed + context.compacted", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "text_delta", text: "一" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", text: "二" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    await session.submit({ text: "第一轮" });
    await session.setModel("fake/fake-1");
    // 直接发持久事件构造压缩记录（压缩本身在别处测试）
    await internalSession(session).emit(
      "context.compacted",
      { kind: "summary", throughSeq: 3, summary: "早期内容摘要" },
      {},
    );
    await session.submit({ text: "第二轮" });

    const view = viewFrom(session, pre, events);
    assertConverged(view);
    expect(view.turnCount).toBe(2);
    expect(view.entries.filter((e) => e.kind === "assistant")).toHaveLength(2);
    const cfg = view.entries.find((e) => e.kind === "notice" && e.subtype === "config");
    const compacted = view.entries.find((e) => e.kind === "notice" && e.subtype === "compacted");
    expect(cfg).toBeDefined();
    expect(compacted?.kind === "notice" && compacted.message).toBe("上下文已压缩为摘要");
    assertConvergedEqual(view, durableOf(session));
    V5(view);
    await session.close();
  });

  it("场景9：provider.retry → retrying → 成功", async () => {
    const { runtime } = await makeRuntime([
      [
        {
          type: "throw",
          error: new ProviderError({ kind: "overloaded", message: "busy", retryAfterMs: 1 }),
        },
      ],
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await newSession(runtime);
    const { pre, events } = collect(session);
    expect(await session.submit({ text: "重试" })).toBe("done");

    expect(events.some((e) => e.type === "provider.retry")).toBe(true);
    const view = viewFrom(session, pre, events);
    assertConverged(view);
    assertConvergedEqual(view, durableOf(session));
    await session.close();
  });

  it("V1 顺序专项：live 序列按真实发出顺序（input.delta 早、resolved 早于 started）与重放一致", async () => {
    // 场景2 已覆盖 ask 顺序；这里补规则拒绝 + 手工乱序
    const { runtime } = await makeRuntime(
      [
        [
          {
            type: "tool_call_delta",
            toolCallId: "p1",
            name: "edit",
            argsDelta: '{"path":"a.txt","old":"o","new":"x"}',
          },
          { type: "tool_call", toolCallId: "p1", name: "edit" },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      { interactive: true },
    );
    const session = await newSession(runtime, "read-only");
    const { pre, events } = collect(session);
    await session.submit({ text: "改" });
    const view = viewFrom(session, pre, events);
    assertConverged(view);
    assertConvergedEqual(view, durableOf(session));
    // 规则拒绝路径：entries 中 notice 在 tool 之前（resolved 先于 completed）
    const kinds = view.entries.map((e) => e.kind);
    const noticeIdx = kinds.indexOf("notice");
    const toolIdx = kinds.indexOf("tool");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(noticeIdx);
    await session.close();
  });

  // ── 手工序列：不变量 ─────────────────────────────────────

  it("乱序容差：tool.completed 先于 tool.started 到达", () => {
    const view = createSessionView();
    const mk = (seq: number, type: DurableEvent["type"], payload: unknown, turnId = "turn-1-x") =>
      ({
        type,
        sessionId: "s",
        seq,
        time: "2026-09-24T00:00:00Z",
        turnId,
        payload,
      }) as DurableEvent;
    reduceSessionView(view, mk(1, "turn.started", { turnIndex: 1 }));
    reduceSessionView(
      view,
      mk(2, "tool.completed", { callId: "c1", name: "read", status: "ok", modelContent: "r" }),
    );
    reduceSessionView(
      view,
      mk(3, "tool.started", {
        callId: "c1",
        name: "read",
        input: { path: "a" },
        subjects: [],
        permission: { action: "allow", source: "rule" },
      }),
    );
    reduceSessionView(
      view,
      mk(4, "turn.completed", {
        reason: "done",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const tool = toolEntries(view)[0];
    expect(tool?.result?.status).toBe("ok");
    expect(tool?.permission?.source).toBe("rule"); // started 后至仍回填 permission
    assertConverged(view);
  });

  it("未知事件类型被忽略，revision 仍递增（V7）", () => {
    const view = createSessionView();
    reduceSessionView(view, {
      type: "future.event",
      sessionId: "s",
      seq: 1,
      time: "t",
      payload: {},
    } as unknown as RuntimeEvent);
    reduceSessionView(view, {
      type: "future.eph",
      sessionId: "s",
      runId: "r",
      eseq: 1,
      afterSeq: 0,
      time: "t",
      payload: {},
    } as unknown as RuntimeEvent);
    expect(view.revision).toBe(2);
    expect(view.entries).toEqual([]);
  });

  it("确定性（V6）：同一序列归约两次结果相等", () => {
    const events: RuntimeEvent[] = [
      {
        type: "session.created",
        sessionId: "s",
        seq: 1,
        time: "t",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0",
          cwd: "/w",
          workspaceRoot: "/w",
          model: { provider: "fake", model: "m" },
          permissionPreset: "default",
        },
      },
      {
        type: "tool.input.delta",
        sessionId: "s",
        runId: "r",
        eseq: 1,
        afterSeq: 1,
        time: "t",
        turnId: "turn-1",
        payload: { callId: "c1", name: "read", delta: '{"path":"a"}' },
      },
      {
        type: "turn.completed",
        sessionId: "s",
        seq: 2,
        time: "t",
        turnId: "turn-1",
        payload: { reason: "aborted", steps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
      },
    ];
    const a = liveView(events);
    const b = liveView(events);
    expect(a).toEqual(b);
    // live 孤儿被 turn.completed 清空（V8 在此序列下也成立）
    expect(a.live.tools).toEqual([]);
    assertConverged(a);
  });

  it("live 条目在持久落点到达时晋升并丢弃流式字段", () => {
    const view = createSessionView();
    const eph = (
      eseq: number,
      type: EphemeralEvent["type"],
      payload: unknown,
      afterSeq = 0,
      turnId = "turn-1",
    ) =>
      ({
        type,
        sessionId: "s",
        runId: "r",
        eseq,
        afterSeq,
        time: "t",
        turnId,
        payload,
      }) as EphemeralEvent;
    const dur = (seq: number, type: DurableEvent["type"], payload: unknown, turnId = "turn-1") =>
      ({
        type,
        sessionId: "s",
        seq,
        time: "t",
        turnId,
        payload,
      }) as DurableEvent;

    reduceSessionView(
      view,
      eph(1, "tool.input.delta", { callId: "c1", name: "shell", delta: "{}" }),
    );
    expect(view.live.tools).toHaveLength(1);
    expect(view.entries).toHaveLength(0);
    reduceSessionView(
      view,
      dur(1, "permission.requested", {
        requestId: "perm-1",
        callId: "c1",
        subjects: [{ kind: "shell", target: "echo" }],
        reason: "r",
        options: ["allow_once", "deny"],
      } satisfies PermissionRequestedPayload),
    );
    expect(view.live.tools).toHaveLength(0);
    expect(view.pendingPermission?.requestId).toBe("perm-1");
    const tool = toolEntries(view)[0];
    expect(tool?.status).toBe("awaiting_permission");
    expect(tool?.name).toBe("shell");
    // 收敛断言不成立（Turn 未闭合）——pendingPermission 非空即非收敛点
    expect(view.pendingPermission).toBeDefined();
  });

  it("图片附件引用进入 user / tool 视图条目；无附件时键不出现（ADR-0023）", () => {
    const att = {
      type: "image" as const,
      file: "img-1.png",
      mimeType: "image/png" as const,
      bytes: 29,
      sha256: "ab".repeat(32),
      source: "read" as const,
    };
    const view = createSessionView();
    const dur = (seq: number, type: DurableEvent["type"], payload: unknown, turnId = "t1") =>
      ({ type, sessionId: "s", seq, time: "t", turnId, payload }) as DurableEvent;
    reduceSessionView(
      view,
      dur(1, "message.user", {
        messageId: "m1",
        content: [{ type: "text", text: "看图" }],
        attachments: [att],
      }),
    );
    reduceSessionView(
      view,
      dur(2, "tool.completed", {
        callId: "c1",
        name: "read",
        status: "ok",
        modelContent: "x",
        attachments: [att],
      }),
    );
    reduceSessionView(
      view,
      dur(3, "message.user", { messageId: "m2", content: [{ type: "text", text: "无图" }] }),
    );
    const [u1, tool, u2] = view.entries;
    expect(u1?.kind === "user" && u1.attachments?.[0]?.file).toBe("img-1.png");
    expect(tool?.kind === "tool" && tool.result?.attachments?.[0]?.sha256).toBe(att.sha256);
    expect(u2?.kind === "user" && "attachments" in u2).toBe(false);
    // 只含引用的视图可 JSON 序列化（字节从未进入事件）
    expect(() => JSON.stringify(view)).not.toThrow();
  });
});

it("审查持久重放保留工具理由与待确认理由，started 不覆盖审查", () => {
  const review = {
    callId: "c-review",
    backend: "model",
    model: { provider: "fake", model: "fake-1" },
    verdict: "unsure" as const,
    reason: "用户意图不明确",
    durationMs: 12,
    cached: false,
  };
  const events: DurableEvent[] = [
    {
      type: "permission.reviewed",
      sessionId: "s",
      seq: 1,
      time: "t",
      turnId: "turn-1",
      payload: review,
    },
    {
      type: "permission.requested",
      sessionId: "s",
      seq: 2,
      time: "t",
      turnId: "turn-1",
      payload: {
        callId: "c-review",
        requestId: "r-review",
        subjects: [{ kind: "edit", target: "/outside.txt", where: "outside" }],
        reason: "审查：拿不准 — 用户意图不明确",
        options: ["allow_once", "deny", "deny_stop"],
      },
    },
  ];
  const view = liveView(events);
  expect(view.pendingPermission?.review).toEqual(review);
  expect(toolEntries(view)[0]?.review).toEqual(review);
  expect(replaySessionView(events).pendingPermission?.review).toEqual(review);
  events.push(
    {
      type: "permission.resolved",
      sessionId: "s",
      seq: 3,
      time: "t",
      payload: { callId: "c-review", requestId: "r-review", action: "allow", source: "user" },
    },
    {
      type: "tool.started",
      sessionId: "s",
      seq: 4,
      time: "t",
      turnId: "turn-1",
      payload: {
        callId: "c-review",
        name: "write",
        input: {},
        subjects: [],
        permission: { action: "allow", source: "user" },
      },
    },
  );
  const replay = replaySessionView(events);
  expect(replay.pendingPermission).toBeUndefined();
  expect(toolEntries(replay)[0]).toMatchObject({ status: "running", review });
});

it("mcp.server 的 starting、ready、failed 都不产生 notice", () => {
  const view = createSessionView();
  const states = ["starting", "ready", "failed"] as const;
  for (const state of states) {
    reduceSessionView(view, {
      type: "mcp.server",
      sessionId: "s",
      runId: "r",
      eseq: states.indexOf(state) + 1,
      afterSeq: 0,
      time: "t",
      payload: {
        name: "exa",
        state,
        toolCount: 2,
        ...(state === "failed" ? { error: "连接失败" } : {}),
      },
    });
  }
  expect(view.notices).toEqual([]);
});

it("审查器结算不再追加权限提示，用户结算照常追加", () => {
  const resolved = (callId: string, source: "reviewer" | "user"): DurableEvent => ({
    type: "permission.resolved",
    sessionId: "s",
    seq: source === "reviewer" ? 1 : 2,
    time: "t",
    payload: { callId, action: "allow", source },
  });
  const events = [resolved("c-auto", "reviewer"), resolved("c-user", "user")];
  for (const view of [liveView(events), replaySessionView(events)]) {
    const notices = view.entries.filter((e) => e.kind === "notice" && e.subtype === "permission");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind === "notice" && notices[0].message).toContain("user");
  }
});

function mcpEvent(eseq: number, payload: McpServerPayload): RuntimeEvent {
  return { type: "mcp.server", sessionId: "s", runId: "r", eseq, afterSeq: 0, time: "t", payload };
}

it("mcp.server 归约进 mcpServers：同名以最新事件为准，stopped 移除", () => {
  const view = createSessionView();
  reduceSessionView(view, mcpEvent(1, { name: "exa", state: "starting" }));
  reduceSessionView(view, mcpEvent(2, { name: "neo", state: "starting" }));
  reduceSessionView(view, mcpEvent(3, { name: "neo", state: "failed", error: "连接失败" }));
  reduceSessionView(view, mcpEvent(4, { name: "exa", state: "ready", toolCount: 2 }));
  expect(view.mcpServers).toEqual({
    exa: { state: "ready", toolCount: 2 },
    neo: { state: "failed", error: "连接失败" },
  });
  // 恢复为 ready 时不残留旧的错误原因
  reduceSessionView(view, mcpEvent(5, { name: "neo", state: "ready", toolCount: 1 }));
  expect(view.mcpServers.neo).toEqual({ state: "ready", toolCount: 1 });
  reduceSessionView(view, mcpEvent(6, { name: "exa", state: "stopped" }));
  expect(Object.keys(view.mcpServers)).toEqual(["neo"]);
});

it("mcpServers 是临时状态：持久重放不产生，不参与重放等价", () => {
  const durable: DurableEvent[] = [
    {
      type: "permission.resolved",
      sessionId: "s",
      seq: 1,
      time: "t",
      payload: { callId: "c", action: "allow", source: "user" },
    },
  ];
  const view = liveView([mcpEvent(1, { name: "neo", state: "failed", error: "x" }), ...durable]);
  expect(view.mcpServers).toEqual({ neo: { state: "failed", error: "x" } });
  expect(replaySessionView(durable).mcpServers).toEqual({});
  assertConvergedEqual(view, durable);
});
