# ADR-0061：Gemini 协议与按模型的接口地址

- 状态：已接受（维护者 2026-10-24 确认：地址跟随 models.dev；预设 baseURL 暂不改）
- 日期：2026-10-24

## 背景

[ADR-0031](ADR-0031-opencode-presets-responses.md) §4 按 models.dev 的 `provider.npm` 推导逐模型协议，`@ai-sdk/google` 映射为 `["npm:@ai-sdk/google"]`，模型标为不可用，说明写「Nocturne 暂不支持」。当时只有个别模型受影响。现在：

- OpenCode Zen（`opencode`）有 9 个 Gemini 模型（gemini-3-flash、3-pro、3.1-pro、3.5-flash、3.5-flash-lite、3.6/3.7/3.8-flash、gemini-4-argon），OpenCode Go（`opencode-go`）有 1 个（gemini-4-argon-contributor），全部只走 Google 原生接口 `models/<id>:streamGenerateContent`，在 Nocturne 里都不可用。
- OpenCode 官方文档（[Zen](https://opencode.ai/docs/zen/)、[Go](https://opencode.ai/docs/go/)）已改为按协议分开的地址：`/inference/[go/]openai/v1`（Chat Completions 与 Responses）、`/inference/[go/]anthropic/v1`（Messages）、`/inference/[go/]google/v1beta`（Gemini）。models.dev 也同步改了：服务商级 `api` 是 OpenAI 那一套地址，Gemini 模型的逐模型 `provider.api` 是 Google 那一套地址。
- 2026-10-24 不带密钥实测：
  - 旧地址 `/zen/v1`、`/zen/go/v1` 的 `GET /models`、`/messages` 等仍可用；新地址 `/inference/v1/models`、`/inference/go/v1/models` 也可用。
  - Zen 旧地址下的 `models/gemini-3-flash:streamGenerateContent` 返回 401（缺密钥），说明 Zen 旧地址能走 Gemini。
  - **Go 旧地址下的 `models/gemini-4-argon-contributor:streamGenerateContent` 返回 404**；新地址 `/inference/go/google/v1beta/...` 返回「缺 x-opencode-session」的 400，说明接口存在。

结论：Go 的 Gemini 模型不只是缺协议，还必须换一个地址，不能沿用条目唯一的 `baseURL`。

## 决定

### 1. 新增 Gemini 协议

- 生效协议新增取值 `gemini`，请求 `<地址>/models/<模型>:streamGenerateContent?alt=sse`。条目 `type` 仍只有 `openai-compatible` 与 `anthropic` 两种，`gemini` 与 `openai-responses` 一样只作为模型协议出现。直连 Google AI Studio 的预设不在本 ADR 内，以后另议。
- **推导**：`PROTOCOL_ENDPOINTS` 增加 `gemini: ":streamGenerateContent"`（按末尾比较）。models.dev 映射表把 `@ai-sdk/google` 从「其他」行移出，映射为 `[":streamGenerateContent"]`。推导规则在「含 `/responses`」之后、「不可用」之前加一条：含 `:streamGenerateContent` → `gemini`。上游 `supported_endpoints` 从不包含这个值，所以这条只经 models.dev 或显式声明生效，已有条目行为不变。
- **传输**：用 `@ai-sdk/google`（`createGoogleGenerativeAI({ baseURL, apiKey, headers, fetch })`），版本与现有 `@ai-sdk/*` 依赖的 `@ai-sdk/provider` 对齐。与另外三种协议共用 `streamText` 归一化路径（`ai-sdk-common.ts`），理由同 [ADR-0006](ADR-0006-anthropic-transport.md)：SDK 类型不出适配器，工具参数从 JSON Schema 到 Gemini 所用 OpenAPI 子集的转换、SSE、用量映射都由 SDK 处理。
- **鉴权**：SDK 默认发 `x-goog-api-key`。条目 `headers`、`sessionHeader` 与 User-Agent 照常携带（ADR-0031 §2、§3）。网关是否接受 `x-goog-api-key` 以真实冒烟为准；不接受时在适配器内改发 `Authorization: Bearer`，在本 ADR 补修订记录。
- **思考**：请求 `thinkingConfig.includeThoughts: true`，把思考摘要当作可见推理文本。思考档位按模型声明的档位就近降档（[ADR-0025](ADR-0025-per-model-reasoning.md)），翻译为 `thinkingConfig.thinkingLevel`。档位为 `none`、或适配器无法表达的档位，按现有规则不发，并记 `diagnostics.provider.unsupported_capability`。
- **工具结果里的图片**：首版沿用 openai-compatible 的 `"user-message"` 方式（图片放在工具结果之后的 user 消息里）。实现时如果确认 SDK 能把内容型工具结果转成 Gemini 原生的多模态 `functionResponse`，可以改用 `"native"`，并在实现记录里写明。
- **契约**：适配器必须通过 [provider-api.md](../protocols/provider-api.md) 第 4 节的流式契约，覆盖文本、推理、工具调用（含并行）、用量（含缓存读 `cachedContentTokenCount` 与思考 token `thoughtsTokenCount`）、结束原因与错误映射。另加一条离线测试：全部内置工具的参数声明经 SDK 转换后都能通过。

### 2. 思考签名回传

Gemini 3 起，模型在一步里返回的函数调用（以及部分文本、思考段）带 `thoughtSignature`。下一次请求必须把签名原样带回到对应的部分上；**当前这一轮里的函数调用缺签名，上游直接返回 400**。AI SDK 在流式部件的 `providerMetadata.google.thoughtSignature` 里给出签名，回传时放在对应消息部件的 `providerOptions.google.thoughtSignature` 里。

现有模型只有推理块带 `providerData`（`ContentBlock` 的 reasoning 分支），工具调用和文本块都没有，需要扩展：

- **协议类型**：`ToolCallRef` 增加可选 `providerData?: unknown`；`ContentBlock` 的 text 分支增加可选 `provider?`、`providerData?`，与 reasoning 分支同义。
- **流式事件**：`ModelStreamEvent` 的 `tool_call` 增加可选 `providerData`；文本的签名经新事件 `text_block_data`（只带 `providerData`，由 consumeStream 落到当前文本块）或在 `text_delta` 上附带，二选一在实现时定，写进 provider-api.md。
- **持久化**：都是可选字段，旧版本读取时忽略，不升 `formatVersion`。schema 保持非严格。
- **回传条件**：沿用 [ADR-0026](ADR-0026-per-model-protocol.md) §6「同一服务商且同一协议」。条件不满足时不带签名。
- **缺签名兜底**：当前轮里需要回传的函数调用如果没有签名（例如本轮中途从别的模型切换过来），按 Google 文档给出的占位值填写（文档写的是 `skip_thought_signature_validator`，实现时核实最新写法），记一次 diagnostics。不在 core 里按协议分支：兜底由 Gemini 适配器在转换消息时完成。

只有 Gemini 适配器读写这些 `providerData`；其他适配器忽略，行为不变。

### 3. 按模型的接口地址

- models.dev 快照与缓存里，ADR-0031 §4 收录的服务商（`opencode`、`opencode-go`）在保存 `npm` 的同时保存服务商级与逐模型的 `api`。
- **地址解析顺序**：
  1. 用户在模型编辑里显式写的地址（`userModels.<id>.baseURL`，新增可选字段）；
  2. 条目设了 `modelsDevProvider` 时，models.dev 该模型的 `provider.api`（逐模型缺省时取服务商级 `api`），且这个地址所对应的协议与该模型的生效协议一致；
  3. 条目 `baseURL`。
- 第 2 步的「一致」按 `npm` 判断：models.dev 给的 `api` 是为它的 `npm` 准备的，只有当生效协议就是从这个 `npm` 推导出来的（没有被用户显式改协议）时才采用；用户改了协议，就回落到条目 `baseURL`。
- `GET /models` 仍用条目 `baseURL`，不受影响。
- 这条规则不区分协议，也不认服务商名：它对 OpenCode 的 OpenAI、Anthropic、Gemini 模型一视同仁，效果是 OpenCode 两个预设的全部模型改走官方文档的 `/inference/...` 地址；models.dev 没有 `api`、或快照里查不到该模型时，照旧走条目 `baseURL`。已有条目不需要迁移。
- 诊断与模型详情里显示实际使用的地址和来源（models.dev 还是条目）。

### 4. 界面

- 模型编辑页的「协议」增加「Gemini」，CLI 输入 `gemini`（ADR-0026 §7）。
- 不可用模型的说明文案里不再出现 `@ai-sdk/google`；其余无法识别的包名照旧列出。
- 模型编辑页增加可选的「接口地址」字段（对应 `userModels.<id>.baseURL`），留空表示按第 3 节的顺序自动选择，占位文字显示当前自动选中的地址。

### 5. 兼容

- `message.assistant.protocol` 可能出现 `gemini`。旧版本只做等值比较，按「协议不同」处理。
- `providers.json` 的 `userModels.<id>.protocol` 可能写入 `gemini`、`userModels.<id>.baseURL` 是新字段。降级到旧版本时，旧 schema 不认识，会把整个文件当作无效配置，与 ADR-0031 §6 同属已知的降级限制，在更新日志中注明。

## 已确认的取舍

1. **地址来源用 models.dev 还是写死在预设里**。本 ADR 选 models.dev（第 3 节）：不用迁移已有条目，OpenCode 再换地址时只要 models.dev 跟上就自动生效。代价是依赖 models.dev 数据正确，并且 OpenCode 预设下全部模型都会改走 `/inference/...` 新地址。备选方案见下文。
2. **预设的 `baseURL` 要不要现在就改成 `/inference/...`**。本 ADR 选「暂不改」：旧地址仍可用，`GET /models` 两边都正常，聊天请求已经按第 3 节走新地址。等旧地址下线或官方明确弃用时再改，审查器（`config/reviewer.ts`）里写死的 Zen 地址届时一并改。

## 验收

- 单元与契约测试（离线）：
  - Gemini 适配器通过流式契约；
  - 推导规则与 models.dev 映射（`@ai-sdk/google` → `gemini`，用户显式改协议时不采用 models.dev 地址）；
  - 思考签名：工具调用、文本、推理三处的签名落盘并在同服务商同协议时回传；跨服务商不回传；当前轮缺签名时填占位值并记 diagnostics；
  - 地址解析顺序三档各一条；
  - 全部内置工具参数声明经转换通过。
- 真实冒烟（需密钥，与默认测试集分离）：用维护者的 OpenCode Go 密钥调 gemini-4-argon-contributor，覆盖纯文本、带工具调用的两步对话（验证签名回传）、思考档位。Zen 没有密钥时只核对文档与 401 探测，在验收记录里注明。
- 回归：OpenCode Go 现有的 Chat Completions、Messages、Responses 模型各跑一次冒烟，确认改走新地址后正常。

## 后果

- OpenCode Zen 与 Go 的 Gemini 模型可用；以后加直连 Google AI Studio 的预设只需要新增条目类型或预设，不再动协议层。
- 协议类型与事件多了三处可选的 `providerData`。它们只给适配器用，业务逻辑不得依赖（与 `providerCallId` 同一规则）。
- 地址解析多了一层 models.dev 来源，排查请求地址时要看诊断里写的来源。
- 新增依赖 `@ai-sdk/google`。

## 备选方案

- **预设写死按协议的地址表**（条目新增 `baseURLs: { gemini: …, anthropic: … }`，预设写入）：显式、不依赖 models.dev，但已写进 `providers.json` 的旧条目要迁移，OpenCode 再换地址时还要发版。
- **只给 Gemini 走 models.dev 地址，其他协议不变**：改动最小，但等于按协议写分支，违反「协议差异在适配器内归一化」的约束，也解释不了为什么同一份数据对别的协议不生效。
- **自建 fetch + SSE，不用 `@ai-sdk/google`**：可控，但要自己实现 Schema 转换、签名部件和用量映射，与 ADR-0006 的取舍相反。
