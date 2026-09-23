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
import { resolveModelInfo, type ModelOverride } from "../registry.js";
import type { ModelInfo, ModelRequest, ModelStreamEvent, Provider } from "../types.js";
import {
  mapPart,
  suppressSdkErrorLog,
  toAiMessages,
  toAiTools,
  toProviderError,
} from "./ai-sdk-common.js";

export interface AnthropicConfig {
  /** Provider id（也是 providerOptions 的键） */
  id: string;
  /** 适配器类型标识（providerConfigs 联合的分辨字段） */
  type: "anthropic";
  /** 缺省用 SDK 内置的 api.anthropic.com */
  baseURL?: string | undefined;
  /** 环境变量名；凭据只经环境变量读取 */
  apiKeyEnv: string;
  /** 模型能力覆盖（合并在内置目录之上） */
  models?: Record<string, ModelOverride> | undefined;
  /** 原样传给适配器（providerOptions.anthropic） */
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

type EnvReader = (name: string) => string | undefined;

export function createAnthropicProvider(
  config: AnthropicConfig,
  env: EnvReader = (name) => process.env[name],
  /** 测试注入用；生产不传（SDK 默认全局 fetch） */
  fetchImpl?: typeof fetch,
): Provider {
  const apiKey = env(config.apiKeyEnv);
  const sdk = createAnthropic({
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });

  const modelList: ModelInfo[] = Object.keys(config.models ?? {}).map((id) =>
    resolveModelInfo({ provider: config.id, model: id }, config.models?.[id]),
  );

  return {
    id: config.id,
    type: "anthropic",
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      if (apiKey === undefined || apiKey === "") {
        throw new ProviderError({
          kind: "auth",
          message: `环境变量 ${config.apiKeyEnv} 未设置（anthropic Provider "${config.id}"）`,
          retryable: false,
        });
      }
      const result = streamText({
        model: sdk(request.model),
        system: request.system.map((b) => b.text).join("\n\n"),
        messages: toAiMessages(request, {
          // providerData 就是 providerMetadata 原值（{ anthropic: {...} }），直接回传
          reasoningProviderOptions: (pd) => pd as Record<string, Record<string, JSONValue>>,
        }),
        tools: toAiTools(request),
        maxOutputTokens: request.maxOutputTokens,
        // 重试由 Agent Loop 决定（providers.md 第 5 节）；SDK 层一律不重试
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        onError: suppressSdkErrorLog,
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
