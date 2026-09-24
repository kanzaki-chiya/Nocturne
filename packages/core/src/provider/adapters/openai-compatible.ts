/**
 * openai-compatible 适配器（providers.md 第 4 节）。
 * 传输实现：@ai-sdk/openai-compatible（Chat Completions）。
 * SDK 类型只存在于本文件与 ai-sdk-common.ts 内，不泄漏到 Core（ADR-0005）。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { abortError, ProviderError } from "../errors.js";
import { resolveModelInfo, type ModelOverride } from "../registry.js";
import type { ModelInfo, ModelRequest, ModelStreamEvent, Provider } from "../types.js";
import type { Diagnostics } from "../../protocol/index.js";
import {
  mapPart,
  planToolChoice,
  suppressSdkErrorLog,
  toAiMessages,
  toAiTools,
  toProviderError,
} from "./ai-sdk-common.js";
import type { JSONValue } from "ai";

export interface OpenAICompatibleConfig {
  /** Provider id（也是 providerOptions 的键） */
  id: string;
  /** 适配器类型标识；缺省即 openai-compatible（providerConfigs 联合的分辨字段） */
  type?: "openai-compatible" | undefined;
  baseURL: string;
  /** 环境变量名；凭据只经环境变量读取 */
  apiKeyEnv: string;
  /** 模型能力覆盖（合并在内置目录之上） */
  models?: Record<string, ModelOverride> | undefined;
  /** true 时接受清单外的模型 id（回退内置目录/保守默认；见 Provider.strictModels） */
  allowUndeclaredModels?: boolean | undefined;
  /** 原样传给适配器（providerOptions） */
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  /** 诊断通道（observability.md）；缺省 no-op */
  diagnostics?: Diagnostics | undefined;
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
    strictModels: config.allowUndeclaredModels !== true,
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      if (apiKey === undefined || apiKey === "") {
        throw new ProviderError({
          kind: "auth",
          message: `环境变量 ${config.apiKeyEnv} 未设置（openai-compatible Provider "${config.id}"）`,
          retryable: false,
        });
      }
      // 合并 providerOptions 后决定 toolChoice：部分兼容服务的推理配置与具体
      // tool_choice 冲突——能安全移除的推理键本轮移除（强制生效），无法安全移除的
      // （归一化 reasoningEffort）丢弃 toolChoice（provider-api.md 第 3 节）
      const mergedOptions: Record<string, unknown> | undefined =
        config.providerOptions !== undefined || request.providerOptions !== undefined
          ? { ...(config.providerOptions ?? {}), ...(request.providerOptions ?? {}) }
          : undefined;
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
        model: sdk.chatModel(request.model),
        system: request.system.map((b) => b.text).join("\n\n"),
        messages: toAiMessages(request),
        tools: toAiTools(request),
        maxOutputTokens: request.maxOutputTokens,
        // 重试由 Agent Loop 决定（providers.md 第 5 节）；SDK 层一律不重试
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        onError: suppressSdkErrorLog,
        // 配置级 providerOptions 为底，请求级覆盖；命名空间是 config.id（SDK name）
        ...(providerOptions !== undefined && Object.keys(providerOptions).length > 0
          ? { providerOptions: { [config.id]: providerOptions as Record<string, JSONValue> } }
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
