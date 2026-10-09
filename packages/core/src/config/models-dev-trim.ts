/**
 * models.dev 原始数据的裁剪（ADR-0031 §4、ADR-0053）。只含类型导入，
 * scripts/update-models-dev-snapshot.mjs 直接导入本文件生成快照，
 * 快照与运行时缓存因此共用同一份白名单与裁剪逻辑。
 */
import type { ModelPricing } from "../protocol/pricing.js";

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

export interface ModelsDevData {
  fetchedAt: string;
  models: Record<string, ModelsDevRecord>;
  providers?: Record<string, ModelsDevProviderData> | undefined;
}

/**
 * models.dev 服务商键白名单（ADR-0031 §4）：快照与缓存完整收录内置预设
 * 引用的键；新增内置预设的 modelsDevProvider 时同步加入。厂商价
 * （ADR-0053 修订）另由 modelsDevVendorKeys 按数据推出，只收 cost。
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

/** 扁平表规范 ID `<厂商>/<模型>` 拆分；没有厂商前缀时返回 undefined。 */
export function splitCanonicalId(id: string): { vendor: string; model: string } | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { vendor: id.slice(0, slash), model: id.slice(slash + 1) };
}

/**
 * 厂商价的服务商键（ADR-0053 修订）：扁平表规范 ID 的厂商前缀中，
 * api.json 里存在同名服务商的那些，按字典序；不手写清单。
 */
export function modelsDevVendorKeys(
  flatModels: Readonly<Record<string, unknown>>,
  api: Readonly<Record<string, unknown>>,
): string[] {
  const vendors = new Set<string>();
  for (const id of Object.keys(flatModels)) {
    const vendor = splitCanonicalId(id)?.vendor;
    const value = vendor !== undefined ? api[vendor] : undefined;
    if (vendor !== undefined && value !== null && typeof value === "object") vendors.add(vendor);
  }
  return [...vendors].sort();
}

/**
 * api.json 的服务商级数据裁剪：白名单键（MODELS_DEV_PROVIDER_KEYS）
 * 保存服务商级 npm 与逐模型 provider.npm 原文、cost（模型条目必存在，
 * npm 缺省为 {}）。给出扁平表时另收录 modelsDevVendorKeys 推出的厂商
 * 服务商，只保留扁平表里该厂商有、且带 cost 的模型，只保留 cost。
 */
export function trimModelsDevProviders(
  raw: unknown,
  flatModels?: Readonly<Record<string, unknown>>,
): Record<string, ModelsDevProviderData> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const table = raw as Record<string, unknown>;
  const providers: Record<string, ModelsDevProviderData> = {};
  const modelsOf = (value: unknown): Record<string, unknown> => {
    const models = (value as { models?: unknown }).models;
    return models !== null && typeof models === "object" ? (models as Record<string, unknown>) : {};
  };
  const whitelist = new Set<string>(MODELS_DEV_PROVIDER_KEYS);
  for (const key of MODELS_DEV_PROVIDER_KEYS) {
    const value = table[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = value as Record<string, unknown>;
    const modelMap: NonNullable<ModelsDevProviderData["models"]> = {};
    for (const [modelId, mv] of Object.entries(modelsOf(provider))) {
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
  if (flatModels !== undefined) {
    for (const vendor of modelsDevVendorKeys(flatModels, table)) {
      if (whitelist.has(vendor) || Array.isArray(table[vendor])) continue;
      const listed = modelsOf(table[vendor]);
      const modelMap: NonNullable<ModelsDevProviderData["models"]> = {};
      for (const id of Object.keys(flatModels)) {
        const parts = splitCanonicalId(id);
        if (parts?.vendor !== vendor || !Object.hasOwn(listed, parts.model)) continue;
        const cost = trimModelsDevCost((listed[parts.model] as { cost?: unknown } | null)?.cost);
        if (cost !== undefined) modelMap[parts.model] = { cost };
      }
      if (Object.keys(modelMap).length > 0) providers[vendor] = { models: modelMap };
    }
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}
