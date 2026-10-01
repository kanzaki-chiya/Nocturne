import { describe, expect, it } from "vitest";

import type { DurableEvent, HistoryEntry, ImageAttachment } from "../protocol/index.js";
import type { ModelInfo, ModelMessage } from "../provider/index.js";
import {
  attachmentsToLoad,
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
    editTool: "edit",
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
  it("压缩后的清单独立进入模型请求并计入预算，清空后撤去", () => {
    const todos = [{ text: "当前任务", status: "in_progress" as const }];
    const plain = buildContext(baseInput({ history: [] }));
    const built = buildContext(baseInput({ history: [], todos }));
    // ADR-0028 修订：清单不进 system（保持缓存前缀稳定），作为末尾 user 消息附上
    expect(built.request.system).toEqual(plain.request.system);
    const last = built.request.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.role === "user" ? last.content.at(-1) : undefined).toMatchObject({
      text: expect.stringContaining('"当前任务"'),
    });
    expect(built.request.cachePrefix?.messages).toBe(built.request.messages.length - 1);
    expect(plain.request.cachePrefix?.messages).toBe(plain.request.messages.length);
    expect(built.report.sections.find((s) => s.name === "todos")?.estimatedTokens).toBeGreaterThan(
      0,
    );
    expect(built.report.estimatedTokens).toBeGreaterThan(plain.report.estimatedTokens);
    expect(
      buildContext(baseInput({ todos: [] })).report.sections.some((s) => s.name === "todos"),
    ).toBe(false);
  });
  it("任务清单：末尾是 user 消息时并入该条（不产生连续 user），末尾是工具结果时另起一条", () => {
    const todos = [{ text: "当前任务", status: "in_progress" as const }];
    const userTail = buildContext(
      baseInput({
        history: [
          {
            kind: "user",
            seq: 1,
            turnId: "t1",
            messageId: "m1",
            content: [{ type: "text", text: "问题" }],
          },
        ],
        todos,
      }),
    ).request;
    expect(userTail.messages).toHaveLength(1);
    const merged = userTail.messages[0];
    expect(merged?.role === "user" ? merged.content.map((c) => c.type) : []).toEqual([
      "text",
      "text",
    ]);
    expect(userTail.cachePrefix?.messages).toBe(0);

    const pending: ModelMessage = {
      role: "tool",
      callId: "c1",
      name: "read",
      content: "结果",
      isError: false,
    };
    const toolTail = buildContext(
      baseInput({
        history: [
          {
            kind: "user",
            seq: 1,
            turnId: "t1",
            messageId: "m1",
            content: [{ type: "text", text: "问题" }],
          },
        ],
        pendingMessages: [pending],
        todos,
      }),
    ).request;
    expect(toolTail.messages.map((m) => m.role)).toEqual(["user", "tool", "user"]);
    expect(toolTail.cachePrefix?.messages).toBe(2);
    expect(pending.content).toBe("结果");
  });
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
    expect(built.request.system[1]?.text).toContain("conflict with default practices");
    expect(built.request.system[1]?.text).toContain("project rule");
    expect(built.request.system[0]?.text).toContain("# Safety");
    expect(built.request.system[0]?.text).toContain("Don't pipe it to pagers like more or less");
    expect(built.request.system[0]?.text).toContain("redirect to a file first");
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

  it("旧会话中无输出的失败 assistant 不进入下一轮请求", () => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t1",
        messageId: "u1",
        content: [{ type: "text", text: "first" }],
      },
      {
        kind: "assistant",
        seq: 2,
        turnId: "t1",
        messageId: "a1",
        model: { provider: "test", model: "m1" },
        content: [],
        toolCalls: [],
        usage: undefined,
        finishReason: "aborted",
      },
      {
        kind: "user",
        seq: 3,
        turnId: "t2",
        messageId: "u2",
        content: [{ type: "text", text: "second" }],
      },
    ];
    expect(buildContext(baseInput({ history })).request.messages.map((m) => m.role)).toEqual([
      "user",
      "user",
    ]);
  });

  it("note 条目（ADR-0022 shell 切换说明）在该位置渲染为 user 消息", () => {
    const history: HistoryEntry[] = [
      {
        kind: "user",
        seq: 1,
        turnId: "t1",
        messageId: "u1",
        content: [{ type: "text", text: "第一条" }],
      },
      {
        kind: "note",
        seq: 2,
        turnId: "t1",
        text: "[Environment change] shell is now PowerShell 7 (pwsh) (C:\\ps\\pwsh.exe); use PowerShell syntax",
      },
      {
        kind: "user",
        seq: 3,
        turnId: "t2",
        messageId: "u2",
        content: [{ type: "text", text: "第二条" }],
      },
    ];
    const built = buildContext(baseInput({ history }));
    const texts = built.request.messages.map((m) =>
      typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("\n"),
    );
    expect(built.request.messages.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(texts[1]).toContain("[Environment change]");
    expect(texts[1]).toContain("pwsh");
    // 位置保持：切换说明在两条用户消息之间
    expect(texts[0]).toBe("第一条");
    expect(texts[2]).toBe("第二条");
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

  // ADR-0026 §6：providerData 回传条件是「同一服务商且同一协议」；
  // 旧日志条目无 protocol 字段时按旧规则只比较服务商
  const assistantWith = (protocol?: "openai-compatible" | "anthropic"): HistoryEntry => ({
    kind: "assistant",
    seq: 1,
    turnId: "t",
    messageId: "a1",
    model: { provider: "test", model: "prev" },
    ...(protocol !== undefined ? { protocol } : {}),
    content: [
      { type: "reasoning", text: "r", providerData: { sig: 1 } },
      { type: "text", text: "answer" },
    ],
    toolCalls: [],
    usage: undefined,
    finishReason: "stop",
  });
  const chatModel: ModelInfo = { ...model, protocol: "openai-compatible" };

  it("同一服务商但跨协议切换：剥离 providerData 推理块，保留文本", () => {
    const built = buildContext(
      baseInput({ history: [assistantWith("anthropic")], model: chatModel }),
    );
    const msg = built.request.messages[0];
    if (msg?.role === "assistant") {
      expect(msg.content).toEqual([{ type: "text", text: "answer" }]);
    }
  });

  it("同一服务商且同一协议：providerData 推理块原样回传", () => {
    const built = buildContext(
      baseInput({ history: [assistantWith("openai-compatible")], model: chatModel }),
    );
    const msg = built.request.messages[0];
    if (msg?.role === "assistant") {
      expect(msg.content).toContainEqual(
        expect.objectContaining({ type: "reasoning", providerData: { sig: 1 } }),
      );
    }
  });

  it("旧日志条目无 protocol：只比较服务商，providerData 保留", () => {
    const built = buildContext(baseInput({ history: [assistantWith()], model: chatModel }));
    const msg = built.request.messages[0];
    if (msg?.role === "assistant") {
      expect(msg.content).toContainEqual(
        expect.objectContaining({ type: "reasoning", providerData: { sig: 1 } }),
      );
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

describe("note 投影遵守 toolCalls/结果邻接（协议约束）", () => {
  const assistantCall = (seq: number, callIds: string[]): HistoryEntry => ({
    kind: "assistant",
    seq,
    turnId: "t",
    messageId: `a${seq}`,
    model: { provider: "test", model: "m1" },
    content: [{ type: "text", text: "ok" }],
    toolCalls: callIds.map((callId) => ({ callId, name: "read" })),
    usage: undefined,
    finishReason: "tool_calls",
  });
  const toolResult = (seq: number, callId: string): HistoryEntry => ({
    kind: "tool",
    seq,
    turnId: "t",
    callId,
    name: "read",
    status: "ok",
    modelContent: `r-${callId}`,
  });
  const note = (seq: number, text = "[Environment change] shell is now bash"): HistoryEntry => ({
    kind: "note",
    seq,
    turnId: "t",
    text,
  });
  /** 把 ModelRequest.messages 压成形状序列，note 记为 note:<文本>，tool 记为 tool:<callId> */
  const shape = (built: ReturnType<typeof buildContext>): string[] =>
    built.request.messages.map((m) => {
      if (m.role === "tool") return `tool:${m.callId}`;
      if (m.role === "assistant") return "assistant";
      const text = m.content.map((b) => b.text).join("");
      return text.startsWith("[Environment change]") ? `note:${text.slice(-8)}` : "user";
    });

  it("assistant 未决调用之间的 shell note 延迟到工具结果之后", () => {
    // /shell 在工具调用进行中执行：持久序 assistant → note → tool 结果，
    // 投影必须不把 user 角色的 note 插到 assistant 与其结果之间
    const history = [assistantCall(2, ["c1"]), note(3), toolResult(4, "c1")];
    const built = buildContext(baseInput({ history }));
    expect(shape(built)).toEqual(["assistant", "tool:c1", "note:now bash"]);
    // 断言 assistant 与其 tool 结果之间没有任何 user 消息
    const assistantIdx = built.request.messages.findIndex((m) => m.role === "assistant");
    expect(built.request.messages[assistantIdx + 1]?.role).toBe("tool");
  });

  it("并行调用：note 插在两段结果之间时等全部结算再放行，多条 note 保序", () => {
    const history = [
      assistantCall(2, ["c1", "c2", "c3"]),
      note(3, "[Environment change] shell is now bash"),
      toolResult(4, "c1"),
      note(5, "[Environment change] shell is now cmd"),
      toolResult(6, "c2"),
      toolResult(7, "c3"),
    ];
    const built = buildContext(baseInput({ history }));
    expect(shape(built)).toEqual([
      "assistant",
      "tool:c1",
      "tool:c2",
      "tool:c3",
      "note:now bash",
      "note: now cmd",
    ]);
  });

  it("结算在 pendingMessages 中到达时，note 排在结果之后、后续 pending 之前", () => {
    const history = [assistantCall(2, ["c1"]), note(3)];
    const built = buildContext(
      baseInput({
        history,
        pendingMessages: [
          { role: "tool", callId: "c1", name: "read", content: "r-c1", isError: false },
          { role: "user", content: [{ type: "text", text: "继续" }] },
        ],
      }),
    );
    expect(shape(built)).toEqual(["assistant", "tool:c1", "note:now bash", "user"]);
  });

  it("调用悬空到历史末尾（中断/截断）时 note 追加到末尾而非插队", () => {
    const history = [assistantCall(2, ["c1"]), note(3)];
    const built = buildContext(baseInput({ history }));
    expect(shape(built)).toEqual(["assistant", "note:now bash"]);
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

describe("图片附件投影（ADR-0023）", () => {
  const visionModel: ModelInfo = {
    ...model,
    capabilities: { ...model.capabilities, imageInput: true },
  };
  const att = (sha: string, label?: string): ImageAttachment => ({
    type: "image",
    file: `img-${sha}.png`,
    mimeType: "image/png",
    bytes: 29,
    sha256: sha,
    width: 2,
    height: 3,
    source: "read",
    ...(label !== undefined ? { label } : {}),
  });
  const toolWithAtt = (seq: number, sha: string): HistoryEntry => ({
    kind: "tool",
    seq,
    turnId: "t",
    callId: `c${seq}`,
    name: "read",
    status: "ok",
    modelContent: `out${seq}`,
    attachments: [att(sha)],
  });
  const userWithAtt = (seq: number, sha: string, label?: string): HistoryEntry => ({
    kind: "user",
    seq,
    turnId: "t",
    messageId: `u${seq}`,
    content: [{ type: "text", text: "看看这个" }],
    attachments: [att(sha, label)],
  });
  const dataOf = (...shas: string[]): ReadonlyMap<string, string> =>
    new Map(shas.map((s) => [s, Buffer.from(`bytes-of-${s}`).toString("base64")]));

  it("支持看图：tool/user 附件投影为 images（base64）", () => {
    const built = buildContext(
      baseInput({
        history: [toolWithAtt(1, "a"), userWithAtt(2, "b")],
        model: visionModel,
        attachmentData: dataOf("a", "b"),
      }),
    );
    const toolMsg = built.request.messages[0];
    expect(toolMsg?.role === "tool" && toolMsg.images?.[0]?.data).toBe(
      Buffer.from("bytes-of-a").toString("base64"),
    );
    expect(toolMsg?.role === "tool" && toolMsg.images?.[0]?.mimeType).toBe("image/png");
    const userMsg = built.request.messages[1];
    expect(userMsg?.role === "user" && userMsg.images).toHaveLength(1);
    // 占位不外溢：文本保持原样
    expect(toolMsg?.role === "tool" && toolMsg.content).toBe("out1");
  });

  it("不支持看图：附件换成占位文字（tool 追加 content；user 追加 text 块）", () => {
    const built = buildContext(
      baseInput({
        history: [toolWithAtt(1, "a"), userWithAtt(2, "b")],
        attachmentData: dataOf("a", "b"),
      }),
    );
    const toolMsg = built.request.messages[0];
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    expect(toolMsg?.role === "tool" && toolMsg.content).toBe(
      "out1\n[image omitted: current model does not support image input]",
    );
    const userMsg = built.request.messages[1];
    expect(userMsg?.role === "user" && userMsg.images).toBeUndefined();
    const blocks = userMsg?.role === "user" ? userMsg.content : [];
    expect(blocks.at(-1)?.text).toBe("[image omitted: current model does not support image input]");
    expect(built.missingAttachments).toBeUndefined();
  });

  it("同一段历史切换模型（imageInput true→false）两次构建结果不同", () => {
    const history = [toolWithAtt(1, "a")];
    const withVision = buildContext(
      baseInput({ history, model: visionModel, attachmentData: dataOf("a") }),
    );
    const without = buildContext(baseInput({ history, attachmentData: dataOf("a") }));
    const tm0 = withVision.request.messages[0];
    const tm1 = without.request.messages[0];
    expect(tm0?.role === "tool" && tm0.images).toHaveLength(1);
    expect(tm1?.role === "tool" && tm1.images).toBeUndefined();
    expect(JSON.stringify(tm1)).toContain("image omitted");
  });

  it("attachmentData 缺该 sha256 → 缺失占位 + missingAttachments", () => {
    const built = buildContext(
      baseInput({
        history: [toolWithAtt(1, "a")],
        model: visionModel,
        attachmentData: new Map(),
      }),
    );
    const toolMsg = built.request.messages[0];
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain(
      "[image unavailable: attachment file missing]",
    );
    expect(built.missingAttachments?.map((a) => a.sha256)).toEqual(["a"]);
  });

  it("25 张图：最旧 5 张换上限占位，最新 20 张保留", () => {
    const history = Array.from({ length: 25 }, (_, i) => toolWithAtt(i + 1, `s${i}`));
    const built = buildContext(
      baseInput({
        history,
        model: visionModel,
        attachmentData: dataOf(...Array.from({ length: 25 }, (_, i) => `s${i}`)),
      }),
    );
    const toolMsgs = built.request.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(25);
    const kept = toolMsgs.filter((m) => m.role === "tool" && (m.images?.length ?? 0) > 0);
    expect(kept).toHaveLength(20);
    // 最旧 5 条：无 images，content 末追加上限占位
    for (const m of toolMsgs.slice(0, 5)) {
      expect(m.role === "tool" && m.images).toBeUndefined();
      expect(m.role === "tool" && m.content).toContain(
        "[image omitted: exceeds the per-request limit of 20 images]",
      );
    }
    // 最新 20 条保留图片且无占位
    for (const m of toolMsgs.slice(5)) {
      expect(m.role === "tool" && m.images).toHaveLength(1);
      expect(m.role === "tool" && m.content).toBe(`out${toolMsgs.indexOf(m) + 1}`);
    }
  });

  it("25 张图、只加载 attachmentsToLoad 给出的 20 张：更早 5 张是上限占位而非缺失", () => {
    const history = Array.from({ length: 25 }, (_, i) => toolWithAtt(i + 1, `s${i}`));
    const loaded = attachmentsToLoad(history, visionModel).map((a) => a.sha256);
    expect(loaded).toHaveLength(20);
    const built = buildContext(
      baseInput({ history, model: visionModel, attachmentData: dataOf(...loaded) }),
    );
    const toolMsgs = built.request.messages.filter((m) => m.role === "tool");
    for (const m of toolMsgs.slice(0, 5)) {
      expect(m.role === "tool" && m.content).toContain(
        "[image omitted: exceeds the per-request limit of 20 images]",
      );
      expect(m.role === "tool" && m.content).not.toContain("attachment file missing");
    }
    expect(toolMsgs.filter((m) => m.role === "tool" && m.images?.length === 1)).toHaveLength(20);
    expect(built.missingAttachments ?? []).toEqual([]);
  });

  it("L1 修剪覆盖的 tool 条目：无图片也无图片占位", () => {
    const history: HistoryEntry[] = [
      toolWithAtt(1, "a"),
      {
        kind: "compaction",
        seq: 2,
        turnId: "t",
        compactKind: "prune",
        throughSeq: 1,
        summary: undefined,
      },
    ];
    const built = buildContext(
      baseInput({ history, model: visionModel, attachmentData: dataOf("a") }),
    );
    const toolMsg = built.request.messages[0];
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("输出已省略");
    expect(toolMsg?.role === "tool" && toolMsg.content).not.toContain("image");
    expect(built.missingAttachments).toBeUndefined();
  });

  it("摘要请求不含 images；转录对每个附件写 [image: …] 标记", () => {
    const history: HistoryEntry[] = [userWithAtt(1, "a", "截图.png"), toolWithAtt(2, "b")];
    const req = buildSummaryRequest({ history, model: visionModel, throughSeq: 2 });
    expect(JSON.stringify(req.messages)).not.toContain("images");
    expect(JSON.stringify(req.messages)).toContain("[image: 截图.png]");
    expect(JSON.stringify(req.messages)).toContain("[image: img-b.png]");
    const transcript = renderTranscript(history, "test");
    expect(transcript).toContain("[image: 截图.png]");
    expect(transcript).toContain("[image: img-b.png]");
  });

  it("token 估算：图片按 1600/张计入，base64 长度不进估算", () => {
    const history = [toolWithAtt(1, "a")];
    const small = buildContext(
      baseInput({
        history,
        model: visionModel,
        attachmentData: new Map([["a", "aVZCT1I="]]),
      }),
    );
    const big = buildContext(
      baseInput({
        history,
        model: visionModel,
        attachmentData: new Map([["a", "x".repeat(1024 * 1024)]]),
      }),
    );
    expect(small.report.estimatedTokens).toBe(big.report.estimatedTokens);
    expect(small.report.images).toEqual({ count: 1, estimatedTokens: 1600 });
    const noImages = buildContext(baseInput({ history: [] }));
    expect(noImages.report.images).toBeUndefined();
  });

  it("估算模式（无 attachmentData）：不产生 images/missing，report.images 按引用计数", () => {
    const built = buildContext(
      baseInput({ history: [toolWithAtt(1, "a"), userWithAtt(2, "b")], model: visionModel }),
    );
    const toolMsg = built.request.messages[0];
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    const userMsg = built.request.messages[1];
    expect(userMsg?.role === "user" && userMsg.images).toBeUndefined();
    expect(built.missingAttachments).toBeUndefined();
    expect(built.report.images).toEqual({ count: 2, estimatedTokens: 3200 });
    // 估算模式 + 不支持看图：写不支持占位、不计数
    const blind = buildContext(baseInput({ history: [toolWithAtt(1, "a")] }));
    expect(blind.report.images).toBeUndefined();
  });

  it("attachmentsToLoad：不支持→[]；跳过摘要/修剪覆盖；最多20并按 sha256 去重", () => {
    const history: HistoryEntry[] = [
      toolWithAtt(1, "covered"),
      {
        kind: "compaction",
        seq: 2,
        turnId: undefined,
        compactKind: "summary",
        throughSeq: 1,
        summary: "S",
      },
      toolWithAtt(3, "pruned"),
      {
        kind: "compaction",
        seq: 4,
        turnId: "t",
        compactKind: "prune",
        throughSeq: 3,
        summary: undefined,
      },
      toolWithAtt(5, "x"),
      toolWithAtt(6, "x"), // 同 sha256 去重
      userWithAtt(7, "y"),
    ];
    expect(attachmentsToLoad(history, model)).toEqual([]);
    expect(attachmentsToLoad(history, visionModel).map((a) => a.sha256)).toEqual(["x", "y"]);
    // 超过 20 个引用只取最新 20
    const many = Array.from({ length: 22 }, (_, i) => toolWithAtt(10 + i, `m${i}`));
    expect(attachmentsToLoad(many, visionModel)).toHaveLength(20);
    expect(attachmentsToLoad(many, visionModel)[0]?.sha256).toBe("m2");
  });
});
