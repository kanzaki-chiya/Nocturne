/** provider — Provider 接口、模型目录、适配器（providers.md、provider-api.md） */
export * from "./types.js";
export * from "./auth.js";
export { externalAuthPath } from "./adapters/external-file-auth.js";
export * from "./http.js";
export * from "./timeout.js";
export * from "./errors.js";
export * from "./catalog.js";
export * from "./reasoning.js";
export * from "./effective-protocol.js";
export * from "./entry.js";
export * from "./registry.js";
export * from "./fake.js";
export * from "./adapters/openai-compatible.js";
export * from "./adapters/anthropic.js";
export * from "./adapters/openai-responses.js";
export * from "./presets.js";

import type { AnthropicConfig } from "./adapters/anthropic.js";
import type { OpenAICompatibleConfig } from "./adapters/openai-compatible.js";

/** 声明式 Provider 配置联合；以 config.type 分辨（缺省为 openai-compatible）。
    ADR-0031 §1：条目 type 只有这两种；openai-responses 只作模型协议出现 */
export type ProviderConfig = OpenAICompatibleConfig | AnthropicConfig;
