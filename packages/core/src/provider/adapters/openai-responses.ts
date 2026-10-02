/**
 * openai-responses 适配器（ADR-0031 §1）：OpenAI Responses API。
 * 传输实现：@ai-sdk/openai 的 provider.responses(modelId)。
 * SDK 类型只存在于本文件与 ai-sdk-common.ts 内，不泄漏到 Core（ADR-0005）。
 *
 * 要点（ADR-0031 §6）：
 * - store:false + include "reasoning.encrypted_content"：不依赖上游存储，
 *   推理以加密块返还并随推理 providerData 原样回传（providerMetadata ↔
 *   providerData，形状 { openai: { itemId, reasoningEncryptedContent } }）；
 * - 档位翻译：归一化 reasoningEffort → reasoning.effort，并附
 *   reasoning.summary "auto"；
 * - 鉴权只发 Authorization: Bearer；条目 headers 照带；
 *   条目级 providerOptions 不给（该适配器不接受此配置项）。
 */
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type JSONValue } from "ai";
import { abortError, ProviderError } from "../errors.js";
import { createAuthResolver } from "../auth.js";
import { resolveModelInfo, type ModelOverride } from "../registry.js";
import { withReasoningEfforts } from "../reasoning.js";
import type {
  AuthResolver,
  CredentialResolver,
  ModelInfo,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  Provider,
  ProviderAuth,
} from "../types.js";
import { type Diagnostics } from "../../protocol/index.js";
import { createAuthFetch, modelRequestHeaders, withUserAgent } from "../http.js";
import {
  mapPart,
  planToolChoice,
  suppressSdkErrorLog,
  toAiMessages,
  toAiTools,
  toProviderError,
  routeSdkWarnings,
} from "./ai-sdk-common.js";
import { constrainResponsesFetch } from "./responses-constraints.js";

export interface OpenAIResponsesConfig {
  /** Provider id */
  id: string;
  /** 适配器类型标识；缺省即 openai-responses */
  type?: "openai-responses" | undefined;
  /** 必填：Responses 没有适配器内置端点（缺省报错在 entry.ts 与 openai-compatible 一致） */
  baseURL: string;
  /**
   * 环境变量名（v0.1 方式保留）。可选：省略时凭据经 credentials 解析
   * （provider-setup.md 第 3 节的凭据索引，密钥不落配置文件）。
   */
  apiKeyEnv?: string | undefined;
  auth?: ProviderAuth | undefined;
  authResolver?: AuthResolver | undefined;
  /**
   * 凭据解析器（装配处注入 CredentialStore.get）：apiKeyEnv 未设置或
   * 对应环境变量为空时，请求前经它取密钥；结果由存储层进程内缓存。
   */
  credentials?: CredentialResolver | undefined;
  /** 模型能力覆盖（合并在内置目录之上） */
  models?: Record<string, ModelOverride> | undefined;
  /** true 时接受清单外的模型 id（回退内置目录/保守默认；见 Provider.strictModels） */
  allowUndeclaredModels?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  modelHeader?: string | undefined;
  /**
   * User-Agent 基值（ADR-0031 §2）：装配处注入 `nocturne/<version>`；
   * 缺省用内置版本。条目 headers 里的 UA（不区分大小写）优先。
   */
  userAgent?: string | undefined;
  /**
   * 会话标识请求头名（ADR-0031 §3）：请求携带 sessionId 时写
   * `<sessionHeader>: <sessionId>`；静态 headers 已有同名头时不写。
   */
  sessionHeader?: string | undefined;
  /** 诊断通道（observability.md）；缺省 no-op */
  diagnostics?: Diagnostics | undefined;
}

type EnvReader = (name: string) => string | undefined;

export function createOpenAIResponsesProvider(
  config: OpenAIResponsesConfig,
  env: EnvReader = (name) => process.env[name],
  /** 测试注入用；生产不传（SDK 默认全局 fetch） */
  fetchImpl?: typeof fetch,
): Provider {
  routeSdkWarnings(config.diagnostics);
  const auth = createAuthResolver(config, env);
  const wrappedFetch = createAuthFetch(
    auth,
    (headers, token) => {
      headers.set("Authorization", `Bearer ${token}`);
    },
    fetchImpl,
  );
  const sdk = createOpenAI({
    baseURL: config.baseURL,
    // SDK 在组装请求头时强制读取 apiKey；真实凭据仍由 wrappedFetch 按请求覆盖
    apiKey: "resolved-by-fetch",
    // ADR-0031 §2：User-Agent 以 nocturne/<version> 开头（条目 headers
    // 里用户写的 UA 优先）；SDK 追加的 ai-sdk/... 后缀保留
    headers: withUserAgent(config.headers, config.userAgent),
    fetch: wrappedFetch,
  });
  const modelList: ModelInfo[] = Object.keys(config.models ?? {}).map((id) =>
    withReasoningEfforts(resolveModelInfo({ provider: config.id, model: id }, config.models?.[id])),
  );

  return {
    id: config.id,
    type: "openai-responses",
    strictModels: config.allowUndeclaredModels !== true,
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      const constrained =
        auth.requestConstraints === undefined
          ? undefined
          : constrainResponsesFetch(auth.requestConstraints, wrappedFetch);
      const requestSdk =
        constrained === undefined
          ? sdk
          : createOpenAI({
              baseURL: config.baseURL,
              apiKey: "resolved-by-fetch",
              headers: withUserAgent(config.headers, config.userAgent),
              fetch: constrained.fetch,
            });
      // providerOptions 命名空间固定为 "openai"（SDK providerOptionsName =
      // provider 名首段；ADR-0031 §6：条目级 providerOptions 不进入本适配器）。
      // store:false 与 encrypted_content include 是推理加密回传的前提，
      // 写在合并之后，不允许被覆盖；归一化档位同理覆盖同名键。
      const merged: Record<string, unknown> = { ...(request.providerOptions ?? {}) };
      if (request.reasoningEffort !== undefined) {
        merged.reasoningEffort = request.reasoningEffort;
        merged.reasoningSummary = "auto";
        // reasoningEffort 只在模型已声明推理能力时出现（Runtime 侧保证）；
        // SDK 按内置名录判定推理模型，名录外的 id（如聚合商模型）需要
        // forceReasoning 才会把 reasoning.* 写进请求体
        merged.forceReasoning = true;
      }
      merged.store = false;
      // 缓存路由键：不在服务端存储时缓存只能按前缀命中，同一会话带同一个键
      // 才会落到同一缓存分片；子代理用根会话 ID（ADR-0031 §3）。配置已给时不覆盖。
      if (request.sessionId !== undefined && merged.promptCacheKey === undefined) {
        merged.promptCacheKey = request.sessionId;
      }
      const declaredInclude = Array.isArray(merged.include)
        ? merged.include.filter((v): v is string => typeof v === "string")
        : [];
      merged.include = [...new Set([...declaredInclude, "reasoning.encrypted_content"])];

      const mergedOptions = Object.keys(merged).length > 0 ? merged : undefined;
      const choice = planToolChoice(request, mergedOptions);
      if (choice.note !== undefined) {
        config.diagnostics?.record("provider.unsupported_capability", {
          provider: config.id,
          capability: "tool_choice",
          resolution: choice.note.resolution,
          reason: choice.note.reason,
        });
      }
      const stripped = new Set(choice.strippedKeys);
      const providerOptions =
        mergedOptions !== undefined
          ? Object.fromEntries(Object.entries(mergedOptions).filter(([k]) => !stripped.has(k)))
          : undefined;
      // ADR-0031 §3：会话标识头——请求带 sessionId 且条目声明
      // sessionHeader 才写；静态 headers 同名头优先
      const requestHeaders = modelRequestHeaders(config, request);
      let droppedReasoning = 0;
      const messages = request.messages.flatMap<ModelMessage>((message) => {
        if (message.role !== "assistant") return [message];
        const content = message.content.filter((block) => {
          if (block.type !== "reasoning") return true;
          const data = block.providerData as { openai?: { itemId?: unknown } } | undefined;
          if (typeof data?.openai?.itemId === "string" && data.openai.itemId.length > 0) {
            return true;
          }
          droppedReasoning++;
          return false;
        });
        return content.length > 0 || message.toolCalls.length > 0 ? [{ ...message, content }] : [];
      });
      if (droppedReasoning > 0) {
        config.diagnostics?.record("provider.reasoning_dropped", {
          count: droppedReasoning,
          reason: "missing_openai_item_id",
        });
      }

      const result = streamText({
        model: requestSdk.responses(request.model),
        system: request.system.map((b) => b.text).join("\n\n"),
        messages: toAiMessages(
          { ...request, messages },
          {
            // providerData 就是 providerMetadata 原值（{ openai: {...} }），直接回传
            reasoningProviderOptions: (pd) => pd as Record<string, Record<string, JSONValue>>,
            // Responses 的 function_call_output 支持原生 input_image 部件
            toolResultImages: "native",
          },
        ),
        tools: toAiTools(request),
        // ADR-0016：最大输出长度未知时请求不带 max_output_tokens，由上游按自己的上限处理
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        // 重试由 Agent Loop 决定（providers.md 第 5 节）；SDK 层一律不重试
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        onError: suppressSdkErrorLog,
        ...(requestHeaders !== undefined ? { headers: requestHeaders } : {}),
        ...(providerOptions !== undefined && Object.keys(providerOptions).length > 0
          ? { providerOptions: { openai: providerOptions as Record<string, JSONValue> } }
          : {}),
        ...(choice.toolChoice !== undefined ? { toolChoice: choice.toolChoice } : {}),
      });

      const toolNames = new Map<string, string>();
      let sawFinish = false;
      let sawUsage = false;
      try {
        for await (const part of result.stream) {
          if (signal.aborted) throw abortError();
          if (
            part.type === "finish" &&
            auth.requestConstraints?.requireCompleted === true &&
            constrained?.completed() !== true
          ) {
            throw new ProviderError({
              kind: "network",
              message: "服务商响应流中断，请重试",
              retryable: true,
            });
          }
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
        const mapped = constrained?.failure();
        if (mapped !== undefined) throw mapped;
        if (
          constrained !== undefined &&
          !signal.aborted &&
          !(e instanceof Error && e.name === "AbortError") &&
          (!(e instanceof ProviderError) ||
            e.providerMessage !== undefined ||
            e.cause !== undefined)
        ) {
          throw new ProviderError({
            kind: "network",
            message: "服务商响应流中断，请重试",
            retryable: true,
          });
        }
        throw toProviderError(e, signal);
      }
      if (auth.requestConstraints?.requireCompleted === true && constrained?.completed() !== true) {
        throw new ProviderError({
          kind: "network",
          message: "服务商响应流中断，请重试",
          retryable: true,
        });
      }
      // 契约：成功的流以且仅以一个 finish 结束
      if (!sawFinish) {
        yield { type: "finish", reason: "other", rawReason: "stream_ended_without_finish" };
      }
    },
  };
}
