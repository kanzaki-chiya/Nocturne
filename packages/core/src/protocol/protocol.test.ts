import { describe, expect, it } from "vitest";
import {
  decodeDurableEvent,
  deriveProtocolFromEndpoints,
  encodeDurableEvent,
  EventParseError,
  isDurableEvent,
  isDurableEventType,
  isEphemeralEventType,
  LOG_FORMAT_VERSION,
  resolveEffectiveProtocol,
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

  it("attachments 字段（ADR-0023）：带/不带均可解析，非法 mimeType 拒绝", () => {
    const att = {
      type: "image" as const,
      file: "img-1.png",
      mimeType: "image/png" as const,
      bytes: 29,
      sha256: "ab".repeat(32),
      width: 2,
      height: 3,
      label: "x.png",
      source: "read" as const,
    };
    const withAtt = makeEvent({
      type: "message.user",
      seq: 2,
      turnId: "t1",
      payload: {
        messageId: "m1",
        content: [{ type: "text", text: "hi" }],
        attachments: [att],
      },
    });
    expect(decodeDurableEvent(encodeDurableEvent(withAtt))).toEqual(withAtt);

    const toolDone = makeEvent({
      type: "tool.completed",
      seq: 3,
      turnId: "t1",
      payload: {
        callId: "c1",
        name: "read",
        status: "ok",
        modelContent: "x",
        attachments: [att],
      },
    });
    expect(decodeDurableEvent(encodeDurableEvent(toolDone))).toEqual(toolDone);

    // 无附件字段照常解析
    const plain = makeEvent({
      type: "tool.completed",
      seq: 4,
      turnId: "t1",
      payload: { callId: "c1", name: "read", status: "ok", modelContent: "x" },
    });
    const decoded = decodeDurableEvent(encodeDurableEvent(plain));
    expect("attachments" in (decoded.payload as Record<string, unknown>)).toBe(false);

    // 非法 mimeType → invalid_event
    const bad = JSON.parse(encodeDurableEvent(withAtt)) as {
      payload: { attachments: { mimeType: string }[] };
    };
    const first = bad.payload.attachments[0];
    if (first === undefined) expect.unreachable();
    first.mimeType = "image/bmp";
    try {
      decodeDurableEvent(JSON.stringify(bad));
      expect.unreachable();
    } catch (e) {
      expect((e as EventParseError).code).toBe("invalid_event");
    }
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

// ── ADR-0026 §2：按接口声明推导生效协议 ──────────────────

describe("deriveProtocolFromEndpoints", () => {
  it("未声明 / 空列表 → undefined（交调用方继续回落）", () => {
    expect(deriveProtocolFromEndpoints(undefined, "openai-compatible")).toBeUndefined();
    expect(deriveProtocolFromEndpoints([], "anthropic")).toBeUndefined();
  });

  it("条目 type 对应接口在列表中 → 条目 type（两接口并存时）", () => {
    const both = ["/chat/completions", "/messages"];
    expect(deriveProtocolFromEndpoints(both, "openai-compatible")).toBe("openai-compatible");
    expect(deriveProtocolFromEndpoints(both, "anthropic")).toBe("anthropic");
  });

  it("条目本家接口不在列表 → 依次 /chat/completions、/messages、/responses", () => {
    expect(deriveProtocolFromEndpoints(["/messages"], "openai-compatible")).toBe("anthropic");
    expect(deriveProtocolFromEndpoints(["/chat/completions"], "anthropic")).toBe(
      "openai-compatible",
    );
    // ADR-0031 §1：/responses 是第三个可识别接口
    expect(deriveProtocolFromEndpoints(["/responses"], "openai-compatible")).toBe(
      "openai-responses",
    );
    expect(deriveProtocolFromEndpoints(["/responses"], "anthropic")).toBe("openai-responses");
  });

  it("条目 type 优先于 /responses：三接口并存时按本家", () => {
    const all = ["/chat/completions", "/messages", "/responses"];
    expect(deriveProtocolFromEndpoints(all, "openai-compatible")).toBe("openai-compatible");
    expect(deriveProtocolFromEndpoints(all, "anthropic")).toBe("anthropic");
    expect(deriveProtocolFromEndpoints(["/messages", "/responses"], "anthropic")).toBe("anthropic");
  });

  it("全部无法识别 → unavailable", () => {
    expect(deriveProtocolFromEndpoints(["/embeddings"], "openai-compatible")).toBe("unavailable");
    expect(deriveProtocolFromEndpoints(["/embeddings", "/files"], "anthropic")).toBe("unavailable");
  });

  it("按路径末尾比较：/v1/messages ≡ /messages；大小写与尾斜杠不敏感", () => {
    expect(deriveProtocolFromEndpoints(["/v1/messages"], "openai-compatible")).toBe("anthropic");
    expect(deriveProtocolFromEndpoints(["/api/v2/Chat/Completions/"], "anthropic")).toBe(
      "openai-compatible",
    );
  });
});

describe("resolveEffectiveProtocol", () => {
  it("优先级：显式声明 > endpoints 推导 > 条目 type", () => {
    // 显式声明压过 endpoints 推导（含"只有 /responses"的 unavailable 情形）
    expect(resolveEffectiveProtocol("anthropic", ["/responses"], "openai-compatible")).toBe(
      "anthropic",
    );
    expect(resolveEffectiveProtocol("openai-compatible", ["/messages"], "openai-compatible")).toBe(
      "openai-compatible",
    );
    // 无声明走 endpoints 推导
    expect(resolveEffectiveProtocol(undefined, ["/messages"], "openai-compatible")).toBe(
      "anthropic",
    );
    expect(resolveEffectiveProtocol(undefined, ["/responses"], "openai-compatible")).toBe(
      "openai-responses",
    );
    expect(resolveEffectiveProtocol(undefined, ["/embeddings"], "openai-compatible")).toBe(
      "unavailable",
    );
    // 无声明无 endpoints → 条目 type
    expect(resolveEffectiveProtocol(undefined, undefined, "anthropic")).toBe("anthropic");
    expect(resolveEffectiveProtocol(undefined, [], "openai-compatible")).toBe("openai-compatible");
  });
});
