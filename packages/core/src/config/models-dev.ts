/** models.dev 的离线快照、缓存与按模型 ID 匹配；只在显式刷新时联网。 */
import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";
import { modelsDevSnapshot } from "./models-dev-snapshot.js";
import type { ModelOverrideShape } from "./types.js";
import type { ModelPricing } from "../protocol/index.js";

export interface ModelsDevRecord {
  reasoning?: boolean;
  input?: readonly string[];
  context?: number;
  output?: number;
  cost?: ModelPricing | undefined;
}

/**
 * 按服务商键保存的接口声明（ADR-0031 §4）：服务商级 npm 原文 +
 * 逐模型 npm 原文（逐模型缺省时继承服务商级）。models 中每个条目
 * 记录该模型在服务商表内的存在性（npm 缺省 → {}）。
 */
export interface ModelsDevProviderData {
  npm?: string | undefined;
  models?:
    Record<string, { npm?: string | undefined; cost?: ModelPricing | undefined }> | undefined;
}

/**
 * models.dev 服务商键白名单（ADR-0031 §4）：快照与缓存只收录内置预设
 * 引用的键；新增内置预设的 modelsDevProvider 时同步加入。
 */
export const MODELS_DEV_PROVIDER_KEYS = [
  "opencode",
  "opencode-go",
  "deepseek",
  "xai",
  "anthropic",
  "openai",
  "openrouter",
] as const;

/** api.json cost 的严格白名单映射，不保留服务商其他字段。 */
export function trimModelsDevCost(raw: unknown): ModelPricing | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const prices: ModelPricing = {};
  for (const [from, to] of [
    ["input", "input"],
    ["output", "output"],
    ["cache_read", "cacheRead"],
    ["cache_write", "cacheWrite"],
  ] as const) {
    const n = value[from];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) prices[to] = n;
  }
  if (Array.isArray(value.tiers)) {
    prices.tiers = value.tiers.flatMap((rawTier: unknown) => {
      if (rawTier === null || typeof rawTier !== "object" || Array.isArray(rawTier)) return [];
      const tier = rawTier as Record<string, unknown>;
      const size = (tier.tier as { size?: unknown } | undefined)?.size;
      if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return [];
      const { tiers: _nested, ...fields } = trimModelsDevCost({ ...tier, tiers: undefined }) ?? {};
      return [{ aboveInputTokens: size, ...fields }];
    });
  }
  return Object.keys(prices).length > 0 ? prices : undefined;
}

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
    const modelMap: NonNullable<ModelsDevProviderData["models"]> = {};
    for (const [modelId, mv] of Object.entries(models)) {
      const npm =
        mv !== null && typeof mv === "object" && !Array.isArray(mv)
          ? (mv as { provider?: { npm?: unknown } }).provider?.npm
          : undefined;
      const cost = trimModelsDevCost((mv as { cost?: unknown } | null)?.cost);
      modelMap[modelId] = {
        ...(typeof npm === "string" && npm !== "" ? { npm } : {}),
        ...(cost !== undefined ? { cost } : {}),
      };
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

/**
 * matchModelsDev 的索引（打开会话慢的根因修复）：原实现对每个模型都
 * `Object.keys(models)` 全扫一遍（filter + toLowerCase + tail 正则），
 * 806 模型 × 441 条目 ≈ 35 万次逐条比较。索引按 models 对象建一次，
 * 后续匹配均为 O(1) 查表；modelsDev 刷新整体换对象，旧索引自然失效。
 */
interface ModelsDevMatchIndex {
  exact: Map<string, ModelsDevRecord | undefined>;
  fold: Map<string, { count: number; id: string }>;
  tail: Map<string, { count: number; id: string }>;
}

const modelsDevMatchIndexes = new WeakMap<object, ModelsDevMatchIndex>();

function matchIndex(models: ModelsDevData["models"]): ModelsDevMatchIndex {
  const hit = modelsDevMatchIndexes.get(models);
  if (hit !== undefined) return hit;
  const index: ModelsDevMatchIndex = { exact: new Map(), fold: new Map(), tail: new Map() };
  for (const id of Object.keys(models)) {
    // 经 exact 回查取值：undefined 值的 key 也参与计数，与原 filter 语义一致
    index.exact.set(id, models[id]);
    const folded = id.toLowerCase();
    const foldHit = index.fold.get(folded);
    if (foldHit === undefined) index.fold.set(folded, { count: 1, id });
    else foldHit.count += 1;
    const suffix = tail(id);
    const tailHit = index.tail.get(suffix);
    if (tailHit === undefined) index.tail.set(suffix, { count: 1, id });
    else tailHit.count += 1;
  }
  modelsDevMatchIndexes.set(models, index);
  return index;
}

export function matchModelsDev(
  models: ModelsDevData["models"],
  modelId: string,
): ModelsDevRecord | undefined {
  const index = matchIndex(models);
  if (index.exact.has(modelId)) return index.exact.get(modelId);
  const folded = index.fold.get(modelId.toLowerCase());
  if (folded !== undefined) {
    if (folded.count !== 1) return undefined;
    return index.exact.get(folded.id);
  }
  const suffix = index.tail.get(tail(modelId));
  if (suffix?.count !== 1) return undefined;
  return index.exact.get(suffix.id);
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
