import { describe, expect, it } from "vitest";
import {
  decodeDurableEvent,
  reduceGoal,
  goalElapsedMs,
  visibleGoal,
  type DurableEvent,
  type GoalState,
} from "../src/protocol/index.js";
import { goalContinuation } from "../src/work-modes/index.js";

const context = { backgroundRunning: 0, queued: false, planning: false, nowMs: 0 };
function log() {
  const events: DurableEvent[] = [];
  let goal: GoalState | undefined;
  const emit = (type: string, payload: unknown, ms = 0, turnOpen = true) => {
    const event = decodeDurableEvent(
      JSON.stringify({
        type,
        payload:
          type === "message.assistant"
            ? { model: { provider: "fake", model: "m" }, ...(payload as object) }
            : type === "turn.completed"
              ? { usage: { inputTokens: 0, outputTokens: 0 }, ...(payload as object) }
              : payload,
        seq: events.length + 1,
        time: new Date(ms).toISOString(),
        sessionId: "s",
        turnId: "t",
      }),
    );
    events.push(event);
    goal = reduceGoal(goal, event, turnOpen);
  };
  const check = (tools = false) => {
    emit("message.user", {
      messageId: `u${events.length}`,
      content: [],
      steer: true,
      workMode: { name: "goal", source: "runtime", body: "Check" },
    });
    if (tools)
      emit("message.assistant", {
        messageId: `a${events.length}`,
        content: [],
        finishReason: "tool_calls",
        toolCalls: [{ callId: "call", name: "read", input: { path: "x" } }],
      });
    emit("message.assistant", {
      messageId: `a${events.length}`,
      content: [],
      toolCalls: [],
      finishReason: "stop",
    });
  };
  return {
    events,
    emit,
    check,
    goal: () => goal,
    current: () => {
      if (goal === undefined) throw new Error("missing goal");
      return goal;
    },
  };
}

describe("目标持久状态", () => {
  it("有工具的一轮重置防空转；恢复折叠后计数与继续判断一致", () => {
    const l = log();
    l.emit("session.config_changed", { goal: { objective: "x", status: "active" } });
    l.check();
    l.check();
    expect(l.goal()?.noProgressRounds).toBe(2);
    l.check(true);
    expect(l.goal()?.noProgressRounds).toBe(0);
    l.check();
    l.check();
    const restored = l.events.reduce<GoalState | undefined>(
      (g, e) => reduceGoal(g, e, true),
      undefined,
    );
    expect(restored).toEqual(l.goal());
    expect(goalContinuation(restored, context).kind).toBe("check");
    l.check();
    expect(goalContinuation(l.goal(), context).kind).toBe("blocked");
  });

  it("旧 limit 与 maxRounds/maxMinutes 可解析、显示为停止并继续；忽略旧上限", () => {
    const l = log();
    l.emit("session.config_changed", {
      goal: { objective: "x", status: "limit", maxRounds: 10, maxMinutes: 60 },
    });
    expect(visibleGoal(l.goal())).toBeDefined();
    l.emit("session.config_changed", { goal: { objective: "x", status: "active" } });
    expect(l.goal()?.maxRounds).toBeUndefined();
    for (let i = 0; i < 50; i++) l.check(true);
    expect(l.goal()?.rounds).toBe(50);
    expect(goalContinuation({ ...l.current(), activeMs: 7_200_000 }, context).kind).toBe("check");
  });

  it("暂停继续累计运行时长，空闲不计时，恢复一致", () => {
    const l = log();
    l.emit("session.config_changed", { goal: { objective: "x", status: "active" } }, 0);
    l.emit(
      "session.config_changed",
      { goal: { objective: "x", status: "stopped", reason: "user" } },
      8_000,
    );
    expect(goalElapsedMs(l.current(), 1_000_000)).toBe(8_000);
    l.emit(
      "session.config_changed",
      { goal: { objective: "x", status: "active" } },
      100_000,
      false,
    );
    expect(goalElapsedMs(l.current(), 200_000)).toBe(8_000);
    l.emit("turn.started", { turnIndex: 1 }, 200_000);
    l.emit("turn.completed", { reason: "done", steps: 0, durationMs: 4_000 }, 204_000);
    expect(goalElapsedMs(l.current(), 300_000)).toBe(12_000);
    const restored = l.events.reduce<GoalState | undefined>(
      (g, e) => reduceGoal(g, e, e.time !== new Date(100_000).toISOString()),
      undefined,
    );
    expect(restored).toEqual(l.goal());
    l.emit("session.config_changed", { goal: null });
    expect(l.goal()).toBeUndefined();
  });
});
