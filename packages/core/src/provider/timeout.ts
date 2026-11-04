import { abortError, ProviderError } from "./errors.js";
import type { ModelOutputEvent, ModelRequest, ModelStreamEvent, Provider } from "./types.js";

/** 内容事件：非空的正文/推理增量、推理块或工具调用（含增量）；heartbeat / usage / finish 与空增量不算 */
export function isContentEvent(ev: ModelStreamEvent): boolean {
  switch (ev.type) {
    case "text_delta":
    case "reasoning_delta":
      return ev.text !== "";
    case "reasoning_block":
    case "tool_call_delta":
    case "tool_call":
      return true;
    default:
      return false;
  }
}

/** 普通 Step 与摘要共用的流式等待上限；不负责重试。 */
export async function* timedStream(
  provider: Provider,
  request: ModelRequest,
  signal: AbortSignal,
  firstEventTimeoutMs: number,
  idleTimeoutMs: number,
): AsyncIterable<ModelOutputEvent> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const iterator = provider.stream(request, combined)[Symbol.asyncIterator]();
  let first = true;
  let sawContent = false;
  let deadline = Date.now() + firstEventTimeoutMs;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const limitMs = first ? firstEventTimeoutMs : idleTimeoutMs;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        controller.abort();
        throw new ProviderError({
          kind: "timeout",
          message: first
            ? `等待首个流式事件超时（${limitMs} ms）`
            : `流式事件空闲超时（${limitMs} ms）`,
          retryable: true,
        });
      }
      const event = await new Promise<IteratorResult<ModelStreamEvent>>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
          cleanup();
          controller.abort();
          reject(
            new ProviderError({
              kind: "timeout",
              message: first
                ? `等待首个流式事件超时（${limitMs} ms）`
                : `流式事件空闲超时（${limitMs} ms）`,
              retryable: true,
            }),
          );
        }, remainingMs);
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void iterator.next().then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
      if (event.done) return;
      const value = event.value;
      if (isContentEvent(value)) {
        first = false;
        sawContent = true;
        deadline = Date.now() + idleTimeoutMs;
      } else if (!sawContent && value.type === "heartbeat") {
        first = false;
        deadline = Date.now() + idleTimeoutMs;
      }
      // 心跳不向下游转发
      if (value.type === "heartbeat") continue;
      yield value;
    }
  } finally {
    controller.abort();
    // 超时的底层迭代器可能永远不响应 return()；不能等待它拖住 Turn。
    void iterator.return?.().catch(() => undefined);
  }
}
