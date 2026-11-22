import { resolveReasoningEfforts, timedStream, type ResolvedModel } from "../provider/index.js";
import type { PageModelInput, SessionPage, Usage } from "../protocol/index.js";
import { SessionError } from "../session/errors.js";
import type { Session } from "../session/types.js";

const MAX_PROMPT_BYTES = 256 * 1024;
const DEFAULT_MAX_TOKENS = 4096;

export function createPageModelCalls(options: {
  session: Session;
  model: () => ResolvedModel;
  permission: (
    page: string,
    title: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<"allow" | "deny">;
  firstEventTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
}) {
  const { session } = options;
  const queues = new Map<string, { controller: AbortController; tail: Promise<void> }>();

  async function call(
    page: SessionPage,
    input: PageModelInput,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const { prompt, system, maxTokens = DEFAULT_MAX_TOKENS } = input;
    if (
      typeof prompt !== "string" ||
      (system !== undefined && typeof system !== "string") ||
      Buffer.byteLength(prompt) + Buffer.byteLength(system ?? "") > MAX_PROMPT_BYTES ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 1
    )
      throw new SessionError(
        "invalid_command",
        "页面请求需要有效的文本（合计最多 256 KiB）和正整数 maxTokens",
      );

    const model = options.model();
    const { ref, protocol, capabilities, maxOutputTokens } = model.model;
    const modelName = `${ref.provider}/${ref.model}`;
    const previous = queues.get(page.page);
    const controller =
      previous && !previous.controller.signal.aborted ? previous.controller : new AbortController();
    const signals = [controller.signal, session.failedSignal];
    if (callerSignal) signals.push(callerSignal);
    const signal = AbortSignal.any(signals);
    const run = (previous?.tail ?? Promise.resolve()).then(async () => {
      const start = performance.now();
      let outcome: "ok" | "error" | "aborted" = "error";
      let usage: Usage | undefined;
      try {
        signal.throwIfAborted();
        if ((await options.permission(page.page, page.title, modelName, signal)) === "deny") {
          throw new SessionError("page_model_denied", "页面模型调用已被拒绝");
        }
        signal.throwIfAborted();
        let text = "";
        const stream = timedStream(
          model.provider,
          {
            purpose: "page",
            model: ref.model,
            protocol,
            system: system === undefined ? [] : [{ text: system }],
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
            tools: [],
            reasoningEffort: resolveReasoningEfforts(capabilities)?.[0],
            maxOutputTokens: Math.min(maxTokens, maxOutputTokens ?? maxTokens),
          },
          signal,
          options.firstEventTimeoutMs ?? 30_000,
          options.idleTimeoutMs ?? 300_000,
        );
        for await (const event of stream) {
          if (event.type === "text_delta") text += event.text;
          if (event.type === "usage") usage = event.usage;
          if (event.type === "finish") {
            if (event.reason === "content_filter" || event.reason === "tool_calls") {
              throw new Error(`模型调用结束：${event.reason}`);
            }
            break;
          }
        }
        signal.throwIfAborted();
        outcome = "ok";
        return text;
      } catch (cause) {
        if (signal.aborted) {
          outcome = "aborted";
          throw new SessionError("page_model_aborted", "页面模型调用已停止", { cause });
        }
        if (cause instanceof SessionError) throw cause;
        throw new SessionError(
          "page_model_failed",
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        );
      } finally {
        await session.emit("page.model_called", {
          page: page.page,
          model: modelName,
          usage,
          durationMs: Math.round(performance.now() - start),
          outcome,
        });
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(page.page, { controller, tail });
    void tail.then(() => {
      if (queues.get(page.page)?.tail === tail) queues.delete(page.page);
    });
    return run;
  }

  return {
    call,
    stop: (page: string) => queues.get(page)?.controller.abort(),
    async stopAll() {
      const entries = [...queues.values()];
      for (const entry of entries) entry.controller.abort();
      await Promise.all(entries.map((entry) => entry.tail));
    },
  };
}
