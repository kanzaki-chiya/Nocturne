/** Gemini 原生传输（ADR-0061）；SDK 类型与签名策略不出适配器。 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText, type JSONValue } from "ai";
import type { Diagnostics } from "../../protocol/index.js";
import { createAuthResolver } from "../auth.js";
import { abortError } from "../errors.js";
import { createAuthFetch, modelRequestHeaders, withUserAgent } from "../http.js";
import {
  registerProtocolAdapterSpec,
  resolveModelInfo,
  type ProtocolAdapterSpec,
} from "../registry.js";
import { withReasoningEfforts } from "../reasoning.js";
import type { ModelRequest, ModelStreamEvent, Provider } from "../types.js";
import type { OpenAIResponsesConfig } from "./openai-responses.js";
import {
  createLiveness,
  mapPart,
  routeSdkWarnings,
  suppressSdkErrorLog,
  toAiMessages,
  toAiTools,
  toProviderError,
} from "./ai-sdk-common.js";

/** gemini 适配器传输特征声明（ADR-0016 2026-10-25 修订）：未声明时不向请求体写 maxOutputTokens */
export const GEMINI_ADAPTER_SPEC: ProtocolAdapterSpec = {
  protocol: "gemini",
  requiresMaxOutputTokens: false,
};
registerProtocolAdapterSpec(GEMINI_ADAPTER_SPEC);

export type GeminiConfig = Omit<OpenAIResponsesConfig, "type">;

type SignatureOptions = Record<string, Record<string, JSONValue>>;

function signatureOptions(data: unknown): SignatureOptions | undefined {
  const signature = (data as { google?: { thoughtSignature?: unknown } } | undefined)?.google
    ?.thoughtSignature;
  return typeof signature === "string" && signature.length > 0
    ? { google: { thoughtSignature: signature } }
    : undefined;
}

export function createGeminiProvider(
  config: GeminiConfig,
  env: (name: string) => string | undefined = (name) => process.env[name],
  fetchImpl?: typeof fetch,
): Provider {
  routeSdkWarnings(config.diagnostics);
  const auth = createAuthResolver(config, env);
  const wrappedFetch = createAuthFetch(
    auth,
    (headers, token) => {
      headers.set("x-goog-api-key", token);
    },
    fetchImpl,
  );
  const modelList = Object.keys(config.models ?? {}).map((model) =>
    withReasoningEfforts(
      resolveModelInfo(
        { provider: config.id, model },
        { protocol: GEMINI_ADAPTER_SPEC.protocol, ...config.models?.[model] },
      ),
    ),
  );

  return {
    id: config.id,
    type: "gemini",
    strictModels: config.allowUndeclaredModels !== true,
    models: () => modelList,
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      const live = createLiveness(wrappedFetch);
      const sdk = createGoogleGenerativeAI({
        baseURL: config.baseURL,
        apiKey: "resolved-by-fetch",
        headers: withUserAgent(config.headers, config.userAgent),
        fetch: live.fetch,
      });
      const thinkingConfig: Record<string, JSONValue> = { includeThoughts: true };
      if (request.reasoningEffort !== undefined) {
        if (["minimal", "low", "medium", "high"].includes(request.reasoningEffort)) {
          thinkingConfig.thinkingLevel = request.reasoningEffort;
        } else {
          config.diagnostics?.record("provider.unsupported_capability", {
            provider: config.id,
            capability: "reasoningEffort",
            value: request.reasoningEffort,
            reason: "Gemini thinkingLevel 仅支持 minimal/low/medium/high",
          });
        }
      }
      let missingSignatures = 0;
      // 并行调用只有第一个带签名（与 SDK 的判定一致）：同一步内已出现签名后，
      // 后续无签名调用属正常，不填占位值、不计诊断。
      let signedInStep = false;
      const messages = toAiMessages(request, {
        reasoningProviderOptions: signatureOptions,
        textProviderOptions: signatureOptions,
        toolCallProviderOptions: (data, index) => {
          if (index === 0) signedInStep = false;
          const signed = signatureOptions(data);
          if (signed !== undefined) {
            signedInStep = true;
            return signed;
          }
          if (signedInStep) return undefined;
          missingSignatures++;
          return { google: { thoughtSignature: "skip_thought_signature_validator" } };
        },
        toolResultImages: "user-message",
      });
      recordMissingSignatures(config.diagnostics, config.id, missingSignatures);
      const requestHeaders = modelRequestHeaders(config, request);
      const result = streamText({
        model: sdk(request.model),
        system: request.system.map((block) => block.text).join("\n\n"),
        messages,
        tools: toAiTools(request),
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        ...(request.toolChoice !== undefined
          ? { toolChoice: { type: "tool" as const, toolName: request.toolChoice.name } }
          : {}),
        ...(requestHeaders !== undefined ? { headers: requestHeaders } : {}),
        providerOptions: { google: { ...request.providerOptions, thinkingConfig } },
        maxRetries: 0,
        streamRetries: 0,
        abortSignal: signal,
        onError: suppressSdkErrorLog,
      });
      const names = new Map<string, string>();
      try {
        for await (const part of live.events(result.stream)) {
          if (signal.aborted) throw abortError();
          if (part.type === "heartbeat") yield part;
          else yield* mapPart(part, names, true);
        }
      } catch (error) {
        throw toProviderError(error, signal);
      }
    },
  };
}

function recordMissingSignatures(
  diagnostics: Diagnostics | undefined,
  provider: string,
  count: number,
): void {
  if (count > 0)
    diagnostics?.record("provider.unsupported_capability", {
      provider,
      capability: "thought_signature",
      resolution: "skip_thought_signature_validator",
      count,
    });
}
