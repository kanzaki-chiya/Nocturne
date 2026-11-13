/**
 * Ensemble 结构化活动摘要（ADR-0089 修订 2026-11-12）与 `/ensemble board|end` 子命令解析。
 */
import { describe, expect, it } from "vitest";

import {
  WORK_MODE_COMMANDS,
  applyEnsembleMemberUpdated,
  parseWorkModeSlash,
  reduceEnsembleDurable,
  summarizeEnsembleToolCall,
  workModeDisplayText,
  type DurableEvent,
  type DurablePayloadMap,
  type DurableType,
  type ModelRef,
  type EnsembleView,
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

function build(events: DurableEvent[]): EnsembleView {
  let ensemble: EnsembleView | undefined;
  for (const e of events) {
    ensemble = reduceEnsembleDurable(ensemble, e, { forkSeq: 0, maestroModel: MODEL });
  }
  if (ensemble === undefined) throw new Error("no ensemble");
  return ensemble;
}

function base(): DurableEvent[] {
  seq = 0;
  return [
    ev("ensemble.created", { title: "T" }),
    ev("ensemble.member_added", {
      name: "api",
      childSessionId: "c1",
      charter: { owns: "src/api\nmore", handsOff: "ui", doneWhen: "tests pass" },
      model: MODEL,
      preset: "general",
      isolated: false,
    }),
  ];
}

function member(ensemble: EnsembleView) {
  const m = ensemble.members.find((x) => x.name === "api");
  if (m === undefined) throw new Error("no member");
  return m;
}

const ENGLISH = /Waiting permission|Paused on error|Removed|shell: /u;

describe("Ensemble 结构化活动摘要", () => {
  it("member_added 之后为任务书首行 charter", () => {
    const ensemble = build(base());
    expect(member(ensemble).activity).toEqual({ kind: "charter", line: "src/api" });
  });

  it("endedSeq：活动期间为 undefined，ensemble.ended 记录事件 seq，新 ensemble.created 重置", () => {
    const events = base();
    const active = build(events);
    expect(active.status).toBe("active");
    expect(active.endedSeq).toBeUndefined();

    seq = 41;
    const endedEvent = ev("ensemble.ended", { reason: "user" });
    expect(endedEvent.seq).toBe(42);
    const ended = build([...events, endedEvent]);
    expect(ended.status).toBe("ended");
    expect(ended.endedSeq).toBe(42);

    seq = 49;
    const recreatedEvent = ev("ensemble.created", { title: "T2" });
    expect(recreatedEvent.seq).toBe(50);
    const restarted = build([...events, endedEvent, recreatedEvent]);
    expect(restarted.createdSeq).toBe(50);
    expect(restarted.endedSeq).toBeUndefined();
  });

  it("posted 之后为 post（成员）；指挥帖子写入指挥 activity", () => {
    const events = base();
    events.push(
      ev("ensemble.posted", {
        number: 2,
        from: "api",
        fromKind: "member",
        text: "\n done: added route \nsecond",
        mentions: ["maestro"],
        recipients: ["maestro"],
      }),
      ev("ensemble.posted", {
        number: 3,
        from: "maestro",
        fromKind: "maestro",
        text: "@api thanks",
        mentions: ["api"],
        recipients: ["api"],
      }),
    );
    const ensemble = build(events);
    expect(member(ensemble).activity).toEqual({
      kind: "post",
      number: 2,
      line: "done: added route",
    });
    expect(ensemble.maestro.activity).toEqual({ kind: "post", number: 3, line: "@api thanks" });
  });

  it("member_updated：工具、确认、暂停三种取值，toolActivity 是对象", () => {
    const ensemble = build(base());
    applyEnsembleMemberUpdated(ensemble, {
      name: "api",
      status: "working",
      toolActivity: { tool: "shell", detail: "pnpm test" },
    });
    expect(member(ensemble).toolActivity).toEqual({ tool: "shell", detail: "pnpm test" });
    expect(member(ensemble).activity).toEqual({ kind: "tool", tool: "shell", detail: "pnpm test" });

    applyEnsembleMemberUpdated(ensemble, {
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
    expect(member(ensemble).activity).toEqual({ kind: "permission", target: "a.ts" });
    expect(ensemble.awaitingPermissionMembers).toEqual(["api"]);

    applyEnsembleMemberUpdated(ensemble, {
      name: "api",
      status: "paused",
      pauseError: { code: "quota_exceeded", message: "429" },
    });
    expect(member(ensemble).activity).toEqual({
      kind: "paused",
      code: "quota_exceeded",
      message: "429",
    });
    expect(JSON.stringify(ensemble)).not.toMatch(ENGLISH);
  });

  it("member_removed 之后为 removed，带或不带原因", () => {
    const events = base();
    events.push(
      ev("ensemble.member_added", {
        name: "ui",
        childSessionId: "c2",
        charter: { owns: "ui", handsOff: "api", doneWhen: "ok" },
        model: MODEL,
        preset: "general",
        isolated: false,
      }),
      ev("ensemble.member_removed", { name: "api", reason: "done early" }),
      ev("ensemble.member_removed", { name: "ui" }),
    );
    const ensemble = build(events);
    expect(member(ensemble).activity).toEqual({ kind: "removed", reason: "done early" });
    expect(ensemble.members[1]?.activity).toEqual({ kind: "removed" });
    expect(JSON.stringify(ensemble)).not.toMatch(ENGLISH);
  });

  it("指挥 tool.started 写入 tool 活动；summarizeEnsembleToolCall 返回对象且取值规则不变", () => {
    expect(summarizeEnsembleToolCall("shell", { command: "\npnpm test\nmore" })).toEqual({
      tool: "shell",
      detail: "pnpm test",
    });
    expect(summarizeEnsembleToolCall("ensemble_checkout", { member: "api" })).toEqual({
      tool: "ensemble_checkout",
      detail: "@api",
    });
    expect(summarizeEnsembleToolCall("todo_write", {})).toEqual({ tool: "todo_write" });
    const long = "x".repeat(100);
    expect(summarizeEnsembleToolCall("read", { path: long }).detail).toBe(`${"x".repeat(77)}…`);

    const events = base();
    events.push({
      type: "tool.started",
      sessionId: "coord",
      seq: ++seq,
      time: "2026-11-12T10:00:00.000Z",
      turnId: "t1",
      payload: { callId: "k", name: "read", input: { path: "a.ts" } },
    } as unknown as DurableEvent);
    const ensemble = build(events);
    expect(ensemble.maestro.activity).toEqual({ kind: "tool", tool: "read", detail: "a.ts" });
  });
});

describe("/ensemble 子命令解析", () => {
  it("整行恰好是 /ensemble board、/ensemble end 才算子命令", () => {
    expect(parseWorkModeSlash("/ensemble board")).toEqual({
      kind: "action",
      action: "ensemble-board",
    });
    expect(parseWorkModeSlash(" /Ensemble END ")).toEqual({
      kind: "action",
      action: "ensemble-end",
    });
    expect(parseWorkModeSlash("/ensemble 做个登录页")).toEqual({
      kind: "submit",
      workMode: "ensemble",
      text: "做个登录页",
    });
    expect(parseWorkModeSlash("/ensemble")).toEqual({
      kind: "usage",
      name: "ensemble",
      hint: "用法：/ensemble 任务",
    });
    expect(parseWorkModeSlash("/ensemble board")).toEqual({
      kind: "action",
      action: "ensemble-board",
    });
    expect(parseWorkModeSlash(" /Ensemble END ")).toEqual({
      kind: "action",
      action: "ensemble-end",
    });
    expect(parseWorkModeSlash("/ensemble board 改一下")).toEqual({
      kind: "submit",
      workMode: "ensemble",
      text: "board 改一下",
    });
    expect(parseWorkModeSlash("/ensemble")).toEqual({
      kind: "usage",
      name: "ensemble",
      hint: "用法：/ensemble 任务",
    });
    expect(workModeDisplayText("做个任务", { name: "ensemble" })).toBe("/ensemble 做个任务");
    expect(WORK_MODE_COMMANDS.map((c) => c.name)).toContain("/ensemble");
    expect(WORK_MODE_COMMANDS.find((c) => c.name === "/ensemble")?.summary).toBe("合奏协作");
  });
});
