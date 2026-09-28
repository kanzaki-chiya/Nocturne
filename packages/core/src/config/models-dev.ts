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
export interface ModelsDevData {
  fetchedAt: string;
  models: Record<string, ModelsDevRecord>;
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

function validCache(raw: unknown): raw is ModelsDevData {
  if (raw === null || typeof raw !== "object") return false;
  const data = raw as Record<string, unknown>;
  if (typeof data.fetchedAt !== "string" || Number.isNaN(Date.parse(data.fetchedAt))) return false;
  if (data.models === null || typeof data.models !== "object" || Array.isArray(data.models)) {
    return false;
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
    const response = await fetcher("https://models.dev/models.json", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = trimModelsDev(await response.json());
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
