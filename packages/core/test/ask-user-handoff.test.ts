/**
 * r1126l · ACP 第三阶段（ADR-0127）：宿主挂起/交还行为的钉住测试。
 *
 * 产品语义（用户确认）：
 * - 文本宿主展示问题后正常交还控制，下一轮按真实回答继续；
 *   在回答前不得按假设执行依赖该选择的动作。
 * - 只有用户明确拒绝才用 declined；宿主不支持/取消/断连/超时不得写成「用户拒答」。
 *
 * 测试驱动最小 Core 语义：
 * - broker.ask 可解析为 `{ kind: "suspended" }`——等待中的提问被宿主挂起交还；
 * - `question.suspend(requestId)` 命令把等待中的提问结算为 suspended，
 *   使 ask_user 工具以 error/handoff_suspended 收尾（不持久化问题形状）；
 * - suspended 不是「用户拒答」：模型不得把它当作 declined 继续按假设执行依赖项。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import type { DurableEvent, RuntimeEvent } from "../src/protocol/index.js";
import { createQuestionBroker } from "../src/tools/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

async function makeRuntime(
  scripts: FakeScript[] | undefined,
  extra: { interactive?: boolean } = {},
): Promise<{ runtime: Runtime; ws: string }> {
  const ws = makeTmp("nct-auh-ws-");
  const provider = new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir: makeTmp("nct-auh-sd-"),
    providers: [provider],
    interactive: extra.interactive,
  });
  return { runtime, ws };
}

const makeSession = (runtime: Runtime) => runtime.createSession({ model: "fake/fake-model" });

function collect(session: RuntimeSession) {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

const askThenDone = (questions: unknown): FakeScript[] => [
  [
    { type: "tool_call", toolCallId: "q1", name: "ask_user", input: { questions } },
    { type: "finish", reason: "tool_calls" },
  ],
  [
    { type: "text_delta", text: "done" },
    { type: "finish", reason: "stop" },
  ],
];

function waitEvent(
  session: RuntimeSession,
  seen: RuntimeEvent[],
  match: (e: RuntimeEvent) => boolean,
): Promise<RuntimeEvent> {
  const found = seen.find(match);
  if (found !== undefined) return Promise.resolve(found);
  return new Promise((resolve) => {
    const off = session.subscribe((e) => {
      if (match(e)) {
        off();
        resolve(e);
      }
    });
  });
}

describe("ask_user 宿主挂起（r1126l / ADR-0127 第三阶段）", () => {
  it("broker.ask 支持 suspended 结算，取消/中断仍按原路径拒绝", async () => {
    const broker = createQuestionBroker({ interactive: true });
    const emitted: { type: string; payload: unknown }[] = [];
    const turn = {
      turnId: "t1",
      events: {
        emitEphemeral: (type: string, payload: unknown) => {
          emitted.push({ type, payload });
        },
      },
    } as never;
    const controller = new AbortController();
    const wait = broker.ask("call-1", { questions: [{ question: "q?" }] }, turn, controller.signal);
    const requestId = [...broker.pendingKeys()][0];
    if (requestId === undefined) throw new Error("pending request missing");
    expect(broker.suspend(requestId)).toBe("ok");
    await expect(wait).resolves.toEqual({ kind: "suspended" });
    expect(broker.suspend(requestId)).toBe("unknown_request");
    const controller2 = new AbortController();
    const wait2 = broker.ask(
      "call-2",
      { questions: [{ question: "q2?" }] },
      turn,
      controller2.signal,
    );
    controller2.abort();
    await expect(wait2).rejects.toThrow();
  });

  it("RuntimeSession.questionSuspend 结算等待中的提问为 handoff_suspended，不写成用户拒答", async () => {
    const { runtime } = await makeRuntime(
      askThenDone([{ question: "用哪个方案？", options: [{ label: "A" }, { label: "B" }] }]),
      { interactive: true },
    );
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "ask" });
    const req = await waitEvent(session, events, (e) => e.type === "question.requested");
    if (req.type !== "question.requested") throw new Error("missing question.requested");

    await session.questionSuspend(req.payload.requestId);
    const reason = await turn;
    expect(reason).toBe("done");

    const completed = events.filter(
      (e): e is DurableEvent<"tool.completed"> =>
        e.type === "tool.completed" && e.payload.name === "ask_user",
    );
    expect(completed).toHaveLength(1);
    const payload = completed[0]?.payload;
    expect(payload?.status).toBe("error");
    expect(payload?.error?.code).toBe("handoff_suspended");
    expect(String(payload?.modelContent)).not.toContain("用户拒绝回答");
    await session.close();
  });

  it("questionSuspend 未知/已结算 requestId 报 unknown_request", async () => {
    const { runtime } = await makeRuntime(
      askThenDone([{ question: "q", options: [{ label: "A" }, { label: "B" }] }]),
      { interactive: true },
    );
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "ask" });
    const req = await waitEvent(session, events, (e) => e.type === "question.requested");
    if (req.type !== "question.requested") throw new Error("missing question.requested");
    await expect(session.questionSuspend("q-unknown")).rejects.toMatchObject({
      code: "unknown_request",
    });
    await session.questionSuspend(req.payload.requestId);
    await expect(session.questionSuspend(req.payload.requestId)).rejects.toMatchObject({
      code: "unknown_request",
    });
    await turn;
    await session.close();
  });
});
