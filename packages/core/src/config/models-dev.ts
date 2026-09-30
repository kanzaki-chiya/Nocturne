/** models.dev 的离线快照、缓存与按模型 ID 匹配；只在显式刷新时联网。 */
import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";
import { modelsDevSnapshot } from "./models-dev-snapshot.js";
import type { ModelOverrideShape } from "./types.js";

export interface ModelsDevRecord {
  reasoning?: boolean;
  input?: readonly string[];
  context?: number;
  output?: number;
}

/**
 * 按服务商键保存的接口声明（ADR-0031 §4）：服务商级 npm 原文 +
 * 逐模型 npm 原文（逐模型缺省时继承服务商级）。models 中每个条目
 * 记录该模型在服务商表内的存在性（npm 缺省 → {}）。
 */
export interface ModelsDevProviderData {
  npm?: string | undefined;
  models?: Record<string, { npm?: string | undefined }> | undefined;
}

/**
 * models.dev 服务商键白名单（ADR-0031 §4）：快照与缓存只收录内置预设
 * 引用的键；新增内置预设的 modelsDevProvider 时同步加入。
 */
export const MODELS_DEV_PROVIDER_KEYS = ["opencode", "opencode-go"] as const;

export interface ModelsDevData {
  fetchedAt: string;
  models: Record<string, ModelsDevRecord>;
  providers?: Record<string, ModelsDevProviderData> | undefined;
}

export function trimModelsDev(raw: unknown, fetchedAt = new Date().toISOString()): ModelsDevData {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("models.dev 返回值不是模型表");
  }
  const models: ModelsDevData["models"] = {};
  for (const [id, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as Record<string, unknown>;
    const modalities = model.modalities as Record<string, unknown> | undefined;
    const limit = model.limit as Record<string, unknown> | undefined;
    models[id] = {
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(Array.isArray(modalities?.input)
        ? { input: modalities.input.filter((x): x is string => typeof x === "string") }
        : {}),
      ...(Number.isInteger(limit?.context) && (limit?.context as number) > 0
        ? { context: limit?.context as number }
        : {}),
      ...(Number.isInteger(limit?.output) && (limit?.output as number) > 0
        ? { output: limit?.output as number }
        : {}),
    };
  }
  return { fetchedAt, models };
}

/**
 * api.json 的服务商级数据裁剪（ADR-0031 §4）：只收录
 * MODELS_DEV_PROVIDER_KEYS 白名单键；保存服务商级 npm 与逐模型
 * provider.npm 原文（模型条目必存在，npm 缺省为 {}）。
 */
export function trimModelsDevProviders(
  raw: unknown,
): Record<string, ModelsDevProviderData> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const table = raw as Record<string, unknown>;
  const providers: Record<string, ModelsDevProviderData> = {};
  for (const key of MODELS_DEV_PROVIDER_KEYS) {
    const value = table[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = value as Record<string, unknown>;
    const models =
      provider.models !== null && typeof provider.models === "object"
        ? (provider.models as Record<string, unknown>)
        : {};
    const modelMap: Record<string, { npm?: string | undefined }> = {};
    for (const [modelId, mv] of Object.entries(models)) {
      const npm =
        mv !== null && typeof mv === "object" && !Array.isArray(mv)
          ? (mv as { provider?: { npm?: unknown } }).provider?.npm
          : undefined;
      modelMap[modelId] = typeof npm === "string" && npm !== "" ? { npm } : {};
    }
    providers[key] = {
      ...(typeof provider.npm === "string" ? { npm: provider.npm } : {}),
      models: modelMap,
    };
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

/** npm 包名 → 服务接口声明（ADR-0031 §4 映射表；npm:<pkg> 由推导标为不可用） */
export function npmToEndpoints(npm: string): string[] {
  switch (npm) {
    case "@ai-sdk/openai-compatible":
      return ["/chat/completions"];
    case "@ai-sdk/anthropic":
      return ["/messages"];
    case "@ai-sdk/openai":
      return ["/responses"];
    default:
      return [`npm:${npm}`];
  }
}

/**
 * 条目 modelsDevProvider 下某模型的接口声明（ADR-0031 §4）：
 * 模型在服务商表内 → npm = 逐模型 npm ?? 服务商级 npm → endpoints；
 * 查不到（模型不在表内 / 服务商键无数据）→ undefined，回落条目 type。
 */
export function devProviderEndpoints(
  data: ModelsDevData,
  providerKey: string,
  modelId: string,
): string[] | undefined {
  const provider = data.providers?.[providerKey];
  const listed = provider?.models !== undefined && Object.hasOwn(provider.models, modelId);
  if (provider === undefined || !listed) return undefined;
  const npm = provider.models?.[modelId]?.npm ?? provider.npm;
  return npm === undefined ? undefined : npmToEndpoints(npm);
}

function validCache(raw: unknown): raw is ModelsDevData {
  if (raw === null || typeof raw !== "object") return false;
  const data = raw as Record<string, unknown>;
  if (typeof data.fetchedAt !== "string" || Number.isNaN(Date.parse(data.fetchedAt))) return false;
  if (data.models === null || typeof data.models !== "object" || Array.isArray(data.models)) {
    return false;
  }
  // providers 块为可选（ADR-0031 §4：旧缓存没有它仍视为有效）
  if (data.providers !== undefined) {
    if (
      data.providers === null ||
      typeof data.providers !== "object" ||
      Array.isArray(data.providers)
    ) {
      return false;
    }
    for (const pv of Object.values(data.providers)) {
      if (pv === null || typeof pv !== "object" || Array.isArray(pv)) return false;
      const p = pv as Record<string, unknown>;
      if (p.npm !== undefined && typeof p.npm !== "string") return false;
      if (p.models !== undefined && (p.models === null || typeof p.models !== "object")) {
        return false;
      }
    }
  }
  return Object.values(data.models).every((v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const m = v as Record<string, unknown>;
    return (
      (m.reasoning === undefined || typeof m.reasoning === "boolean") &&
      (m.input === undefined ||
        (Array.isArray(m.input) && m.input.every((x) => typeof x === "string"))) &&
      (m.context === undefined || (Number.isInteger(m.context) && (m.context as number) > 0)) &&
      (m.output === undefined || (Number.isInteger(m.output) && (m.output as number) > 0))
    );
  });
}

export async function readModelsDev(platform: Platform, home: string): Promise<ModelsDevData> {
  const path = platform.paths.join(home, "cache", "models-dev.json");
  try {
    const raw: unknown = JSON.parse(await platform.fs.readTextFile(path));
    if (validCache(raw) && Date.parse(raw.fetchedAt) > Date.parse(modelsDevSnapshot.fetchedAt)) {
      return raw;
    }
  } catch {
    // 缓存不存在或损坏时使用随版本内置的快照。
  }
  return modelsDevSnapshot;
}

export async function refreshModelsDev(
  platform: Platform,
  home: string,
  fetcher: typeof fetch = fetch,
): Promise<{ data: ModelsDevData; warning?: string }> {
  try {
    // ADR-0031 §4：api.json 携带按服务商的接口声明（provider.npm /
    // 逐模型 provider.npm），与扁平模型表一同裁剪进缓存；api.json
    // 失败只丢 providers 块，models 表照常更新。
    const [response, apiResponse] = await Promise.all([
      fetcher("https://models.dev/models.json", {
        signal: AbortSignal.timeout(10_000),
      }),
      fetcher("https://models.dev/api.json", {
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const trimmed = trimModelsDev(await response.json());
    const providers =
      apiResponse?.ok === true
        ? trimModelsDevProviders(await apiResponse.json().catch(() => undefined))
        : undefined;
    const data: ModelsDevData = {
      ...trimmed,
      ...(providers !== undefined ? { providers } : {}),
    };
    await writeJsonAtomic(
      platform.fs,
      platform.paths,
      platform.paths.join(home, "cache", "models-dev.json"),
      data,
    );
    return { data };
  } catch (e) {
    return {
      data: await readModelsDev(platform, home),
      warning: `models.dev 获取失败（${e instanceof Error ? e.message : String(e)}），继续使用缓存或内置快照`,
    };
  }
}

const tail = (id: string): string =>
  (
    id
      .replace(/:[^/]*$/, "")
      .split("/")
      .at(-1) ?? ""
  ).toLowerCase();

export function matchModelsDev(
  models: ModelsDevData["models"],
  modelId: string,
): ModelsDevRecord | undefined {
  if (Object.hasOwn(models, modelId)) return models[modelId];
  const ids = Object.keys(models);
  const exactCaseFold = ids.filter((id) => id.toLowerCase() === modelId.toLowerCase());
  if (exactCaseFold.length === 1) return models[exactCaseFold[0] ?? ""];
  if (exactCaseFold.length > 1) return undefined;
  const suffix = ids.filter((id) => tail(id) === tail(modelId));
  return suffix.length === 1 ? models[suffix[0] ?? ""] : undefined;
}

export function modelOverrideFromDev(record: ModelsDevRecord): ModelOverrideShape {
  const capabilities: NonNullable<ModelOverrideShape["capabilities"]> = {};
  if (record.reasoning !== undefined)
    capabilities.reasoning = record.reasoning ? "visible" : "none";
  if (record.input !== undefined) capabilities.imageInput = record.input.includes("image");
  return {
    ...(record.context !== undefined ? { contextWindow: record.context } : {}),
    ...(record.output !== undefined ? { maxOutputTokens: record.output } : {}),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}
