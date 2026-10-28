/**
 * 待发输入（ADR-0070）的 RPC 往返：插话/排队方法、input.pending 转发、错误码、
 * 远程可用（rpc.md 第 7 节）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";

import { cleanupTmp, connectMany, MODEL, textScript, until, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);

/** 调用 ask_user 把 Turn 稳在"工具执行中" */
const askScript = [
  {
    type: "tool_call" as const,
    toolCallId: "q1",
    name: "ask_user",
    input: { questions: [{ question: "用哪个方案？" }] },
  },
  { type: "finish" as const, reason: "tool_calls" as const },
];

const pendingSnapshots = (events: RuntimeEvent[]) =>
  events.filter((event) => event.type === "input.pending");

describe("待发输入（ADR-0070）", () => {
  it("空闲时提交直接开始，运行中入列并转发快照；编辑、撤回与 input_consumed", async () => {
    const h = await connectMany({
      provider: new FakeProvider({
        handler: (_request, index) =>
          index === 1 || index === 3 ? askScript : textScript(`第 ${index} 次回复`),
        models: VISION_MODELS,
      }),
    });
    const { session } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const events: RuntimeEvent[] = [];
    await session.subscribe((event) => events.push(event));

    // 空闲：与 submit 等价立即开始，queued=false，id 不进列表
    const idle = await session.enqueueInput("steer", { text: "先来一句" });
    expect(idle.queued).toBe(false);
    expect((await session.pendingInputs()).items).toEqual([]);
    await until(() => events.some((event) => event.type === "message.user"));
    await until(() => events.some((event) => event.type === "turn.completed"));

    let turn = session.submit({ text: "开始" });
    await until(() => events.some((event) => event.type === "question.requested"));
    const asked = events.find((event) => event.type === "question.requested");
    if (asked?.type !== "question.requested") throw new Error("缺少提问请求");

    // 手机（远程连接）看同一会话并插话
    const remote = await h.add();
    const phone = (await remote.client.runtime.resumeSession(session.id)).session;
    const phoneEvents: RuntimeEvent[] = [];
    await phone.subscribe((event) => phoneEvents.push(event));

    const enqueued = await phone.enqueueInput("steer", { text: "改成蓝色" });
    expect(enqueued.queued).toBe(true);
    await until(() => pendingSnapshots(phoneEvents).length > 0, "手机收到快照");
    await until(() => pendingSnapshots(events).length > 0, "电脑收到快照");
    const snapshot = await phone.pendingInputs();
    expect(snapshot.paused).toBe(false);
    expect(snapshot.items).toMatchObject([
      { id: enqueued.id, mode: "steer", text: "改成蓝色", attachments: 0, paused: false },
    ]);
    // 两个客户端的快照同形
    expect(pendingSnapshots(events).at(-1)).toMatchObject({
      type: "input.pending",
      sessionId: session.id,
      payload: snapshot,
    });

    await phone.updateInput(enqueued.id, { mode: "queue", input: { text: "改成绿色" } });
    expect((await session.pendingInputs()).items[0]).toMatchObject({
      mode: "queue",
      text: "改成绿色",
    });
    await phone.updateInput(enqueued.id, { mode: "steer" });
    await phone.respondQuestion(asked.payload.requestId, {
      answers: [{ selected: [], text: "按你说的" }],
    });
    expect(await turn).toBe("done");
    const steer = events.findLast((event) => event.type === "message.user");
    expect(steer?.type === "message.user" && steer.payload.steer).toBe(true);
    expect(JSON.stringify(steer)).toContain("改成绿色");
    expect((await session.pendingInputs()).items).toEqual([]);

    // 已消费：编辑与撤回都以 input_consumed 拒绝
    await expect(phone.updateInput(enqueued.id, { input: { text: "太晚" } })).rejects.toMatchObject(
      {
        code: "input_consumed",
      },
    );
    await expect(phone.cancelInput(enqueued.id)).rejects.toMatchObject({
      code: "input_consumed",
    });

    // 排队：done 后自动开新 Turn，手机端也能提交
    const questionsBefore = events.filter((event) => event.type === "question.requested").length;
    turn = session.submit({ text: "再来" });
    await until(
      () => events.filter((event) => event.type === "question.requested").length > questionsBefore,
      "第二次提问",
    );
    const askedAgain = events.findLast((event) => event.type === "question.requested");
    if (askedAgain?.type !== "question.requested") throw new Error("缺少提问请求");
    await phone.enqueueInput("queue", { text: "排队的一条" });
    await phone.respondQuestion(askedAgain.payload.requestId, {
      answers: [{ selected: [], text: "好" }],
    });
    expect(await turn).toBe("done");
    const texts = events
      .filter((event) => event.type === "message.user")
      .map((event) => (event.type === "message.user" ? JSON.stringify(event.payload.content) : ""));
    expect(texts.at(-1)).toContain("排队的一条");
    expect(events.filter((event) => event.type === "turn.started").length).toBe(4);

    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("中断后暂停：resumeInputs 从队首恢复；非本机与非法参数按约定报错", async () => {
    const h = await connectMany({
      scripts: [askScript, textScript("恢复后"), textScript("第二条")],
    });
    const { session } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const events: RuntimeEvent[] = [];
    await session.subscribe((event) => events.push(event));
    const turn = session.submit({ text: "开始" });
    await until(() => events.some((event) => event.type === "question.requested"));
    await session.enqueueInput("queue", { text: "待发 A" });
    session.interrupt();
    expect(await turn).toBe("aborted");
    const paused = await session.pendingInputs();
    expect(paused.paused).toBe(true);
    expect(paused.items[0]?.mode).toBe("queue");

    // 参数校验：mode 只能是 steer/queue
    await expect(
      h.client.call("session.enqueueInput", {
        sessionId: session.id,
        mode: "later" as "steer",
        text: "x",
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("session.updateInput", {
        sessionId: session.id,
        id: paused.items[0]?.id ?? "",
        mode: "later" as "steer",
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });

    await session.resumeInputs();
    expect((await session.pendingInputs()).items).toEqual([]);
    const users = events.filter((event) => event.type === "message.user");
    expect(JSON.stringify(users.at(-1))).toContain("待发 A");
    await h.client.shutdown();
    await Promise.all([h.served]);
  });
});
