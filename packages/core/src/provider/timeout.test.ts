import { describe, expect, it } from "vitest";
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
});
