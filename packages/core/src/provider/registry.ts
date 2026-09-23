/**
 * ProviderRegistry：按 ModelRef 解析 Provider + ModelInfo。
 * 模型信息 = 内置目录 ← 用户配置覆盖 ← 保守默认。
 */
import type { ModelRef } from "../protocol/index.js";
import { BUILTIN_MODEL_CATALOG, DEFAULT_MODEL_FALLBACK } from "./catalog.js";
import type { ModelInfo, Provider, ProviderRegistry, ResolvedModel } from "./types.js";

export class UnknownModelError extends Error {
  readonly ref: ModelRef;
  constructor(ref: ModelRef, message: string) {
    super(message);
    this.name = "UnknownModelError";
    this.ref = ref;
  }
}

/** 用户在 Provider 配置里对某个模型的覆盖 */
export type ModelOverride = Partial<Omit<ModelInfo, "ref">>;

/** 在既有 ModelInfo 上应用用户覆盖 */
export function applyModelOverride(
  base: ModelInfo,
  override: ModelOverride | undefined,
): ModelInfo {
  if (override === undefined) return base;
  return {
    ref: base.ref,
    displayName: override.displayName ?? base.displayName,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    capabilities: {
      ...base.capabilities,
      ...override.capabilities,
    },
  };
}

/** 合并目录项与覆盖项，生成 ModelInfo */
export function resolveModelInfo(ref: ModelRef, override: ModelOverride | undefined): ModelInfo {
  const base: ModelInfo = {
    ref,
    ...(BUILTIN_MODEL_CATALOG[ref.provider]?.[ref.model] ?? DEFAULT_MODEL_FALLBACK),
  };
  return applyModelOverride(base, override);
}

export function createProviderRegistry(
  providers: Provider[],
  modelOverrides: Record<string, Record<string, ModelOverride>> = {},
): ProviderRegistry {
  const byId = new Map<string, Provider>();
  for (const p of providers) {
    if (byId.has(p.id)) {
      throw new Error(`Provider id 重复: ${p.id}`);
    }
    byId.set(p.id, p);
  }
  return {
    resolve(ref: ModelRef): ResolvedModel {
      const provider = byId.get(ref.provider);
      if (provider === undefined) {
        throw new UnknownModelError(ref, `未配置的 Provider: ${ref.provider}`);
      }
      const configured = provider.models().find((m) => m.ref.model === ref.model);
      const base = configured ?? resolveModelInfo(ref, undefined);
      const model = applyModelOverride(base, modelOverrides[ref.provider]?.[ref.model]);
      return { provider, model };
    },
    providers: () => [...byId.values()],
  };
}
