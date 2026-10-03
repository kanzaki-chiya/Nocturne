import { afterEach, describe, expect, it } from "vitest";

import {
  replaySessionView,
  type DurableEvent,
  type RuntimeEvent,
  type SessionView,
} from "@nocturne/core/protocol";
import { trackSessionView } from "@nocturne/rpc/client";

import { cleanupTmp, connect, MODEL, textScript, until } from "./harness.js";

afterEach(cleanupTmp);

const isDurable = (e: RuntimeEvent): e is DurableEvent => "seq" in e;
const durableSeqs = (events: RuntimeEvent[]) => events.filter(isDurable).map((e) => e.seq);

/** V1：收敛点上除 revision 与 notices 外重放等价（view.md 第 6 节） */
function comparable(view: SessionView): Omit<SessionView, "revision" | "notices"> {
  const { revision: _revision, notices: _notices, ...rest } = view;
  return rest;
}

describe("session.subscribe", () => {
  it("先回放 afterSeq 之后的全部持久事件，临时事件不回放，之后接实时", async () => {
    const h = await connect({ scripts: [textScript("第一轮"), textScript("第二轮")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "一" });
    const durable = (await session.state()).lastSeq;

    const all: RuntimeEvent[] = [];
    const sub = await session.subscribe((e) => all.push(e));
    expect(sub.lastSeq).toBe(durable);
    expect(durableSeqs(all)).toEqual(Array.from({ length: durable }, (_, i) => i + 1));
    // 第一轮的流式增量是临时事件：断开期间/订阅前发生的不补发
    expect(all.some((e) => !isDurable(e))).toBe(false);

    await session.submit({ text: "二" });
    expect(all.some((e) => e.type === "message.assistant.delta")).toBe(true);
    const seqs = durableSeqs(all);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

    // afterSeq 续接：只收到之后的
    const tail: RuntimeEvent[] = [];
    const sub2 = await session.subscribe((e) => tail.push(e), { afterSeq: durable });
    expect(durableSeqs(tail)[0]).toBe(durable + 1);
    expect(durableSeqs(tail).at(-1)).toBe(seqs.at(-1));
    await sub.unsubscribe();
    await sub2.unsubscribe();
    h.client.close();
    await h.served;
  });

  it("回放期间有新事件：不丢不重，seq 连续，且折叠出的视图与进程内重放相等", async () => {
    const turns = 6;
    const scripts = Array.from({ length: turns + 1 }, (_, i) => textScript(`回复 ${i}`));
    let sessionId = "";
    let before = 0;
    let paused = false;
    // 回放推完第一批就暂停，等进程内会话产生了新的持久事件再继续：
    // 这些事件在回放未结束时被缓冲，之后按 seq 去重冲刷
    const h = await connect({
      scripts,
      replayChunkSize: 1,
      replayYield: async () => {
        if (paused) return;
        paused = true;
        await until(() => h.durable(sessionId).length > before, "回放期间产生新事件");
      },
    });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    sessionId = session.id;
    for (let i = 0; i < turns; i++) await session.submit({ text: `问 ${i}` });
    before = (await session.state()).lastSeq;

    const received: RuntimeEvent[] = [];
    const subscribed = session.subscribe((e) => received.push(e));
    const live = session.submit({ text: "回放期间的一轮" });
    const [sub] = await Promise.all([subscribed, live]);

    const total = (await session.state()).lastSeq;
    expect(total).toBeGreaterThan(before);
    // 回放暂停期间产生的事件被缓冲，订阅返回时已衔接进来（之后的事件走实时推送）
    expect(sub.lastSeq).toBeGreaterThan(before);
    await until(() => durableSeqs(received).length === total, "实时事件到齐");
    expect(durableSeqs(received)).toEqual(Array.from({ length: total }, (_, i) => i + 1));

    // 经 RPC 折叠的视图 == 进程内重放
    const viaRpc = replaySessionView(received.filter(isDurable));
    const direct = replaySessionView(h.durable(session.id));
    expect(comparable(viaRpc)).toEqual(comparable(direct));
    h.client.close();
    await h.served;
  });

  it("trackSessionView：实时折叠（含临时事件）在收敛点与进程内重放相等", async () => {
    const h = await connect({ scripts: [textScript("你好，世界"), textScript("再见")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    const tracker = await trackSessionView(session);
    await session.submit({ text: "问候" });
    await session.submit({ text: "告别" });
    const direct = replaySessionView(h.durable(session.id));
    expect(tracker.view.status).toBe("idle");
    expect(comparable(tracker.view)).toEqual(comparable(direct));
    // 临时事件确实参与了折叠（revision 比纯持久重放大）
    expect(tracker.view.revision).toBeGreaterThan(direct.revision);

    // 重连续接：新视图从旧视图的 lastSeq 之后继续
    const resumed = await trackSessionView(session, undefined, {
      afterSeq: 0,
    });
    expect(comparable(resumed.view)).toEqual(comparable(direct));
    await tracker.stop();
    await resumed.stop();
    h.client.close();
    await h.served;
  });

  it("重复订阅替换旧订阅（旧监听器不再收到任何事件）；unsubscribe 后服务端停推", async () => {
    const h = await connect({ scripts: [textScript("a"), textScript("b")] });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    let pushed = 0;
    const stop = h.client.onEvent(() => {
      pushed++;
    });
    const first: RuntimeEvent[] = [];
    const second: RuntimeEvent[] = [];
    const sub1 = await session.subscribe((e) => first.push(e));
    const firstCount = first.length;
    const sub2 = await session.subscribe((e) => second.push(e));
    await session.submit({ text: "x" });
    // 服务端只有一路推送；旧监听器停在替换之前，新监听器收到回放加实时、seq 不重复
    expect(first).toHaveLength(firstCount);
    const seqs = durableSeqs(second);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    await sub1.unsubscribe(); // 已被替换：无操作，不会让服务端停推
    await session.submit({ text: "y" });
    expect(durableSeqs(second).length).toBeGreaterThan(seqs.length);

    await sub2.unsubscribe();
    const frozen = pushed;
    await session.state(); // 往返一次，保证服务端已处理 unsubscribe
    await session.submit({ text: "z" });
    expect(pushed).toBe(frozen);
    stop();
    h.client.close();
    await h.served;
  });

  it("多个会话同时打开：事件按 sessionId 隔离", async () => {
    const h = await connect({ scripts: [textScript("甲"), textScript("乙")] });
    const a = await h.client.runtime.createSession({ model: MODEL });
    const b = await h.client.runtime.createSession({ model: MODEL });
    const eventsA: RuntimeEvent[] = [];
    const eventsB: RuntimeEvent[] = [];
    await a.session.subscribe((e) => eventsA.push(e));
    await b.session.subscribe((e) => eventsB.push(e));
    await a.session.submit({ text: "给甲" });
    expect(eventsA.some((e) => e.type === "turn.completed")).toBe(true);
    expect(eventsB.some((e) => e.type === "turn.started")).toBe(false);
    await b.session.submit({ text: "给乙" });
    expect(eventsB.some((e) => e.type === "turn.completed")).toBe(true);
    for (const e of eventsA) expect(e.sessionId).toBe(a.session.id);
    for (const e of eventsB) expect(e.sessionId).toBe(b.session.id);
    h.client.close();
    await h.served;
  });
});
