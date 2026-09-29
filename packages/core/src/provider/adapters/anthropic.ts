/**
 * anthropic 适配器（providers.md 第 4 节、ADR-0006）。
 * 传输实现：@ai-sdk/anthropic（Messages API + SSE）。
 * SDK 类型只存在于本文件与 ai-sdk-common.ts 内，不泄漏到 Core（ADR-0005）。
 *
 * 推理块回传：流式 signature delta 以 reasoning_delta.providerData 进入
 * Core；历史回传时 providerData 原样放回 providerOptions（形状即
 * { anthropic: { signature } }），由适配器还原为 thinking 块。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, type JSONValue } from "ai";
import { abortError, ProviderError } from "../errors.js";
import { MAX_OUTPUT_FALLBACK } from "../catalog.js";
import { planAnthropicThinking, withReasoningEfforts } from "../reasoning.js";
import { resolveModelInfo, type ModelOverride } from "../registry.js";
import type {
  CredentialResolver,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  Provider,
  ProviderThinkingOptions,
} from "../types.js";
import {
  isReasoningEffortLevel,
  type Diagnostics,
  type ReasoningEffortLevel,
} from "../../protocol/index.js";
import {
  mapPart,
  planToolChoice,
  suppressSdkErrorLog,
  toAiMessages,
  toAiTools,
  toProviderError,
} from "./ai-sdk-common.js";

export interface AnthropicConfig {
  /** Provider id（providerOptions 的 SDK 命名空间固定为 "anthropic"，与 id 无关） */
  id: string;
  /** 适配器类型标识（providerConfigs 联合的分辨字段） */
  type: "anthropic";
  /** 缺省用 SDK 内置的 api.anthropic.com */
  baseURL?: string | undefined;
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
  /** 原样传给适配器（providerOptions.anthropic） */
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * 思考兼容开关（ADR-0018）：levels 是服务商级可用档位（用户声明）；
   * budgets 覆盖档位 → thinking.budget_tokens 的默认预算表。
   * anthropic 不使用 format（恒走 thinking.budget_tokens）。
   */
  thinking?: ProviderThinkingOptions | undefined;
  /**
   * ADR-0026 §3：openai-compatible 条目下的 Messages 协议请求同时发送
   * `x-api-key` 与 `Authorization: Bearer`（各家 Messages 兼容网关接受的
   * 鉴权头不统一，两个都带由网关选用）。anthropic 条目本家请求置 false
   * ——不给官方端点多发 Authorization，以免被当成 OAuth 令牌。
   */
  dualAuth?: boolean | undefined;
  /** 诊断通道（observability.md）；缺省 no-op */
  diagnostics?: Diagnostics | undefined;
}

type EnvReader = (name: string) => string | undefined;

export function createAnthropicProvider(
  config: AnthropicConfig,
  env: EnvReader = (name) => process.env[name],
  /** 测试注入用；生产不传（SDK 默认全局 fetch） */
  fetchImpl?: typeof fetch,
): Provider {
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
          ? `环境变量 ${config.apiKeyEnv} 未设置，凭据存储中也没有 "${config.id}" 的密钥（anthropic Provider）——可运行 nctrn setup 或 /provider key 配置`
          : `Provider "${config.id}" 未配置凭据——可运行 nctrn setup 或 /provider key 配置，或在条目上声明 apiKeyEnv`,
      retryable: false,
    });
  /** 请求时解析密钥：环境变量优先，其次凭据存储（结果由存储层缓存） */
  const resolveKey = async (): Promise<string | undefined> =>
    apiKeyFromEnv ?? (await config.credentials?.(config.id));
  // SDK 的 apiKey 只接受静态字符串；凭据存储的密钥经包装 fetch
  // 覆盖 x-api-key 头注入（每次请求取最新值，/provider key 后立即生效）。
  // 惰性取 globalThis.fetch：测试在构造后替换全局 fetch 的场景保持有效
  const baseFetch: typeof fetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  const wrappedFetch: typeof fetch = async (url, init) => {
    const key = await resolveKey();
    if (key === undefined) throw missingKeyError();
    const headers = new Headers(init?.headers);
    headers.set("x-api-key", key);
    // ADR-0026 §3：openai-compatible 条目下的 Messages 请求双发鉴权头
    if (config.dualAuth === true) headers.set("Authorization", `Bearer ${key}`);
    return baseFetch(url, { ...init, headers });
  };
  const sdk = createAnthropic({
    ...(apiKeyFromEnv !== undefined ? { apiKey: apiKeyFromEnv } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    fetch: wrappedFetch,
  });

  // 预算覆盖表仍按服务商的协议格式配置；档位能力只看模型声明。
  const budgets: Partial<Record<ReasoningEffortLevel, number>> = {};
  for (const [k, v] of Object.entries(config.thinking?.budgets ?? {})) {
    if (isReasoningEffortLevel(k) && typeof v === "number" && Number.isFinite(v) && v > 0) {
      budgets[k] = v;
    }
  }
  const modelList: ModelInfo[] = Object.keys(config.models ?? {}).map((id) =>
    withReasoningEfforts(resolveModelInfo({ provider: config.id, model: id }, config.models?.[id])),
  );

  return {
    id: config.id,
    type: "anthropic",
    strictModels: config.allowUndeclaredModels !== true,
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      if ((await resolveKey()) === undefined) {
        throw missingKeyError();
      }
      // 归一化档位 → thinking.budget_tokens（ADR-0018 §3）：预算查
      // thinking.budgets 覆盖表否则默认表；max_tokens 不满足"预算+余量"
      // 时先抬升（不超过模型声明上限），仍不够则压预算；压到协议下限
      // 以下本轮不发送 thinking 并记 diagnostics。
      const thinkingPlan =
        request.reasoningEffort !== undefined
          ? planAnthropicThinking(request.reasoningEffort, request.maxOutputTokens, budgets)
          : undefined;
      if (request.reasoningEffort !== undefined && thinkingPlan === undefined) {
        config.diagnostics?.record("provider.unsupported_capability", {
          provider: config.id,
          capability: "reasoning_effort",
          resolution: "thinking_omitted",
          reason: `档位 ${request.reasoningEffort} 的预算在本请求 max_tokens 下压不到协议下限，本轮不发送 thinking`,
        });
      }
      // 合并 providerOptions 后决定 toolChoice：扩展思考开启时 Anthropic 只接受
      // auto/none，具体 tool_choice 会 400——临时关闭本轮思考（剥离 thinking 键）
      // 让强制生效（provider-api.md 第 3 节），不发明知无效的组合
      const merged: Record<string, unknown> = {
        ...(config.providerOptions ?? {}),
        ...(request.providerOptions ?? {}),
      };
      if (thinkingPlan !== undefined) {
        merged.thinking = {
          type: "enabled",
          budgetTokens: thinkingPlan.budgetTokens,
        };
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

      const result = streamText({
        model: sdk(request.model),
        system: request.system.map((b) => b.text).join("\n\n"),
        messages: toAiMessages(request, {
          // providerData 就是 providerMetadata 原值（{ anthropic: {...} }），直接回传
          reasoningProviderOptions: (pd) => pd as Record<string, Record<string, JSONValue>>,
          // ADR-0023：tool_result content 支持原生 image 块
          toolResultImages: "native",
        }),
        tools: toAiTools(request),
        // ADR-0016：Messages API 的 max_tokens 必填，未知时只能给兜底值
        // （8192）——这是协议要求，不代表对上游能力的断言。
        // 思考档位生效时取 thinkingPlan 的线上目标值（满足 预算+余量，ADR-0018 §3）。
        // 注意 SDK 语义：maxOutputTokens 是纯输出余量，思考开启时线上
        // max_tokens = maxOutputTokens + budgetTokens——因此传 目标值-预算，
        // 使线上 max_tokens 恰好等于 thinkingPlan.maxTokens。
        maxOutputTokens:
          thinkingPlan !== undefined
            ? thinkingPlan.maxTokens - thinkingPlan.budgetTokens
            : (request.maxOutputTokens ?? MAX_OUTPUT_FALLBACK),
        // 重试由 Agent Loop 决定（providers.md 第 5 节）；SDK 层一律不重试
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        onError: suppressSdkErrorLog,
        // SDK 命名空间固定为 "anthropic"（与 config.id 无关）；
        // 配置级 providerOptions 为底，请求级覆盖
        ...(providerOptions !== undefined && Object.keys(providerOptions).length > 0
          ? { providerOptions: { anthropic: providerOptions as Record<string, JSONValue> } }
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
