# ADR-0016：模型上下文窗口与最大输出长度以上游声明为准

- 状态：已接受；上游之上的用户编辑层见 [ADR-0024](ADR-0024-model-settings-editor.md)；上游之下的 models.dev 来源层见 [ADR-0025](ADR-0025-per-model-reasoning.md)
- 日期：2026-09-25

## 背景

v0.1 对内置目录中查不到的模型套用保守默认值：`contextWindow` 128000、`maxOutputTokens` 4096，并且每个请求都发送 `maxOutputTokens`。实测两头都错：

- commandcode 网关的模型列表对 `deepseek/deepseek-v4.1-flash` 声明 `context_length` 为 1000000，按 128000 计算会过早触发上下文压缩；
- OpenRouter 对同一模型声明 `top_provider.max_completion_tokens` 为 393216（458 个模型中 452 个有此字段），按 4096 发送会让一次大文件写入被截断。

上下文窗口与输出上限是服务方的事实，Nocturne 不应替上游猜。`ModelInfo.maxOutputTokens` 与 `ModelRequest.maxOutputTokens` 目前是必填字段，改变它属于 [provider-api.md](../protocols/provider-api.md) 第 6 节所说的契约变化。

## 决定

1. **限额来源的优先级**：默认值 < 内置目录 < 上游声明 < 手写配置。上游声明在向导选择模型时与 `/provider refresh` 时从模型列表接口获取，写入 `providers.json` 并记录来源与时间；不在每次启动时请求。只映射含义明确的字段，没有的字段不猜（映射表见 [provider-setup.md](../architecture/provider-setup.md) 第 7 节）。
2. **`ModelInfo.maxOutputTokens` 与 `ModelRequest.maxOutputTokens` 改为可选**，未知即"上游未声明"：
   - `openai-compatible` 请求不发送 `max_tokens`，由上游按自己的上限处理；
   - `anthropic` 协议要求必填，适配器使用兜底值 8192；
   - 上下文预算为输出预留的空间与发送值分开，未知时按兜底值预留，只影响本地估算。
3. **上下文窗口仍然必须有值**（预算需要一个数），未知时按 128000 估算，同时发出 `runtime.warning(code="model_capabilities_defaulted")` 并在 `/context` 标注。

## 后果

- 声明了限额的模型自动得到正确的预算与输出上限；commandcode 上的 DeepSeek V4.1 Flash 可用窗口从 128000 提升到 1000000。
- 不发送 `max_tokens` 时，实际输出上限取决于上游默认值，个别服务的默认值可能偏小；用户可在手写配置的 `models` 中显式声明覆盖。
- 适配器与上下文预算的测试需要覆盖"未知"分支；既有显式声明的配置行为不变。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 调高默认值（如 8192） | 否决 | 仍然是猜：对 1M 窗口、39 万输出上限的模型依然偏小，对小模型又可能超限 |
| 每次启动都请求模型列表 | 否决 | 启动依赖网络、增加延迟；限额变化不频繁，按需刷新足够 |
| 未知时也照发一个默认 `max_tokens` | 否决 | 这正是 v0.1 的问题：由 Nocturne 替上游决定上限 |
