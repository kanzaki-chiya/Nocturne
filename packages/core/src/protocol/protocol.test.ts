import { describe, expect, it } from "vitest";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  EventParseError,
  isDurableEvent,
  isDurableEventType,
  isEphemeralEventType,
  LOG_FORMAT_VERSION,
  type DurableEvent,
  type MessageAssistantPayload,
} from "./index.js";

function makeEvent(overrides: Partial<DurableEvent> = {}): DurableEvent {
  return {
    type: "session.created",
    sessionId: "s1",
    seq: 1,
    time: "2026-09-23T00:00:00.000Z",
    payload: {
      formatVersion: LOG_FORMAT_VERSION,
      nocturneVersion: "0.0.0",
      cwd: "Z:\\repo",
      workspaceRoot: "Z:\\repo",
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "phase1",
    },
    ...overrides,
  } as DurableEvent;
}

describe("decodeDurableEvent", () => {
  it("解析合法持久化事件", () => {
    const event = makeEvent();
    const decoded = decodeDurableEvent(encodeDurableEvent(event));
    expect(decoded).toEqual(event);
  });

  it("encode/decode 稳定往返", () => {
    const event = makeEvent({
      type: "message.assistant",
      turnId: "t1",
      payload: {
        messageId: "m1",
        model: { provider: "fake", model: "fake-1" },
        content: [
          { type: "text", text: "hello" },
          { type: "reasoning", text: "thinking", provider: "fake" },
        ],
        toolCalls: [{ callId: "c1", providerCallId: "p1", name: "read" }],
        finishReason: "tool_calls",
      } satisfies MessageAssistantPayload,
    });
    const line = encodeDurableEvent(event);
    expect(decodeDurableEvent(line)).toEqual(event);
    expect(decodeDurableEvent(encodeDurableEvent(decodeDurableEvent(line)))).toEqual(event);
  });

  it("非法 JSON → invalid_json", () => {
    expect(() => decodeDurableEvent("{not json")).toThrowError(EventParseError);
    try {
      decodeDurableEvent("{not json");
    } catch (e) {
      expect((e as EventParseError).code).toBe("invalid_json");
    }
  });

  it("非对象 → invalid_event", () => {
    for (const line of ["42", '"str"', "[1,2]", "null"]) {
      try {
        decodeDurableEvent(line);
        expect.unreachable();
      } catch (e) {
        expect((e as EventParseError).code).toBe("invalid_event");
      }
    }
  });

  it("不认识的持久化事件类型 → unknown_event_type（恢复必须拒绝）", () => {
    const line = JSON.stringify({
      type: "session.future_feature",
      sessionId: "s1",
      seq: 5,
      time: "2026-09-23T00:00:00.000Z",
      payload: {},
    });
    try {
      decodeDurableEvent(line);
      expect.unreachable();
    } catch (e) {
      expect((e as EventParseError).code).toBe("unknown_event_type");
    }
  });

  it("已知类型但字段非法 → invalid_event", () => {
    const bad = JSON.stringify({
      type: "turn.completed",
      sessionId: "s1",
      seq: 3,
      time: "t",
      payload: { reason: "done", steps: "not-a-number" },
    });
    try {
      decodeDurableEvent(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as EventParseError).code).toBe("invalid_event");
    }
  });

  it("已知事件中的未知字段被忽略（演进规则）", () => {
    const event = makeEvent({
      type: "turn.started",
      seq: 2,
      turnId: "t1",
      payload: { turnIndex: 1 },
    });
    const raw = JSON.parse(encodeDurableEvent(event)) as Record<string, unknown>;
    raw.futureField = { anything: true };
    (raw.payload as Record<string, unknown>).futurePayloadField = 42;
    const decoded = decodeDurableEvent(JSON.stringify(raw));
    expect(decoded.type).toBe("turn.started");
    expect("futureField" in decoded).toBe(false);
  });

  it("seq 必须为正整数", () => {
    for (const seq of [0, -1, 1.5, "2"]) {
      const raw = JSON.parse(encodeDurableEvent(makeEvent())) as Record<string, unknown>;
      raw.seq = seq;
      expect(() => decodeDurableEvent(JSON.stringify(raw))).toThrowError(EventParseError);
    }
  });
});

describe("事件类型守卫", () => {
  it("持久化 / 临时类型分类", () => {
    expect(isDurableEventType("message.assistant")).toBe(true);
    expect(isDurableEventType("message.assistant.delta")).toBe(false);
    expect(isEphemeralEventType("message.assistant.delta")).toBe(true);
    expect(isEphemeralEventType("turn.completed")).toBe(false);
  });

  it("isDurableEvent 用 seq 区分", () => {
    expect(isDurableEvent(makeEvent())).toBe(true);
    expect(
      isDurableEvent({
        type: "runtime.status",
        sessionId: "s1",
        runId: "r1",
        eseq: 1,
        afterSeq: 1,
        time: "t",
        payload: { status: "idle" },
      }),
    ).toBe(false);
  });
});
