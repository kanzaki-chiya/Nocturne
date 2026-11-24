import type {
  CredentialStore,
  DecisionModelConfig,
  GeminiDecisionEndpoint,
  GeminiDecisionModelConfig,
  JevDecisionModelConfig,
  JevEndpoint,
  JevReviewerConfig,
  ProviderEntryConfig,
  ProviderOverview,
  ReviewerRulesConfig,
  SecurityReviewerConfig,
} from "./types.js";

/** Gemini 决策模型接入点（ADR-0117 §1）；权限层只接收解析后的连接信息。 */
export const GEMINI_DECISION_ENDPOINTS = {
  "ai-studio": {
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-decision-1",
    modelFilter: "decision",
    recipient: "Google",
    env: "GEMINI_API_KEY",
  },
  custom: {
    baseURL: "",
    model: "gemini-decision-1",
    modelFilter: "decision",
    recipient: "自定义地址",
    env: "GEMINI_API_KEY",
  },
} as const;

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
    recipient: "自定义地址",
    env: "TYPESAFE_API_KEY",
  },
} as const;

export function geminiDecisionBaseURL(config: GeminiDecisionModelConfig): string {
  return (
    config.endpoint === "custom"
      ? (config.baseURL ?? "")
      : GEMINI_DECISION_ENDPOINTS[config.endpoint].baseURL
  ).replace(/\/+$/, "");
}

export function jevBaseURL(config: Pick<JevReviewerConfig, "endpoint" | "baseURL">): string {
  return (
    config.endpoint === "custom" ? (config.baseURL ?? "") : JEV_ENDPOINTS[config.endpoint].baseURL
  ).replace(/\/+$/, "");
}

export function decisionModelFromJevReviewer(reviewer: JevReviewerConfig): JevDecisionModelConfig {
  return {
    source: "jev",
    endpoint: reviewer.endpoint,
    ...(reviewer.endpoint === "custom" && reviewer.baseURL !== undefined
      ? { baseURL: reviewer.baseURL }
      : {}),
    model: reviewer.model,
    credential: reviewer.credential,
  };
}

/** ADR-0117 §3：未显式配置 decisionModel 时，从旧 Jev 审查器派生生效决策模型。 */
export function resolveEffectiveDecisionModel(
  decisionModel: DecisionModelConfig | undefined,
  permissionReviewer: SecurityReviewerConfig | undefined,
): DecisionModelConfig | undefined {
  if (decisionModel !== undefined) return decisionModel;
  if (permissionReviewer?.backend === "jev")
    return decisionModelFromJevReviewer(permissionReviewer);
  return undefined;
}

export function decisionModelText(config: DecisionModelConfig | undefined): string | undefined {
  if (!config) return undefined;
  return config.source === "gemini"
    ? `Gemini · ${config.endpoint} · ${config.model}`
    : `Jev · ${config.endpoint} · ${config.model}`;
}

export type DecisionRecipientId = "google" | "typesafe" | "opencode-zen" | "custom";

export function decisionModelRecipient(config: DecisionModelConfig): {
  id: DecisionRecipientId;
  label: string;
} {
  if (config.source === "gemini") {
    return config.endpoint === "ai-studio"
      ? { id: "google", label: "Google" }
      : { id: "custom", label: "自定义地址" };
  }
  if (config.endpoint === "opencode-zen") {
    return { id: "opencode-zen", label: "OpenCode 与 TypeSafe" };
  }
  if (config.endpoint === "typesafe") {
    return { id: "typesafe", label: "TypeSafe" };
  }
  return { id: "custom", label: "自定义地址" };
}

export function defaultGeminiDecisionModel(
  endpoint: GeminiDecisionEndpoint,
  baseURL?: string,
): GeminiDecisionModelConfig {
  const preset = GEMINI_DECISION_ENDPOINTS[endpoint];
  return {
    source: "gemini",
    endpoint,
    ...(endpoint === "custom" ? { baseURL: baseURL ?? "" } : {}),
    model: preset.model,
    credential: { env: preset.env },
  };
}

export function defaultJevDecisionModel(
  endpoint: JevEndpoint,
  providers: readonly ProviderOverview[] = [],
  baseURL?: string,
): JevDecisionModelConfig {
  const preset = JEV_ENDPOINTS[endpoint];
  if (endpoint === "opencode-zen") {
    let host: string | undefined;
    try {
      host = new URL(preset.baseURL).hostname;
    } catch {
      /* ignore */
    }
    const matching = providers.filter((entry) => host !== undefined && entry.host === host);
    const provider = matching.find((entry) => entry.keySource !== "missing") ?? matching[0];
    return {
      source: "jev",
      endpoint,
      model: preset.model,
      credential: provider ? { provider: provider.id } : { env: preset.env },
    };
  }
  return {
    source: "jev",
    endpoint,
    ...(endpoint === "custom" ? { baseURL: baseURL ?? "" } : {}),
    model: preset.model,
    credential: { env: preset.env },
  };
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

export function reviewerText(
  reviewer: SecurityReviewerConfig | undefined,
  decisionModel?: DecisionModelConfig,
): string {
  if (!reviewer || reviewer.backend === "off") return "off";
  if (reviewer.backend === "model") return `${reviewer.model.provider}/${reviewer.model.model}`;
  if (reviewer.backend === "decision") return decisionModelText(decisionModel) ?? "决策模型";
  return `Jev · ${reviewer.endpoint} · ${reviewer.model}`;
}

/** 追加规则的一行摘要（设置页与 describeSettings 的显示值） */
export function reviewerRulesText(rules: ReviewerRulesConfig | undefined): string {
  const parts: string[] = [];
  if (rules?.ask !== undefined && rules.ask.trim() !== "")
    parts.push(`需要确认 ${rules.ask.length} 字`);
  if (rules?.allow !== undefined && rules.allow.trim() !== "")
    parts.push(`自动放行 ${rules.allow.length} 字`);
  return parts.length === 0 ? "未设置" : parts.join(" · ");
}

export function resolveGeminiDecisionConnection(
  config: GeminiDecisionModelConfig,
  credentials: CredentialStore | undefined,
  env: (name: string) => string | undefined,
  minConfidence = 0.7,
) {
  const credential = config.credential;
  return {
    baseURL: geminiDecisionBaseURL(config),
    model: config.model,
    minConfidence,
    endpoint: config.endpoint,
    key: async (): Promise<string | undefined> => {
      if ("env" in credential) return env(credential.env);
      return credentials?.get("decision-model");
    },
  };
}

export function resolveJevConnection(
  config: Pick<
    JevReviewerConfig,
    "endpoint" | "baseURL" | "model" | "credential" | "minConfidence"
  >,
  providers: readonly Pick<ProviderEntryConfig, "id" | "sessionHeader">[],
  credentials: CredentialStore | undefined,
  env: (name: string) => string | undefined,
  storedCredentialId: "reviewer" | "decision-model" = "reviewer",
  fallbackStoredCredentialId?: "reviewer",
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
      if ("provider" in credential) return credentials?.get(credential.provider);
      const primary = await credentials?.get(storedCredentialId);
      if (primary !== undefined || fallbackStoredCredentialId === undefined) return primary;
      return credentials?.get(fallbackStoredCredentialId);
    },
  };
}

/** Gemini Decisions 实时模型列表：去掉 models/ 前缀后过滤包含 decision 的项。 */
export async function fetchGeminiDecisionModels(
  connection: { baseURL: string; key: () => Promise<string | undefined> },
  fallback: string,
  signal?: AbortSignal,
  modelFilter = "decision",
): Promise<{ models: string[]; warning?: string }> {
  try {
    const key = await connection.key();
    const response = await fetch(`${connection.baseURL}/models`, {
      headers: key ? { "x-goog-api-key": key } : {},
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error("HTTP");
    const body: unknown = await response.json();
    const list = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(list)) throw new Error("格式");
    const models = [
      ...new Set(
        list.flatMap((entry: unknown) => {
          const rawName = (entry as { name?: unknown } | null)?.name;
          if (typeof rawName !== "string") return [];
          const id = rawName.replace(/^models\//, "");
          return id.toLowerCase().includes(modelFilter) ? [id] : [];
        }),
      ),
    ];
    if (models.length === 0) throw new Error("无决策模型");
    return { models };
  } catch {
    return { models: [fallback], warning: "模型列表拉取失败，已退回默认模型；也可手动输入" };
  }
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
