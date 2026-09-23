# 事件协议（Event Protocol）

> 状态：已接受 v0.2 ｜ 设计依据：[sessions.md](../architecture/sessions.md)、[ADR-0003](../decisions/ADR-0003-session-event-log.md) ｜ 代码位置（计划）：`packages/core/src/protocol/`

本文是事件类型与字段的唯一主文档。修改任何事件，先改本文。

## 1. 核心结论

| 问题 | 结论 |
|---|---|
| Event 是不是事实来源？ | 持久化事件是会话的唯一事实来源；临时事件不是 |
| 是否持久化？ | 按类型区分：持久化事件写入会话日志；临时事件只发布 |
| 是否 append-only？ | 是。任何更正都以新事件表达 |
| 序号？ | 持久化事件独占会话内连续递增的 `seq`（1, 2, 3, …，无空洞）。临时事件不占用 `seq`，使用本次运行的 `runId` 与运行内序号 `eseq` |
| 需要 event id 吗？ | 不需要。持久化事件由 `(sessionId, seq)` 唯一标识；临时事件由 `(sessionId, runId, eseq)` 唯一标识 |
| 需要 parent id 吗？ | 不需要。关联用有类型的字段（`turnId`、`messageId`、`callId`、`requestId`） |
| 需要 correlation id 吗？ | `turnId` 关联一次 Turn 内的所有事件；跨会话的 `traceId` 在引入 Subagent 时以可选字段加入 |
| Tool Call 如何关联？ | Runtime 为每个工具调用分配会话内唯一的 `callId`，贯穿所有生命周期事件；Provider 给出的原始 ID 保存在 `providerCallId` 中，仅用于回传 Provider |
| Message 与 Event 的关系？ | 消息就是事件：`message.user`、`message.assistant` 本身就是会话中的消息记录，工具结果就是 `tool.completed`。没有另一张消息表 |
| Session state 如何得到？ | 由持久化事件折叠重建；MVP 不做快照 |
| CLI/TUI 消费什么？ | CLI（行式输出）直接消费事件；TUI 等需要整体视图的客户端使用 `protocol` 提供的纯函数 reducer 派生视图（Phase 4 加入）；远程客户端先按 `seq` 回放持久化事件，再接收实时事件 |

## 2. 事件信封

```ts
/** 持久化事件：写入日志 */
interface DurableEvent<T extends DurableType = DurableType> {
  type: T
  sessionId: string
  seq: number          // 会话内从 1 开始连续递增；日志中出现空洞或倒序即视为损坏
  time: string         // ISO 8601
  turnId?: string      // 属于某个 Turn 的事件必须携带
  payload: DurablePayload<T>
}

/** 临时事件：只发布，不写日志 */
interface EphemeralEvent<T extends EphemeralType = EphemeralType> {
  type: T
  sessionId: string
  runId: string        // 本次打开会话时生成（每次恢复都不同）
  eseq: number         // 运行内从 1 开始递增
  afterSeq: number     // 发出时最后一个持久化事件的 seq，用于与持久化事件对齐顺序
  time: string
  turnId?: string
  payload: EphemeralPayload<T>
}

type RuntimeEvent = DurableEvent | EphemeralEvent
```

为什么拆开序号：若临时事件也占用永久序号，进程在发出临时事件 101～130 后崩溃，仅凭日志（最后是 100）无法得知 101～130 已被使用，恢复后再次分配会破坏唯一性。让持久化序号只由日志决定，恢复后从"最后一个有效 `seq` + 1"继续即可，不需要额外的高水位记录。

字段取舍：

| 字段 | MVP | 说明 |
|---|---|---|
| `type`、`sessionId`、`time`、`payload` | 必须 | |
| `seq`（持久化）/ `runId` + `eseq` + `afterSeq`（临时） | 必须 | 见上 |
| `turnId` | 必须（Turn 内事件） | 会话级事件（如 `session.created`）没有 |
| `messageId`、`callId`、`requestId` | 放在 payload | 只对相关事件有意义 |
| 日志格式版本 | 在 `session.created.formatVersion` | 整个日志共用 |
| `eventId`、`parentId` | 不需要 | 见第 1 节 |
| `traceId`、`spanId` | 以后可选加入 | 兼容变更 |

## 3. 事件类型

### 3.1 持久化事件

| 类型 | turnId | payload |
|---|---|---|
| `session.created` | — | `formatVersion`、`nocturneVersion`、`cwd`、`workspaceRoot`、`model: ModelRef`、`permissionPreset` |
| `session.config_changed` | — | 变化的字段：`model?`、`permissionPreset?` |
| `turn.started` | ✓ | `turnIndex` |
| `message.user` | ✓ | `messageId`、`content: ContentBlock[]` |
| `message.assistant` | ✓ | `messageId`、`model: ModelRef`、`content: ContentBlock[]`、`toolCalls: ToolCallRef[]`、`usage?: Usage`、`finishReason: FinishReason \| "aborted"` |
| `tool.started` | ✓ | `callId`、`name`、`input`（规范化后）、`subjects: PermissionSubject[]`（解析后）、`permission: { action, source }` |
| `permission.requested` | ✓ | `requestId`、`callId`、`subjects`、`reason`、`options` |
| `permission.resolved` | ✓ | `requestId?`、`callId`、`action: "allow" \| "deny"`、`source: "user" \| "rule" \| "grant" \| "non_interactive" \| "cancelled"`、`rule?`、`remember?`、`feedback?` |
| `tool.completed` | ✓ | `callId`、`name`、`status`、`modelContent`、`output?`、`error?`、`truncated?`、`durationMs?` |
| `context.compacted` | ✓ 或 — | `kind: "prune" \| "summary"`、`throughSeq`、`summary?`（规则见 [context.md](../architecture/context.md) 第 6 节） |
| `turn.completed` | ✓ | `reason`、`steps`、`usage`、`error?`、`recovered?` |

`tool.completed.status`：`ok`、`error`、`denied`、`cancelled`、`interrupted`（仅恢复修复产生）。

`turn.completed.reason`：

| reason | 含义 |
|---|---|
| `done` | 模型以 `stop` 结束且没有工具调用 |
| `truncated` | 模型输出达到长度上限（`length`） |
| `refused` | 内容被 Provider 过滤（`content_filter`） |
| `aborted` | 用户中断，或在权限确认中选择"拒绝并停止" |
| `max_steps` | 达到单 Turn 步数上限 |
| `error` | 不可恢复的错误：Provider 错误重试耗尽、意外的结束原因、压缩失败、Runtime 内部错误。恢复修复补写的 Turn 也使用 `error`，`error.code = "process_exited"`，`recovered: true` |

`permission.resolved` 在以下情况发出：经过用户确认的请求（有 `requestId`）；被规则直接拒绝的调用；由会话或项目授权放行原本需要确认的调用（`source: "grant"`）。规则直接允许的调用不单独发事件，其决定记录在 `tool.started.permission` 中。

### 3.2 临时事件

| 类型 | turnId | payload |
|---|---|---|
| `message.assistant.delta` | ✓ | `messageId`、`kind: "text" \| "reasoning"`、`delta` |
| `tool.input.delta` | ✓ | `callId`、`name`、`delta`（参数 JSON 片段，仅供显示） |
| `tool.progress` | ✓ | `callId`、`stream: "stdout" \| "stderr" \| "info"`、`chunk` |
| `runtime.status` | ✓ 或 — | `status: "idle" \| "thinking" \| "running_tool" \| "waiting_permission" \| "retrying" \| "compacting" \| "failed"` |
| `provider.retry` | ✓ | `attempt`、`maxAttempts`、`delayMs`、`error: { kind, message }` |
| `runtime.warning` | ✓ 或 — | `code`、`message` |
| `runtime.error` | ✓ 或 — | `code`、`message`（例如日志写入失败导致会话进入 `failed` 状态） |

临时事件的信息要么包含在随后的持久化事件中（增量 → 完整消息），要么是可丢弃的状态提示。客户端丢失临时事件不影响正确性。

## 4. 公共数据类型

```ts
type ModelRef = { provider: string; model: string }

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; provider?: string; providerData?: unknown }

type ToolCallRef = {
  callId: string            // Runtime 分配，会话内唯一，字符集 [A-Za-z0-9_-]
  providerCallId?: string   // Provider 返回的原始 ID，只保证在一次响应内唯一
  name: string
  input?: unknown           // 参数解析失败时为空
  rawInput?: string         // 参数解析失败时的原文
}

type Usage = {
  inputTokens: number; outputTokens: number
  cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number
}

/** 解析后的权限主体，见 permissions.md */
type PermissionSubject = {
  kind: "read" | "edit" | "shell" | "network" | "mcp"
  target: string            // 工具给出的目标（规范化后的路径、命令、URL）
  resolved?: string         // 路径类：解析符号链接 / junction 后的真实路径
  where?: "workspace" | "outside"
}
```

`providerData` 只能回传给 `provider` 字段所示的 Provider，见 [context.md](../architecture/context.md) 第 7 节。

## 5. 不变量

1. **先写后发，先写后执行**：持久化事件写入日志成功后才分发给订阅者；`tool.started` 写入成功后工具才开始执行。写入失败的处理见 [sessions.md](../architecture/sessions.md) 第 5 节。
2. **连续序号**：日志中持久化事件的 `seq` 从 1 开始连续递增。
3. **Turn 成对**：每个 `turn.started` 最终都有一个同 `turnId` 的 `turn.completed`。
4. **工具调用成对**：`message.assistant.toolCalls` 中的每个 `callId` 最终都有且只有一个 `tool.completed`，且位于同一 Turn 的 `turn.completed` 之前。Agent Loop 在任何出口结束 Turn 前都会结算未完成的调用（[agent-loop.md](../architecture/agent-loop.md) 第 2 节）；恢复修复会检查全部日志而不仅是未结束的 Turn。
5. **增量归属**：`message.assistant.delta` 的 `messageId` 与随后的 `message.assistant` 相同。
6. **有界**：`tool.completed.output`、`modelContent`、`summary` 都有大小上限（见 [tools.md](../architecture/tools.md) 第 4 节）。
7. **无密钥**：事件中不得出现凭据。

## 6. 订阅者契约

- 同一会话的事件按发出顺序交付给每个订阅者：持久化事件按 `seq`，临时事件按 `eseq`，两者之间按发出顺序（`afterSeq` 可用于事后对齐）。
- **订阅者不影响执行**：Runtime 不等待订阅者处理完成；订阅者抛出的异常被捕获并记录到诊断日志，不影响 Runtime，也不影响其他订阅者，该订阅者继续接收后续事件。
- 处理跟不上的订阅者：持久化事件不丢弃（可按 `seq` 从日志补读）；临时事件允许丢弃。进程内 MVP 使用无界队列；引入 RPC 时改为有界队列并在溢出时丢弃临时事件，届时在本文补充。

## 7. 客户端命令

客户端通过会话句柄发出命令（进程内为方法调用，将来 RPC 为消息）。命令不写入日志，其效果以事件体现：

| 命令 | 前置条件 | 效果事件 | 实现阶段 |
|---|---|---|---|
| `submit(content)` | 会话空闲，否则返回 `session_busy` | `turn.started`、`message.user`、…… | Phase 1 |
| `interrupt()` | 有运行中的 Turn，否则无操作 | `turn.completed(reason="aborted")` | Phase 1 |
| `respondPermission(requestId, reply)` | 请求处于等待中，否则返回 `unknown_request` | `permission.resolved` | Phase 2（ask 流程生效；`reply.remember` 暂不生效，不生成持久授权） |
| `setModel(ref)` | 会话空闲；未知 provider/model 返回 `invalid_model` | `session.config_changed` | Phase 2（`/model`） |
| `compact()` | 会话空闲；上一次摘要进行中返回 `compaction_in_progress`，请求被中断返回 `compaction_interrupted` | `context.compacted(kind="summary")` | Phase 2（`/compact`，一次模型调用生成摘要，见 [context.md](../architecture/context.md) §6.2） |

会话处于 `failed` 状态时，除 `close` 外的命令都返回 `session_failed`。

## 8. 演进与未知内容

**读取方分两类，规则不同：**

| 读取方 | 未知持久化事件类型 | 已知事件中的未知字段 | `formatVersion` 高于自身支持 |
|---|---|---|---|
| Runtime（要恢复并继续写入会话） | 拒绝恢复，报 `session_log_newer`：不认识的事件可能改变状态语义，按旧逻辑折叠会得到错误状态 | 忽略 | 拒绝恢复 |
| 客户端 / 只读查看 | 忽略 | 忽略 | 尽力展示已知内容 |

演进规则：

- 新增临时事件类型、在已知事件中新增可选字段：兼容变更。新增字段不得改变已有字段的含义。
- 新增持久化事件类型：旧版本 Runtime 将无法恢复包含它的会话（见上表）。这是有意的保守选择；变更说明中需写明。
- 删除字段、改变字段含义：不兼容变更，提升 `formatVersion`，提供旧格式日志的读取迁移，并新增 ADR。
