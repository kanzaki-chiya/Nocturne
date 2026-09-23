/**
 * openai-compatible 适配器（providers.md 第 4 节）。
 * 传输实现：@ai-sdk/openai-compatible（Chat Completions）。
 * SDK 类型只存在于本文件内，不泄漏到 Core（ADR-0005）。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  jsonSchema,
  streamText,
  type AssistantContent,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage as AiModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type { ContentBlock, FinishReason, Usage } from "../../protocol/index.js";
import { abortError, ProviderError } from "../errors.js";
import { resolveModelInfo, type ModelOverride } from "../registry.js";
import type { ModelInfo, ModelRequest, ModelStreamEvent, Provider } from "../types.js";

export interface OpenAICompatibleConfig {
  /** Provider id（也是 providerOptions 的键） */
  id: string;
  baseURL: string;
  /** 环境变量名；凭据只经环境变量读取 */
  apiKeyEnv: string;
  /** 模型能力覆盖（合并在内置目录之上） */
  models?: Record<string, ModelOverride> | undefined;
  /** 原样传给适配器（providerOptions） */
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

type EnvReader = (name: string) => string | undefined;

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  env: EnvReader = (name) => process.env[name],
): Provider {
  const apiKey = env(config.apiKeyEnv);
  const sdk = createOpenAICompatible({
    name: config.id,
    baseURL: config.baseURL,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  });

  const modelList: ModelInfo[] = Object.keys(config.models ?? {}).map((id) =>
    resolveModelInfo({ provider: config.id, model: id }, config.models?.[id]),
  );

  return {
    id: config.id,
    type: "openai-compatible",
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      if (apiKey === undefined || apiKey === "") {
        throw new ProviderError({
          kind: "auth",
          message: `环境变量 ${config.apiKeyEnv} 未设置（openai-compatible Provider "${config.id}"）`,
          retryable: false,
        });
      }
      const result = streamText({
        model: sdk.chatModel(request.model),
        system: request.system.map((b) => b.text).join("\n\n"),
        messages: toAiMessages(request),
        tools: toAiTools(request),
        maxOutputTokens: request.maxOutputTokens,
        // 重试由 Agent Loop 决定（providers.md 第 5 节）；SDK 层一律不重试
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        ...(request.providerOptions !== undefined
          ? {
              providerOptions: {
                [config.id]: request.providerOptions as Record<string, JSONValue>,
              },
            }
          : {}),
      });

      const toolNames = new Map<string, string>();
      let sawFinish = false;
      let sawUsage = false;
      try {
        for await (const part of result.stream) {
          if (signal.aborted) throw abortError();
          const events = mapPart(part, toolNames);
          for (const ev of events) {
            if (ev.type === "usage") {
              if (sawUsage) continue;
              sawUsage = true;
            }
            if (ev.type === "finish") sawFinish = true;
            yield ev;
          }
        }
      } catch (e) {
        throw toProviderError(e, signal);
      }
      // 契约：成功的流以且仅以一个 finish 结束
      if (!sawFinish) {
        yield { type: "finish", reason: "other", rawReason: "stream_ended_without_finish" };
      }
    },
  };
}

// ── 消息转换：中性 ModelMessage → AI SDK ModelMessage ──────

function toAiMessages(request: ModelRequest): AiModelMessage[] {
  // callId → 线上 id：同一请求内同一对调用/结果必须用同一个 id（provider-api.md 第 3 节）
  const wireIds = new Map<string, string>();
  const out: AiModelMessage[] = [];
  for (const m of request.messages) {
    switch (m.role) {
      case "user": {
        out.push({
          role: "user",
          content: m.content
            .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
            .map((c) => ({ type: "text" as const, text: c.text })),
        });
        break;
      }
      case "assistant": {
        const parts: AssistantContent = [];
        for (const c of m.content) {
          if (c.type === "text") {
            parts.push({ type: "text", text: c.text });
          } else {
            parts.push({ type: "reasoning", text: c.text });
          }
        }
        for (const tc of m.toolCalls) {
          const wireId = tc.providerCallId ?? tc.callId;
          wireIds.set(tc.callId, wireId);
          let input = tc.input;
          if (input === undefined && tc.rawInput !== undefined) {
            try {
              input = JSON.parse(tc.rawInput) as unknown;
            } catch {
              input = {};
            }
          }
          parts.push({
            type: "tool-call",
            toolCallId: wireId,
            toolName: tc.name,
            input: input ?? {},
          });
        }
        out.push({ role: "assistant", content: parts });
        break;
      }
      case "tool": {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: wireIds.get(m.callId) ?? m.callId,
              toolName: m.name,
              output: m.isError
                ? { type: "error-text", value: m.content }
                : { type: "text", value: m.content },
            },
          ],
        });
        break;
      }
    }
  }
  return out;
}

function toAiTools(request: ModelRequest): ToolSet {
  const tools: ToolSet = {};
  for (const spec of request.tools) {
    tools[spec.name] = {
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
    };
  }
  return tools;
}

// ── 流式事件归一化 ─────────────────────────────────────────

function mapPart(
  part: TextStreamPart<ToolSet>,
  toolNames: Map<string, string>,
): ModelStreamEvent[] {
  switch (part.type) {
    case "text-delta":
      return [{ type: "text_delta", text: part.text }];
    case "reasoning-delta":
      return [{ type: "reasoning_delta", text: part.text }];
    case "tool-input-start":
      toolNames.set(part.id, part.toolName);
      return [];
    case "tool-input-delta":
      return [
        {
          type: "tool_call_delta",
          toolCallId: part.id,
          name: toolNames.get(part.id) ?? "",
          argsDelta: part.delta,
        },
      ];
    case "tool-call": {
      const invalid = "invalid" in part && part.invalid === true;
      return [
        {
          type: "tool_call",
          toolCallId: part.toolCallId,
          name: part.toolName,
          input: invalid ? undefined : part.input,
          rawInput: invalid && typeof part.input === "string" ? part.input : undefined,
        },
      ];
    }
    case "finish": {
      const events: ModelStreamEvent[] = [];
      const usage = mapUsage(part.totalUsage);
      if (usage !== undefined) events.push({ type: "usage", usage });
      events.push({
        type: "finish",
        reason: mapFinishReason(part.finishReason),
        rawReason: part.rawFinishReason,
      });
      return events;
    }
    case "error":
      throw toProviderError(part.error, undefined);
    case "abort":
      throw abortError();
    default:
      // start / *-start / *-end / source / file / raw / tool-result 等：不需要
      return [];
  }
}

function mapUsage(u: LanguageModelUsage | undefined): Usage | undefined {
  if (u === undefined) return undefined;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens,
    reasoningTokens: u.outputTokenDetails.reasoningTokens,
  };
}

function mapFinishReason(r: string | undefined): FinishReason {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    default:
      return "other";
  }
}

// ── 错误归一化（duck-typing：@ai-sdk/provider 不是直接依赖） ──

interface SdkErrorShape {
  name?: string;
  message?: string;
  statusCode?: number;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  isRetryable?: boolean;
  cause?: unknown;
}

function toProviderError(e: unknown, signal: AbortSignal | undefined): Error {
  if (e instanceof ProviderError) return e;
  if (signal?.aborted === true) return abortError();
  if (e instanceof Error && e.name === "AbortError") return abortError();

  const s = e as SdkErrorShape;
  const status = s.statusCode ?? s.status;
  const providerMessage =
    typeof s.responseBody === "string" && s.responseBody.length > 0
      ? s.responseBody.slice(0, 2000)
      : s.message;
  const retryAfterMs = parseRetryAfter(s.responseHeaders?.["retry-after"]);

  if (typeof status === "number") {
    let kind: ProviderError["kind"] = "unknown";
    if (status === 401 || status === 403) kind = "auth";
    else if (status === 408) kind = "timeout";
    else if (status === 409) kind = "overloaded";
    else if (status === 413) kind = "context_overflow";
    else if (status === 429) kind = "rate_limit";
    else if (status >= 500) kind = "server";
    else if (status === 400 || status === 422) {
      // 部分兼容服务用 400 表达上下文超限
      kind = /context|length|token/i.test(String(providerMessage))
        ? "context_overflow"
        : "invalid_request";
    }
    return new ProviderError({
      kind,
      message: s.message ?? `HTTP ${status}`,
      retryable: s.isRetryable,
      retryAfterMs,
      status,
      providerMessage,
      cause: e,
    });
  }

  // 无 HTTP 状态：网络层失败（fetch TypeError、ECONN* 等）
  const causeCode =
    typeof s.cause === "object" && s.cause !== null && "code" in s.cause
      ? String((s.cause as { code?: unknown }).code)
      : undefined;
  const isNetwork =
    e instanceof TypeError ||
    (causeCode !== undefined &&
      /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(causeCode));
  return new ProviderError({
    kind: isNetwork ? "network" : "unknown",
    message: s.message ?? String(e),
    providerMessage,
    cause: e,
  });
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
