/**
 * 子代理目录的查询节奏（ADR-0060 修订（五）第 3、4 条）：进入/重连/回前台查一次，
 * 父 task 事件合并查询，未结算 task 时补查每秒至多一次且不重叠，窗口后台、进设置、
 * 切会话、断线、卸载都停止补查并丢弃在途响应。
 */
import type { SubagentSummary } from "@nocturne/core/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  DIRECTORY_POLL_MS,
  SubagentDirectory,
  type DirectoryContext,
  type DirectoryRuntime,
} from "../src/subagent-directory";
import { summary } from "./subagent-fixtures";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 可控的 listSubagents：每次调用留一个待决的 promise */
function controlled() {
  const calls: {
    parent: string;
    resolve: (list: SubagentSummary[]) => void;
    reject: () => void;
  }[] = [];
  const runtime: DirectoryRuntime = {
    listSubagents: (parent) =>
      new Promise<SubagentSummary[]>((resolve, reject) => {
        calls.push({ parent, resolve, reject: () => reject(new Error("失败")) });
      }),
  };
  return { runtime, calls };
}

function context(
  runtime: DirectoryRuntime,
  over: Partial<DirectoryContext> = {},
): DirectoryContext {
  return {
    runtime,
    sessionId: "p",
    visible: true,
    settingsOpen: false,
    pollNeeded: false,
    ...over,
  };
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

it("进入会话查一次；结果更新摘要和版本；没有未结算 task 时不补查", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  const versions: number[] = [];
  directory.subscribe(() => versions.push(directory.getVersion()));
  directory.setContext(context(runtime));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.parent).toBe("p");
  expect(directory.loaded).toBe(false);
  calls[0]?.resolve([summary({ childSessionId: "a" })]);
  await settle();
  expect(directory.loaded).toBe(true);
  expect(directory.summaries.map((s) => s.childSessionId)).toEqual(["a"]);
  expect(versions.length).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls).toHaveLength(1);
  // 同样的上下文再设置一次：什么都不重复
  directory.setContext(context(runtime));
  expect(calls).toHaveLength(1);
});

it("事件触发的查询合并：在途时只记一次，结束后再补一次", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  directory.setContext(context(runtime));
  calls[0]?.resolve([]);
  await settle();
  directory.trigger();
  directory.trigger();
  directory.trigger();
  expect(calls).toHaveLength(2);
  calls[1]?.resolve([summary({ childSessionId: "a" })]);
  await settle();
  // 在途期间的两次触发合并成一次后续查询
  expect(calls).toHaveLength(3);
  calls[2]?.resolve([summary({ childSessionId: "a" }), summary({ childSessionId: "b" })]);
  await settle();
  expect(calls).toHaveLength(3);
  expect(directory.summaries).toHaveLength(2);
});

it("存在未结算 task：补查每秒至多一次，请求不重叠", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  directory.setContext(context(runtime, { pollNeeded: true }));
  expect(calls).toHaveLength(1);
  // 请求在途 3 秒：不会叠加新请求
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls).toHaveLength(1);
  calls[0]?.resolve([]);
  await settle();
  // 距离上次开始已超过 1 秒：马上可以补查，但不会在同一毫秒连发
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.length).toBeLessThanOrEqual(2);
  const base = calls.length;
  calls[base - 1]?.resolve([]);
  await settle();
  await vi.advanceTimersByTimeAsync(DIRECTORY_POLL_MS - 1);
  expect(calls).toHaveLength(base);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toHaveLength(base + 1);
  // 每个请求立刻返回：10 秒内最多 10 次
  const before = calls.length;
  for (let i = 0; i < 10; i += 1) {
    calls[calls.length - 1]?.resolve([]);
    await vi.advanceTimersByTimeAsync(DIRECTORY_POLL_MS);
  }
  expect(calls.length - before).toBeLessThanOrEqual(11);
  expect(calls.length - before).toBeGreaterThanOrEqual(9);
});

it("task 结算后（pollNeeded 变 false）停止补查", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  directory.setContext(context(runtime, { pollNeeded: true }));
  calls[0]?.resolve([]);
  await settle();
  directory.setContext(context(runtime, { pollNeeded: false }));
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).toHaveLength(count);
});

it("窗口后台：停止补查并丢弃在途响应；回到前台再查一次", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  directory.setContext(context(runtime, { pollNeeded: true }));
  expect(calls).toHaveLength(1);
  directory.setContext(context(runtime, { pollNeeded: true, visible: false }));
  // 旧请求的响应被丢弃
  calls[0]?.resolve([summary({ childSessionId: "stale" })]);
  await settle();
  expect(directory.summaries).toEqual([]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).toHaveLength(1);
  // 后台时事件触发也不查
  directory.trigger();
  expect(calls).toHaveLength(1);
  directory.setContext(context(runtime, { pollNeeded: true, visible: true }));
  expect(calls).toHaveLength(2);
});

it("进设置页停止补查，返回再查；切会话丢弃旧会话的响应和摘要", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  directory.setContext(context(runtime, { pollNeeded: true }));
  calls[0]?.resolve([summary({ childSessionId: "a" })]);
  await settle();
  expect(directory.summaries).toHaveLength(1);
  directory.setContext(context(runtime, { pollNeeded: true, settingsOpen: true }));
  const inSettings = calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).toHaveLength(inSettings);
  // 设置里摘要还在（同一会话），回来后再查
  expect(directory.summaries).toHaveLength(1);
  directory.setContext(context(runtime, { pollNeeded: true }));
  expect(calls).toHaveLength(inSettings + 1);
  // 切到另一个会话：旧响应作废，摘要清空
  const stale = calls[calls.length - 1];
  directory.setContext(context(runtime, { sessionId: "q", pollNeeded: true }));
  expect(directory.summaries).toEqual([]);
  expect(directory.loaded).toBe(false);
  expect(calls.at(-1)?.parent).toBe("p"); // 等旧请求落定，不重叠发给同一后台
  stale?.resolve([summary({ childSessionId: "from-p" })]);
  await settle();
  expect(directory.summaries).toEqual([]);
  const last = calls[calls.length - 1];
  expect(last?.parent).toBe("q");
  last?.resolve([summary({ childSessionId: "from-q" })]);
  await settle();
  expect(directory.summaries.map((s) => s.childSessionId)).toEqual(["from-q"]);
});

it("没有会话或没有连接：不查询；换后台连接重新查询并丢弃旧连接的响应", async () => {
  const a = controlled();
  const b = controlled();
  const directory = new SubagentDirectory();
  directory.setContext({ ...context(a.runtime), sessionId: null });
  directory.setContext({
    runtime: undefined,
    sessionId: "p",
    visible: true,
    settingsOpen: false,
    pollNeeded: true,
  });
  expect(a.calls).toHaveLength(0);
  directory.setContext(context(a.runtime));
  expect(a.calls).toHaveLength(1);
  directory.setContext(context(b.runtime));
  expect(b.calls).toHaveLength(1);
  a.calls[0]?.resolve([summary({ childSessionId: "old-backend" })]);
  await settle();
  expect(directory.summaries).toEqual([]);
  b.calls[0]?.resolve([summary({ childSessionId: "new-backend" })]);
  await settle();
  expect(directory.summaries.map((s) => s.childSessionId)).toEqual(["new-backend"]);
});

it("查询失败保留旧结果；卸载后停止一切并丢弃响应，可 revive", async () => {
  const { runtime, calls } = controlled();
  const directory = new SubagentDirectory();
  directory.setContext(context(runtime, { pollNeeded: true }));
  calls[0]?.resolve([summary({ childSessionId: "a" })]);
  await settle();
  await vi.advanceTimersByTimeAsync(DIRECTORY_POLL_MS);
  const failing = calls[calls.length - 1];
  failing?.reject();
  await settle();
  expect(directory.summaries.map((s) => s.childSessionId)).toEqual(["a"]);
  // 失败后仍按节奏再试
  await vi.advanceTimersByTimeAsync(DIRECTORY_POLL_MS);
  const pending = calls[calls.length - 1];
  directory.dispose();
  pending?.resolve([summary({ childSessionId: "late" })]);
  await settle();
  expect(directory.summaries.map((s) => s.childSessionId)).toEqual(["a"]);
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).toHaveLength(count);
  directory.trigger();
  expect(calls).toHaveLength(count);
  // StrictMode：同一实例先卸载再挂载
  directory.revive();
  expect(calls.length).toBeGreaterThan(count);
  const resumed = calls.length;
  directory.setContext(context(runtime, { pollNeeded: true }));
  expect(calls).toHaveLength(resumed);
});
