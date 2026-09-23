# ADR-0005：自有 Provider 接口，不暴露第三方 SDK 类型

- 状态：已接受（第 2 版，2026-09-23；只包含接口决定，传输实现不在本 ADR 中决定）
- 日期：2026-09-23

## 背景

需要接入多家模型服务。一种做法是直接以某个多 Provider SDK（例如 Vercel AI SDK）的类型作为 Core 的模型接口。ZCode 的模型适配层基于 AI SDK，但在其上又定义了自己的 `Model` 接口与 `ModelStreamEvent`，并对 `@ai-sdk/anthropic`、`@ai-sdk/openai-compatible` 打了补丁（见其仓库 `patches/`）。这说明两点：Core 需要一层自己掌握的契约；而 SDK 本身仍然是可用的实现手段。

## 决定

1. Core 只依赖 Nocturne 自己定义的 `Provider`、`ModelRequest`、`ModelStreamEvent`、`ProviderError`（见 [provider-api.md](../protocols/provider-api.md)）。
2. 第三方 SDK 或解析库的类型不得出现在适配器之外。
3. 适配器的传输实现不在本 ADR 中决定。默认做法是先复用合适的官方 SDK、多 Provider SDK 或 SSE 解析库，在遇到具体限制（例如无法取得某个推理字段或用量字段）时再替换为自建实现。每个适配器的选择与理由记录在 [providers.md](../architecture/providers.md)。

## 后果

- 替换或升级某个 SDK 只影响对应适配器。
- 契约由我们掌握，"错误以抛出方式报告""工具调用完整后才发出"等约束写在接口上，由适配器负责满足，不论底层用什么实现。
- 使用 SDK 时需要在适配器内做一次类型转换，并用契约测试验证流式行为。

## 备选方案

- **直接使用多 Provider SDK 的类型作为 Core 接口**：起步最快，但 Core 被 SDK 的抽象与版本节奏绑定。
- **所有适配器一律自建 HTTP + SSE**（第 1 版的倾向）：控制力最强，但掌握契约并不要求从底层写起，过早自建增加维护量。
- **每个 Provider 各写一套 Agent 集成**：违背"Core 中不出现 Provider 分支"的原则。
