/**
 * 服务商预设（provider-setup.md 第 5 节）：向导默认值用的纯数据。
 * 写进 providers.json 的是完整条目；预设更新不会改变已写入的条目。
 * 新增预设门槛：服务地址与协议兼容性有官方文档可查，并实测过连接。
 */
import type { AuthResolver, ProviderAuth, UpstreamModelInfo } from "./types.js";
import { createAuthResolver } from "./auth.js";
import { ProviderAuthError } from "./errors.js";
import { hasStaticHeader, nocturneUserAgent } from "./http.js";

export interface ProviderPreset {
  /** 预设标识（向导内部使用；"custom-*" 表示手动填写地址的预设） */
  id: string;
  /** 显示名（向导左侧栏 ○ 列表的标签） */
  label: string;
  type: "openai-compatible" | "anthropic";
  /** 建议的服务商 id（用户可改） */
  defaultName: string;
  /** 建议的 baseURL；undefined = 适配器内置端点（Anthropic）或用户必填 */
  baseURL?: string | undefined;
  /** 建议的环境变量名（凭据走环境变量时的默认值；用户可改） */
  defaultKeyEnv?: string | undefined;
  auth?: ProviderAuth | undefined;
  headers?: Record<string, string> | undefined;
  modelHeader?: string | undefined;
  login?: "openrouter" | "openai-siwc" | "xai-oauth2" | undefined;
  /** 模型列表能否经 GET /models 自动获取 */
  fetchableModels: boolean;
  /**
   * 该服务商的思考参数格式（ADR-0018）：写入条目的 thinking.format。
   * "openrouter" → reasoning: { effort }；缺省 → openai（reasoning_effort）。
   */
  thinkingFormat?: "openai" | "openrouter" | undefined;
  /** 密钥获取入口（控制台 URL）：向导密钥步骤的说明小字提示来源 */
  keyHint?: string | undefined;
  /**
   * 会话标识请求头名（ADR-0031 §5）：预设写死的服务商要求
   * （如 OpenCode 的 x-opencode-session），原样写入条目。
   */
  sessionHeader?: string | undefined;
  /**
   * models.dev 服务商键（ADR-0031 §5）：预设写死，原样写入条目；
   * 启用 models.dev 服务商层的逐模型接口声明参与合并。
   */
  modelsDevProvider?: string | undefined;
}

/**
 * Grok 代理（cli-chat-proxy.grok.com）要求的请求头，两个 Grok 预设共用（ADR-0043）。
 * 缺版本门头时代理回 426；版本号对齐当前能过门的官方 CLI，不是 Nocturne 版本，
 * 代理提高门槛时只改这里。User-Agent 仍是 nocturne/<version>。
 */
const GROK_PROXY_HEADERS: Readonly<Record<string, string>> = {
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-grok-client-version": "1.0.44",
  "x-grok-client-identifier": "nocturne",
  "x-authenticateresponse": "authenticate-response",
  "x-grok-client-mode": "headless",
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    type: "openai-compatible",
    defaultName: "chatgpt",
    baseURL: "https://api.openai.com/v1",
    auth: { kind: "openai-siwc" },
    login: "openai-siwc",
    modelsDevProvider: "openai",
    fetchableModels: true,
  },
  {
    id: "grok",
    label: "Grok",
    type: "openai-compatible",
    defaultName: "grok",
    baseURL: "https://cli-chat-proxy.grok.com/v1",
    headers: { ...GROK_PROXY_HEADERS },
    modelHeader: "x-grok-model-override",
    auth: { kind: "xai-oauth2" },
    login: "xai-oauth2",
    fetchableModels: true,
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    type: "openai-compatible",
    defaultName: "grok-cli",
    baseURL: "https://cli-chat-proxy.grok.com/v1",
    headers: { ...GROK_PROXY_HEADERS },
    modelHeader: "x-grok-model-override",
    auth: {
      kind: "external-file",
      path: "~/.grok/auth.json",
      keyPath: ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828", "key"],
      renewHint: "grok login",
    },
    fetchableModels: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "openai-compatible",
    defaultName: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    defaultKeyEnv: "DEEPSEEK_API_KEY",
    fetchableModels: true,
    keyHint: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openrouter",
    login: "openrouter",
    label: "OpenRouter",
    type: "openai-compatible",
    defaultName: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultKeyEnv: "OPENROUTER_API_KEY",
    fetchableModels: true,
    thinkingFormat: "openrouter",
    keyHint: "https://openrouter.ai/keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    type: "anthropic",
    defaultName: "anthropic",
    defaultKeyEnv: "ANTHROPIC_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.anthropic.com/settings/keys",
  },
  {
    // ADR-0031 §5：OpenCode Zen；会话头与 models.dev 服务商键写死。
    // 官方文档的密钥入口是 opencode.ai/auth（登录后复制 API key）。
    id: "opencode-zen",
    label: "OpenCode Zen",
    type: "openai-compatible",
    defaultName: "opencode-zen",
    baseURL: "https://opencode.ai/zen/v1",
    defaultKeyEnv: "OPENCODE_API_KEY",
    fetchableModels: true,
    sessionHeader: "x-opencode-session",
    modelsDevProvider: "opencode",
    keyHint: "https://opencode.ai/auth",
  },
  {
    // ADR-0031 §5：OpenCode Go（Zen 的同系网关，要求 x-opencode-session）
    id: "opencode-go",
    label: "OpenCode Go",
    type: "openai-compatible",
    defaultName: "opencode-go",
    baseURL: "https://opencode.ai/zen/go/v1",
    defaultKeyEnv: "OPENCODE_API_KEY",
    fetchableModels: true,
    sessionHeader: "x-opencode-session",
    modelsDevProvider: "opencode-go",
    keyHint: "https://opencode.ai/auth",
  },
  {
    id: "custom-openai",
    label: "其他 OpenAI 兼容服务",
    type: "openai-compatible",
    defaultName: "",
    fetchableModels: true,
  },
  {
    id: "custom-anthropic",
    label: "其他 Anthropic 兼容服务",
    type: "anthropic",
    defaultName: "",
    fetchableModels: true,
  },
];

export function listProviderPresets(): ProviderPreset[] {
  return [...PROVIDER_PRESETS];
}

/** fetchModels 的入参：与 ProviderEntryConfig 同形但松一档（向导半成品也能测） */
export interface FetchModelsRequest {
  id?: string | undefined;
  auth?: ProviderAuth | undefined;
  type: "openai-compatible" | "anthropic";
  baseURL?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** 条目可能声明的会话头名；fetchModels 不属于会话，永不发送（ADR-0031 §3） */
  sessionHeader?: string | undefined;
}

const FETCH_TIMEOUT_MS = 15_000;

/** /v1/models 按未入文档的 client_version 过滤较新模型；发足够大的版本以列出全部（ADR-0042 修订） */
const SIWC_MODELS_CLIENT_VERSION = "99.0.0";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * anthropic 条目的请求基地址（ADR-0026 §3）：与消息请求共用同一 baseURL
 * 语义——省略 baseURL 时用官方 https://api.anthropic.com/v1。
 */
function anthropicBase(entry: FetchModelsRequest): string {
  return entry.baseURL ?? "https://api.anthropic.com/v1";
}

function authHeaders(entry: FetchModelsRequest, key: string | undefined): Record<string, string> {
  const out: Record<string, string> = { ...(entry.headers ?? {}) };
  if (key === undefined || key === "") return out;
  if (entry.type === "anthropic") {
    out["x-api-key"] = key;
    out["anthropic-version"] ??= "2023-06-01";
  } else {
    out.Authorization = `Bearer ${key}`;
  }
  return out;
}

function withTimeout(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, FETCH_TIMEOUT_MS);
  const onAbort = () => {
    ac.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ac.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const t = withTimeout(signal);
  try {
    const res = await fetch(url, { headers, signal: t.signal, redirect: "error" });
    if (!res.ok) {
      throw new ProviderUpstreamError(`上游返回 HTTP ${res.status}`, res.status);
    }
    const data: unknown = await res.json();
    return data;
  } finally {
    t.cancel();
  }
}

export class ProviderUpstreamError extends Error {
  readonly status?: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderUpstreamError";
    this.status = status;
  }
}

// ── 上游字段映射（provider-setup.md 第 7 节）───────────────

interface RawModel {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  top_provider?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
  /** 上游声明的服务接口列表（ADR-0026 §2；OpenRouter 等聚合服务逐模型给出） */
  supported_endpoints?: unknown;
  architecture?: unknown;
  // Anthropic /v1/models 官方声明的限额字段
  max_input_tokens?: unknown;
  max_tokens?: unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const perTokenPrice = (v: unknown): number | undefined => {
  // OpenRouter pricing 是按 token 计价的 USD 字符串，换算为每百万 token
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : undefined;
};

/** 单个上游模型条目 → UpstreamModelInfo；只映射明确声明的字段 */
function mapUpstreamModel(raw: RawModel): UpstreamModelInfo | undefined {
  const id = str(raw.id);
  if (id === undefined) return undefined;
  const top =
    typeof raw.top_provider === "object" && raw.top_provider !== null
      ? (raw.top_provider as { context_length?: unknown; max_completion_tokens?: unknown })
      : undefined;
  const out: UpstreamModelInfo = { id };

  const displayName = str(raw.display_name) ?? str(raw.name);
  if (displayName !== undefined) out.displayName = displayName;

  // top_provider.context_length 优先于顶层 context_length（OpenRouter）
  const contextWindow =
    num(top?.context_length) ?? num(raw.context_length) ?? num(raw.max_input_tokens);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;

  const maxOutput = num(top?.max_completion_tokens) ?? num(raw.max_tokens);
  if (maxOutput !== undefined) out.maxOutputTokens = maxOutput;

  const pricing =
    typeof raw.pricing === "object" && raw.pricing !== null
      ? (raw.pricing as { prompt?: unknown; completion?: unknown })
      : undefined;
  const inputPrice = perTokenPrice(pricing?.prompt);
  const outputPrice = perTokenPrice(pricing?.completion);
  if (inputPrice !== undefined || outputPrice !== undefined) {
    out.pricing = {
      ...(inputPrice !== undefined ? { input: inputPrice } : {}),
      ...(outputPrice !== undefined ? { output: outputPrice } : {}),
    };
  }

  // 能力位只在有声明时设置（清单字段覆盖范围各服务不统一，不反向断言）
  const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const modalities =
    typeof raw.architecture === "object" && raw.architecture !== null
      ? (raw.architecture as { input_modalities?: unknown }).input_modalities
      : undefined;
  const caps: { reasoning?: "visible"; imageInput?: boolean } = {};
  if (params.includes("reasoning") || params.includes("include_reasoning")) {
    caps.reasoning = "visible";
  }
  if (Array.isArray(modalities) && modalities.includes("image")) {
    caps.imageInput = true;
  }
  if (caps.reasoning !== undefined || caps.imageInput !== undefined) {
    out.capabilities = caps;
  }

  // ADR-0026 §2：supported_endpoints 原文保存（字符串数组、非空才记）；
  // 空数组按未声明处理——由调用方继续走条目 type 回落
  if (Array.isArray(raw.supported_endpoints)) {
    const eps = raw.supported_endpoints.filter(
      (e): e is string => typeof e === "string" && e !== "",
    );
    if (eps.length > 0) out.endpoints = eps;
  }
  return out;
}

/**
 * GET /models（provider-setup.md 第 7 节）：拉取上游模型列表并映射声明的
 * 限额/能力/价格字段。服务不提供列表接口或请求失败时返回 [] 由调用方
 * 降级为手动输入；HTTP 错误抛 ProviderUpstreamError。
 */
export async function fetchModels(
  entry: FetchModelsRequest,
  key: string | AuthResolver | undefined,
  signal?: AbortSignal,
): Promise<UpstreamModelInfo[]> {
  // ADR-0031 §2：模型列表请求同样以 nocturne/<version> 开头；
  // 条目 headers 里用户写的 UA 优先。fetchModels 不属于会话，不写会话头。
  const uaHeader = hasStaticHeader(entry.headers, "user-agent")
    ? {}
    : { "User-Agent": nocturneUserAgent() };
  // ADR-0026 §3：两种协议共用条目的 baseURL 语义（含 /v1）——
  // anthropic 条目为 <baseURL 或官方默认>/models（不再是额外的 /v1 段）
  const url =
    entry.type === "anthropic"
      ? joinUrl(anthropicBase(entry), "/models")
      : entry.baseURL !== undefined && entry.baseURL !== ""
        ? joinUrl(entry.baseURL, "/models")
        : (() => {
            throw new ProviderUpstreamError(
              "openai-compatible 服务商缺少 baseURL，无法获取模型列表",
            );
          })();
  const resolver: AuthResolver =
    typeof key === "object"
      ? key
      : entry.auth !== undefined && entry.auth.kind !== "apiKey"
        ? createAuthResolver({ id: entry.id ?? "provider", auth: entry.auth })
        : {
            token: () => Promise.resolve(key ?? ""),
            invalidate: () => Promise.resolve(),
          };
  // 仅 siwc 模型列表带 client_version；其他服务商地址不变。
  const modelsUrl =
    resolver.modelFormat === "siwc" ? `${url}?client_version=${SIWC_MODELS_CLIENT_VERSION}` : url;
  const requestSignal = signal ?? new AbortController().signal;
  let raw: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await fetchJson(
        modelsUrl,
        {
          ...uaHeader,
          Accept: "application/json",
          ...authHeaders(entry, await resolver.token(requestSignal)),
        },
        signal,
      );
      break;
    } catch (error) {
      if (!(error instanceof ProviderUpstreamError) || error.status !== 401) throw error;
      if (attempt === 1)
        throw new ProviderAuthError(
          resolver.unauthorizedMessage ?? "服务商凭据已失效，请重新登录或更新密钥",
          401,
        );
      await resolver.invalidate();
    }
  }
  if (resolver.modelFormat === "siwc") {
    const models =
      typeof raw === "object" && raw !== null && "models" in raw && Array.isArray(raw.models)
        ? (raw.models as unknown[])
        : [];
    return models.flatMap((value): UpstreamModelInfo[] => {
      if (typeof value !== "object" || value === null) return [];
      const model = value as {
        visibility?: unknown;
        slug?: unknown;
        display_name?: unknown;
        context_window?: unknown;
        input_modalities?: unknown;
      };
      if (model.visibility !== "list" || typeof model.slug !== "string" || model.slug === "")
        return [];
      return [
        {
          id: model.slug,
          ...(typeof model.display_name === "string" && model.display_name !== ""
            ? { displayName: model.display_name }
            : {}),
          // 账号通道声明的上下文长度（如 272000）优先于 models.dev 的 API 数值（ADR-0016）
          ...(typeof model.context_window === "number" &&
          Number.isInteger(model.context_window) &&
          model.context_window > 0
            ? { contextWindow: model.context_window }
            : {}),
          ...(Array.isArray(model.input_modalities)
            ? { capabilities: { imageInput: model.input_modalities.includes("image") } }
            : {}),
        },
      ];
    });
  }
  const data =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data as RawModel[])
      : [];
  return data.map(mapUpstreamModel).filter((m): m is UpstreamModelInfo => m !== undefined);
}
