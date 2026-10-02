/**
 * 服务商条目的路由 Provider（ADR-0026 §4）：每个条目仍是一个 Provider
 * 实例，id/type 保留原义——type 兼作模型的默认协议与鉴权「本家」写法。
 * 实例内部按需构造三种协议的适配器，共用鉴权解析器、headers 与诊断
 * 通道；stream() 按请求模型的生效协议分发。Agent Loop / Context 不感知
 * 协议分支。
 */
import { PROTOCOL_ENDPOINTS, type Diagnostics, type ModelProtocol } from "../protocol/index.js";
import { createAnthropicProvider } from "./adapters/anthropic.js";
import { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";
import { createOpenAIResponsesProvider } from "./adapters/openai-responses.js";
import { createAuthResolver } from "./auth.js";
import { ProviderError } from "./errors.js";
import { withEffectiveProtocol } from "./effective-protocol.js";
import { withReasoningEfforts } from "./reasoning.js";
import { resolveModelInfo, type EditToolDefault, type ModelOverride } from "./registry.js";
import type {
  AuthResolver,
  CredentialResolver,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  Provider,
  ProviderAuth,
  ProviderThinkingOptions,
} from "./types.js";

type EnvReader = (name: string) => string | undefined;

/** 条目级装配输入（形状与 config 的 ProviderEntryConfig 对齐） */
export interface EntryProviderConfig {
  id: string;
  /** 默认协议（= 条目 type）；缺省 openai-compatible */
  type?: ModelProtocol | undefined;
  baseURL?: string | undefined;
  auth?: ProviderAuth | undefined;
  authResolver?: AuthResolver | undefined;
  apiKeyEnv?: string | undefined;
  credentials?: CredentialResolver | undefined;
  /** 逐模型声明（含 protocol/endpoints；ADR-0026 §2） */
  models?: Record<string, ModelOverride> | undefined;
  allowUndeclaredModels?: boolean | undefined;
  /** 只交给与条目 type 同协议的请求（ADR-0026 §3） */
  providerOptions?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  modelHeader?: string | undefined;
  /**
   * 会话标识请求头名（ADR-0031 §3）：配置字段，值为请求头名称
   * （如 "x-opencode-session"）；未声明时不发送任何会话头。
   */
  sessionHeader?: string | undefined;
  /**
   * User-Agent 基值（ADR-0031 §2）：装配处注入 `nocturne/<version>`；
   * 缺省时适配器用内置版本。
   */
  userAgent?: string | undefined;
  thinking?: ProviderThinkingOptions | undefined;
  /**
   * 编辑工具默认表（ADR-0035 §5）：装配层注入 config 的
   * defaultEditToolForModel；缺省时目录未命中模型一律 "edit"。
   */
  editToolDefault?: EditToolDefault | undefined;
  diagnostics?: Diagnostics | undefined;
}

export function createEntryProvider(
  config: EntryProviderConfig,
  env: EnvReader = (name) => process.env[name],
  /** 测试注入用；生产不传（SDK 默认全局 fetch） */
  fetchImpl?: typeof fetch,
): Provider {
  const entryType: ModelProtocol = config.type ?? "openai-compatible";
  // 装配层注入 openai-siwc 解析器；本模块不持有存储或跨进程锁。
  const authResolver = createAuthResolver(config, env);

  // 清单模型逐枚盖章（ADR-0026 §2）：unavailable 模型照常列出（§5）
  const modelList: ModelInfo[] = Object.keys(config.models ?? {}).map((id) => {
    const model = withReasoningEfforts(
      resolveModelInfo(
        { provider: config.id, model: id },
        config.models?.[id],
        config.editToolDefault,
      ),
    );
    return authResolver.protocol === undefined
      ? withEffectiveProtocol(model, entryType)
      : { ...model, protocol: authResolver.protocol, unavailable: undefined };
  });
  const byModel = new Map(modelList.map((m) => [m.ref.model, m]));

  // 三种适配器共用的条目级输入（凭据解析器/headers/会话头/UA/诊断/thinking 一致）
  const common = {
    id: config.id,
    authResolver,
    headers: config.headers,
    modelHeader: config.modelHeader,
    sessionHeader: config.sessionHeader,
    userAgent: config.userAgent,
    thinking: config.thinking,
    diagnostics: config.diagnostics,
  };

  let openaiAdapter: Provider | undefined;
  let anthropicAdapter: Provider | undefined;
  let responsesAdapter: Provider | undefined;

  const openai = (): Provider => {
    openaiAdapter ??= createOpenAICompatibleProvider(
      {
        ...common,
        type: "openai-compatible",
        baseURL: config.baseURL ?? "",
        // ADR-0026 §3：条目级 providerOptions 只给同协议请求（键是按协议写的）
        ...(entryType === "openai-compatible" && config.providerOptions !== undefined
          ? { providerOptions: config.providerOptions }
          : {}),
      },
      env,
      fetchImpl,
    );
    return openaiAdapter;
  };
  const anthropic = (): Provider => {
    anthropicAdapter ??= createAnthropicProvider(
      {
        ...common,
        type: "anthropic",
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
        ...(entryType === "anthropic" && config.providerOptions !== undefined
          ? { providerOptions: config.providerOptions }
          : {}),
        // ADR-0026 §3：openai-compatible 条目下的 Messages 请求同时携带
        // x-api-key 与 Authorization: Bearer（anthropic-version 由 SDK 注入）
        dualAuth: entryType === "openai-compatible",
      },
      env,
      fetchImpl,
    );
    return anthropicAdapter;
  };
  const responses = (): Provider => {
    responsesAdapter ??= createOpenAIResponsesProvider(
      {
        ...common,
        type: "openai-responses",
        baseURL: config.baseURL ?? "",
        // ADR-0031 §6：条目级 providerOptions 不给 Responses 适配器
        // （协议选项固定由适配器写死：store:false + reasoning.encrypted_content）
      },
      env,
      fetchImpl,
    );
    return responsesAdapter;
  };

  /** 鉴权通道限定 > 请求携带 > 清单盖章 > 条目 type */
  const protocolOf = (request: ModelRequest): ModelProtocol =>
    authResolver.protocol ?? request.protocol ?? byModel.get(request.model)?.protocol ?? entryType;

  return {
    id: config.id,
    type: entryType,
    strictModels: config.allowUndeclaredModels !== true,
    models: () => modelList,

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
      // ADR-0026 §5：不可用模型不发请求（发请求前以说明结束）
      const declared = byModel.get(request.model);
      if (declared?.unavailable !== undefined) {
        throw new ProviderError({
          kind: "invalid_request",
          message: declared.unavailable.reason,
          retryable: false,
        });
      }
      const protocol = protocolOf(request);
      if (protocol === "anthropic") {
        yield* anthropic().stream(request, signal);
        return;
      }
      // anthropic 条目省略 baseURL 时没有可构造 openai 请求的地址
      // （api.anthropic.com 不提供 Chat Completions / Responses）
      if (config.baseURL === undefined || config.baseURL === "") {
        throw new ProviderError({
          kind: "invalid_request",
          message:
            `服务商 "${config.id}" 未声明 baseURL，模型 ${request.model} 无法按 ` +
            `${protocol} 协议请求${PROTOCOL_ENDPOINTS[protocol]}`,
          retryable: false,
        });
      }
      if (protocol === "openai-responses") {
        yield* responses().stream(request, signal);
        return;
      }
      yield* openai().stream(request, signal);
    },
  };
}
