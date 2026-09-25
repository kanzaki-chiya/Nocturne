# Provider API

> 状态：已接受 v0.2 ｜ 设计依据：[providers.md](../architecture/providers.md)、[ADR-0005](../decisions/ADR-0005-own-provider-interface.md) ｜ 代码位置：`packages/core/src/provider/`

本文定义 Provider 适配器必须实现的接口与必须遵守的流式契约。公共类型 `ContentBlock`、`ToolCallRef`、`Usage`、`ModelRef` 定义在 [events.md](events.md) 第 4 节。

## 1. Provider

```ts
interface Provider {
  readonly id: string            // 配置中的名称，如 "deepseek"
  readonly type: string          // 适配器类型，如 "openai-compatible"、"anthropic"
  /** 严格模型清单（默认 true）：models() 非空时清单外模型在 setModel 时拒绝；
      false 时任何模型 id 经 resolve 回退内置目录/保守默认（CLI 用） */
  readonly strictModels?: boolean
  /** 该 Provider 下可用的模型：内置目录 + 用户配置合并的结果 */
  models(): ModelInfo[]
  /** 发起一次流式请求。错误以抛出 ProviderError 的方式报告 */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>
}
```

Provider 实例由 `config` 中的配置创建，Core 通过 `ProviderRegistry.resolve(modelRef)` 取得 `{ provider, model }`。

## 2. 模型与能力

```ts
interface ModelInfo {
  ref: ModelRef                  // { provider, model }
  displayName?: string
  contextWindow: number          // 输入 + 输出共享的窗口大小
  maxOutputTokens?: number       // v0.2 改为可选：未知表示上游未声明（ADR-0016）
  capabilities: ModelCapabilities
  /** v0.2 新增：上游声明的按量价格（USD / 每百万 token）。
      只在上游或配置明确声明时存在；模型选择页依此渲染价格列，
      未声明时界面留空而不是显示估算值（provider-setup.md 第 7 节） */
  pricing?: { input?: number; output?: number }
}

interface ModelCapabilities {
  toolCalls: boolean
  parallelToolCalls: boolean
  reasoning: "none" | "hidden" | "visible"   // 不支持 / 有推理但不返回内容 / 返回推理内容
  reasoningEffort?: ReasoningEffortLevel[]   // 已解析的可用思考档位集合；"off" 恒可用、不在集合中，缺省=不可切换
  imageInput: boolean
  promptCache: boolean
}
```

能力是数据，不是代码分支的依据名单。缺失的能力按保守值处理（不支持）。

`ReasoningEffortLevel` 为 `"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`，加上恒可用的 `"off"` 构成 `ReasoningEffort` 七档（常量定义在 protocol）。`reasoningEffort` 写的是**已解析的可用档位集合**——逐模型声明 > 服务商级 `thinking.levels`（用户声明）> 能力标记推导（`reasoning ≠ "none"` → 标准六档）的优先级折叠在 Provider 构造/解析时完成（[ADR-0018](../decisions/ADR-0018-reasoning-effort.md) 第 2 节）。

## 3. 请求

```ts
interface ModelRequest {
  model: string                   // Provider 内的模型 id
  system: SystemBlock[]
  messages: ModelMessage[]
  tools: ToolSpec[]               // 见 tool-api.md
  /** 强制模型调用指定工具（Phase 6 新增；仅 Subagent 的结束工具兜底使用，subagent.md 第 2 节）。
      适配器映射为服务方的 tool_choice。通用规则：适配器知道自己发出的组合不被服务端
      接受时（如开启思考的服务端只接受 auto/none），丢弃 toolChoice 而不是发出必然
      失败的请求；丢弃在 provider.request 诊断中标注。Subagent 的兜底轮本身不携带
      reasoningEffort，正常路径不触发此规则 */
  toolChoice?: { name: string }
  /** v0.2 改为可选（ADR-0016）：缺省时 openai-compatible 不发送 max_tokens、由上游决定；
      anthropic 协议要求必填，适配器使用兜底值；思考开启时该兜底值须与 thinking.budget_tokens
      协调（抬升 max_tokens 或压低预算，见 ADR-0018 第 3 节） */
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffortLevel    // Runtime 在 Turn 开始时对会话配置就近降档并固定（本 Turn 不变）；"off"/无可用档位时缺省（不发送思考参数）
  cachePrefix?: { systemBlocks: number; messages: number }   // 可缓存前缀的边界提示，适配器自行决定是否使用
  providerOptions?: Record<string, unknown>                  // 请求级 Provider 专有选项，原样交给适配器，Core 不解释
}
```

`providerOptions` 的命名空间由适配器定义：openai-compatible 以 Provider id 为键（`{ "<id>": {...} }`）；anthropic 固定为 `{ anthropic: {...} }`，与 Provider id 无关。适配器把**配置级** `providerOptions`（ProviderConfig）与**请求级** `providerOptions`（ModelRequest）做浅合并后填入该命名空间，请求级覆盖同名键；两者都缺省时不产生该字段。

`reasoningEffort` 是归一化的中性档位，由 Runtime 按会话配置赋值（`"off"` 与无可用档位时该字段缺省）；适配器把它翻译为各自协议的思考参数，Agent Loop / Context 不出现服务商分支：

| thinking-format | 请求体片段（档位为 `high` 示例；`"max"` 等档位原样发送） |
|---|---|
| `openai`（缺省） | `"reasoning_effort": "high"` |
| `openrouter` | `"reasoning": { "effort": "high" }` |
| anthropic（不看 thinking-format） | `"thinking": { "type": "enabled", "budget_tokens": 16384 }` |

- 档位→`budget_tokens` 默认预算表：`minimal 1024 / low 4096 / medium 8192 / high 16384 / xhigh 32768 / max 32768`（条目 `thinking.budgets` 可覆盖）；`max` 是通用最高档而非 Anthropic 专有，openai/openrouter 格式原样发送 `"max"`。
- anthropic 发送前调整 `max_tokens`：要求 `max_tokens ≥ budget_tokens + 1024`，不足先抬 `max_tokens`（封顶模型声明的最大输出长度，未声明无封顶），仍不足则压低预算，预算压到低于 1024 时本轮不发思考参数。
- `off`（或字段缺省）时请求体不含任何思考字段（disable-mode `omit`）。
- 归一化字段与 `providerOptions` 中同义的原生键（`reasoningEffort`、`reasoning`、`thinking`）冲突时，归一化字段胜出。
- 思考开启 + 强制 `toolChoice` 的冲突沿用上文规则（适配器丢弃 `toolChoice` 并记诊断）；子代理兜底轮不携带 `reasoningEffort`，正常路径不触发该规则。

全部细节与理由见 [ADR-0018](../decisions/ADR-0018-reasoning-effort.md)。

```ts
type SystemBlock = { text: string }

type ModelMessage =
  | { role: "user"; content: ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[]; toolCalls: ToolCallRef[] }
  | { role: "tool"; callId: string; name: string; content: string; isError: boolean }
```

工具调用的标识：历史中的工具调用与结果以 Runtime 分配的 `callId` 关联（`ToolCallRef` 见 [events.md](events.md) 第 4 节）。适配器转换为服务协议时，需要为每对调用 / 结果选择一个线上 ID：若该调用来自同一 Provider 且保存了 `providerCallId`，可以使用它；否则使用 `callId`（字符集 `[A-Za-z0-9_-]`，满足主流服务的格式要求）。同一请求内同一对调用与结果必须使用同一个线上 ID。

请求中不包含重试预算、状态回调、追踪上下文等运行时对象；这些由调用方在请求之外处理，保持请求是纯数据。

## 4. 流式事件

```ts
type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; providerData?: unknown }       // providerData：随增量携带的专有数据（如 Anthropic 签名 delta），落到当前推理块
  | { type: "reasoning_block"; text: string; providerData?: unknown }       // 完整推理块（含签名等专有数据时必须提供）
  | { type: "tool_call_delta"; toolCallId: string; name: string; argsDelta: string }   // 可选，仅用于显示
  | { type: "tool_call"; toolCallId: string; name: string; input?: unknown; rawInput?: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason; rawReason?: string }

type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "other"
```

流式契约（适配器必须保证）：

1. 成功的流以且仅以一个 `finish` 结束；`finish` 之后不再有事件。
2. `tool_call` 只在该调用的参数完整后发出。参数 JSON 解析失败时 `input` 为空、`rawInput` 为原文，由工具执行器返回 `invalid_input` 让模型修正，而不是让整个请求失败。
3. `toolCallId` 只保证在一次响应内唯一；Provider 未给出时由适配器生成。它不是跨 Step 的标识：Agent Loop 收到 `tool_call` 后分配会话内唯一的 `callId`，原值保存为 `providerCallId`。
4. `usage` 至多出现一次，语义已换算为统一口径（`inputTokens` 不重复计入缓存 token 等）。
5. 失败时迭代器抛出 `ProviderError`；`signal` 中止时抛出 `name === "AbortError"` 的错误。不使用"错误事件"。
6. 适配器不重试、不裁剪上下文、不执行工具。

流消费的公共包装为首个事件和事件间空闲设置独立超时；超时中止底层请求并抛出 `ProviderError(kind="timeout", retryable=true)`。这改变了静默流的失败语义，决策见 [ADR-0014](../decisions/ADR-0014-stream-timeout-empty-response.md)。适配器自身仍不重试。

## 5. 错误

```ts
class ProviderError extends Error {
  kind:
    | "auth"              // 凭据无效或缺失
    | "rate_limit"
    | "overloaded"
    | "context_overflow"  // 请求超出上下文窗口
    | "invalid_request"   // 请求格式或参数被拒绝
    | "content_filter"
    | "network"
    | "timeout"
    | "server"            // 5xx
    | "unknown"
  retryable: boolean
  retryAfterMs?: number
  status?: number         // HTTP 状态码
  providerMessage?: string   // 原始错误信息（已去除凭据），用于日志与界面
}
```

默认可重试：`rate_limit`、`overloaded`、`network`、`timeout`、`server`。适配器可以根据响应细节修正 `retryable`。Agent Loop 只依据 `kind` 与 `retryable` 决策，不解析 `providerMessage`。

## 6. 演进规则

- 新增能力字段、新增可选请求字段、新增流式事件类型：兼容变更；Agent Loop 必须忽略不认识的流式事件。
- 修改流式契约或错误语义：不兼容变更，需要 ADR。
