import { abortError, ProviderError } from "./errors.js";
import type { ModelOutputEvent, ModelRequest, ModelStreamEvent, Provider } from "./types.js";

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
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const ms = first ? firstEventTimeoutMs : idleTimeoutMs;
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
              message: first ? `等待首个流式事件超时（${ms} ms）` : `流式事件空闲超时（${ms} ms）`,
              retryable: true,
            }),
          );
        }, ms);
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
      first = false;
      // 心跳只重置计时，不向下游转发
      if (event.value.type === "heartbeat") continue;
      yield event.value;
    }
  } finally {
    controller.abort();
    // 超时的底层迭代器可能永远不响应 return()；不能等待它拖住 Turn。
    void iterator.return?.().catch(() => undefined);
  }
}
