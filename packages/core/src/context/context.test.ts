import { describe, expect, it } from "vitest";

import type { HistoryEntry } from "../protocol/index.js";
import type { ModelInfo } from "../provider/index.js";
import { buildContext, estimateTokens } from "./index.js";
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
