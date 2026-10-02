/**
 * AI SDK 适配器的共享映射层（providers.md 第 4 节）。
 * openai-compatible 与 anthropic 适配器共用消息/工具/事件/错误归一化；
 * SDK 类型只存在于 adapters 目录内（ADR-0005）。
 */
import {
  jsonSchema,
  type AssistantContent,
  type FilePart,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage as AiModelMessage,
  type TextPart,
  type TextStreamPart,
  type ToolResultPart,
  type ToolSet,
} from "ai";

/** ai 包未再导出 ProviderOptions/JSONObject；此处与 SharedV4ProviderOptions 结构等价 */
type SdkProviderOptions = Record<string, Record<string, JSONValue>>;
import type { ContentBlock, Diagnostics, FinishReason, Usage } from "../../protocol/index.js";
import { abortError, ProviderError } from "../errors.js";
import type { ModelImage, ModelRequest, ModelStreamEvent } from "../types.js";

// ── 消息转换：中性 ModelMessage → AI SDK ModelMessage ──────

export interface ToAiMessagesOptions {
  /**
   * 为 reasoning 块生成 providerOptions（如 anthropic 的 signature 回传）。
   * 返回 undefined 表示不带 providerOptions。
   */
  reasoningProviderOptions?: (providerData: unknown) => SdkProviderOptions | undefined;
  /**
   * 工具结果图片的传输方式（ADR-0023）：
   * - "user-message"（缺省，openai-compatible）：tool 消息只放文本——
   *   @ai-sdk/openai-compatible 对 content 型 output 会 JSON.stringify，
   *   绝不能用它传图——一批连续 tool 消息的 images 收集后在该批结束处
   *   插入一条 user 消息（每张图一行 `Image from tool call <id> (<name>):`）。
   * - "native"（anthropic）：output 用 SDK 的内容型结果
   *   （{ type:"content", value:[…] }），适配器转成 tool_result 内的
   *   原生 image 块；isError 带图时丢弃图片并在文本末追加说明。
   */
  toolResultImages?: "native" | "user-message" | undefined;
  /**
   * 提示缓存断点（anthropic 的 cache_control）：前 `afterMessages` 条中性消息
   * 转换出的最后一条 SDK 消息挂上 `providerOptions`。取
   * `request.cachePrefix.messages`；为 0 时不挂。
   */
  cacheBreakpoint?: { afterMessages: number; providerOptions: SdkProviderOptions } | undefined;
}

/** 中性图片 → AI SDK file 部件（v7 的 image 部件已弃用，file 是标准形态） */
function toFilePart(img: ModelImage): FilePart {
  return { type: "file", mediaType: img.mimeType, data: { type: "data", data: img.data } };
}

export function toAiMessages(
  request: ModelRequest,
  options: ToAiMessagesOptions = {},
): AiModelMessage[] {
  const toolResultImages = options.toolResultImages ?? "user-message";
  // callId → 线上 id：同一请求内同一对调用/结果必须用同一个 id（provider-api.md 第 3 节）
  const wireIds = new Map<string, string>();
  const out: AiModelMessage[] = [];
  // user-message 模式：连续 tool 消息的图像暂存，批末插入一条 user 消息
  const pendingToolImages: { wireId: string; toolName: string; img: ModelImage }[] = [];
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return;
    const parts: (TextPart | FilePart)[] = [];
    for (const p of pendingToolImages) {
      parts.push({
        type: "text",
        text: `Image from tool call ${p.wireId} (${p.toolName}):`,
      });
      parts.push(toFilePart(p.img));
    }
    out.push({ role: "user", content: parts });
    pendingToolImages.length = 0;
  };
  const breakpoint = options.cacheBreakpoint;
  // 前缀内消息转换出的 SDK 消息条数（断点挂在其中最后一条上）
  let prefixOut = breakpoint !== undefined && breakpoint.afterMessages <= 0 ? 0 : undefined;
  for (const [index, m] of request.messages.entries()) {
    if (index === breakpoint?.afterMessages) prefixOut = out.length;
    switch (m.role) {
      case "user": {
        flushToolImages();
        const content: (TextPart | FilePart)[] = m.content
          .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
          .map((c) => ({ type: "text" as const, text: c.text }));
        for (const img of m.images ?? []) content.push(toFilePart(img));
        out.push({ role: "user", content });
        break;
      }
      case "assistant": {
        flushToolImages();
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
        const wireId = wireIds.get(m.callId) ?? m.callId;
        const imgs = m.images ?? [];
        let output: ToolResultPart["output"];
        if (toolResultImages === "native" && imgs.length > 0 && !m.isError) {
          output = {
            type: "content" as const,
            value: [
              { type: "text" as const, text: m.content },
              ...imgs.map((img) => ({
                type: "file" as const,
                mediaType: img.mimeType,
                data: { type: "data" as const, data: img.data },
              })),
            ],
          };
        } else if (m.isError) {
          // native 模式下 Anthropic 的 is_error tool_result 不携带图片：
          // 丢弃并在文本末注明（user-message 模式的图仍在下方收集转发）
          output = {
            type: "error-text" as const,
            value:
              imgs.length > 0 && toolResultImages === "native"
                ? `${m.content}\n[image omitted: error result]`
                : m.content,
          };
        } else {
          output = { type: "text" as const, value: m.content };
        }
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: wireId,
              toolName: m.name,
              output,
            },
          ],
        });
        if (toolResultImages === "user-message") {
          for (const img of imgs) {
            pendingToolImages.push({ wireId, toolName: m.name, img });
          }
        }
        break;
      }
    }
  }
  flushToolImages();
  if (breakpoint !== undefined) {
    const target = out[(prefixOut ?? out.length) - 1];
    if (target !== undefined) target.providerOptions = breakpoint.providerOptions;
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
 * thinking 形如 { type: "enabled" | "disabled" }；reasoning / reasoningEffort /
 * reasoning_effort 以存在且非禁用值为准。集合是开放的：只处理可识别的键，
 * 未知键原样透传。
 */
const REASONING_OPTION_KEYS = [
  "thinking",
  "reasoning",
  "reasoningEffort",
  "reasoning_effort",
] as const;

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
 * 决定本轮请求如何携带 toolChoice。规则（provider-api.md 第 3 节，ADR-0018 §3）：
 * - request.reasoningEffort 已设置（归一化档位）：推理确定开启且档位是请求级
 *   承诺，无法安全关闭 → 丢弃 toolChoice（子代理 finish 兜底轮由 Runtime 侧
 *   不携带档位来关闭思考，正常路径不触发本分支）。
 * - providerOptions 中可识别的推理键已开启：把推理配置从本轮 providerOptions
 *   移除（临时关闭），保留 toolChoice 使强制生效。
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

// ── 上游存活信号（ADR-0014 修订） ───────────────────────────

const HEARTBEAT_INTERVAL_MS = 1_000;

/**
 * 在 fetch 层观察上游：拿到响应头、读到任意字节（含 SSE 保活注释）都算存活。
 * SDK 只在首个内容事件到来时才发 start-step，长上下文或推理模型在此之前可能静默很久，
 * 不能用它判断连接是否建立。每个请求单独创建，events() 把存活信号并入 SDK 的流，
 * 以 heartbeat 交给计时包装（至多每秒一次）。
 */
export function createLiveness(fetchImpl: typeof fetch): {
  fetch: typeof fetch;
  events<T>(source: AsyncIterable<T>): AsyncIterable<T | { type: "heartbeat" }>;
} {
  let beaten = false;
  let waiter: (() => void) | undefined;
  const beat = (): void => {
    beaten = true;
    const wake = waiter;
    waiter = undefined;
    wake?.();
  };
  const livenessFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    beat();
    if (response.body === null) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          beat();
          controller.enqueue(chunk);
        },
      }),
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  async function* events<T>(source: AsyncIterable<T>): AsyncIterable<T | { type: "heartbeat" }> {
    const iterator = source[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<T>> | undefined;
    let lastHeartbeat = -Infinity;
    try {
      for (;;) {
        pending ??= iterator.next();
        const woke = beaten
          ? Promise.resolve("beat" as const)
          : new Promise<"beat">((resolve) => {
              waiter = () => {
                resolve("beat");
              };
            });
        const result = await Promise.race([pending, woke]);
        if (result === "beat") {
          beaten = false;
          if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeat = Date.now();
            yield { type: "heartbeat" };
          }
          continue;
        }
        waiter = undefined;
        pending = undefined;
        if (result.done === true) return;
        yield result.value;
      }
    } finally {
      waiter = undefined;
      await iterator.return?.();
    }
  }
  return { fetch: livenessFetch, events };
}

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
    case "reasoning-start":
    case "reasoning-end": {
      // 推理块的专有数据也可能只出现在边界事件上（ADR-0031 §1：
      // Responses 在 reasoning-end 携带 encrypted_content）。以空 text 的
      // reasoning_delta 上送——stream.ts 对 text==="" 只合并数据不产生新块
      const providerData =
        part.providerMetadata !== undefined ? { ...part.providerMetadata } : undefined;
      // Responses 把一个推理项的摘要分段发送，后续段的 id 为 `<itemId>:<n>`（n ≥ 1），
      // 各段合并进同一推理块；段间补空行，否则段落标题首尾相连。
      // 其他协议的推理块 id 不是这种形式，文本不变（Anthropic 思考块带签名，改文本会失效）。
      const summaryIndex = part.type === "reasoning-start" ? /:(\d+)$/.exec(part.id) : null;
      const separator = summaryIndex !== null && Number(summaryIndex[1]) > 0 ? "\n\n" : "";
      if (separator !== "")
        return [
          {
            type: "reasoning_delta",
            text: separator,
            ...(providerData !== undefined ? { providerData } : {}),
          },
        ];
      return providerData !== undefined
        ? [{ type: "reasoning_delta", text: "", providerData }]
        : [];
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
    } else if (status === 404) kind = "invalid_request"; // 端点路径或模型 id 有误
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

let sdkWarningSink: Diagnostics | undefined;

/**
 * AI SDK 的警告默认经 process.emitWarning 打到 stderr，会打乱全屏 TUI；
 * 改记诊断 provider.sdk_warning（observability.md）。进程级开关，
 * 由最近装配的适配器的诊断通道接收；用户已自行设置 AI_SDK_LOG_WARNINGS 时不覆盖。
 */
export function routeSdkWarnings(diagnostics: Diagnostics | undefined): void {
  if (diagnostics !== undefined) sdkWarningSink = diagnostics;
  const g = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
  if (g.AI_SDK_LOG_WARNINGS !== undefined) return;
  g.AI_SDK_LOG_WARNINGS = (options: { warnings: unknown[]; provider?: string; model?: string }) => {
    sdkWarningSink?.record("provider.sdk_warning", {
      provider: options.provider,
      model: options.model,
      warnings: options.warnings,
    });
  };
}
