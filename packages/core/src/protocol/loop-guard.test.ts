import { describe, expect, it } from "vitest";

import type { DurableEvent } from "./events.js";
import {
  advanceLoopGuard,
  canonicalLoopInput,
  DEFAULT_LOOP_GUARD,
  hashLoopResult,
  loopGuardArgs,
  loopGuardNoteText,
  loopGuardNotes,
  loopGuardSignature,
  loopGuardWarnings,
} from "./loop-guard.js";

/** 构造一条最小持久事件（只填 loop-guard 用到的字段） */
function ev(seq: number, type: string, payload: unknown, turnId = "turn-1"): DurableEvent {
  return { type, sessionId: "s", seq, time: "t", turnId, payload } as unknown as DurableEvent;
}

/**
 * 一段"同一调用重复 n 次"的事件序列：每次 assistant 给出调用，随后一个 tool.completed。
 * `name`/`input`/`result` 决定签名，`turnId` 决定 Turn 边界。
 */
function repeats(
  n: number,
  options: {
    name?: string;
    input?: unknown;
    rawInput?: string;
    result?: string;
    turnId?: string;
    startSeq?: number;
    status?: "ok" | "error";
  } = {},
): DurableEvent[] {
  const {
    name = "shell",
    input = { command: "git status" },
    rawInput,
    result = "clean",
    turnId = "turn-1",
    startSeq = 1,
    status = "ok",
  } = options;
  const events: DurableEvent[] = [ev(startSeq, "turn.started", {}, turnId)];
  for (let i = 0; i < n; i++) {
    const callId = `${turnId}-call-${i + 1}`;
    events.push(
      ev(
        startSeq + 1 + i * 2,
        "message.assistant",
        {
          messageId: `m${i}`,
          model: { provider: "p", model: "m" },
          content: [],
          toolCalls: [
            {
              callId,
              name,
              ...(input !== undefined ? { input } : {}),
              ...(rawInput !== undefined ? { rawInput } : {}),
            },
          ],
          usage: undefined,
          finishReason: "tool_calls",
        },
        turnId,
      ),
      ev(
        startSeq + 2 + i * 2,
        "tool.completed",
        { callId, name, status, modelContent: result },
        turnId,
      ),
    );
  }
  return events;
}

describe("canonicalLoopInput", () => {
  it("相同入参、键顺序不同得到同一串", () => {
    expect(canonicalLoopInput({ a: 1, b: { c: [1, 2] } })).toBe(
      canonicalLoopInput({ b: { c: [1, 2] }, a: 1 }),
    );
    expect(canonicalLoopInput({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("数组保序、undefined 丢弃、其他标量原样", () => {
    expect(canonicalLoopInput([2, 1])).not.toBe(canonicalLoopInput([1, 2]));
    expect(canonicalLoopInput({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalLoopInput("x")).toBe('"x"');
    expect(canonicalLoopInput(3)).toBe("3");
    expect(canonicalLoopInput(null)).toBe("null");
    expect(canonicalLoopInput(undefined)).toBe("null");
  });
});

describe("hashLoopResult / loopGuardSignature", () => {
  it("同一正文同哈希，不同正文不同哈希（含中文与空白差异）", () => {
    expect(hashLoopResult("clean")).toBe(hashLoopResult("clean"));
    expect(hashLoopResult("clean")).not.toBe(hashLoopResult("clean "));
    expect(hashLoopResult("检测到")).not.toBe(hashLoopResult("检测"));
    expect(hashLoopResult("")).toBe(hashLoopResult(""));
  });

  it("签名覆盖工具名、入参与结果正文", () => {
    const base = loopGuardSignature("shell", '{"command":"git status"}', "clean");
    expect(base).toBe(loopGuardSignature("shell", '{"command":"git status"}', "clean"));
    expect(base).not.toBe(loopGuardSignature("read", '{"command":"git status"}', "clean"));
    expect(base).not.toBe(loopGuardSignature("shell", '{"command":"git diff"}', "clean"));
    expect(base).not.toBe(loopGuardSignature("shell", '{"command":"git status"}', "dirty"));
  });
});

describe("loopGuardArgs", () => {
  it("优先用解析后的入参，参数解析失败时回退原文", () => {
    expect(loopGuardArgs({ input: { b: 1, a: 2 } })).toBe('{"a":2,"b":1}');
    expect(loopGuardArgs({ input: undefined, rawInput: '{"a":' })).toBe('{"a":');
    expect(loopGuardArgs({ input: undefined, rawInput: undefined })).toBe("");
  });
});

describe("advanceLoopGuard", () => {
  it("相同签名累加，不同签名从 1 重来", () => {
    let run = advanceLoopGuard(undefined, "a");
    expect(run).toEqual({ signature: "a", count: 1 });
    run = advanceLoopGuard(run, "a");
    expect(run.count).toBe(2);
    run = advanceLoopGuard(run, "b");
    expect(run).toEqual({ signature: "b", count: 1 });
  });
});

describe("loopGuardWarnings", () => {
  it("第 warnAt 次后附说明，且只附一次", () => {
    const events = repeats(4);
    const warnings = loopGuardWarnings(events, DEFAULT_LOOP_GUARD);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ name: "shell", count: 3 });
    // 说明位置在第 3 次结果（turn.started=1，之后每组 assistant+tool.completed 各占两个 seq）
    expect(warnings[0]?.seq).toBe(7);
    expect(warnings[0]?.text.startsWith("\n\n[Loop guard]")).toBe(true);
    expect(warnings[0]?.text).toContain('"shell"');
    expect(warnings[0]?.text).toContain("3 times");
  });

  it("结果不同即重置：交替结果不触发", () => {
    const events = [
      ...repeats(1, { result: "a", startSeq: 1 }),
      ...repeats(1, { result: "b", startSeq: 10, turnId: "turn-1" }).slice(1),
      ...repeats(1, { result: "a", startSeq: 20, turnId: "turn-1" }).slice(1),
      ...repeats(1, { result: "b", startSeq: 30, turnId: "turn-1" }).slice(1),
    ];
    expect(loopGuardWarnings(events, DEFAULT_LOOP_GUARD)).toHaveLength(0);
  });

  it("中间穿插其他工具调用会重置计数", () => {
    const events = [
      ...repeats(2),
      ...repeats(1, { name: "read", input: { path: "a.txt" }, result: "x", startSeq: 20 }).slice(1),
      ...repeats(2, { startSeq: 30 }).slice(1),
    ];
    expect(loopGuardWarnings(events, DEFAULT_LOOP_GUARD)).toHaveLength(0);
  });

  it("只穿插模型文本/推理不打断", () => {
    const events = repeats(3);
    events.push(
      ev(7, "message.assistant", {
        messageId: "m-text",
        model: { provider: "p", model: "m" },
        content: [{ type: "text", text: "换一种做法试试" }],
        toolCalls: [],
        usage: undefined,
        finishReason: "stop",
      }),
    );
    expect(loopGuardWarnings(events, DEFAULT_LOOP_GUARD)).toHaveLength(1);
  });

  it("跨 Turn 不累计", () => {
    const events = [
      ...repeats(2, { turnId: "turn-1" }),
      ev(5, "turn.completed", { reason: "done", steps: 2, usage: {} }, "turn-1"),
      ...repeats(2, { turnId: "turn-2", startSeq: 6 }),
    ];
    expect(loopGuardWarnings(events, DEFAULT_LOOP_GUARD)).toHaveLength(0);
  });

  it("同一步并行的相同调用各算一次", () => {
    const events: DurableEvent[] = [
      ev(1, "turn.started", {}),
      ev(2, "message.assistant", {
        messageId: "m",
        model: { provider: "p", model: "m" },
        content: [],
        toolCalls: [
          { callId: "c1", name: "shell", input: { command: "git status" } },
          { callId: "c2", name: "shell", input: { command: "git status" } },
          { callId: "c3", name: "shell", input: { command: "git status" } },
        ],
        usage: undefined,
        finishReason: "tool_calls",
      }),
      ev(3, "tool.completed", { callId: "c1", name: "shell", status: "ok", modelContent: "clean" }),
      ev(4, "tool.completed", { callId: "c2", name: "shell", status: "ok", modelContent: "clean" }),
      ev(5, "tool.completed", { callId: "c3", name: "shell", status: "ok", modelContent: "clean" }),
    ];
    const warnings = loopGuardWarnings(events, DEFAULT_LOOP_GUARD);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.seq).toBe(5);
    expect(warnings[0]?.count).toBe(3);
  });

  it("键顺序不同视为同一调用", () => {
    const events: DurableEvent[] = [];
    events.push(ev(1, "turn.started", {}));
    for (let i = 0; i < 3; i++) {
      events.push(
        ev(2 + i * 2, "message.assistant", {
          messageId: `m${i}`,
          model: { provider: "p", model: "m" },
          content: [],
          toolCalls: [
            {
              callId: `c${i}`,
              name: "read",
              input: i % 2 === 0 ? { path: "a.txt", limit: 10 } : { limit: 10, path: "a.txt" },
            },
          ],
          usage: undefined,
          finishReason: "tool_calls",
        }),
        ev(3 + i * 2, "tool.completed", {
          callId: `c${i}`,
          name: "read",
          status: "ok",
          modelContent: "same",
        }),
      );
    }
    expect(loopGuardWarnings(events, DEFAULT_LOOP_GUARD)).toHaveLength(1);
  });

  it("取消与恢复补写的结算不计数", () => {
    const events: DurableEvent[] = [
      ev(1, "turn.started", {}),
      ev(2, "message.assistant", {
        messageId: "m",
        model: { provider: "p", model: "m" },
        content: [],
        toolCalls: [
          { callId: "c1", name: "shell", input: { command: "x" } },
          { callId: "c2", name: "shell", input: { command: "x" } },
        ],
        usage: undefined,
        finishReason: "tool_calls",
      }),
      ev(3, "tool.completed", {
        callId: "c1",
        name: "shell",
        status: "cancelled",
        modelContent: "[调用未执行：Turn 以 aborted 结束]",
      }),
      ev(4, "tool.completed", {
        callId: "c2",
        name: "shell",
        status: "interrupted",
        modelContent: "[调用未执行：Turn 以 aborted 结束]",
      }),
    ];
    expect(loopGuardWarnings(events, DEFAULT_LOOP_GUARD)).toHaveLength(0);
  });

  it("config=false 关闭；自定义阈值生效", () => {
    const events = repeats(3);
    expect(loopGuardWarnings(events, false)).toEqual([]);
    expect(loopGuardWarnings(events, { warnAt: 2, stopAt: 4 })[0]?.seq).toBe(5);
    expect(loopGuardWarnings(events, undefined)).toHaveLength(1);
  });

  it("说明只由历史决定：同一事件序列重建结果一字不差", () => {
    const events = repeats(5);
    const a = loopGuardNotes(events, DEFAULT_LOOP_GUARD);
    const b = loopGuardNotes(structuredClone(events), DEFAULT_LOOP_GUARD);
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.get(7)).toBe(`\n\n${loopGuardNoteText("shell", 3)}`);
  });

  // f0136a6d（2026-10-22）seq 926–965：摘要压缩后连续 14 次 `git status`，
  // 输出一字不差。这条回归按同一形状构造事件序列，确认第 6 次就会判停。
  it("f0136a6d 形状：14 次相同 git status 在第 6 次达到 stopAt", () => {
    const events = repeats(14, { name: "shell", input: { command: "git status" }, result: "" });
    const warnings = loopGuardWarnings(events, DEFAULT_LOOP_GUARD);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.count).toBe(3);
    // 与 Agent Loop 相同的推进方式：第 6 次 tool.completed 时计数到达 stopAt
    let run: ReturnType<typeof advanceLoopGuard> | undefined;
    let stoppedAt: number | undefined;
    for (const event of events) {
      if (event.type !== "tool.completed") continue;
      run = advanceLoopGuard(
        run,
        loopGuardSignature(
          event.payload.name,
          '{"command":"git status"}',
          event.payload.modelContent,
        ),
      );
      if (run.count === DEFAULT_LOOP_GUARD.stopAt) {
        stoppedAt = event.seq;
        break;
      }
    }
    // 每次重复占 2 个 seq（assistant + tool.completed），第 6 次结果落在 seq 13
    expect(stoppedAt).toBe(13);
  });
});
