import { describe, expect, it, vi } from "vitest";
import { timedStream } from "./timeout.js";
import type { ModelRequest, ModelStreamEvent, Provider } from "./types.js";

const request = { model: { provider: "p", model: "m" }, messages: [] } as unknown as ModelRequest;

function provider(script: (ModelStreamEvent | { wait: number })[]): Provider {
  return {
    id: "p",
    type: "openai-compatible",
    models: () => [],
    async *stream() {
      for (const step of script) {
        if ("wait" in step) await new Promise((resolve) => setTimeout(resolve, step.wait));
        else yield step;
      }
    },
  } as unknown as Provider;
}

async function collect(p: Provider, first: number, idle: number) {
  const events: ModelStreamEvent[] = [];
  for await (const ev of timedStream(p, request, new AbortController().signal, first, idle))
    events.push(ev);
  return events;
}

describe("timedStream 心跳（ADR-0014 修订）", () => {
  it("两次读取之间中断立即拒绝，不再读取 Provider，并执行清理", async () => {
    const next = vi.fn(() =>
      Promise.resolve({ done: false as const, value: { type: "text_delta" as const, text: "ok" } }),
    );
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    let providerSignal: AbortSignal | undefined;
    const p: Provider = {
      id: "p",
      type: "fake",
      models: () => [],
      stream(_request, signal) {
        providerSignal = signal;
        return { [Symbol.asyncIterator]: () => ({ next, return: close }) };
      },
    };
    const controller = new AbortController();
    const stream = timedStream(p, request, controller.signal, 30, 500)[Symbol.asyncIterator]();
    expect(await stream.next()).toMatchObject({ value: { type: "text_delta", text: "ok" } });
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("心跳满足首事件等待，之后按空闲上限计时，且不向下游转发", async () => {
    const events = await collect(
      provider([{ type: "heartbeat" }, { wait: 80 }, { type: "text_delta", text: "ok" }]),
      30,
      500,
    );
    expect(events).toEqual([{ type: "text_delta", text: "ok" }]);
  });

  it("没有心跳时首个内容事件晚于上限仍超时", async () => {
    await expect(
      collect(provider([{ wait: 80 }, { type: "text_delta", text: "ok" }]), 30, 500),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });

  it("内容之前的长时间保活与空增量不触发超时，正常结束的流不受影响", async () => {
    const events = await collect(
      provider([
        { wait: 20 },
        { type: "heartbeat" },
        { wait: 25 },
        { type: "text_delta", text: "" },
        { wait: 25 },
        { type: "heartbeat" },
        { wait: 45 },
        { type: "heartbeat" },
        { wait: 30 },
        { type: "text_delta", text: "ok" },
        { wait: 20 },
        { type: "heartbeat" },
        { wait: 20 },
        { type: "finish", reason: "stop" },
      ]),
      40,
      65,
    );
    expect(events).toEqual([
      { type: "text_delta", text: "" },
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("收到首个内容事件后，心跳与空增量不再重置空闲计时，按剩余时间超时", async () => {
    const started = Date.now();
    await expect(
      collect(
        provider([
          { type: "text_delta", text: "first" },
          { wait: 25 },
          { type: "heartbeat" },
          { wait: 25 },
          { type: "text_delta", text: "" },
          { wait: 25 },
          { type: "heartbeat" },
          { wait: 25 },
          { type: "heartbeat" },
          { wait: 25 },
          { type: "text_delta", text: "too-late" },
        ]),
        40,
        80,
      ),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(125);
  });

  it("保活夹在内容之间时，超时从最后一个内容事件算起", async () => {
    const started = Date.now();
    await expect(
      collect(
        provider([
          { type: "text_delta", text: "c1" },
          { wait: 35 },
          { type: "heartbeat" },
          { wait: 30 },
          { type: "text_delta", text: "c2" },
          { wait: 30 },
          { type: "heartbeat" },
          { wait: 30 },
          { type: "heartbeat" },
          { wait: 30 },
          { type: "heartbeat" },
          { wait: 80 },
          { type: "text_delta", text: "never" },
        ]),
        40,
        85,
      ),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
    const elapsed = Date.now() - started;
    // c2 在 ~65ms 到达并把空闲上限重置到 ~150ms；若从 c1 算会在 85ms 超时，若被后续心跳续住则 >235ms
    expect(elapsed).toBeGreaterThanOrEqual(135);
    expect(elapsed).toBeLessThan(215);
  });
});
