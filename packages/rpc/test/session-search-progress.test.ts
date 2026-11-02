import { afterEach, expect, it, vi } from "vitest";
import type { SessionSearchOptions, SessionSearchResult } from "@nocturne/core";
import { REMOTE_METHODS } from "@nocturne/rpc/server";
import { cleanupTmp, connectMany } from "./harness.js";

afterEach(() => {
  vi.useRealTimers();
  cleanupTmp();
});

it("搜索增量仅发起连接可见，100ms合并，结束冲刷；替代与断线停止旧通知", async () => {
  const h = await connectMany();
  const remote = await h.add();
  const received: { searchId: string; results: SessionSearchResult[] }[] = [];
  const other = vi.fn();
  h.client.onNotification("runtime.sessionSearchProgress", (value) => received.push(value));
  remote.client.onNotification("runtime.sessionSearchProgress", other);
  expect(REMOTE_METHODS as readonly string[]).not.toContain("runtime.searchSessions");
  await expect(
    remote.client.runtime.searchSessions({ query: "x", searchId: "remote" }),
  ).rejects.toMatchObject({ code: "remote_not_allowed" });
  const scans = new Map<
    string,
    { options: SessionSearchOptions | undefined; resolve: (results: SessionSearchResult[]) => void }
  >();
  const runtime = h.runtimes[0];
  if (!runtime) throw new Error("缺少 Runtime");
  vi.spyOn(runtime, "searchSessions").mockImplementation(
    (query, options) => new Promise((resolve) => scans.set(query, { options, resolve })),
  );
  vi.useFakeTimers();
  const first = h.client.runtime.searchSessions({ query: "first", searchId: "one" });
  await vi.advanceTimersByTimeAsync(0);
  const result = (id: number) => ({ sessionId: `s${id}`, mtimeMs: 1000 - id });
  for (let i = 0; i < 100; i++) scans.get("first")?.options?.onProgress?.([result(i)]);
  await vi.advanceTimersByTimeAsync(99);
  expect(received).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(received).toEqual([
    { searchId: "one", results: Array.from({ length: 100 }, (_, i) => result(i)) },
  ]);
  scans.get("first")?.options?.onProgress?.([result(100)]);
  scans.get("first")?.resolve(Array.from({ length: 101 }, (_, i) => result(i)));
  expect(await first).toHaveLength(101);
  expect(received).toHaveLength(2);
  expect(received[1]).toEqual({ searchId: "one", results: [result(100)] });
  const old = h.client.runtime.searchSessions({ query: "old", searchId: "old" });
  await vi.advanceTimersByTimeAsync(0);
  scans.get("old")?.options?.onProgress?.([result(101)]);
  const fresh = h.client.runtime.searchSessions({ query: "fresh", searchId: "new" });
  await vi.advanceTimersByTimeAsync(0);
  expect(scans.get("old")?.options?.signal?.aborted).toBe(true);
  scans.get("old")?.options?.onProgress?.([result(102)]);
  scans.get("old")?.resolve([result(101)]);
  scans.get("fresh")?.options?.onProgress?.([result(103)]);
  await vi.advanceTimersByTimeAsync(100);
  expect(await old).toEqual([]);
  expect(received.map((batch) => batch.searchId)).toEqual(["one", "one", "new"]);
  scans.get("fresh")?.resolve([result(103)]);
  await fresh;
  const disconnected = h.client.runtime.searchSessions({ query: "disconnect", searchId: "closed" });
  const rejected = expect(disconnected).rejects.toMatchObject({ code: "connection_closed" });
  await vi.advanceTimersByTimeAsync(0);
  scans.get("disconnect")?.options?.onProgress?.([result(104)]);
  h.client.close();
  await rejected;
  scans.get("disconnect")?.options?.onProgress?.([result(105)]);
  scans.get("disconnect")?.resolve([]);
  await vi.advanceTimersByTimeAsync(200);
  expect(received).toHaveLength(3);
  expect(other).not.toHaveBeenCalled();
  remote.client.close();
  await Promise.all([h.served, remote.served]);
});
