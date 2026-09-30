# ADR-0031：OpenCode Zen / Go 预设、Responses 协议与会话标识请求头

- 状态：已接受（维护者 2026-09-30 确认：Responses 本轮一并接入；自定义预设向导增加会话标识请求头选项）
- 日期：2026-09-30

## 背景

维护者用「其他 OpenAI 兼容」接入 OpenCode Go 后，请求被拒：`Request is missing x-opencode-session and cannot be routed efficiently`。[Go 文档](https://opencode.ai/docs/go/#where-can-i-use-it)「Where can I use it?」一节对第三方编程代理有两条要求：

- 用自己的 User-Agent 标识自己（例如 `my-coding-agent/1.0`），不能是通用 SDK 或 HTTP 库的名字；
- 每个对话在 `x-opencode-session` 里发送一个稳定的会话 ID，用于路由与提示缓存。

Nocturne 目前两条都不满足：请求头里只有 AI SDK 的默认 User-Agent；条目的 `headers` 是静态值，表达不了「每个会话一个值」。

第二个问题是协议。Go（`https://opencode.ai/zen/go/v1`）与 Zen（`https://opencode.ai/zen/v1`）的模型分别走 `/chat/completions`、`/messages`、`/responses` 三种接口，但两者的 `GET /models` 只返回 `{id, object, created, owned_by}`，没有 `supported_endpoints`。按 [ADR-0026](ADR-0026-per-model-protocol.md)，这些模型全部回落到条目 `type`，于是 GPT、Grok、muse-spark 等只支持 Responses 的模型被当成 Chat Completions 发送，必然失败。Go 的 33 个模型里有 7 个只走 `/responses`，ADR-0026 暂缓的 Responses 协议已经不能再缓。

models.dev 现已收录 `opencode`（Zen）与 `opencode-go` 两个服务商，逐模型给出 `provider.npm`（`@ai-sdk/openai` 表示 Responses，`@ai-sdk/anthropic` 表示 Messages，缺省继承服务商级 `@ai-sdk/openai-compatible` 表示 Chat Completions）。与官方文档的端点列表逐一核对一致。这是限定在某个服务商内部的逐模型声明，与 ADR-0026 排除的「服务商级协议信息」不同。

## 决定

### 1. 新增 Responses 协议

- 生效协议新增取值 `openai-responses`，请求 `<baseURL>/responses`。条目 `type` 仍只有 `openai-compatible` 与 `anthropic` 两种，Responses 只作为模型协议出现，不新增服务商类型。
- **推导规则**（ADR-0026 §2）在「含 `/messages`」之后、「不可用」之前加一条：列表含 `/responses` → `openai-responses`。有 Chat Completions 的模型仍优先走 Chat Completions，已有条目行为不变。
- **传输**：用 `@ai-sdk/openai` 的 Responses 模型（`provider.responses(id)`），与另外两种协议共用 `streamText` 归一化路径（`ai-sdk-common.ts`）。取代 [providers.md](../architecture/providers.md) 第 4 节「将来用 `openai` 官方 SDK」的设想，理由同 [ADR-0006](ADR-0006-anthropic-transport.md)：共用一条归一化路径，SDK 类型不出适配器。
- **无状态**：每次请求带完整历史，发送 `store: false`，不使用 `previous_response_id`。推理项通过 `include: ["reasoning.encrypted_content"]` 取回加密内容，放进推理块的 `providerData` 原样回传；回传条件沿用 ADR-0026 §6「同一服务商且同一协议」。
- **鉴权**：只发 `Authorization: Bearer`，`anthropic` 条目下也一样。条目 `headers` 照常携带；条目级 `providerOptions` 不交给 Responses 请求（它不是条目 `type` 对应的协议，ADR-0026 §3）。
- **思考档位**：翻译为 `reasoning.effort`（按模型声明的档位就近降档，[ADR-0025](ADR-0025-per-model-reasoning.md)），并请求 `reasoning.summary: "auto"`，把推理摘要当作可见推理文本。适配器无法表达的档位按现有规则丢弃，并记 `diagnostics.provider.unsupported_capability`。
- **流式契约**：Responses 适配器与另外两个一样，必须通过 [provider-api.md](../protocols/provider-api.md) 第 4 节的契约测试，覆盖文本、推理、工具调用（含并行）、用量（含缓存读与推理 token）、结束原因与错误映射。
- **界面**：模型编辑页的「协议」字段增加选项「Responses」，CLI 输入 `responses`（ADR-0026 §7）。不可用模型的说明文案去掉「暂不支持 /responses」的说法，改为列出无法识别的接口。

### 2. 统一 User-Agent

所有 Provider 请求（三种协议的 `stream` 以及 `fetchModels`）的 `User-Agent` 以 `nocturne/<version>` 开头，版本号与 Runtime 报告的 Nocturne 版本一致。AI SDK 在其后追加的 `ai-sdk/...` 后缀保留。这是通用行为，不按服务商区分。条目 `headers` 里如果写了 `User-Agent`（不区分大小写），以用户的写法为准。

### 3. 会话标识请求头

- **条目字段**：新增可选的 `sessionHeader: string`，值为请求头名称，例如 `"x-opencode-session"`。它进入条目 schema，`config.json` 与 `providers.json` 都能写。未声明时不发送任何会话头。
- **请求字段**：`ModelRequest` 新增可选的 `sessionId?: string`，是不透明数据，Core 不解释。Runtime 为它构造的每个模型请求填入会话 ID，包括主 Turn、上下文压缩和子代理兜底轮。子代理请求填**根会话**的 ID，保证「一个对话一个 ID」。恢复会话后沿用原 ID，因为会话 ID 本身不变。
- **发送**：条目路由 Provider 把 `sessionHeader` 交给三种适配器。请求带 `sessionId` 且条目声明了 `sessionHeader` 时，适配器把 `<sessionHeader>: <sessionId>` 写进该次请求的请求头；两者缺一就不写。`fetchModels` 不属于任何会话，不发送。条目 `headers` 里如果已有同名头，以静态值为准。
- **边界**：Agent Loop 与 Context 只负责把会话 ID 放进 `ModelRequest`，对所有 Provider 一视同仁，不知道哪个服务商需要它。会话 ID 按原样发送；它形如 `202609301230-1a2b3c4d`，只含创建时间与随机数，不含路径或用户信息。
- **自定义入口**：「其他 OpenAI 兼容」与「其他 Anthropic 兼容」两个预设的向导，在服务地址之后增加一步可选输入「会话标识请求头」，说明小字为「部分网关要求每个对话带固定的会话 ID，填请求头名称，例如 x-opencode-session；留空不发送」，直接回车跳过。内置预设不问这一步，由预设写死。

### 4. models.dev 按服务商提供接口声明

- **条目字段**：新增可选的 `modelsDevProvider: string`，值为 models.dev 的服务商键，例如 `"opencode-go"`。只影响本条目。
- **数据**：models.dev 的裁剪快照与本地缓存新增按服务商保存的接口信息。只收录内置预设引用的服务商键（首版为 `opencode` 与 `opencode-go`），保存服务商级与逐模型的 `npm` 原文。刷新时机与失败回退沿用 ADR-0025：添加服务商或刷新模型列表时更新，离线时用缓存或快照。
- **映射**：解析时把 `npm` 翻译为 `endpoints`，作为 models.dev 层的声明，参与 ADR-0025 的逐字段合并，优先级低于上游：

  | `npm`（逐模型缺省时取服务商级） | `endpoints` |
  |---|---|
  | `@ai-sdk/openai-compatible` | `["/chat/completions"]` |
  | `@ai-sdk/anthropic` | `["/messages"]` |
  | `@ai-sdk/openai` | `["/responses"]` |
  | 其他（如 `@ai-sdk/google`） | `["npm:<包名>"]` |

  最后一行无法被推导规则识别，模型标为不可用，说明写「models.dev 标注该模型使用 <包名> 对应的接口，Nocturne 暂不支持」。
- **不在表中的模型**：条目 `modelsDevProvider` 下查不到的模型，不从 models.dev 取接口，回落到条目 `type`。本 ADR 不改变 models.dev 层其他字段（推理、看图、上下文、输出）的匹配方式。
- ADR-0026「models.dev 不提供协议」的限制针对的是全局按模型 ID 匹配。限定服务商键之后，数据是逐模型的，不再适用这条限制。

### 5. 两个内置预设

| 预设 | 显示名 | `type` | `baseURL` | `sessionHeader` | `modelsDevProvider` |
|---|---|---|---|---|---|
| `opencode-zen` | OpenCode Zen | `openai-compatible` | `https://opencode.ai/zen/v1` | `x-opencode-session` | `opencode` |
| `opencode-go` | OpenCode Go | `openai-compatible` | `https://opencode.ai/zen/go/v1` | `x-opencode-session` | `opencode-go` |

两个预设都能获取模型列表，默认环境变量为 `OPENCODE_API_KEY`，密钥入口取官方文档给出的控制台地址（实现时核实）。Zen 文档目前没有写出会话头要求，但它与 Go 是同一套网关，带上无害，也便于路由与缓存。已有的手动条目不迁移；用户可以删除后改用预设重新添加，或手写 `sessionHeader` 与 `modelsDevProvider`。

预设门槛（「服务地址与协议兼容性有官方文档可查，并实测过连接」）由维护者的 Go 密钥实测完成；Zen 如无密钥可测，在验收记录里注明只核对了文档。

### 6. 会话历史与配置兼容

- `message.assistant.protocol` 可能出现新值 `openai-responses`。该字段只做等值比较，旧版本读到时按「协议不同」处理，不升 `formatVersion`。
- `providers.json` 中 `userModels.<id>.protocol` 可能写入 `openai-responses`。降级到旧版本时，旧版本的 schema 不认识这个值，会把整个文件当作无效配置。这是已知的降级限制，在更新日志中注明。

## 验收

- **单元与契约测试**（离线）：
  - Responses 适配器通过流式契约；
  - 推导新增分支、`npm` → `endpoints` 映射，以及 models.dev 层与上游层的优先级；
  - 三种协议的请求都带 `User-Agent: nocturne/<version>…`，用户在 `headers` 里写的 UA 优先；
  - `sessionHeader` 与 `sessionId` 同时存在时三种协议都带会话头，缺一不带；子代理用根会话 ID；`fetchModels` 不带；
  - 自定义预设向导的可选步骤：留空不写字段；
  - 两个新预设写出的条目字段完整。
- **真实服务冒烟**（缺变量时跳过）：新增 `NOCTURNE_SMOKE_OPENCODE_*` 变量，用 Go 密钥各选一个 Chat Completions、Messages、Responses 模型完成一轮带工具调用的对话，请求不再报 `missing x-opencode-session`。
- **维护者手测**：在 Windows Terminal 用 OpenCode Go 预设添加服务商，刷新后 GPT 系模型显示为可用，并能完成多轮对话（含推理回传）。
- **文档同步**：
  - [providers.md](../architecture/providers.md)：协议取值、推导规则、适配器表、models.dev 服务商层、UA 与会话头；
  - [provider-api.md](../protocols/provider-api.md)：`ModelRequest.sessionId`、Responses 协议；
  - [provider-setup.md](../architecture/provider-setup.md)：预设列表、自定义预设的可选步骤；
  - [config.md](../architecture/config.md)：条目新字段（若条目字段在别处有主文档，则写在那里，config.md 只链接）；
  - [events.md](../protocols/events.md)：`protocol` 新取值；
  - [tui.md](../apps/tui.md) 与 [cli.md](../apps/cli.md)：编辑页协议选项；
  - [workflow.md](../development/workflow.md)：冒烟变量；
  - 路线图条目、[decisions/README.md](README.md)；
  - ADR-0026 追加一条修订，指向本 ADR。

## 后果

- **正面**：
  - OpenCode Zen / Go 开箱可用，三种协议的模型都能选；
  - Responses 协议接入后，command code 等聚合服务里只声明 `/responses` 的模型也随之可用；
  - `sessionHeader` 是通用机制，以后别的网关提出同类要求时只需声明一个字段。
- **负面**：
  - 新增一个 SDK 依赖（`@ai-sdk/openai`）和一个适配器需要维护；
  - models.dev 快照多了按服务商的一小块数据；opencode 的模型更新依赖 models.dev 跟进，没跟进时新模型回落到 Chat Completions，需用户在编辑页手动改协议；
  - 降级到旧版本时，写过 `openai-responses` 的 `providers.json` 无法读取。
- **约束**：
  - 会话头的值只能来自 `ModelRequest.sessionId`，适配器不得自行生成或缓存会话 ID；
  - `modelsDevProvider` 只提供接口声明，不能用来推导套餐是否可用。

## 备选方案

- **让用户在 `headers` 里手写会话头**：静态值无法随会话变化，所有对话共用一个 ID，违背「每个对话一个稳定 ID」，也会打乱对方的路由与缓存。
- **按服务商 ID 或地址识别 OpenCode 并硬编码会话头**：违反「不按 Provider 写分支」的约束，自定义网关也用不上。
- **内置一张手写的 OpenCode 模型协议表**：模型更新时需要随版本发布才能跟进，models.dev 已有同样的数据并且可以刷新。
- **Responses 继续暂缓，只标「协议不支持」**：Go 里 7 个模型（GPT、Grok、muse-spark 系）不能用，预设的价值大打折扣。
- **Responses 用 `openai` 官方 SDK**：需要另写一套流式归一化；`@ai-sdk/openai` 与现有两个适配器共用路径，契约测试也能复用。
- **有状态 Responses（`store: true` + `previous_response_id`）**：依赖服务端保存历史，与本地事件日志作为唯一事实来源的设计冲突，第三方网关对它的支持也不确定。
