/**
 * 子代理观察存储（ADR-0060 修订（五）第 2、9 条）：独立 SessionView、按 seq 去重与续接、
 * 退订不丢视图、换后台连接续接、过期回调丢弃、与真实 RPC 客户端的衔接。
 */
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { RpcFail, fakeServer, withInit } from "./fake-server";
import { afterEach, expect, it, vi } from "vitest";

import { SubagentWatcher, clearTransient, watchKey } from "../src/subagent-watch";
import {
  assistantMessage,
  endOf,
  fakeObserveRuntime,
  summary,
  userMessage,
} from "./subagent-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("观察建立后事件折叠进独立视图；重复的持久事件按 seq 去重；临时事件照收", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime();
  const versions: number[] = [];
  watcher.subscribe(() => versions.push(watcher.getVersion()));
  const seen: string[] = [];
  watcher.events("p", "child-1", (event) => seen.push(event.type));
  watcher.start(runtime, "p", "child-1");
  expect(watcher.state("p", "child-1")?.phase).toBe("connecting");
  const sub = subscriptions[0];
  if (sub === undefined) throw new Error("没有订阅");
  expect(sub.input).toEqual({ parentSessionId: "p", childSessionId: "child-1" });
  sub.observer.onEvent(userMessage(1, "任务"));
  sub.observer.onEvent(assistantMessage(2, "你好"));
  // 补读与实时衔接重复送达同一条：忽略
  sub.observer.onEvent(assistantMessage(2, "你好"));
  sub.observer.onEvent({
    type: "message.assistant.delta",
    sessionId: "child-1",
    time: "2026-10-21T00:00:00.000Z",
    payload: { messageId: "m3", kind: "text", delta: "流" },
  } as unknown as RuntimeEvent);
  sub.resolve({ mode: "live", summary: summary() });
  await flush();
  const state = watcher.state("p", "child-1");
  expect(state?.phase).toBe("open");
  expect(state?.mode).toBe("live");
  expect(state?.view.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(state?.view.lastSeq).toBe(2);
  expect(state?.view.live.assistants).toHaveLength(1);
  // 思考时长簿记看到每个收进视图的事件（重复的持久事件不算）
  expect(seen).toEqual(["message.user", "message.assistant", "message.assistant.delta"]);
  expect(versions.length).toBeGreaterThan(0);
});

it("退订保留视图和最后持久 seq；回看按 seq 补读，不重放已有内容，并清掉瞬态", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime({ autoResolve: true });
  watcher.start(runtime, "p", "child-1");
  const first = subscriptions[0];
  if (first === undefined) throw new Error("没有订阅");
  first.observer.onEvent(userMessage(1, "任务"));
  first.observer.onEvent(assistantMessage(2, "第一段"));
  first.observer.onEvent({
    type: "message.assistant.delta",
    sessionId: "child-1",
    time: "2026-10-21T00:00:00.000Z",
    payload: { messageId: "m3", kind: "text", delta: "半截" },
  } as unknown as RuntimeEvent);
  await flush();
  watcher.stop("p", "child-1");
  expect(first.unsubscribed).toBe(true);
  expect(watcher.observing("p", "child-1")).toBe(false);
  expect(watcher.state("p", "child-1")?.phase).toBe("idle");
  // 迟到的旧回调被丢弃
  first.observer.onEvent(assistantMessage(3, "迟到"));
  expect(watcher.state("p", "child-1")?.view.lastSeq).toBe(2);

  watcher.start(runtime, "p", "child-1");
  const second = subscriptions[1];
  expect(second?.input.afterSeq).toBe(2);
  // 瞬态（流式半截）已清，持久内容还在
  const view = watcher.state("p", "child-1")?.view;
  expect(view?.live.assistants).toEqual([]);
  expect(view?.entries).toHaveLength(2);
  second?.observer.onEvent(assistantMessage(3, "补读到的"));
  expect(watcher.state("p", "child-1")?.view.entries).toHaveLength(3);
});

it("重复 start 同一连接是幂等的；换了后台连接丢弃旧订阅并从保留的 seq 续接", async () => {
  const watcher = new SubagentWatcher();
  const a = fakeObserveRuntime({ autoResolve: true });
  const b = fakeObserveRuntime({ autoResolve: true });
  watcher.start(a.runtime, "p", "child-1");
  watcher.start(a.runtime, "p", "child-1");
  expect(a.subscriptions).toHaveLength(1);
  a.subscriptions[0]?.observer.onEvent(userMessage(1, "任务"));
  a.subscriptions[0]?.observer.onEvent(assistantMessage(2, "内容"));
  await flush();
  watcher.start(b.runtime, "p", "child-1");
  expect(a.subscriptions[0]?.unsubscribed).toBe(true);
  expect(b.subscriptions[0]?.input.afterSeq).toBe(2);
  // 旧连接的迟到事件不再进视图
  a.subscriptions[0]?.observer.onEvent(assistantMessage(3, "旧连接"));
  expect(watcher.state("p", "child-1")?.view.lastSeq).toBe(2);
});

it("没有缓存的新连接从 0 重放（不带 afterSeq）", () => {
  const watcher = new SubagentWatcher();
  const a = fakeObserveRuntime();
  watcher.start(a.runtime, "p", "child-9");
  expect(a.subscriptions[0]?.input).toEqual({ parentSessionId: "p", childSessionId: "child-9" });
  expect("afterSeq" in (a.subscriptions[0]?.input ?? {})).toBe(false);
});

it("自然结束：closed 记录终止信息；已确定结束的不再重开，未收束的回看会重读", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime({ autoResolve: true });
  watcher.start(runtime, "p", "child-1");
  const sub = subscriptions[0];
  sub?.observer.onEvent(userMessage(1, "任务"));
  sub?.observer.onEnd(
    endOf({
      lastSeq: 1,
      summary: summary({ state: "ended" }),
      source: "snapshot",
      tailIgnored: true,
    }),
  );
  await flush();
  const state = watcher.state("p", "child-1");
  expect(state?.phase).toBe("closed");
  expect(state?.end?.tailIgnored).toBe(true);
  expect(state?.summary?.state).toBe("ended");
  // 终止事实已知：回看不再请求
  watcher.stop("p", "child-1");
  watcher.start(runtime, "p", "child-1");
  expect(subscriptions).toHaveLength(1);

  // 未收束的快照：回看会按 seq 重读一次（别的进程可能还在写）
  const other = fakeObserveRuntime({ autoResolve: true });
  watcher.start(other.runtime, "p", "child-2");
  other.subscriptions[0]?.observer.onEvent(userMessage(1, "任务", "child-2"));
  other.subscriptions[0]?.observer.onEnd(
    endOf({ lastSeq: 1, summary: summary({ childSessionId: "child-2", state: "unsealed" }) }),
  );
  await flush();
  expect(watcher.state("p", "child-2")?.phase).toBe("closed");
  watcher.start(other.runtime, "p", "child-2");
  expect(other.subscriptions).toHaveLength(2);
  expect(other.subscriptions[1]?.input.afterSeq).toBe(1);
});

it("closed 先于订阅响应到达时保持关闭，不被响应改回 live", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime();
  watcher.start(runtime, "p", "child-1");
  const sub = subscriptions[0];
  sub?.observer.onEvent(userMessage(1, "任务"));
  sub?.observer.onEnd(endOf({ lastSeq: 1 }));
  sub?.resolve({ mode: "snapshot" });
  await flush();
  const state = watcher.state("p", "child-1");
  expect(state?.phase).toBe("closed");
  expect(state?.mode).toBe("snapshot");
});

it("订阅失败：记录错误码，保留已有视图；重试成功；保留的 seq 失效时丢缓存从 0 重放一次", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime();
  watcher.start(runtime, "p", "child-1");
  const error = Object.assign(new Error("子会话不属于该父会话"), {
    code: "subagent_parent_mismatch",
  });
  subscriptions[0]?.reject(error);
  await flush();
  expect(watcher.state("p", "child-1")).toMatchObject({
    phase: "error",
    error: { code: "subagent_parent_mismatch", message: "子会话不属于该父会话" },
  });
  expect(watcher.observing("p", "child-1")).toBe(false);
  // 重试
  watcher.retry(runtime, "p", "child-1");
  expect(subscriptions).toHaveLength(2);
  expect(watcher.state("p", "child-1")?.error).toBeUndefined();
  subscriptions[1]?.observer.onEvent(userMessage(1, "任务"));
  subscriptions[1]?.observer.onEvent(assistantMessage(2, "内容"));
  subscriptions[1]?.resolve();
  await flush();
  watcher.stop("p", "child-1");
  // 日志被换掉：afterSeq 超出 → invalid_params，丢缓存从 0 来一次
  watcher.start(runtime, "p", "child-1");
  expect(subscriptions[2]?.input.afterSeq).toBe(2);
  subscriptions[2]?.reject(Object.assign(new Error("afterSeq 超出"), { code: "invalid_params" }));
  await flush();
  expect(subscriptions).toHaveLength(4);
  expect("afterSeq" in (subscriptions[3]?.input ?? {})).toBe(false);
  expect(watcher.state("p", "child-1")?.view.entries).toHaveLength(0);
  expect(watcher.state("p", "child-1")?.phase).toBe("connecting");
  // 从 0 重放仍失败就报错，不再循环
  subscriptions[3]?.reject(Object.assign(new Error("再次失败"), { code: "invalid_params" }));
  await flush();
  expect(subscriptions).toHaveLength(4);
  expect(watcher.state("p", "child-1")?.phase).toBe("error");
});

it("订阅在途时退订：响应回来后立刻撤销，不复活", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime();
  watcher.start(runtime, "p", "child-1");
  watcher.stop("p", "child-1");
  subscriptions[0]?.resolve();
  await flush();
  expect(subscriptions[0]?.unsubscribed).toBe(true);
  expect(watcher.state("p", "child-1")?.phase).toBe("idle");
  expect(watcher.observing("p", "child-1")).toBe(false);
});

it("release 退订并丢弃视图；releaseParent 清掉一个父会话的全部观察；dispose 全部撤销", async () => {
  const watcher = new SubagentWatcher();
  const { runtime, subscriptions } = fakeObserveRuntime({ autoResolve: true });
  watcher.start(runtime, "p", "c1");
  watcher.start(runtime, "p", "c2");
  watcher.start(runtime, "q", "c3");
  await flush();
  watcher.release("p", "c1");
  expect(subscriptions[0]?.unsubscribed).toBe(true);
  expect(watcher.state("p", "c1")).toBeUndefined();
  watcher.releaseParent("p");
  expect(subscriptions[1]?.unsubscribed).toBe(true);
  expect(watcher.state("p", "c2")).toBeUndefined();
  expect(watcher.state("q", "c3")).toBeDefined();
  watcher.dispose();
  expect(subscriptions[2]?.unsubscribed).toBe(true);
  expect(watcher.state("q", "c3")).toBeUndefined();
});

it("clearTransient 只清不可重放的瞬态", () => {
  const view = {
    live: { assistants: [{}], tools: [{}] },
    notices: [{}],
    pendingQuestion: {},
    retry: {},
    entries: [{ kind: "tool", liveOutput: "旧输出" }],
    mcpServers: { old: { state: "ready" } },
    status: "retrying",
  } as never as Parameters<typeof clearTransient>[0];
  clearTransient(view);
  expect(view.live).toEqual({ assistants: [], tools: [] });
  expect(view.notices).toEqual([]);
  expect(view.pendingQuestion).toBeUndefined();
  expect(view.retry).toBeUndefined();
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]).toMatchObject({ liveOutput: "" });
  expect(view.mcpServers).toEqual({});
  expect(view.status).toBe("idle");
  expect(watchKey("a", "b")).not.toBe(watchKey("ab", ""));
});

it("与真实 RPC 客户端衔接：通知先于响应到达也不丢；退订发 subagent.unsubscribe；断开不回调", async () => {
  const server = fakeServer(
    withInit({
      "subagent.subscribe": (params: Record<string, unknown>) => {
        const base = {
          subscriptionId: params.subscriptionId,
          parentSessionId: params.parentSessionId,
          childSessionId: params.childSessionId,
        };
        server.notify("subagent.event", { ...base, event: userMessage(1, "任务") });
        server.notify("subagent.event", { ...base, event: assistantMessage(2, "答复") });
        server.notify("subagent.closed", { ...base, end: endOf({ lastSeq: 2 }) });
        return { lastSeq: 2, summary: summary({ state: "ended" }), mode: "snapshot" };
      },
      "subagent.unsubscribe": null,
    }),
  );
  await server.initialize();
  const watcher = new SubagentWatcher();
  watcher.start(server.client.runtime, "p", "child-1");
  await vi.waitFor(() => {
    expect(watcher.state("p", "child-1")?.phase).toBe("closed");
  });
  const state = watcher.state("p", "child-1");
  expect(state?.view.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(state?.mode).toBe("snapshot");
  expect(state?.end?.summary.state).toBe("ended");
  const methods = server.calls.map((c) => c.method);
  expect(methods.filter((m) => m === "subagent.subscribe")).toHaveLength(1);
  // 已自然结束：服务端表项早已释放，退订不再发请求
  watcher.stop("p", "child-1");
  await flush();
  expect(server.calls.map((c) => c.method)).not.toContain("subagent.unsubscribe");
  server.close();
});

it("真实 RPC 客户端：运行中观察退订会发 subagent.unsubscribe；服务端拒绝时记录错误码", async () => {
  const server = fakeServer(
    withInit({
      "subagent.subscribe": (params: Record<string, unknown>) =>
        params.childSessionId === "bad"
          ? new RpcFail(-32002, "子会话不属于该父会话", { code: "subagent_parent_mismatch" })
          : { lastSeq: 0, summary: summary(), mode: "live" },
      "subagent.unsubscribe": null,
    }),
  );
  await server.initialize();
  const watcher = new SubagentWatcher();
  watcher.start(server.client.runtime, "p", "child-1");
  await vi.waitFor(() => {
    expect(watcher.state("p", "child-1")?.phase).toBe("open");
  });
  watcher.stop("p", "child-1");
  await vi.waitFor(() => {
    expect(server.calls.map((c) => c.method)).toContain("subagent.unsubscribe");
  });
  watcher.start(server.client.runtime, "p", "bad");
  await vi.waitFor(() => {
    expect(watcher.state("p", "bad")?.phase).toBe("error");
  });
  expect(watcher.state("p", "bad")?.error?.code).toBe("subagent_parent_mismatch");
  server.close();
});
