/**
 * ADR-0064 第 5、6 节：会话级非交互（无人值守）与恢复交互。
 * 定时会话的第一轮按非交互处理：剩余 ask 直接拒绝、ask_user 以 not_interactive 结算、
 * smart 的审查放行照常执行；客户端提交第二条用户消息后转为交互且不再变回，
 * 关闭再打开后状态由日志推出。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import type { RuntimeEvent, SessionSchedule } from "../src/protocol/index.js";
import {
  createAttendance,
  UNATTENDED_DENY_HINT,
  type SecurityReviewer,
} from "../src/permission/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

const SCHEDULE: SessionSchedule = {
  taskId: "task-1",
  scheduledAt: "2026-10-25T01:00:00.000Z",
  trigger: "schedule",
};

async function makeRuntime(
  scripts: FakeScript[],
  extra: { interactive?: boolean; reviewer?: SecurityReviewer; sessionsDir?: string } = {},
): Promise<{ runtime: Runtime; ws: string; sessionsDir: string }> {
  const ws = makeTmp("nct-un-ws-");
  const sessionsDir = extra.sessionsDir ?? makeTmp("nct-un-sd-");
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [new FakeProvider({ scripts })],
    interactive: extra.interactive ?? true,
    permissions: extra.reviewer !== undefined ? { reviewer: extra.reviewer } : undefined,
  });
  return { runtime, ws, sessionsDir };
}

const scheduled = (runtime: Runtime, extra: { permissionPreset?: string } = {}) =>
  runtime.createSession({
    model: "fake/fake-model",
    interactive: false,
    schedule: SCHEDULE,
    ...extra,
  });

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

const writeTurn = (rel: string): FakeScript[] => [
  [
    { type: "tool_call", toolCallId: "w", name: "write", input: { path: rel, content: "x" } },
    { type: "finish", reason: "tool_calls" },
  ],
  [
    { type: "text_delta", text: "done" },
    { type: "finish", reason: "stop" },
  ],
];

const requested = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "permission.requested");
const resolvedSources = (events: RuntimeEvent[]) =>
  events.flatMap((e) => (e.type === "permission.resolved" ? [e.payload.source] : []));

describe("createAttendance（日志推出是否已恢复交互）", () => {
  it("非交互的 Runtime 里恒为 false", () => {
    const interactive = createAttendance({
      runtimeInteractive: false,
      unattended: false,
      userMessageCount: () => 5,
    });
    expect(interactive()).toBe(false);
  });

  it("普通会话沿用 Runtime 的值", () => {
    expect(
      createAttendance({
        runtimeInteractive: true,
        unattended: false,
        userMessageCount: () => 0,
      })(),
    ).toBe(true);
  });

  it("无人值守：第 1 条用户消息之前、之时都是 false，第 2 条出现后转为 true 且不再变回", () => {
    let count = 0;
    const interactive = createAttendance({
      runtimeInteractive: true,
      unattended: true,
      userMessageCount: () => count,
    });
    expect(interactive()).toBe(false);
    count = 1;
    expect(interactive()).toBe(false);
    count = 2;
    expect(interactive()).toBe(true);
    count = 0;
    expect(interactive()).toBe(true);
  });
});

describe("定时会话的第一轮：无人值守", () => {
  it("剩余 ask 被拒绝（non_interactive）、不发 permission.requested、拒绝文案带无人值守指引", async () => {
    const { runtime, ws } = await makeRuntime(writeTurn("out.txt"));
    const session = await scheduled(runtime);
    const events = collect(session);
    expect(await session.submit({ text: "跑一下" })).toBe("done");

    expect(existsSync(path.join(ws, "out.txt"))).toBe(false);
    expect(requested(events)).toHaveLength(0);
    expect(resolvedSources(events)).toEqual(["non_interactive"]);
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
    expect(completed?.type === "tool.completed" && completed.payload.modelContent).toContain(
      UNATTENDED_DENY_HINT,
    );
    await session.close();
  });

  it("来源写入 meta，并出现在会话列表摘要里", async () => {
    const { runtime } = await makeRuntime(writeTurn("out.txt"));
    const session = await scheduled(runtime);
    expect(session.state().meta.schedule).toEqual(SCHEDULE);
    await session.submit({ text: "跑一下" });
    const listed = (await runtime.listSessions()).find((s) => s.id === session.id);
    expect(listed?.schedule).toEqual(SCHEDULE);
    await session.close();
  });

  it("ask_user 以 not_interactive 结算，不发 question.requested", async () => {
    const { runtime } = await makeRuntime([
      [
        {
          type: "tool_call",
          toolCallId: "q1",
          name: "ask_user",
          input: { questions: [{ question: "用哪个？" }] },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "按默认继续" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await scheduled(runtime);
    const events = collect(session);
    expect(await session.submit({ text: "跑一下" })).toBe("done");

    expect(events.some((e) => e.type === "question.requested")).toBe(false);
    const completed = events.find(
      (e) => e.type === "tool.completed" && e.payload.name === "ask_user",
    );
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("error");
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "not_interactive",
    );
    await session.close();
  });

  it("smart 的审查放行照常执行", async () => {
    const outside = path.join(makeTmp("nct-un-out-"), "result.txt");
    const reviewer: SecurityReviewer = {
      backend: "custom",
      review: async () => ({ verdict: "allow", reason: "写入合理" }),
    };
    const { runtime } = await makeRuntime(writeTurn(outside), { reviewer });
    const session = await scheduled(runtime, { permissionPreset: "smart" });
    const events = collect(session);
    expect(await session.submit({ text: "跑一下" })).toBe("done");

    expect(readFileSync(outside, "utf8")).toBe("x");
    expect(requested(events)).toHaveLength(0);
    expect(resolvedSources(events)).toEqual(["reviewer"]);
    await session.close();
  });

  it("smart 审查交给用户确认（unsure）仍被非交互拒绝", async () => {
    const outside = path.join(makeTmp("nct-un-out-"), "result.txt");
    const reviewer: SecurityReviewer = {
      backend: "custom",
      review: async () => ({ verdict: "unsure", reason: "拿不准" }),
    };
    const { runtime } = await makeRuntime(writeTurn(outside), { reviewer });
    const session = await scheduled(runtime, { permissionPreset: "smart" });
    const events = collect(session);
    await session.submit({ text: "跑一下" });

    expect(existsSync(outside)).toBe(false);
    expect(requested(events)).toHaveLength(0);
    expect(resolvedSources(events)).toEqual(["non_interactive"]);
    await session.close();
  });

  it("非交互的 Runtime 里 interactive:true 不会开出交互会话", async () => {
    const { runtime, ws } = await makeRuntime([...writeTurn("a.txt"), ...writeTurn("b.txt")], {
      interactive: false,
    });
    const session = await runtime.createSession({ model: "fake/fake-model", interactive: true });
    const events = collect(session);
    await session.submit({ text: "一" });
    await session.submit({ text: "二" });
    expect(requested(events)).toHaveLength(0);
    expect(existsSync(path.join(ws, "a.txt"))).toBe(false);
    await session.close();
  });
});

describe("客户端提交新消息后恢复交互", () => {
  it("第二条用户消息起权限请求照常发出，并可批准执行", async () => {
    const { runtime, ws } = await makeRuntime([...writeTurn("a.txt"), ...writeTurn("b.txt")]);
    const session = await scheduled(runtime);
    const events = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested")
        void session.respondPermission(e.payload.requestId, { decision: "allow" });
    });

    await session.submit({ text: "定时任务指令" });
    expect(requested(events)).toHaveLength(0);
    expect(existsSync(path.join(ws, "a.txt"))).toBe(false);

    await session.submit({ text: "继续，写 b" });
    expect(requested(events)).toHaveLength(1);
    expect(readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("x");
    expect(resolvedSources(events)).toEqual(["non_interactive", "user"]);
    await session.close();
  });

  it("关闭再打开：尚无任何消息时仍是无人值守，第 1 条提交按非交互处理", async () => {
    const { runtime, ws } = await makeRuntime(writeTurn("a.txt"));
    const created = await scheduled(runtime);
    const id = created.id;
    await created.close();

    const reopened = await runtime.resumeSession(id);
    expect(reopened.state().meta.schedule).toEqual(SCHEDULE);
    const events = collect(reopened);
    await reopened.submit({ text: "定时任务指令" });
    expect(requested(events)).toHaveLength(0);
    expect(resolvedSources(events)).toEqual(["non_interactive"]);
    expect(existsSync(path.join(ws, "a.txt"))).toBe(false);
    await reopened.close();
  });

  it("关闭再打开：已有客户端提交的会话保持交互", async () => {
    const { runtime, ws } = await makeRuntime([
      ...writeTurn("a.txt"),
      ...writeTurn("b.txt"),
      ...writeTurn("c.txt"),
    ]);
    const first = await scheduled(runtime);
    first.subscribe((e) => {
      if (e.type === "permission.requested")
        void first.respondPermission(e.payload.requestId, { decision: "allow" });
    });
    await first.submit({ text: "定时任务指令" });
    await first.submit({ text: "我来接着聊" });
    const id = first.id;
    await first.close();

    const reopened = await runtime.resumeSession(id);
    const events = collect(reopened);
    reopened.subscribe((e) => {
      if (e.type === "permission.requested")
        void reopened.respondPermission(e.payload.requestId, { decision: "allow" });
    });
    await reopened.submit({ text: "再写一个" });
    expect(requested(events)).toHaveLength(1);
    expect(readFileSync(path.join(ws, "c.txt"), "utf8")).toBe("x");
    await reopened.close();
  });

  it("关闭再打开：第一轮结束后只读打开（未提交）不改变来源", async () => {
    const { runtime } = await makeRuntime(writeTurn("a.txt"));
    const session = await scheduled(runtime);
    await session.submit({ text: "定时任务指令" });
    const id = session.id;
    await session.close();
    const reopened = await runtime.resumeSession(id);
    expect(reopened.state().meta.schedule).toEqual(SCHEDULE);
    await reopened.close();
  });
});

describe("分叉不继承定时任务来源", () => {
  it("分叉出的会话没有 meta.schedule，是用户的普通交互会话", async () => {
    const { runtime } = await makeRuntime(writeTurn("a.txt"));
    const session = await scheduled(runtime);
    await session.submit({ text: "定时任务指令" });
    const forkId = await runtime.forkSession(session.id);
    await session.close();

    const fork = await runtime.resumeSession(forkId);
    expect(fork.state().meta.schedule).toBeUndefined();
    expect(fork.state().meta.forkedFrom?.sessionId).toBe(session.id);
    await fork.close();
  });
});
