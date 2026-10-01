import type {
  CredentialStore,
  JevEndpoint,
  JevReviewerConfig,
  ProviderEntryConfig,
  ProviderOverview,
  SecurityReviewerConfig,
} from "./types.js";

/** 接入点只是配置数据；权限层接收解析后的连接信息。 */
export const JEV_ENDPOINTS = {
  "opencode-zen": {
    baseURL: "https://opencode.ai/zen/v1",
    model: "jev-1.13-free",
    sessionHeader: "x-opencode-session",
    modelFilter: "jev",
    recipient: "OpenCode 与 TypeSafe",
    env: "OPENCODE_API_KEY",
  },
  typesafe: {
    baseURL: "https://api.typesafe.ai/v1",
    model: "jev-latest",
    sessionHeader: undefined,
    modelFilter: "jev",
    recipient: "TypeSafe",
    env: "TYPESAFE_API_KEY",
  },
  custom: {
    baseURL: "",
    model: "jev-latest",
    sessionHeader: undefined,
    modelFilter: "jev",
    recipient: "自定义兼容服务",
    env: "TYPESAFE_API_KEY",
  },
} as const;

export function jevBaseURL(config: JevReviewerConfig): string {
  return (
    config.endpoint === "custom" ? (config.baseURL ?? "") : JEV_ENDPOINTS[config.endpoint].baseURL
  ).replace(/\/+$/, "");
}

export function defaultJevReviewer(
  endpoint: JevEndpoint,
  providers: readonly ProviderOverview[] = [],
  baseURL?: string,
): JevReviewerConfig {
  const preset = JEV_ENDPOINTS[endpoint];
  let host: string | undefined;
  try {
    host = new URL(baseURL ?? preset.baseURL).hostname;
  } catch {
    /* 尚未填写 custom URL */
  }
  const matching = providers.filter((entry) => host !== undefined && entry.host === host);
  const provider = matching.find((entry) => entry.keySource !== "missing") ?? matching[0];
  return {
    backend: "jev",
    endpoint,
    ...(endpoint === "custom" ? { baseURL: baseURL ?? "" } : {}),
    model: preset.model,
    minConfidence: 0.7,
    credential: provider ? { provider: provider.id } : { env: preset.env },
  };
}

export function reviewerText(reviewer: SecurityReviewerConfig | undefined): string {
  if (!reviewer || reviewer.backend === "off") return "off";
  if (reviewer.backend === "model") return `${reviewer.model.provider}/${reviewer.model.model}`;
  return `Jev · ${reviewer.endpoint} · ${reviewer.model}`;
}

export function resolveJevConnection(
  config: JevReviewerConfig,
  providers: readonly Pick<ProviderEntryConfig, "id" | "sessionHeader">[],
  credentials: CredentialStore | undefined,
  env: (name: string) => string | undefined,
) {
  const credential = config.credential;
  const borrowed =
    "provider" in credential
      ? providers.find((entry) => entry.id === credential.provider)
      : undefined;
  return {
    baseURL: jevBaseURL(config),
    model: config.model,
    minConfidence: config.minConfidence ?? 0.7,
    endpoint: config.endpoint,
    sessionHeader: borrowed?.sessionHeader ?? JEV_ENDPOINTS[config.endpoint].sessionHeader,
    key: async (): Promise<string | undefined> => {
      if ("env" in credential) return env(credential.env);
      return credentials?.get("provider" in credential ? credential.provider : "reviewer");
    },
  };
}

/** 实时列表不进入服务商模型目录；失败始终保留默认模型与手动输入入口。 */
export async function fetchJevModels(
  connection: { baseURL: string; key: () => Promise<string | undefined> },
  fallback: string,
  signal?: AbortSignal,
  modelFilter = "jev",
): Promise<{ models: string[]; warning?: string }> {
  try {
    const key = await connection.key();
    const response = await fetch(`${connection.baseURL}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error("HTTP");
    const body: unknown = await response.json();
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error("格式");
    const models = [
      ...new Set(
        data.flatMap((entry: unknown) => {
          const id = (entry as { id?: unknown } | null)?.id;
          return typeof id === "string" && id.toLowerCase().includes(modelFilter) ? [id] : [];
        }),
      ),
    ];
    if (models.length === 0) throw new Error("无 Jev 模型");
    return { models };
  } catch {
    return { models: [fallback], warning: "模型列表拉取失败，已退回默认模型；也可手动输入" };
  }
}
