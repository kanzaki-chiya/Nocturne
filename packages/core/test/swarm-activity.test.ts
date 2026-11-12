/**
 * Swarm 结构化活动摘要（ADR-0089 修订 2026-11-12）与 `/swarm board|end` 子命令解析。
 */
import { describe, expect, it } from "vitest";

import {
  applySwarmMemberUpdated,
  parseWorkModeSlash,
  reduceSwarmDurable,
  summarizeSwarmToolCall,
  type DurableEvent,
  type DurablePayloadMap,
  type DurableType,
  type ModelRef,
  type SwarmView,
} from "../src/protocol/index.js";

const MODEL: ModelRef = { provider: "p", model: "m" } as ModelRef;
let seq = 0;

function ev<T extends DurableType>(type: T, payload: DurablePayloadMap[T]): DurableEvent {
  seq += 1;
  return {
    type,
    sessionId: "coord",
    seq,
    time: "2026-11-12T10:00:00.000Z",
    payload,
  } as DurableEvent;
}

function build(events: DurableEvent[]): SwarmView {
  let swarm: SwarmView | undefined;
  for (const e of events) {
    swarm = reduceSwarmDurable(swarm, e, { forkSeq: 0, coordinatorModel: MODEL });
  }
  if (swarm === undefined) throw new Error("no swarm");
  return swarm;
}

function base(): DurableEvent[] {
  seq = 0;
  return [
    ev("swarm.created", { title: "T" }),
    ev("swarm.member_added", {
      name: "api",
      childSessionId: "c1",
      charter: { owns: "src/api\nmore", handsOff: "ui", doneWhen: "tests pass" },
      model: MODEL,
      preset: "general",
      isolated: false,
    }),
  ];
}

function member(swarm: SwarmView) {
  const m = swarm.members.find((x) => x.name === "api");
  if (m === undefined) throw new Error("no member");
  return m;
}

const ENGLISH = /Waiting permission|Paused on error|Removed|shell: /u;

describe("Swarm 结构化活动摘要", () => {
  it("member_added 之后为任务书首行 charter", () => {
    const swarm = build(base());
    expect(member(swarm).activity).toEqual({ kind: "charter", line: "src/api" });
  });

  it("endedSeq：活动期间为 undefined，swarm.ended 记录事件 seq，新 swarm.created 重置", () => {
    const events = base();
    const active = build(events);
    expect(active.status).toBe("active");
    expect(active.endedSeq).toBeUndefined();

    seq = 41;
    const endedEvent = ev("swarm.ended", { reason: "user" });
    expect(endedEvent.seq).toBe(42);
    const ended = build([...events, endedEvent]);
    expect(ended.status).toBe("ended");
    expect(ended.endedSeq).toBe(42);

    seq = 49;
    const recreatedEvent = ev("swarm.created", { title: "T2" });
    expect(recreatedEvent.seq).toBe(50);
    const restarted = build([...events, endedEvent, recreatedEvent]);
    expect(restarted.createdSeq).toBe(50);
    expect(restarted.endedSeq).toBeUndefined();
  });

  it("posted 之后为 post（成员）；协调者帖子写入协调者 activity", () => {
    const events = base();
    events.push(
      ev("swarm.posted", {
        number: 2,
        from: "api",
        fromKind: "member",
        text: "\n done: added route \nsecond",
        mentions: ["coordinator"],
        recipients: ["coordinator"],
      }),
      ev("swarm.posted", {
        number: 3,
        from: "coordinator",
        fromKind: "coordinator",
        text: "@api thanks",
        mentions: ["api"],
        recipients: ["api"],
      }),
    );
    const swarm = build(events);
    expect(member(swarm).activity).toEqual({ kind: "post", number: 2, line: "done: added route" });
    expect(swarm.coordinator.activity).toEqual({ kind: "post", number: 3, line: "@api thanks" });
  });

  it("member_updated：工具、确认、暂停三种取值，toolActivity 是对象", () => {
    const swarm = build(base());
    applySwarmMemberUpdated(swarm, {
      name: "api",
      status: "working",
      toolActivity: { tool: "shell", detail: "pnpm test" },
    });
    expect(member(swarm).toolActivity).toEqual({ tool: "shell", detail: "pnpm test" });
    expect(member(swarm).activity).toEqual({ kind: "tool", tool: "shell", detail: "pnpm test" });

    applySwarmMemberUpdated(swarm, {
      name: "api",
      status: "working",
      toolActivity: { tool: "write", detail: "a.ts" },
      pendingPermissions: [
        {
          requestId: "r1",
          callId: "k1",
          reason: "write file",
          subjects: [{ kind: "path", target: "a.ts" } as never],
          options: [],
        },
      ],
    });
    expect(member(swarm).activity).toEqual({ kind: "permission", target: "a.ts" });
    expect(swarm.awaitingPermissionMembers).toEqual(["api"]);

    applySwarmMemberUpdated(swarm, {
      name: "api",
      status: "paused",
      pauseError: { code: "quota_exceeded", message: "429" },
    });
    expect(member(swarm).activity).toEqual({
      kind: "paused",
      code: "quota_exceeded",
      message: "429",
    });
    expect(JSON.stringify(swarm)).not.toMatch(ENGLISH);
  });

  it("member_removed 之后为 removed，带或不带原因", () => {
    const events = base();
    events.push(
      ev("swarm.member_added", {
        name: "ui",
        childSessionId: "c2",
        charter: { owns: "ui", handsOff: "api", doneWhen: "ok" },
        model: MODEL,
        preset: "general",
        isolated: false,
      }),
      ev("swarm.member_removed", { name: "api", reason: "done early" }),
      ev("swarm.member_removed", { name: "ui" }),
    );
    const swarm = build(events);
    expect(member(swarm).activity).toEqual({ kind: "removed", reason: "done early" });
    expect(swarm.members[1]?.activity).toEqual({ kind: "removed" });
    expect(JSON.stringify(swarm)).not.toMatch(ENGLISH);
  });

  it("协调者 tool.started 写入 tool 活动；summarizeSwarmToolCall 返回对象且取值规则不变", () => {
    expect(summarizeSwarmToolCall("shell", { command: "\npnpm test\nmore" })).toEqual({
      tool: "shell",
      detail: "pnpm test",
    });
    expect(summarizeSwarmToolCall("swarm_checkout", { member: "api" })).toEqual({
      tool: "swarm_checkout",
      detail: "@api",
    });
    expect(summarizeSwarmToolCall("todo_write", {})).toEqual({ tool: "todo_write" });
    const long = "x".repeat(100);
    expect(summarizeSwarmToolCall("read", { path: long }).detail).toBe(`${"x".repeat(77)}…`);

    const events = base();
    events.push({
      type: "tool.started",
      sessionId: "coord",
      seq: ++seq,
      time: "2026-11-12T10:00:00.000Z",
      turnId: "t1",
      payload: { callId: "k", name: "read", input: { path: "a.ts" } },
    } as unknown as DurableEvent);
    const swarm = build(events);
    expect(swarm.coordinator.activity).toEqual({ kind: "tool", tool: "read", detail: "a.ts" });
  });
});

describe("/swarm 子命令解析", () => {
  it("整行恰好是 /swarm board、/swarm end 才算子命令", () => {
    expect(parseWorkModeSlash("/swarm board")).toEqual({ kind: "action", action: "swarm-board" });
    expect(parseWorkModeSlash(" /Swarm END ")).toEqual({ kind: "action", action: "swarm-end" });
    expect(parseWorkModeSlash("/swarm board 改一下")).toEqual({
      kind: "submit",
      workMode: "swarm",
      text: "board 改一下",
    });
    expect(parseWorkModeSlash("/swarm")).toEqual({
      kind: "usage",
      name: "swarm",
      hint: "用法：/swarm 任务",
    });
  });
});
