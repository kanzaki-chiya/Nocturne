/**
 * 内置模型能力目录（providers.md 第 2 节）：纯数据，按 Provider 内模型 id 索引。
 * 用户配置可覆盖；未列出的模型按保守默认处理。
 */
import type { ModelCapabilities, ModelInfo } from "./types.js";

type CatalogEntry = Omit<ModelInfo, "ref">;

const FULL_CAPS: ModelCapabilities = {
  toolCalls: true,
  parallelToolCalls: true,
  reasoning: "none",
  imageInput: false,
  promptCache: false,
};

/** 各 Provider 的内置目录：<providerId>/<modelId> */
export const BUILTIN_MODEL_CATALOG: Record<string, Record<string, CatalogEntry>> = {
  deepseek: {
    "deepseek-chat": {
      displayName: "DeepSeek Chat",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { ...FULL_CAPS, promptCache: true },
    },
    "deepseek-reasoner": {
      displayName: "DeepSeek Reasoner",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { ...FULL_CAPS, reasoning: "visible", promptCache: true },
    },
  },
};

/** 未列出模型的保守默认：能力一律 false（缺失能力按保守值处理） */
export const DEFAULT_MODEL_FALLBACK: CatalogEntry = {
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  capabilities: {
    toolCalls: false,
    parallelToolCalls: false,
    reasoning: "none",
    imageInput: false,
    promptCache: false,
  },
};
