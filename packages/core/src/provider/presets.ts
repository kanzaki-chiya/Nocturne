/**
 * 服务商预设（provider-setup.md 第 5 节）：向导默认值用的纯数据。
 * 写进 providers.json 的是完整条目；预设更新不会改变已写入的条目。
 * 新增预设门槛：服务地址与协议兼容性有官方文档可查，并实测过连接。
 */
import { ProviderError } from "./errors.js";
import type { UpstreamModelInfo } from "./types.js";

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
  /** 模型列表能否经 GET /models 自动获取 */
  fetchableModels: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "openai-compatible",
    defaultName: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    defaultKeyEnv: "DEEPSEEK_API_KEY",
    fetchableModels: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    type: "openai-compatible",
    defaultName: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultKeyEnv: "OPENROUTER_API_KEY",
    fetchableModels: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    type: "anthropic",
    defaultName: "anthropic",
    defaultKeyEnv: "ANTHROPIC_API_KEY",
    fetchableModels: true,
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
    fetchableModels: false,
  },
];

export function listProviderPresets(): ProviderPreset[] {
  return [...PROVIDER_PRESETS];
}

/** fetchModels 的入参：与 ProviderEntryConfig 同形但松一档（向导半成品也能测） */
export interface FetchModelsRequest {
  type: "openai-compatible" | "anthropic";
  baseURL?: string | undefined;
  headers?: Record<string, string> | undefined;
}

const FETCH_TIMEOUT_MS = 15_000;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function anthropicBase(entry: FetchModelsRequest): string {
  return entry.baseURL ?? "https://api.anthropic.com";
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
    const res = await fetch(url, { headers, signal: t.signal });
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
  return out;
}

/**
 * GET /models（provider-setup.md 第 7 节）：拉取上游模型列表并映射声明的
 * 限额/能力/价格字段。服务不提供列表接口或请求失败时返回 [] 由调用方
 * 降级为手动输入；HTTP 错误抛 ProviderUpstreamError。
 */
export async function fetchModels(
  entry: FetchModelsRequest,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<UpstreamModelInfo[]> {
  const url =
    entry.type === "anthropic"
      ? joinUrl(anthropicBase(entry), "/v1/models")
      : entry.baseURL !== undefined && entry.baseURL !== ""
        ? joinUrl(entry.baseURL, "/models")
        : (() => {
            throw new ProviderUpstreamError(
              "openai-compatible 服务商缺少 baseURL，无法获取模型列表",
            );
          })();
  const raw = await fetchJson(
    url,
    { Accept: "application/json", ...authHeaders(entry, key) },
    signal,
  );
  const data =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data as RawModel[])
      : [];
  return data.map(mapUpstreamModel).filter((m): m is UpstreamModelInfo => m !== undefined);
}

/**
 * 连接测试：向模型列表接口发一次请求。返回 ok+latencyMs（含模型数）或
 * 结构化错误；不验证具体模型是否可用（模型可用性由第一次真实请求检验）。
 */
export async function testProviderConnection(
  entry: FetchModelsRequest,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<
  { ok: true; latencyMs: number; modelCount: number } | { ok: false; error: ProviderError }
> {
  const started = Date.now();
  try {
    const models = await fetchModels(entry, key, signal);
    return { ok: true, latencyMs: Date.now() - started, modelCount: models.length };
  } catch (e) {
    const status = e instanceof ProviderUpstreamError ? e.status : undefined;
    const kind =
      status === 401 || status === 403
        ? ("auth" as const)
        : status !== undefined && status >= 500
          ? ("server" as const)
          : ("network" as const);
    return {
      ok: false,
      error: new ProviderError({
        kind,
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
        ...(status !== undefined ? { status } : {}),
      }),
    };
  }
}
