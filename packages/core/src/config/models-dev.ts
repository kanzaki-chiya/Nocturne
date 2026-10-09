/** models.dev 的离线快照、缓存与按模型 ID 匹配；只在显式刷新时联网。 */
import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";
import { modelsDevSnapshot } from "./models-dev-snapshot.js";
import type { ModelOverrideShape } from "./types.js";
import type { ModelPricing } from "../protocol/index.js";
import {
  splitCanonicalId,
  trimModelsDev,
  trimModelsDevProviders,
  type ModelsDevData,
  type ModelsDevRecord,
} from "./models-dev-trim.js";

export {
  MODELS_DEV_PROVIDER_KEYS,
  modelsDevVendorKeys,
  trimModelsDev,
  trimModelsDevCost,
  trimModelsDevProviders,
  type ModelsDevData,
  type ModelsDevProviderData,
  type ModelsDevRecord,
} from "./models-dev-trim.js";

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
        ? trimModelsDevProviders(await apiResponse.json().catch(() => undefined), trimmed.models)
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

/** 匹配规则（精确 → 忽略大小写唯一 → 末段唯一）命中的表内 ID。 */
export function matchModelsDevId(
  models: Readonly<Record<string, unknown>>,
  modelId: string,
): string | undefined {
  const index = matchIndex(models as ModelsDevData["models"]);
  if (index.exact.has(modelId)) return modelId;
  const folded = index.fold.get(modelId.toLowerCase());
  if (folded !== undefined) return folded.count === 1 ? folded.id : undefined;
  const suffix = index.tail.get(tail(modelId));
  return suffix?.count === 1 ? suffix.id : undefined;
}

export function matchModelsDev(
  models: ModelsDevData["models"],
  modelId: string,
): ModelsDevRecord | undefined {
  const id = matchModelsDevId(models, modelId);
  return id === undefined ? undefined : models[id];
}

/**
 * 厂商价（ADR-0053 修订）：按匹配规则在扁平表找到规范 ID
 * `<厂商>/<模型>`，取该厂商服务商下同名模型的 cost；厂商未列出时取
 * OpenRouter 下同一规范 ID 的 cost；都没有返回 undefined。
 */
export function vendorPricing(data: ModelsDevData, modelId: string): ModelPricing | undefined {
  const canonical = matchModelsDevId(data.models, modelId);
  const parts = canonical === undefined ? undefined : splitCanonicalId(canonical);
  if (canonical === undefined || parts === undefined) return undefined;
  const vendorModels = data.providers?.[parts.vendor]?.models;
  const own =
    vendorModels !== undefined && Object.hasOwn(vendorModels, parts.model)
      ? vendorModels[parts.model]?.cost
      : undefined;
  if (own !== undefined) return own;
  const router = data.providers?.openrouter?.models;
  return router !== undefined && Object.hasOwn(router, canonical)
    ? router[canonical]?.cost
    : undefined;
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
