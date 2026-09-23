# ADR-0006：anthropic 适配器使用 @ai-sdk/anthropic 传输

- 状态：提议
- 日期：2026-09-24

## 背景

[providers.md](../architecture/providers.md) 第 4 节把 `anthropic` 适配器（Messages API）排在 Phase 2，传输实现标注"待定（官方 SDK 或 AI SDK Provider）"。需要满足的要求与 `openai-compatible` 相同：流式事件归一化为 `ModelStreamEvent`、错误归一化为 `ProviderError`、工具调用在参数完整后才交出、SDK 类型不泄漏到 Core（ADR-0005）。Anthropic 特有的差异：thinking 块携带必须原样回传的签名、`cache_control` 断点、`tool_use` / `tool_result` 内容块形态。

## 决定

`anthropic` 适配器使用 `@ai-sdk/anthropic`（AI SDK Provider），与 `openai-compatible` 适配器共用同一传输栈（`ai` 包的 `streamText` 与 `TextStreamPart` 归一化路径）。

- 版本写精确版本，选择发布已满 7 天的版本（实现时以 `npm view time` 为准；记录时参考 `4.0.56`，2026-09-16 发布）。peer 要求 `zod ^3.25.76 || ^4.1.8`，与现有 `zod@4.6.5` 兼容。
- Anthropic 特有字段在适配器内经 `providerMetadata` ↔ `providerData` 往返：thinking 块的签名进入 `reasoning_block` 的 `providerData`，历史回传时在消息转换中还原为 `providerMetadata`；`cachePrefix` 提示用于在 system 边界标注 `cache_control`。
- 若暴露"拿不到必需字段"的限制（例如签名/用量细节不透传），退路是在适配器内自建 `fetch` + SSE 解析或改用官方 SDK——按 ADR-0005 的规则只换传输实现，不改 Core 接口。

## 后果

- 正面：与既有适配器同构——同一套消息转换骨架、流式事件映射与错误归一化思路可以沿用；不引入第二种 SDK 形态与错误模型；适配器间共享的归一化逻辑可以在 `provider/` 内部沉淀。
- 负面：依赖 AI SDK 对 Anthropic 字段的覆盖度；新增 npm 依赖；`providerMetadata` 的往返需要在适配器内显式处理并有契约测试看护。
- 约束：与所有适配器相同——必须通过 provider-api.md 第 4 节的流式契约测试，并在真实服务冒烟测试中验证（`NOCTURNE_SMOKE_ANTHROPIC_*` 变量，缺失时跳过）。

## 备选方案

- **`@anthropic-ai/sdk`（官方 SDK）**：对 Messages API 的覆盖最直接、字段最全；但引入第二套 SDK 的流式与错误形态，归一化代码不能与现有适配器同构。当 AI SDK 的字段透传出现实际缺口时改用它。
- **适配器内自建 `fetch` + SSE**：控制最强、零新依赖，但要自行处理 SSE 边界、`content_block_*` 事件组装与错误体映射，重复 `@ai-sdk/openai-compatible` 已经解决的问题；作为最终退路保留。
