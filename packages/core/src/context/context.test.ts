import { describe, expect, it } from "vitest";

import type { DurableEvent, HistoryEntry } from "../protocol/index.js";
import type { ModelInfo } from "../provider/index.js";
import {
  buildContext,
  buildSummaryRequest,
  chooseSummaryBoundary,
  closedBoundaries,
  estimateTokens,
  renderTranscript,
} from "./index.js";
import type { BuildContextInput } from "./index.js";

const model: ModelInfo = {
  ref: { provider: "test", model: "m1" },
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  capabilities: {
    toolCalls: true,
    parallelToolCalls: true,
    reasoning: "none",
    imageInput: false,
    promptCache: false,
  },
};

const baseInput = (over: Partial<BuildContextInput> = {}): BuildContextInput => ({
  history: [],
  model,
  tools: [
    {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object" },
    },
  ],
  instructions: { project: [] },
  environment: {
    os: "Windows 11",
    shell: "pwsh",
    cwd: "C:\\ws",
    workspaceRoot: "C:\\ws",
    sessionDate: "2025-01-01",
  },
  ...over,
});

describe("buildContext", () => {
  it("组装顺序：system → tools → instructions → environment → history", () => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 2,
        turnId: "t1",
        messageId: "m1",
        content: [{ type: "text", text: "你好" }],
      },
    ];
    const built = buildContext(
      baseInput({
        history,
        instructions: {
          user: { source: "HOME/AGENTS.md", content: "user rule" },
          project: [{ source: "ws/AGENTS.md", content: "project rule" }],
        },
      }),
    );
    expect(built.request.system).toHaveLength(3); // base + instructions + env
    expect(built.request.system[1]?.text).toContain("user rule");
    expect(built.request.system[1]?.text).toContain("project rule");
    expect(built.request.system[2]?.text).toContain("C:\\ws");
    expect(built.request.messages).toHaveLength(1);
    expect(built.request.messages[0]?.role).toBe("user");
    expect(built.request.tools).toHaveLength(1);
    expect(built.request.model).toBe("m1");
    const names = built.report.sections.map((s) => s.name);
    expect(names).toEqual(["system", "tools", "instructions", "environment", "history"]);
  });

  it("assistant + tool 条目转为成对消息", () => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t",
        messageId: "u1",
        content: [{ type: "text", text: "read a" }],
      },
      {
        kind: "assistant",
        seq: 2,
        turnId: "t",
        messageId: "a1",
        model: { provider: "test", model: "m1" },
        content: [{ type: "text", text: "ok" }],
        toolCalls: [{ callId: "c1", name: "read", input: { path: "a" } }],
        usage: undefined,
        finishReason: "tool_calls",
      },
      {
        kind: "tool",
        seq: 3,
        turnId: "t",
        callId: "c1",
        name: "read",
        status: "ok",
        modelContent: "1|content",
      },
    ];
    const built = buildContext(baseInput({ history }));
    expect(built.request.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const toolMsg = built.request.messages[2];
    expect(toolMsg?.role === "tool" && toolMsg.callId).toBe("c1");
    expect(toolMsg?.role === "tool" && toolMsg.isError).toBe(false);
  });

  it("工具失败结果标记 isError", () => {
    const history: HistoryEntry[] = [
      {
        kind: "tool",
        seq: 1,
        turnId: "t",
        callId: "c1",
        name: "read",
        status: "denied",
        modelContent: "denied",
      },
    ];
    const built = buildContext(baseInput({ history }));
    const toolMsg = built.request.messages[0];
    expect(toolMsg?.role === "tool" && toolMsg.isError).toBe(true);
  });

  it("跨 Provider 切换时丢弃含 providerData 的推理块", () => {
    const history: HistoryEntry[] = [
      {
        kind: "assistant",
        seq: 1,
        turnId: "t",
        messageId: "a1",
        model: { provider: "other", model: "x" },
        content: [
          { type: "reasoning", text: "r", providerData: { sig: 1 } },
          { type: "text", text: "answer" },
        ],
        toolCalls: [],
        usage: undefined,
        finishReason: "stop",
      },
    ];
    const built = buildContext(baseInput({ history }));
    const msg = built.request.messages[0];
    if (msg?.role === "assistant") {
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0]?.type).toBe("text");
    }
  });

  it("预算：contextWindow − min(maxOutput,16k) − 余量；超预算 → overBudget+mustCompact", () => {
    const huge = "x".repeat(400_000);
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t",
        messageId: "u",
        content: [{ type: "text", text: huge }],
      },
    ];
    const built = buildContext(baseInput({ history }));
    expect(built.report.budgetTokens).toBe(100_000 - 8_000 - 1_024);
    expect(built.overBudget).toBe(true);
    expect(built.mustCompact).toBe(true);

    const ok = buildContext(baseInput({ history: [] }));
    expect(ok.overBudget).toBe(false);
    expect(ok.mustCompact).toBe(false);
  });

  it("ContextReport 记录各部分来源与估算", () => {
    const built = buildContext(baseInput());
    expect(built.report.estimatedTokens).toBeGreaterThan(0);
    expect(built.report.budgetTokens).toBeGreaterThan(0);
    const tools = built.report.sections.find((s) => s.name === "tools");
    expect(tools?.source).toContain("1 tools");
  });

  it("pendingMessages 追加在历史之后", () => {
    const built = buildContext(
      baseInput({
        pendingMessages: [{ role: "user", content: [{ type: "text", text: "pending" }] }],
      }),
    );
    expect(built.request.messages.at(-1)?.role).toBe("user");
  });
});

describe("estimateTokens", () => {
  it("字符数 / 4 向上取整", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});

/** 构造持久化事件的简便助手（字段只填断言所需的） */
function ev(
  seq: number,
  type: DurableEvent["type"],
  payload: Record<string, unknown>,
): DurableEvent {
  return {
    type,
    sessionId: "s",
    seq,
    time: "t",
    payload,
  } as unknown as DurableEvent;
}

describe("压缩边界与有效历史（context.md 6.3/6.4）", () => {
  const toolEntry = (seq: number, content: string): HistoryEntry => ({
    kind: "tool",
    seq,
    turnId: "t",
    callId: `c${seq}`,
    name: "read",
    status: "ok",
    modelContent: content,
    inputSummary: "path=a.txt",
  });
  const assistantEntry = (seq: number, callIds: string[] = []): HistoryEntry => ({
    kind: "assistant",
    seq,
    turnId: "t",
    messageId: `a${seq}`,
    model: { provider: "test", model: "m1" },
    content: [{ type: "text", text: "ok" }],
    toolCalls: callIds.map((callId) => ({ callId, name: "read" })),
    usage: undefined,
    finishReason: callIds.length > 0 ? "tool_calls" : "stop",
  });

  it("closedBoundaries：turn.completed 与全部结算的 tool.completed", () => {
    const events = [
      ev(1, "session.created", {}),
      ev(2, "turn.started", { turnIndex: 1 }),
      ev(3, "message.assistant", { toolCalls: [{ callId: "c1" }, { callId: "c2" }] }),
      ev(4, "tool.completed", { callId: "c1" }), // 仍有未结算调用，不是边界
      ev(5, "tool.completed", { callId: "c2" }), // 全部结算 → 边界
      ev(6, "turn.completed", {}),
      ev(7, "turn.started", { turnIndex: 2 }),
    ];
    expect(closedBoundaries(events)).toEqual([5, 6]);
  });

  it("prune：throughSeq 及之前的工具结果替换为占位说明", () => {
    const history: HistoryEntry[] = [
      toolEntry(3, "x".repeat(5000)),
      {
        kind: "compaction",
        seq: 4,
        turnId: "t",
        compactKind: "prune",
        throughSeq: 3,
        summary: undefined,
      },
      toolEntry(5, "新结果"),
    ];
    const built = buildContext(baseInput({ history }));
    const msgs = built.request.messages.filter((m) => m.role === "tool");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role === "tool" && msgs[0].content).toContain("输出已省略");
    expect(msgs[0]?.role === "tool" && msgs[0].content).toContain("path=a.txt");
    expect(msgs[1]?.role === "tool" && msgs[1].content).toBe("新结果");
  });

  it("summary：throughSeq 及之前的条目被丢弃，摘要文本成为历史首条", () => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t",
        messageId: "u",
        content: [{ type: "text", text: "旧输入" }],
      },
      toolEntry(2, "旧结果"),
      {
        kind: "compaction",
        seq: 3,
        turnId: undefined,
        compactKind: "summary",
        throughSeq: 2,
        summary: "此前进展摘要",
      },
      toolEntry(4, "新结果"),
    ];
    const built = buildContext(baseInput({ history }));
    const msgs = built.request.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role === "user" && JSON.stringify(msgs[0].content)).toContain("此前进展摘要");
    expect(JSON.stringify(msgs)).not.toContain("旧输入");
    expect(JSON.stringify(msgs)).not.toContain("旧结果");
  });

  it("最新摘要之后的新修剪才生效；摘要前的修剪被忽略", () => {
    const history: HistoryEntry[] = [
      toolEntry(1, "A"),
      {
        kind: "compaction",
        seq: 2,
        turnId: "t",
        compactKind: "prune",
        throughSeq: 1,
        summary: undefined,
      },
      {
        kind: "compaction",
        seq: 3,
        turnId: undefined,
        compactKind: "summary",
        throughSeq: 2,
        summary: "S",
      },
      toolEntry(4, "B"),
      {
        kind: "compaction",
        seq: 5,
        turnId: "t",
        compactKind: "prune",
        throughSeq: 4,
        summary: undefined,
      },
      toolEntry(6, "C"),
    ];
    const built = buildContext(baseInput({ history }));
    const text = JSON.stringify(built.request.messages);
    expect(text).not.toContain('"A"'); // 被摘要覆盖
    expect(text).toContain("输出已省略"); // seq4 被新修剪占位
    expect(text).toContain('"C"'); // 修剪截止之后的结果正常呈现
  });

  it("超过 80% 阈值且存在新边界 → 给出 prune 计划", () => {
    // 预算 8000-256-1024=6720，阈值 5376；构造 ~6000 token 的历史
    const big = "x".repeat(22_000);
    const history: HistoryEntry[] = [assistantEntry(2, ["c3"]), toolEntry(3, big)];
    const events = [
      ev(1, "session.created", {}),
      ev(2, "message.assistant", { toolCalls: [{ callId: "c3" }] }),
      ev(3, "tool.completed", { callId: "c3" }),
    ];
    const built = buildContext(
      baseInput({
        history,
        events,
        model: { ...model, contextWindow: 8_000, maxOutputTokens: 256 },
      }),
    );
    expect(built.compaction).toEqual({ kind: "prune", throughSeq: 3 });
    expect(built.overBudget).toBe(false);
    expect(built.mustCompact).toBe(false);
  });

  it("无 events 输入时不产生压缩计划", () => {
    const big = "x".repeat(400_000);
    const built = buildContext(baseInput({ history: [toolEntry(1, big)] }));
    expect(built.compaction).toBeUndefined();
    expect(built.mustCompact).toBe(true);
  });
});

describe("L2 摘要请求（context.md 6.2/6.6）", () => {
  const hist: HistoryEntry[] = [
    {
      kind: "user",
      seq: 1,
      turnId: "t",
      messageId: "u",
      content: [{ type: "text", text: "目标：修 bug" }],
    },
    {
      kind: "tool",
      seq: 2,
      turnId: "t",
      callId: "c",
      name: "read",
      status: "ok",
      modelContent: "file body",
    },
  ];
  const events = [
    ev(1, "session.created", {}),
    ev(2, "turn.started", {}),
    ev(3, "turn.completed", {}),
  ];

  it("buildSummaryRequest：转录 + 指令，maxOutput 有上限，不带工具", () => {
    const req = buildSummaryRequest({ history: hist, model, throughSeq: 3 });
    expect(req.tools).toHaveLength(0);
    expect(req.maxOutputTokens).toBeLessThanOrEqual(4_000);
    const user = req.messages.find((m) => m.role === "user");
    expect(user && JSON.stringify(user.content)).toContain("目标：修 bug");
    expect(user && JSON.stringify(user.content)).toContain("file body");
  });

  it("chooseSummaryBoundary：装得进窗口时取最近边界，装不下向前回退", () => {
    expect(chooseSummaryBoundary(events, hist, model)).toBe(3);
    // 极小窗口：任何边界都装不下
    const tiny = { ...model, contextWindow: 100, maxOutputTokens: 50 };
    expect(chooseSummaryBoundary(events, hist, tiny)).toBeUndefined();
    // 空历史无边界
    expect(chooseSummaryBoundary([], [], model)).toBeUndefined();
  });

  it("renderTranscript：摘要事件渲染为 [会话历史摘要] 段", () => {
    const withSummary: HistoryEntry[] = [
      ...hist,
      {
        kind: "compaction",
        seq: 3,
        turnId: undefined,
        compactKind: "summary",
        throughSeq: 2,
        summary: "旧摘要",
      },
      {
        kind: "user",
        seq: 4,
        turnId: "t",
        messageId: "u2",
        content: [{ type: "text", text: "新输入" }],
      },
    ];
    const text = renderTranscript(withSummary, "test");
    expect(text).toContain("会话历史摘要");
    expect(text).toContain("旧摘要");
    expect(text).not.toContain("目标：修 bug"); // 被摘要覆盖
    expect(text).toContain("新输入");
  });
});

describe("自动 L2 与进行中输入保留（context.md 6.5）", () => {
  const evT = (
    seq: number,
    type: DurableEvent["type"],
    payload: Record<string, unknown>,
    turnId: string,
  ): DurableEvent => ({ ...ev(seq, type, payload), turnId }) as DurableEvent;

  it("无新闭合边界（本轮已修剪）且仍超阈值 → 给出携带请求的 summary 计划", () => {
    // 预算 8000-256-1024=6720 token，阈值 5376；工具结果已被修剪为占位，
    // 超阈值部分来自未持久化的 pending 输入（不进摘要转录）
    const history: HistoryEntry[] = [
      {
        kind: "assistant",
        seq: 2,
        turnId: "t1",
        messageId: "a2",
        model: { provider: "test", model: "m1" },
        content: [{ type: "text", text: "ok" }],
        toolCalls: [{ callId: "c3", name: "read" }],
        usage: undefined,
        finishReason: "tool_calls",
      },
      {
        kind: "tool",
        seq: 3,
        turnId: "t1",
        callId: "c3",
        name: "read",
        status: "ok",
        modelContent: "x".repeat(2_000),
        inputSummary: "path=a",
      },
      {
        kind: "compaction",
        seq: 4,
        turnId: "t1",
        compactKind: "prune",
        throughSeq: 3,
        summary: undefined,
      },
    ];
    const events = [
      evT(1, "turn.started", { turnIndex: 1 }, "t1"),
      evT(3, "tool.completed", { callId: "c3" }, "t1"),
      evT(4, "context.compacted", { kind: "prune", throughSeq: 3 }, "t1"),
    ];
    const built = buildContext(
      baseInput({
        history,
        events,
        model: { ...model, contextWindow: 8_000, maxOutputTokens: 256 },
        pendingMessages: [{ role: "user", content: [{ type: "text", text: "y".repeat(23_000) }] }],
      }),
    );
    expect(built.compaction?.kind).toBe("summary");
    expect(built.compaction?.throughSeq).toBe(3);
    expect(built.compaction?.summaryRequest).toBeDefined();
    expect(built.compaction?.summaryRequest?.tools).toHaveLength(0);
    expect(built.compaction?.summaryRequest?.maxOutputTokens).toBeLessThanOrEqual(4_000);
  });

  it("进行中 Turn 的 message.user 被摘要覆盖时重新注入，保证当前任务不丢", () => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 2,
        turnId: "t1",
        messageId: "u2",
        content: [{ type: "text", text: "当前任务：修复登录" }],
      },
      {
        kind: "assistant",
        seq: 3,
        turnId: "t1",
        messageId: "a3",
        model: { provider: "test", model: "m1" },
        content: [{ type: "text", text: "读取中" }],
        toolCalls: [{ callId: "c4", name: "read" }],
        usage: undefined,
        finishReason: "tool_calls",
      },
      {
        kind: "tool",
        seq: 4,
        turnId: "t1",
        callId: "c4",
        name: "read",
        status: "ok",
        modelContent: "body",
      },
      {
        kind: "compaction",
        seq: 5,
        turnId: "t1",
        compactKind: "summary",
        throughSeq: 4,
        summary: "前半段摘要",
      },
    ];
    const events = [
      evT(1, "turn.started", { turnIndex: 1 }, "t1"),
      evT(4, "tool.completed", { callId: "c4" }, "t1"),
      evT(5, "context.compacted", { kind: "summary", throughSeq: 4, summary: "前半段摘要" }, "t1"),
    ];
    const built = buildContext(baseInput({ history, events }));
    // 摘要覆盖 seq≤4：只剩摘要消息 + 重新注入的当前任务
    expect(built.request.messages).toHaveLength(2);
    const last = built.request.messages[1];
    expect(last?.role === "user" && JSON.stringify(last.content)).toContain("当前任务：修复登录");
  });
});
