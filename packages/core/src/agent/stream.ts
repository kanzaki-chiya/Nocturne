/**
 * 单个 Step 的 Provider 流消费与重试（agent-loop.md 3.5）。
 * 只有在本次请求尚未产生任何输出事件时才允许重试；
 * 已开始输出后失败，把已收到的部分内容交给调用方保存。
 */
import type { ContentBlock, FinishReason, ToolCallRef, Usage } from "../protocol/index.js";
import { isProviderError, timedStream, type ModelRequest } from "../provider/index.js";
import type { TurnDeps } from "./types.js";

export interface StreamAccumulation {
  content: ContentBlock[];
  toolCalls: ToolCallRef[];
  usage: Usage | undefined;
}

export type StreamOutcome =
  | {
      kind: "finished";
      finishReason: FinishReason;
      acc: StreamAccumulation;
    }
  /** 流被中断：已收到的部分内容在 acc 中，由调用方按 finishReason="aborted" 保存 */
  | { kind: "aborted"; acc: StreamAccumulation }
  | { kind: "failed"; error: unknown; acc: StreamAccumulation };

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 追加 delta 到有序内容块：与末尾同类块合并，否则开新块 */
function appendDelta(blocks: ContentBlock[], type: "text" | "reasoning", delta: string): void {
  const last = blocks.at(-1);
  if (last?.type === type) {
    last.text += delta;
  } else {
    blocks.push({ type, text: delta });
  }
}

export async function consumeStream(
  deps: TurnDeps,
  request: ModelRequest,
  turnId: string,
  messageId: string,
  nextCallId: () => string,
): Promise<StreamOutcome> {
  const { session, config, signal } = deps;
  const { provider } = deps.model;
  const maxAttempts = config.retryLimit + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const acc: StreamAccumulation = {
      content: [],
      toolCalls: [],
      usage: undefined,
    };
    /** providerCallId → 已分配的 callId 与累积的原始参数 */
    const pending = new Map<string, { callId: string; name: string; rawArgs: string }>();
    let producedOutput = false;
    // 诊断：完整 ModelRequest（不含请求头——头由适配器构造，天然不会进来）
    deps.execEnv.diagnostics?.record("provider.request", {
      turnId,
      attempt,
      provider: provider.id,
      model: deps.model.model.ref.model,
      request,
    });
    const requestStart = Date.now();

    try {
      for await (const ev of timedStream(
        provider,
        request,
        signal,
        config.firstEventTimeoutMs,
        config.idleTimeoutMs,
      )) {
        producedOutput = true;
        switch (ev.type) {
          case "text_delta": {
            appendDelta(acc.content, "text", ev.text);
            session.emitEphemeral(
              "message.assistant.delta",
              { messageId, kind: "text", delta: ev.text },
              { turnId },
            );
            break;
          }
          case "reasoning_delta": {
            // 专有数据 delta（如 Anthropic signature）落到末尾推理块；
            // text 为空时只合并数据，不产生空块/空 delta 事件
            if (ev.providerData !== undefined) {
              const last = acc.content.at(-1);
              if (last?.type === "reasoning") {
                last.provider = provider.id;
                last.providerData = ev.providerData;
              }
            }
            if (ev.text === "") break;
            appendDelta(acc.content, "reasoning", ev.text);
            session.emitEphemeral(
              "message.assistant.delta",
              { messageId, kind: "reasoning", delta: ev.text },
              { turnId },
            );
            break;
          }
          case "reasoning_block": {
            acc.content.push({
              type: "reasoning",
              text: ev.text,
              provider: deps.model.provider.id,
              providerData: ev.providerData,
            });
            break;
          }
          case "tool_call_delta": {
            let p = pending.get(ev.toolCallId);
            if (p === undefined) {
              p = { callId: nextCallId(), name: ev.name, rawArgs: "" };
              pending.set(ev.toolCallId, p);
            }
            p.rawArgs += ev.argsDelta;
            session.emitEphemeral(
              "tool.input.delta",
              { callId: p.callId, name: p.name, delta: ev.argsDelta },
              { turnId },
            );
            break;
          }
          case "tool_call": {
            const p = pending.get(ev.toolCallId);
            const callId = p?.callId ?? nextCallId();
            let input = ev.input;
            let rawInput = ev.rawInput;
            if (input === undefined && rawInput === undefined && p !== undefined) {
              // 由 delta 累积的调用：尝试解析累积原文
              rawInput = p.rawArgs;
              try {
                input = JSON.parse(p.rawArgs) as unknown;
              } catch {
                input = undefined;
              }
            }
            acc.toolCalls.push({
              callId,
              providerCallId: ev.toolCallId,
              name: ev.name,
              input,
              rawInput: input === undefined ? rawInput : undefined,
            });
            break;
          }
          case "usage": {
            acc.usage = ev.usage;
            break;
          }
          case "finish": {
            deps.execEnv.diagnostics?.record("provider.result", {
              turnId,
              attempt,
              provider: provider.id,
              finishReason: ev.reason,
              usage: acc.usage,
              toolCalls: acc.toolCalls.length,
              contentChars: acc.content.reduce((a, b) => a + b.text.length, 0),
              durationMs: Date.now() - requestStart,
            });
            return { kind: "finished", finishReason: ev.reason, acc };
          }
        }
        if (signal.aborted) return { kind: "aborted", acc };
      }
      // 流结束但没有 finish：违反 Provider 契约，按意外结束处理
      return {
        kind: "failed",
        error: new Error("Provider 流在没有 finish 的情况下结束"),
        acc,
      };
    } catch (e) {
      deps.execEnv.diagnostics?.record("provider.error", {
        turnId,
        attempt,
        provider: provider.id,
        kind: isProviderError(e) ? e.kind : "unknown",
        message: e instanceof Error ? e.message : String(e),
        retryable: isProviderError(e) ? e.retryable : false,
        durationMs: Date.now() - requestStart,
      });
      if (signal.aborted || isAbortError(e)) {
        return { kind: "aborted", acc };
      }
      if (isProviderError(e) && e.retryable && !producedOutput && attempt < maxAttempts) {
        // 尚未产生任何输出事件：允许重发整个请求（agent-loop.md 3.5）
        const delayMs = e.retryAfterMs ?? config.retryBaseDelayMs * 2 ** (attempt - 1);
        session.emitEphemeral(
          "provider.retry",
          {
            attempt,
            maxAttempts,
            delayMs,
            error: { kind: e.kind, message: e.message },
          },
          { turnId },
        );
        session.emitEphemeral("runtime.status", { status: "retrying" }, { turnId });
        await sleep(delayMs, signal);
        continue;
      }
      return { kind: "failed", error: e, acc };
    }
  }
  // 不可达：循环内必然返回
  return {
    kind: "failed",
    error: new Error("retry loop exhausted"),
    acc: { content: [], toolCalls: [], usage: undefined },
  };
}
