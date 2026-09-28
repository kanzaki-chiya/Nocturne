# Provider 抽象

> 状态：已接受 v0.2 ｜ 前置阅读：[overview.md](overview.md) ｜ 接口契约：[provider-api.md](../protocols/provider-api.md) ｜ 决策：[ADR-0005](../decisions/ADR-0005-own-provider-interface.md)

## 1. 职责

Provider 层把"各家模型服务的协议差异"关在适配器里，对上只暴露一套中性的请求、流式事件和错误。它负责归一化：

| 方面 | 归一化为 |
|---|---|
| 流式输出 | `ModelStreamEvent` 序列 |
| 文本 | `text_delta` |
| 推理 / 思考 | `reasoning_delta`，完整块可携带 Provider 专有数据（签名、加密内容） |
| 工具调用 | 完整的 `tool_call`（id、名称、已解析参数）；参数增量可选地以 `tool_call_delta` 提供给界面 |
| 用量 | `Usage`：输入、输出、缓存读、缓存写、推理 token，语义统一 |
| 结束原因 | `stop` / `tool_calls` / `length` / `content_filter` / `other`，并保留原始值 |
| 错误 | `ProviderError`：`kind`、`retryable`、`retryAfterMs`、HTTP 状态、原始信息 |
| 能力 | `ModelInfo.capabilities` |

Agent Core 中不允许出现 `if provider === "openai"` 之类的分支。某个模型的特殊行为，要么在适配器内处理，要么表达为能力字段。

## 2. Provider、Model、能力、选项的关系

| 概念 | 是什么 | 为什么单独存在 |
|---|---|---|
| `Provider` | 一个模型服务的连接：适配器类型 + 端点 + 凭据，实现 `stream()` | 同一种协议（如 OpenAI 兼容）可以连接许多不同的服务 |
| `ModelInfo` | 某个 Provider 下一个模型的描述：id、上下文窗口、最大输出、能力 | 能力属于模型而不是 Provider：同一 Provider 的不同模型差异很大 |
| `ModelCapabilities` | 数据：是否支持工具调用、并行工具调用、推理及其形式、图片输入、提示缓存、可选的推理强度档位 | Context Builder 与 Agent Loop 依据能力做决定，而不是依据名字 |
| `ProviderOptions` | 传给某个 Provider 的专有参数，Core 不解释 | 给高级用户留出口，又不污染中性接口 |

能力信息来自内置的小型模型目录（纯数据），用户可以在配置中覆盖或为未知模型补充。MVP 不从远端同步模型目录。

模型字段（`displayName`/`contextWindow`/`maxOutputTokens`/`capabilities.*`）的生效值按**逐字段**优先级取（高者覆盖低者，ADR-0024 第 2 节）：逐模型手写 `models.<id>.<字段>`（config.json / 项目配置 / 环境变量 / 命令行，层间再按全局层级）> 用户编辑（providers.json 条目的 `userModels.<模型>`，「编辑模型」或 `/provider model` 写入，见 [provider-setup.md](provider-setup.md)）> 上游声明（`GET /models` 的字段映射，provider-setup.md 第 7 节）> 内置目录 > 字段默认（`imageInput` 为 `false`、`reasoning` 为 `none`、数值字段为未声明）。逐字段的含义：`config.json` 同名模型条目**只覆盖它实际写出的字段**——只写 `contextWindow` 时其余字段照常回落到用户编辑/上游/内置；数组字段（`reasoningEffort`）由最高层整体替换，不并集，显式空数组同样生效。

`reasoningEffort` 在字段级声明之外还有一条档位链（ADR-0018/0024）：逐模型字段声明（同上优先级）> 服务商条目 `thinking.levels`（服务商级用户声明，`/provider refresh` 不覆盖）> `reasoning ≠ "none"` 时推导全档 > 无（不可切换）。**显式 none**：生效 `reasoning` 为 `none` 且来源是用户编辑或手写层时档位锁定为空数组——两个例外：`userModels` 的 none 遇到手写非空档位时手写优先（保留档位并警告）；手写层自身的 none + 非空档位是配置矛盾，档位置空并产生 `config_warning`（写明文件、服务商、模型）。内置目录/默认给出的 none 不算配置层声明，不触发锁定（服务商 `thinking.levels` 照常生效）。

## 3. 配置形态（示意）

```jsonc
{
  "model": "deepseek/deepseek-chat",          // <providerId>/<modelId>
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",          // 只引用环境变量名，不在配置里写密钥
      "models": { "deepseek-chat": { "contextWindow": 128000 } },
      "providerOptions": {},                     // 配置级选项，与请求级合并后传给适配器（provider-api.md §3）
      "allowUndeclaredModels": false              // true → strictModels=false，接受清单外模型 id（CLI 用）
    }
  }
}
```

凭据只从环境变量或用户级凭据文件读取，不写入会话日志、事件或普通日志。交互式配置（`nctrn setup`、`/provider`）、服务商预设与凭据解析顺序见 [provider-setup.md](provider-setup.md)（v0.2）。

思考强度档位（[ADR-0018](../decisions/ADR-0018-reasoning-effort.md)）：中性档位集合为 `off | minimal | low | medium | high | xhigh | max`，无 `auto`。每个模型的可用档位按声明解析——逐模型 `capabilities.reasoningEffort` > 服务商条目 `thinking.levels`（用户声明，`/provider refresh` 不覆盖）> 上游能力标记推导 > 无（不可切换）。`ModelRequest.reasoningEffort` 由 Runtime 按会话配置就近降档赋值；适配器把档位翻译为 `reasoning_effort`（openai 格式）、`reasoning.effort`（openrouter 格式）或 `thinking.budget_tokens`（anthropic）——`"max"` 是通用最高档，openai/openrouter 原样发送，anthropic 换算默认 32768。`providerOptions` 中的原生推理键仍可直传，与归一化字段同义时归一化字段胜出；子代理兜底轮不携带 `reasoningEffort`，使强制 `toolChoice` 可正常表达。

## 4. 适配器

| 适配器 | 覆盖 | 阶段 | 传输实现 |
|---|---|---|---|
| `openai-compatible`（Chat Completions） | DeepSeek、GLM、OpenRouter、Ollama / vLLM / LM Studio 等 OpenAI 兼容服务 | Phase 1 | `@ai-sdk/openai-compatible`（peer: `ai`） |
| `openai`（Responses API） | OpenAI 官方服务（推理内容回传、服务端状态等） | 按需 | `openai` 官方 SDK |
| `anthropic`（Messages） | Anthropic 及兼容 Anthropic 协议的服务 | Phase 2 | `@ai-sdk/anthropic`（peer: `ai`），见 [ADR-0006](../decisions/ADR-0006-anthropic-transport.md) |
| `gemini` | Google Gemini | 按需 | 待定 |

传输实现的理由与约定：

- **`openai-compatible` 用 `@ai-sdk/openai-compatible`**：该包专为"实现 `/v1/chat/completions` 的第三方服务"设计，已处理 SSE 边界、按 `index` 分片的 `tool_calls` 组装、用量与错误体归一化；自托管 / 中转兼容服务是它的明示使用场景。SDK 类型只存在于适配器内部，不泄漏到 Core（ADR-0005）。已知风险是各家在推理字段（`reasoning_content` 等）、用量口径、错误体结构上的差异不一定全部透传——契约测试与真实服务冒烟测试用于检验这一点；若暴露拿不到必需字段的限制，退路是适配器内自建 `fetch` + SSE 解析（不引第三方 SDK）。
- **`anthropic` 用 `@ai-sdk/anthropic`**（[ADR-0006](../decisions/ADR-0006-anthropic-transport.md)）：与 openai-compatible 共用 `streamText` / `TextStreamPart` 归一化路径。Anthropic 特有字段在适配器内经 `providerMetadata` ↔ `providerData` 往返（thinking 签名回传、`cache_control` 断点）；`baseURL` 可省略（默认官方端点），凭据经 `apiKeyEnv` 环境变量名引用。冒烟变量为 `NOCTURNE_SMOKE_ANTHROPIC_*`（workflow.md 第 5 节）。
- **OpenAI 官方 API 将来走 `openai` SDK 的 Responses API**，与 `openai-compatible` 是不同的适配器：兼容只保证 Chat Completions，不保证 Responses / Files / Assistants 等能力。
- 无论底层如何实现，适配器都必须通过同一组契约测试（[provider-api.md](../protocols/provider-api.md) 第 4 节的流式契约）；遇到具体限制时按 ADR-0005 替换传输实现，不改 Core 接口。

各协议的主要差异与处理位置：

| 差异 | 例子 | 处理 |
|---|---|---|
| 工具调用的流式形态 | Chat Completions 按 index 分片传参数；Anthropic 按内容块传 JSON 片段 | 适配器组装为完整 `tool_call` 后再交出 |
| 推理内容 | 部分服务以独立字段返回推理文本；Anthropic 的思考块带签名且必须原样回传 | 统一为 reasoning 内容块；签名等放入 `providerData`，并记录来源 Provider |
| 工具结果的消息形态 | `tool` 角色消息 vs `tool_result` 内容块 | 适配器把中性消息转换为各自格式 |
| 用量字段含义 | 输入 token 是否已包含缓存 token 各家不同 | 适配器换算为统一语义 |
| 错误格式 | HTTP 状态码、错误体结构、限流头 | 适配器映射为 `ProviderError.kind` |

## 5. 不属于 Provider 的事

- **重试**：Provider 只报告错误是否可重试；是否重试、重试几次、何时停止，由 Agent Loop 决定（它知道是否已经输出过内容），见 [agent-loop.md](agent-loop.md)。
- **上下文裁剪**：由 Context Builder 完成；Provider 收到的请求应当已经装得进窗口。
- **工具执行**：Provider 只报告模型想调用什么。

## 6. 暂不设计

Provider 原生工具（服务端网页搜索等）、结构化输出（JSON schema 响应）、多模态输出、账号登录类凭据、按量计费展示。接入时以能力字段与可选请求字段扩展，不改变现有事件。
