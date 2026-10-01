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
  editTool: "edit",
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

/**
 * 未列出模型的保守默认（ADR-0016）：能力一律 false；
 * contextWindow / maxOutputTokens 不设值——"未知"由调用方按
 * 128000 估算并发出 model_capabilities_defaulted 警告，不再静默填数。
 */
export const DEFAULT_MODEL_FALLBACK: CatalogEntry = {
  capabilities: {
    toolCalls: false,
    parallelToolCalls: false,
    reasoning: "none",
    imageInput: false,
    promptCache: false,
    // ADR-0035 §5：占位值——目录未命中的模型在 resolve 时由配置层
    // 默认表（含 gpt/codex → apply_patch）或 "edit" 兜底覆盖
    editTool: "edit",
  },
};

/** 上下文窗口未知时的本地估算值（ADR-0016：预算必须有一个数） */
export const CONTEXT_WINDOW_FALLBACK = 128_000;
/** 输出预留兜底（仅本地预算估算与 anthropic 必填参数使用，不发送给上游的 openai-compatible 请求） */
export const MAX_OUTPUT_FALLBACK = 8_192;
