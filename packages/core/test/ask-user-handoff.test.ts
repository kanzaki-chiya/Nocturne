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

  it("挂起后本轮有序收尾：不再发起下一次推理，依赖答复的合成写操作不落盘；新一轮按真实值继续", async () => {
    // 测试 provider 用 handler 精确计数推理次数：
    // 第 1 次推理发起 ask_user；之后即便模型「想」继续，运行时也不再请求。
    // 若错误地在 handoff 轮内发起第 2 次推理，handler 会返回一个合成 write 调用；
    // 该 write 在 default 权限预设下会请求审批——测试用权限停滞作为哨兵：
    // 正确行为下根本不应到达第 2 次推理（handoff 轮内推理恒为 1 次）。
    const inferenceLog: string[] = [];
    // 记录每次推理发生时，当前是否仍处于 handoff 那一轮（turn 尚未 done）。
    const inferenceDuringHandoffTurn: number[] = [];
    let handoffTurnDone = false;
    const handler = (request: { messages: unknown }, callIndex: number): FakeScript => {
      inferenceLog.push(`inference-${callIndex}`);
      if (!handoffTurnDone && callIndex > 0) inferenceDuringHandoffTurn.push(callIndex);
      if (callIndex === 0) {
        return [
          {
            type: "tool_call",
            toolCallId: "q1",
            name: "ask_user",
            input: {
              questions: [
                { question: "用哪个方案？", options: [{ label: "方案A" }, { label: "方案B" }] },
              ],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      // 多余推理（错误路径才会到达）：提出依赖答复的合成写操作。
      return [
        {
          type: "tool_call",
          toolCallId: "w1",
          name: "write",
          input: { path: "dependent-write.txt", content: "ASSUMED-WRITE" },
        },
        { type: "finish", reason: "tool_calls" },
      ];
    };
    const ws = makeTmp("nct-auh-ws-");
    const provider = new FakeProvider({ handler });
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: makeTmp("nct-auh-sd-"),
      providers: [provider],
      interactive: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "ask" });
    const req = await waitEvent(session, events, (e) => e.type === "question.requested");
    if (req.type !== "question.requested") throw new Error("missing question.requested");

    // 宿主展示问题后挂起交还
    await session.questionSuspend(req.payload.requestId);
    const reason = await turn;
    handoffTurnDone = true;
    // 本轮以 done 有序收尾（交还控制，不是 error/cancelled）
    expect(reason).toBe("done");
    // 钉住核心行为：handoff 轮内没有发起第二次推理
    expect(inferenceLog).toEqual(["inference-0"]);
    expect(inferenceDuringHandoffTurn).toEqual([]);
    // 依赖答复的合成写操作从未执行（无 tool.completed、无落盘）
    const writeCompleted = events.filter(
      (e) => e.type === "tool.completed" && e.payload.name === "write",
    );
    expect(writeCompleted).toHaveLength(0);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(ws, "dependent-write.txt"))).toBe(false);
    // ask_user 以 handoff_suspended 结算、非用户拒答
    const askCompleted = events.filter(
      (e): e is DurableEvent<"tool.completed"> =>
        e.type === "tool.completed" && e.payload.name === "ask_user",
    );
    expect(askCompleted[0]?.payload.error?.code).toBe("handoff_suspended");

    // 新一轮：用户给出真实答复后，按真实值继续（而非按假设）
    // 第 2 次推理在新 turn 发生；handler 此时返回 write 探测，
    // 但该 write 需审批——这里只验证请求历史带上真实答复后立即中断，
    // 不让审批挂起阻塞测试。
    const turn2 = session.submit({ text: "方案A" });
    // 等第 2 次推理确实发出（新一轮的证明）
    await waitEvent(session, events, (e) => e.type === "turn.completed" || inferenceLog.length >= 2);
    // 轮询直到第 2 次推理记录出现
    for (let i = 0; i < 50 && inferenceLog.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(inferenceLog.length).toBeGreaterThanOrEqual(2);
    const secondReq = provider.requests[1];
    expect(secondReq).toBeDefined();
    const secondText = JSON.stringify(secondReq?.messages ?? []);
    expect(secondText).toContain("方案A");
    // write 探测的审批挂起不代表失败——中断本轮收尾，避免阻塞
    session.interrupt();
    await turn2.catch(() => undefined);
    await session.close();
  });
});
