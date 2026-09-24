/**
 * AI SDK 适配器的共享映射层（providers.md 第 4 节）。
 * openai-compatible 与 anthropic 适配器共用消息/工具/事件/错误归一化；
 * SDK 类型只存在于 adapters 目录内（ADR-0005）。
 */
import {
  jsonSchema,
  type AssistantContent,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage as AiModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";

/** ai 包未再导出 ProviderOptions/JSONObject；此处与 SharedV4ProviderOptions 结构等价 */
type SdkProviderOptions = Record<string, Record<string, JSONValue>>;
import type { ContentBlock, FinishReason, Usage } from "../../protocol/index.js";
import { abortError, ProviderError } from "../errors.js";
import type { ModelRequest, ModelStreamEvent } from "../types.js";

// ── 消息转换：中性 ModelMessage → AI SDK ModelMessage ──────

export interface ToAiMessagesOptions {
  /**
   * 为 reasoning 块生成 providerOptions（如 anthropic 的 signature 回传）。
   * 返回 undefined 表示不带 providerOptions。
   */
  reasoningProviderOptions?: (providerData: unknown) => SdkProviderOptions | undefined;
}

export function toAiMessages(
  request: ModelRequest,
  options: ToAiMessagesOptions = {},
): AiModelMessage[] {
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
            const providerOptions =
              c.providerData !== undefined
                ? options.reasoningProviderOptions?.(c.providerData)
                : undefined;
            parts.push(
              providerOptions !== undefined
                ? { type: "reasoning", text: c.text, providerOptions }
                : { type: "reasoning", text: c.text },
            );
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

export function toAiTools(request: ModelRequest): ToolSet {
  const tools: ToolSet = {};
  for (const spec of request.tools) {
    tools[spec.name] = {
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
    };
  }
  return tools;
}

// ── toolChoice 映射与思考冲突（provider-api.md 第 3 节） ───

/**
 * providerOptions 命名空间内表示"推理/思考已开启"的键。
 * thinking 形如 { type: "enabled" | "disabled" }；reasoning / reasoningEffort
 * 以存在且非禁用值为准。集合是开放的：只处理可识别的键，未知键原样透传。
 */
const REASONING_OPTION_KEYS = ["thinking", "reasoning", "reasoningEffort"] as const;

function reasoningOptionEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "object" && "type" in value) {
    return value.type === "enabled";
  }
  return value !== "none" && value !== "off";
}

export interface ToolChoicePlan {
  /** 映射后的 ai-sdk toolChoice；被丢弃时为 undefined */
  toolChoice: { type: "tool"; toolName: string } | undefined;
  /**
   * 需要从本轮 providerOptions 移除的键（兜底轮临时关闭思考，
   * 使强制选择真正生效——subagent.md 第 2 节的二选一结论）。
   */
  strippedKeys: string[];
  /** 冲突处置说明（适配器记 diagnostics.provider.unsupported_capability） */
  note: { resolution: "disabled_reasoning" | "dropped_tool_choice"; reason: string } | undefined;
}

/**
 * 决定本轮请求如何携带 toolChoice。规则（provider-api.md 第 3 节）：
 * 思考/推理已开启时，优先把可识别的推理配置从本轮 providerOptions 移除
 * （临时关闭），保留 toolChoice 使强制生效；对无法安全移除的推理声明
 * （保留字段 request.reasoningEffort：Runtime 不赋值，适配器不映射；
 * 手工请求若设置它，则保守地丢弃 toolChoice）则丢弃 toolChoice。
 * 两种处置都不会把明知无效的组合发给服务端。
 */
export function planToolChoice(
  request: ModelRequest,
  mergedProviderOptions: Record<string, unknown> | undefined,
): ToolChoicePlan {
  if (request.toolChoice === undefined) {
    return { toolChoice: undefined, strippedKeys: [], note: undefined };
  }
  const toolChoice = { type: "tool" as const, toolName: request.toolChoice.name };
  if (request.reasoningEffort !== undefined) {
    return {
      toolChoice: undefined,
      strippedKeys: [],
      note: {
        resolution: "dropped_tool_choice",
        reason: "reasoningEffort 已设置：推理开启时无法表达具体 tool_choice，丢弃 toolChoice",
      },
    };
  }
  const strippedKeys = REASONING_OPTION_KEYS.filter(
    (k) =>
      mergedProviderOptions !== undefined &&
      k in mergedProviderOptions &&
      reasoningOptionEnabled(mergedProviderOptions[k]),
  );
  if (strippedKeys.length > 0) {
    return {
      toolChoice,
      strippedKeys,
      note: {
        resolution: "disabled_reasoning",
        reason: `本轮移除推理配置（${strippedKeys.join(", ")}）以使 toolChoice 生效`,
      },
    };
  }
  return { toolChoice, strippedKeys: [], note: undefined };
}

/**
 * streamText 的 onError 缺省会把错误打到 console；错误由适配器统一归一化为
 * ProviderError 后抛出，必须传空函数抑制 SDK 自带的 stderr 噪音。
 */
export const suppressSdkErrorLog = (): void => undefined;

// ── 流式事件归一化 ─────────────────────────────────────────

export function mapPart(
  part: TextStreamPart<ToolSet>,
  toolNames: Map<string, string>,
): ModelStreamEvent[] {
  switch (part.type) {
    case "text-delta":
      return [{ type: "text_delta", text: part.text }];
    case "reasoning-delta": {
      const providerData =
        part.providerMetadata !== undefined ? { ...part.providerMetadata } : undefined;
      return [
        {
          type: "reasoning_delta",
          text: part.text,
          ...(providerData !== undefined ? { providerData } : {}),
        },
      ];
    }
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

export function toProviderError(e: unknown, signal: AbortSignal | undefined): Error {
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
    else if (status === 409 || status === 529) kind = "overloaded";
    else if (status === 413) kind = "context_overflow";
    else if (status === 429) kind = "rate_limit";
    else if (status >= 500) kind = "server";
    else if (status === 400 || status === 422) {
      // 部分服务用 400 表达上下文超限（含 Anthropic 的 "prompt is too long"）
      kind = /context|length|token|too long/i.test(String(providerMessage))
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
