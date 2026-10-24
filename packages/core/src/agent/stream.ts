/**
 * 单个 Step 的 Provider 流消费与重试（agent-loop.md 3.5）。
 * 可重试错误丢弃本次尝试的输出后重发；
 * 重试用尽或不可重试时，把最后收到的部分内容交给调用方保存。
 */
import {
  PROTOCOL_ENDPOINTS,
  type ContentBlock,
  type FinishReason,
  type AssistantTiming,
  type ToolCallRef,
  type Usage,
} from "../protocol/index.js";
import {
  isProviderError,
  timedStream,
  type ModelOutputEvent,
  type ModelRequest,
} from "../provider/index.js";
import { redactRequestImages } from "./redact.js";
import type { TurnDeps } from "./types.js";

export class EmptyResponseError extends Error {
  constructor() {
    super("Provider 以 stop 结束，但未返回文本或工具调用");
    this.name = "EmptyResponseError";
  }
}

export interface StreamAccumulation {
  content: ContentBlock[];
  toolCalls: ToolCallRef[];
  usage: Usage | undefined;
  /** 本次尝试的计时，在流收束（finish / aborted / failed）时填写 */
  timing?: AssistantTiming | undefined;
}

export type StreamOutcome =
  | {
      kind: "finished";
      finishReason: FinishReason;
      acc: StreamAccumulation;
    }
  /** 流被中断：已收到的部分内容在 acc 中，由调用方按 finishReason="aborted" 保存 */
  | { kind: "aborted"; acc: StreamAccumulation }
  | {
      kind: "failed";
      error: unknown;
      acc: StreamAccumulation;
      producedOutput: boolean;
      retries: number;
    };

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      resolve(signal.aborted);
    }, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

/** 计 TTFT 的内容事件：正文、推理或工具调用（含增量）；usage / finish 不算 */
function isContentEvent(ev: ModelOutputEvent): boolean {
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
  const now = deps.now ?? (() => performance.now());

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const acc: StreamAccumulation = {
      content: [],
      toolCalls: [],
      usage: undefined,
    };
    /** providerCallId → 已分配的 callId 与累积的原始参数 */
    const pending = new Map<string, { callId: string; name: string; rawArgs: string }>();
    let producedOutput = false;
    // 诊断：完整 ModelRequest（不含请求头——头由适配器构造，天然不会进来）；
    // 图片 base64 脱敏为 { mimeType, bytes, sha256 }（ADR-0023，observability.md）
    deps.execEnv.diagnostics?.record("provider.request", {
      turnId,
      attempt,
      provider: provider.id,
      model: deps.model.model.ref.model,
      // ADR-0026 §7：请求记录带生效协议与接口路径（不含密钥）
      ...(deps.model.model.protocol !== undefined
        ? {
            protocol: deps.model.model.protocol,
            endpoint: PROTOCOL_ENDPOINTS[deps.model.model.protocol],
          }
        : {}),
      request: redactRequestImages(request),
    });
    const requestStart = Date.now();
    // 计时只看本次尝试：起点为请求交给 Provider 的时刻，首个内容事件定 TTFT。
    // heartbeat 已在 timedStream 内消费，不会到这里。
    const started = now();
    let firstContent: number | undefined;
    const settle = (): StreamAccumulation => {
      acc.timing = {
        ...(firstContent !== undefined ? { ttftMs: Math.round(firstContent - started) } : {}),
        durationMs: Math.round(now() - started),
      };
      return acc;
    };

    try {
      for await (const ev of timedStream(
        provider,
        request,
        signal,
        config.firstEventTimeoutMs,
        config.idleTimeoutMs,
      )) {
        producedOutput = true;
        if (firstContent === undefined && isContentEvent(ev)) firstContent = now();
        switch (ev.type) {
          case "text_delta": {
            if (
              ev.text !== "" ||
              ev.providerData === undefined ||
              acc.content.at(-1)?.type !== "text"
            )
              appendDelta(acc.content, "text", ev.text);
            const last = acc.content.at(-1);
            if (last?.type === "text" && ev.providerData !== undefined) {
              last.provider = provider.id;
              last.providerData = ev.providerData;
            }
            if (ev.text === "") break;
            session.emitEphemeral(
              "message.assistant.delta",
              { messageId, kind: "text", delta: ev.text },
              { turnId },
            );
            break;
          }
          case "reasoning_delta": {
            if (
              ev.text !== "" ||
              (ev.providerData !== undefined && acc.content.at(-1)?.type !== "reasoning")
            )
              appendDelta(acc.content, "reasoning", ev.text);
            // 专有数据 delta（如 Anthropic signature）落到末尾推理块；
            // 仅元数据的部件也要保留，但不产生空的界面 delta。
            if (ev.providerData !== undefined) {
              const last = acc.content.at(-1);
              if (last?.type === "reasoning") {
                last.provider = provider.id;
                last.providerData = ev.providerData;
              }
            }
            if (ev.text === "") break;
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
              ...(ev.providerData !== undefined ? { providerData: ev.providerData } : {}),
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
            if (
              ev.reason === "stop" &&
              !acc.content.some((block) => block.type === "text" && block.text.length > 0) &&
              acc.toolCalls.length === 0
            ) {
              throw new EmptyResponseError();
            }
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
            return { kind: "finished", finishReason: ev.reason, acc: settle() };
          }
        }
        if (signal.aborted) return { kind: "aborted", acc: settle() };
      }
      // 流结束但没有 finish：违反 Provider 契约，按意外结束处理
      return {
        kind: "failed",
        error: new Error("Provider 流在没有 finish 的情况下结束"),
        acc: settle(),
        producedOutput,
        retries: attempt - 1,
      };
    } catch (e) {
      deps.execEnv.diagnostics?.record("provider.error", {
        turnId,
        attempt,
        provider: provider.id,
        kind:
          e instanceof EmptyResponseError
            ? "empty_response"
            : isProviderError(e)
              ? e.kind
              : "unknown",
        message: e instanceof Error ? e.message : String(e),
        retryable: e instanceof EmptyResponseError || (isProviderError(e) && e.retryable),
        producedOutput,
        durationMs: Date.now() - requestStart,
      });
      if (signal.aborted || isAbortError(e)) {
        return { kind: "aborted", acc: settle() };
      }
      if (
        (e instanceof EmptyResponseError || (isProviderError(e) && e.retryable)) &&
        attempt < maxAttempts
      ) {
        // 本次累积尚未持久化、工具尚未执行；丢弃后重发整个请求。
        const delayMs =
          (isProviderError(e) ? e.retryAfterMs : undefined) ??
          config.retryBaseDelayMs * 2 ** (attempt - 1);
        session.emitEphemeral(
          "provider.retry",
          {
            attempt,
            maxAttempts,
            delayMs,
            ...(producedOutput && !(e instanceof EmptyResponseError)
              ? { discarded: { messageId, callIds: [...pending.values()].map((p) => p.callId) } }
              : {}),
            error: {
              kind: e instanceof EmptyResponseError ? "empty_response" : e.kind,
              message: e.message,
            },
          },
          { turnId },
        );
        session.emitEphemeral("runtime.status", { status: "retrying" }, { turnId });
        if (await sleep(delayMs, signal)) {
          return { kind: "aborted", acc: { content: [], toolCalls: [], usage: undefined } };
        }
        continue;
      }
      return { kind: "failed", error: e, acc: settle(), producedOutput, retries: attempt - 1 };
    }
  }
  // 不可达：循环内必然返回
  return {
    kind: "failed",
    error: new Error("retry loop exhausted"),
    acc: { content: [], toolCalls: [], usage: undefined },
    producedOutput: false,
    retries: config.retryLimit,
  };
}
