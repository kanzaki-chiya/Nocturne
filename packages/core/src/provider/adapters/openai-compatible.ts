/**
 * openai-compatible 适配器（providers.md 第 4 节）。
 * 传输实现：@ai-sdk/openai-compatible（Chat Completions）。
 * SDK 类型只存在于本文件与 ai-sdk-common.ts 内，不泄漏到 Core（ADR-0005）。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { abortError, ProviderError } from "../errors.js";
import { resolveModelInfo, type ModelOverride } from "../registry.js";
import { withReasoningEfforts } from "../reasoning.js";
import type {
  CredentialResolver,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  Provider,
  ProviderThinkingOptions,
} from "../types.js";
import { type Diagnostics } from "../../protocol/index.js";
import {
  mapPart,
  planToolChoice,
  suppressSdkErrorLog,
  toAiMessages,
  toAiTools,
  toProviderError,
  routeSdkWarnings,
} from "./ai-sdk-common.js";
import { sessionRequestHeaders, withUserAgent } from "../http.js";
import type { JSONValue } from "ai";

export interface OpenAICompatibleConfig {
  /** Provider id（也是 providerOptions 的键） */
  id: string;
  /** 适配器类型标识；缺省即 openai-compatible（providerConfigs 联合的分辨字段） */
  type?: "openai-compatible" | undefined;
  baseURL: string;
  /**
   * 环境变量名（v0.1 方式保留）。可选：省略时凭据经 credentials 解析
   * （provider-setup.md 第 3 节的凭据索引，密钥不落配置文件）。
   */
  apiKeyEnv?: string | undefined;
  /**
   * 凭据解析器（装配处注入 CredentialStore.get）：apiKeyEnv 未设置或
   * 对应环境变量为空时，请求前经它取密钥；结果由存储层进程内缓存。
   */
  credentials?: CredentialResolver | undefined;
  /** 模型能力覆盖（合并在内置目录之上） */
  models?: Record<string, ModelOverride> | undefined;
  /** true 时接受清单外的模型 id（回退内置目录/保守默认；见 Provider.strictModels） */
  allowUndeclaredModels?: boolean | undefined;
  /** 原样传给适配器（providerOptions） */
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * 思考兼容开关（ADR-0018）：format 决定档位写进请求体的形状
   * （"openai" → reasoning_effort，缺省；"openrouter" → reasoning.effort）；
   * levels 是服务商级可用档位（用户声明）。
   */
  thinking?: ProviderThinkingOptions | undefined;
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

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  env: EnvReader = (name) => process.env[name],
  /** 测试注入用；生产不传（SDK 默认全局 fetch） */
  fetchImpl?: typeof fetch,
): Provider {
  routeSdkWarnings(config.diagnostics);
  // 构造时只取环境变量；凭据存储在请求时解析（异步），两条路径在 stream 里汇合
  const apiKeyFromEnv =
    config.apiKeyEnv !== undefined && env(config.apiKeyEnv) !== ""
      ? env(config.apiKeyEnv)
      : undefined;
  const missingKeyError = (): ProviderError =>
    new ProviderError({
      kind: "auth",
      message:
        config.apiKeyEnv !== undefined
          ? `环境变量 ${config.apiKeyEnv} 未设置，凭据存储中也没有 "${config.id}" 的密钥（openai-compatible Provider）——可运行 nctrn setup 或 /provider key 配置`
          : `Provider "${config.id}" 未配置凭据——可运行 nctrn setup 或 /provider key 配置，或在条目上声明 apiKeyEnv`,
      retryable: false,
    });
  /** 请求时解析密钥：环境变量优先，其次凭据存储（结果由存储层缓存） */
  const resolveKey = async (): Promise<string | undefined> =>
    apiKeyFromEnv ?? (await config.credentials?.(config.id));
  // SDK 的 apiKey 只接受静态字符串；凭据存储的密钥经包装 fetch
  // 覆盖 Authorization 头注入（每次请求取最新值，/provider key 后立即生效）。
  // 惰性取 globalThis.fetch：测试在构造后替换全局 fetch 的场景保持有效
  const baseFetch: typeof fetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  const wrappedFetch: typeof fetch = async (url, init) => {
    const key = await resolveKey();
    if (key === undefined) throw missingKeyError();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    return baseFetch(url, { ...init, headers });
  };
  const sdk = createOpenAICompatible({
    name: config.id,
    baseURL: config.baseURL,
    ...(apiKeyFromEnv !== undefined ? { apiKey: apiKeyFromEnv } : {}),
    // ADR-0031 §2：User-Agent 以 nocturne/<version> 开头（条目 headers
    // 里用户写的 UA 优先）；SDK 追加的 ai-sdk/... 后缀保留
    headers: withUserAgent(config.headers, config.userAgent),
    fetch: wrappedFetch,
  });
  // SDK 的 providerOptions 命名空间是 name.split(".")[0] 的驼峰形；
  // 含连字符/下划线的 id 用原名会触发 SDK 弃用告警，统一写驼峰键
  const optionsNs = (config.id.split(".")[0] ?? config.id).replace(
    /[-_]([a-z])/g,
    (_m, c: string) => c.toUpperCase(),
  );

  const thinkingFormat = config.thinking?.format ?? "openai";
  const modelList: ModelInfo[] = Object.keys(config.models ?? {}).map((id) =>
    withReasoningEfforts(resolveModelInfo({ provider: config.id, model: id }, config.models?.[id])),
  );

  return {
    id: config.id,
    type: "openai-compatible",
    strictModels: config.allowUndeclaredModels !== true,
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      if ((await resolveKey()) === undefined) {
        throw missingKeyError();
      }
      // 归一化档位写进 providerOptions 命名空间（ADR-0018 §3）：
      // format "openai" → reasoningEffort: "<level>"（schema 键，SDK 序列化为
      // reasoning_effort；蛇形 reasoning_effort 会被 SDK 的显式字段覆盖，不能用）；
      // format "openrouter" → reasoning: { effort: "<level>" }（非 schema 键，
      // 原样透传进请求体）。"max" 两种格式都原样发送。
      // 之后与手写推理键走同一条 toolChoice 剥离路径（本轮关闭思考）
      const merged: Record<string, unknown> = {
        ...(config.providerOptions ?? {}),
        ...(request.providerOptions ?? {}),
      };
      if (request.reasoningEffort !== undefined) {
        if (thinkingFormat === "openrouter") {
          const existing = merged.reasoning;
          merged.reasoning = {
            ...(typeof existing === "object" && existing !== null ? existing : {}),
            effort: request.reasoningEffort,
          };
        } else {
          merged.reasoningEffort = request.reasoningEffort;
        }
      }
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
      const sessionHeaders = sessionRequestHeaders(config, request.sessionId);

      const result = streamText({
        model: sdk.chatModel(request.model),
        system: request.system.map((b) => b.text).join("\n\n"),
        // ADR-0023：Chat Completions 的 tool 消息不能携带图片——
        // 工具结果图以批末 user 消息转发（ai-sdk-common.ts 说明）
        messages: toAiMessages(request, { toolResultImages: "user-message" }),
        tools: toAiTools(request),
        // ADR-0016：最大输出长度未知时请求不带 max_tokens，由上游按自己的上限处理
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        // 重试由 Agent Loop 决定（providers.md 第 5 节）；SDK 层一律不重试
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        onError: suppressSdkErrorLog,
        ...(sessionHeaders !== undefined ? { headers: sessionHeaders } : {}),
        // 配置级 providerOptions 为底，请求级覆盖；命名空间是 SDK 首选驼峰键
        ...(providerOptions !== undefined && Object.keys(providerOptions).length > 0
          ? { providerOptions: { [optionsNs]: providerOptions as Record<string, JSONValue> } }
          : {}),
        ...(choice.toolChoice !== undefined ? { toolChoice: choice.toolChoice } : {}),
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
