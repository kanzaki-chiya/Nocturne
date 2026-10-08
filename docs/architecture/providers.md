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
| `Provider` | 一个模型服务的连接：适配器类型 + 端点 + 凭据，实现 `stream()`；同一服务商条目内的模型可以按模型各自走不同协议（ADR-0026） | 同一种协议（如 OpenAI 兼容）可以连接许多不同的服务 |
| `ModelInfo` | 某个 Provider 下一个模型的描述：id、上下文窗口、最大输出、能力 | 能力属于模型而不是 Provider：同一 Provider 的不同模型差异很大 |
| `ModelCapabilities` | 数据：是否支持工具调用、并行工具调用、推理及其形式、图片输入、提示缓存、可选的推理强度档位 | Context Builder 与 Agent Loop 依据能力做决定，而不是依据名字 |
| `ProviderOptions` | 传给某个 Provider 的专有参数，Core 不解释 | 给高级用户留出口，又不污染中性接口 |

模型能力来自上游、models.dev 裁剪目录与内置的小型目录，用户可以按模型覆盖。models.dev 只在添加服务商或刷新模型列表时更新，本地缓存与内置快照保证离线可用（[ADR-0025](../decisions/ADR-0025-per-model-reasoning.md)）。

模型字段（`displayName`/`contextWindow`/`maxOutputTokens`/`capabilities.*`）的生效值按**逐字段**优先级取（高者覆盖低者，ADR-0025）：逐模型手写配置 > 用户编辑（`userModels`）> 上游声明（`GET /models`）> models.dev > 内置目录 > 默认。只覆盖实际声明的字段；数组字段（`reasoningEffort`）由最高层整体替换，不并集，显式空数组同样生效。models.dev 只取 `reasoning`（true→visible，false→none）、`modalities.input` 是否包含 `image`、`limit.context`、`limit.output`，不取 `attachment`、显示名和价格。模型 ID 依次尝试完全相同、忽略大小写相同、去冒号后缀后末段模型名相同；每步只有唯一候选才匹配，歧义时不猜。`capabilities.editTool` 的「默认」层是按模型 id 末段匹配的内置默认表（不区分大小写：含 `gpt`/`codex` → `apply_patch`，否则 `edit`；ADR-0035 §5）——上游不参与该字段的映射，条目与覆盖未声明且内置目录未命中时才启用。

推理能力只按逐模型声明解析：没有任何层声明 `reasoning`，但有非空 `reasoningEffort` 声明时，视为支持推理；都没有时默认不支持。支持推理时档位取逐模型声明，否则推导六档；推理为 `none` 时没有档位。旧服务商级 `thinking.levels/source` 忽略；读到旧 `levels` 每次启动发 `runtime.warning(provider_thinking_levels_ignored)`。用户编辑设为「否」与手写非空档位冲突时拒绝保存；手写配置自身同时声明 `none` 和非空档位时推理为准，并警告文件、服务商、模型。

**协议来源（[ADR-0026](../decisions/ADR-0026-per-model-protocol.md)）**：每个模型解析一个**生效协议**——`openai-compatible`（请求 `<baseURL>/chat/completions`）、`anthropic`（请求 `<baseURL>/messages`）或 `openai-responses`（请求 `<baseURL>/responses`，[ADR-0031](../decisions/ADR-0031-opencode-presets-responses.md) §1）。解析优先级（高者覆盖低者）：手写 `models.<id>.protocol` > 用户编辑 `userModels.<id>.protocol` > 上游 `supported_endpoints` 推导 > models.dev 服务商层 `endpoints` > 条目 `type`（同时是鉴权与模型列表接口的「本家」协议）。推导按接口路径末尾比较（`/v1/messages` ≡ `/messages`，大小写与尾斜杠不敏感）：条目 `type` 对应接口在列 → `type`；否则含 `/chat/completions` → `openai-compatible`；否则含 `/messages` → `anthropic`；否则含 `/responses` → `openai-responses`；否则（全部无法识别）→ **unavailable**，说明列出无法识别的接口（`npm:<包名>` 标记写 models.dev 专属说明）。上游未声明 `supported_endpoints`（或空数组）不触发推导，回落到条目 `type`。**不得**按模型名或内置目录猜协议。`protocol` 与 `endpoints` 同其他模型字段一样参与逐字段合并。

**models.dev 服务商层接口声明（[ADR-0031](../decisions/ADR-0031-opencode-presets-responses.md) §4）**：条目可选字段 `modelsDevProvider`（models.dev 服务商键，如 `"opencode-go"`）使 models.dev 缓存/快照中该服务商的逐模型 `npm` 原文参与合并——映射为 `endpoints`（`@ai-sdk/openai-compatible` → `/chat/completions`、`@ai-sdk/anthropic` → `/messages`、`@ai-sdk/openai` → `/responses`、其他 → `npm:<包名>` 标记为不可用）并作为 models.dev 层（最低层）声明。逐模型缺省时取服务商级 `npm`；服务商表内查不到的模型不贡献 `endpoints`、回落条目 `type`。快照与缓存只收录内置预设引用的服务商键（`MODELS_DEV_PROVIDER_KEYS`），数据为 api.json 的服务商级与逐模型 `provider.npm` 原文；没有该块的旧缓存仍然有效。

## 3. 配置形态（示意）

```jsonc
{
  "model": "gateway/deepseek-chat",           // <providerId>/<modelId>
  "providers": {
    "gateway": {
      "type": "openai-compatible",              // 默认协议与鉴权本家（ADR-0026）
      "baseURL": "https://api.example.com/v1",
      "apiKeyEnv": "GW_API_KEY",               // 只引用环境变量名，不在配置里写密钥
      "models": {
        "deepseek-chat": { "contextWindow": 128000 },
        // 手写协议：同一条目内该模型改走 <baseURL>/messages（x-api-key + Bearer 双发）
        "claude-opus-4.6": { "protocol": "anthropic" },
        // 上游接口原文（supported_endpoints），据此推导生效协议
        "some-model": { "endpoints": ["/v1/chat/completions", "/v1/messages"] }
      },
      "providerOptions": {},                     // 配置级选项，与请求级合并后传给适配器（provider-api.md §3）
      "sessionHeader": "x-opencode-session",      // 可选：会话标识请求头名（ADR-0031 §3，见第 4 节）
      "modelHeader": "x-grok-model-override",      // 可选：把本次模型 id 写入该请求头（ADR-0042）
      "auth": { "kind": "apiKey" },                 // 可省略；非 apiKey 只在用户级生效（config.md 第 1 节）
      "modelsDevProvider": "opencode-go",          // 可选：models.dev 服务商键（ADR-0031 §4，见第 2 节）
    }
  }
}
```

凭据只从环境变量或用户级凭据存储读取，不写入会话日志、事件或普通日志。`auth` 与协议分开：省略等同 `{ "kind": "apiKey" }`；`openai-siwc`、`xai-oauth2` 与 `external-file` 的字段、用户级限制和请求约束见 [ADR-0042](../decisions/ADR-0042-provider-oauth.md) 与 [ADR-0043](../decisions/ADR-0043-grok-build-oauth.md)。交互式配置见 [provider-setup.md](provider-setup.md)。

思考强度档位（[ADR-0025](../decisions/ADR-0025-per-model-reasoning.md)）：中性档位集合为 `off | minimal | low | medium | high | xhigh | max`。每个模型的可用档位按上段规则解析；`ModelRequest.reasoningEffort` 由 Runtime 按会话配置就近降档赋值。适配器把档位翻译为 `reasoning_effort`（openai 格式）、`reasoning.effort`（openrouter 格式）或 `thinking.budget_tokens`（anthropic）；`thinking.format` 与 `thinking.budgets` 保留。`providerOptions` 中的原生推理键仍可直传，与归一化字段同义时归一化字段胜出；子代理兜底轮不携带 `reasoningEffort`。

## 4. 适配器

条目可声明用户级 `auth`（省略等同 `apiKey`）及 `modelHeader`。适配器只认 `AuthResolver`，不按服务商名分支。主对话、子代理、模型角色、审查器、压缩摘要和 `fetchModels` 共用同一解析器。响应流开始前的 401 调用 `invalidate()` 后重发一次，仍失败则为不可重试的 `auth`。`external-file` 按 mtime 缓存，只读指定 JSON 路径；失效后重读一次，失败提示 `renewHint`，不复制到 Nocturne 凭据库。`xai-oauth2` 自己持有可刷新的访问令牌，请求仍走 OpenAI 兼容 Chat Completions，不另加 Responses 约束。`openai-siwc` 向 Responses 适配器提供一份请求约束声明：固定 `store: false`、`stream: true`，不发 `max_output_tokens` 等通道禁用字段，system 改为 `instructions`，function 工具放入 namespace，只有 `response.completed` 算成功；`{detail}` 与 `{error:{code}}` 都归一化，额度用完不重试。完整字段与错误表见 [ADR-0042](../decisions/ADR-0042-provider-oauth.md) 第 3–5 节和 [ADR-0043](../decisions/ADR-0043-grok-build-oauth.md)，接口见 [provider-api.md](../protocols/provider-api.md) 第 5 节。

| 适配器 | 覆盖 | 阶段 | 传输实现 |
|---|---|---|---|
| `openai-compatible`（Chat Completions） | DeepSeek、GLM、OpenRouter、Ollama / vLLM / LM Studio 等 OpenAI 兼容服务 | Phase 1 | `@ai-sdk/openai-compatible`（peer: `ai`） |
| `openai-responses`（Responses API） | OpenAI Responses 兼容服务（OpenCode Go 的 GPT/Grok 系等只声明 `/responses` 的模型） | Phase 2 | `@ai-sdk/openai`（peer: `ai`），见 [ADR-0031](../decisions/ADR-0031-opencode-presets-responses.md) |
| `anthropic`（Messages） | Anthropic 及兼容 Anthropic 协议的服务 | Phase 2 | `@ai-sdk/anthropic`（peer: `ai`），见 [ADR-0006](../decisions/ADR-0006-anthropic-transport.md) |
| `gemini` | Google Gemini | 按需 | 待定 |

传输实现的理由与约定：

- **`openai-compatible` 用 `@ai-sdk/openai-compatible`**：该包专为"实现 `/v1/chat/completions` 的第三方服务"设计，已处理 SSE 边界、按 `index` 分片的 `tool_calls` 组装、用量与错误体归一化；流式请求固定带 `stream_options.include_usage`（Grok 代理等服务不带就不返回用量）；自托管 / 中转兼容服务是它的明示使用场景。SDK 类型只存在于适配器内部，不泄漏到 Core（ADR-0005）。已知风险是各家在推理字段（`reasoning_content` 等）、用量口径、错误体结构上的差异不一定全部透传——契约测试与真实服务冒烟测试用于检验这一点；若暴露拿不到必需字段的限制，退路是适配器内自建 `fetch` + SSE 解析（不引第三方 SDK）。
- **`anthropic` 用 `@ai-sdk/anthropic`**（[ADR-0006](../decisions/ADR-0006-anthropic-transport.md)）：与 openai-compatible 共用 `streamText` / `TextStreamPart` 归一化路径。Anthropic 特有字段在适配器内经 `providerMetadata` ↔ `providerData` 往返（thinking 签名回传）；提示缓存按请求的 `cachePrefix` 打两个 `cache_control` 断点：system 末尾（连同其前的工具规格）与前缀内最后一条消息，没有 `cachePrefix` 时不打（Messages API 只缓存显式断点之前的前缀，其他协议由服务商自动缓存）；`baseURL` 可省略（默认官方端点），凭据经 `apiKeyEnv` 环境变量名引用。冒烟变量为 `NOCTURNE_SMOKE_ANTHROPIC_*`（workflow.md 第 5 节）。
- **`openai-responses` 用 `@ai-sdk/openai` 的 Responses 模型**（`provider.responses(id)`，[ADR-0031](../decisions/ADR-0031-opencode-presets-responses.md) §1）：与另外两种协议共用 `streamText` 归一化路径；请求发送 `store: false`（无状态，每次带完整历史，不使用 `previous_response_id`），推理项以 `include: ["reasoning.encrypted_content"]` 取回加密内容并经 `providerMetadata` ↔ `providerData` 往返；`reasoningEffort` 档位翻译为 `reasoning.effort` 并请求 `reasoning.summary: "auto"`（推理摘要当作可见推理文本，同一推理项的多段摘要合并为一个推理块、段间补空行）；请求带 `sessionId` 时作为 `prompt_cache_key` 发送（无状态下缓存只按前缀命中，同一会话同一个键才会路由到同一缓存分片；请求级 `promptCacheKey` 已给时不覆盖）；鉴权只发 `Authorization: Bearer`（`anthropic` 条目下也一样），条目级 `providerOptions` 不交给它。
- 无论底层如何实现，适配器都必须通过同一组契约测试（[provider-api.md](../protocols/provider-api.md) 第 4 节的流式契约）；遇到具体限制时按 ADR-0005 替换传输实现，不改 Core 接口。

各协议的主要差异与处理位置：
Anthropic 条目的默认地址固定为官方 `https://api.anthropic.com/v1`，不读 `ANTHROPIC_BASE_URL` 等 SDK 环境变量；要改地址，在条目里写 `baseURL`。凭据仍由 Nocturne 的凭据解析器按配置读取。

| 差异 | 例子 | 处理 |
|---|---|---|
| 工具调用的流式形态 | Chat Completions 按 index 分片传参数；Anthropic 按内容块传 JSON 片段 | 适配器组装为完整 `tool_call` 后再交出 |
| 推理内容 | 部分服务以独立字段返回推理文本；Anthropic 的思考块带签名且必须原样回传 | 统一为 reasoning 内容块；签名等放入 `providerData`，并记录来源 Provider |
| 工具结果的消息形态 | `tool` 角色消息 vs `tool_result` 内容块 | 适配器把中性消息转换为各自格式 |
| 用量字段含义 | 输入 token 是否已包含缓存 token 各家不同 | 适配器换算为统一语义 |
| 错误格式 | HTTP 状态码、错误体结构、限流头 | 适配器映射为 `ProviderError.kind` |

**条目级路由（[ADR-0026](../decisions/ADR-0026-per-model-protocol.md)）**：每个服务商条目仍是一个 `Provider` 实例（`id`/`type` 语义不变），实例内部按需构造 `openai-compatible`、`anthropic` 与 `openai-responses` 三种适配器并复用，共用凭据解析器、`headers` 与诊断通道；`stream()` 按请求模型的生效协议分发（第 2 节）。三种协议共用同一条目的 `baseURL`：`anthropic` 请求 `<baseURL>/messages`（条目省略 `baseURL` 时用官方 `https://api.anthropic.com/v1`），`openai-compatible` 请求 `<baseURL>/chat/completions`、`openai-responses` 请求 `<baseURL>/responses`（条目未声明 `baseURL` 时两者都以 `ProviderError(kind="invalid_request")` 拒绝，不发请求）。

跨协议的鉴权写法：鉴权以条目 `type` 为「本家」——`anthropic` 条目本家发 `x-api-key`（不发 `Authorization`，避免官方端点将其当 OAuth 令牌），`openai-compatible` 条目本家发 `Authorization: Bearer`；`openai-compatible` 条目下的 `anthropic` 协议请求**同时携带** `x-api-key` 与 `Authorization: Bearer`（`anthropic-version` 由 SDK 注入）；`openai-responses` 协议请求无论条目 `type` 都只发 `Authorization: Bearer`（ADR-0031 §1）。条目级 `providerOptions` 只交给与条目 `type` 同协议的请求。推导为 `unavailable` 的模型照常出现在清单中（`ModelInfo.unavailable`），选择或请求时以同一说明拒绝、不发 HTTP（ADR-0026 §5）。`message.assistant` 事件记录产生该消息时的协议；上下文回传 Provider 专有数据（`providerData`）要求「同一服务商且同一协议」（context.md 第 7 节）。

**请求头（[ADR-0031](../decisions/ADR-0031-opencode-presets-responses.md) §2/§3）**：三种协议的模型请求与 `fetchModels` 都携带 `User-Agent: nocturne/<version>`（版本为 Core 的 `NOCTURNE_VERSION`，SDK 追加的后缀保留）；条目 `headers` 中同名的 `User-Agent`（大小写不敏感）优先。条目可选字段 `sessionHeader` 声明一个会话标识请求头名（如 `x-opencode-session`）：适配器仅在「`ModelRequest.sessionId` 非空且条目声明了 `sessionHeader`」时写该头，值为 `sessionId`；条目 `headers` 已有同名头时以静态值为准。`sessionId` 由 Runtime 填入根会话 ID（provider-api.md 第 3 节），适配器不生成、不缓存、不修改它；`fetchModels` 属于服务商级请求，永远不写会话头。

Responses 组装请求时只回传带非空 `providerData.openai.itemId` 的推理块，保留原标识、摘要与 `reasoningEncryptedContent`；其他推理块在适配器内丢弃，不交给 SDK。丢弃时每次请求记录一条 `provider.reasoning_dropped` 诊断，仅含数量和缺少标识的原因，不记录正文、不发 `runtime.warning`。

## 5. 不属于 Provider 的事

- **重试**：Provider 只报告错误是否可重试；是否重试、重试几次、何时停止，由 Agent Loop 决定（它知道是否已经输出过内容），见 [agent-loop.md](agent-loop.md)。
- **上下文裁剪**：由 Context Builder 完成；Provider 收到的请求应当已经装得进窗口。
- **工具执行**：Provider 只报告模型想调用什么。

## 6. 暂不设计

Provider 原生工具（服务端网页搜索等）、结构化输出（JSON schema 响应）、多模态输出、按量计费展示。官方未开放给第三方的订阅登录（如 Claude.ai）不接入（[ADR-0042](../decisions/ADR-0042-provider-oauth.md) 第 1 节）。接入时以能力字段与可选请求字段扩展，不改变现有事件。
