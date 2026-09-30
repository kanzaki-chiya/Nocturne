# 事件协议（Event Protocol）

> 状态：已接受 v0.2 ｜ 设计依据：[sessions.md](../architecture/sessions.md)、[ADR-0003](../decisions/ADR-0003-session-event-log.md) ｜ 代码位置：`packages/core/src/protocol/`

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
| 需要 correlation id 吗？ | `turnId` 关联一次 Turn 内的所有事件；父子会话关联由 `session.created.parent` 的类型化字段记录（Phase 6）；跨进程 `traceId` 推迟到 RPC 阶段评估（[subagent.md](../architecture/subagent.md) 第 13 节、[ADR-0013](../decisions/ADR-0013-subagent.md)） |
| Tool Call 如何关联？ | Runtime 为每个工具调用分配会话内唯一的 `callId`，贯穿所有生命周期事件；Provider 给出的原始 ID 保存在 `providerCallId` 中，仅用于回传 Provider |
| Message 与 Event 的关系？ | 消息就是事件：`message.user`、`message.assistant` 本身就是会话中的消息记录，工具结果就是 `tool.completed`。没有另一张消息表 |
| Session state 如何得到？ | 由持久化事件折叠重建；MVP 不做快照 |
| CLI/TUI 消费什么？ | CLI（行式输出）直接消费事件；TUI 等需要整体视图的客户端使用 `protocol` 提供的纯函数 reducer 派生视图（[view.md](view.md)，Phase 4）；远程客户端先按 `seq` 回放持久化事件，再接收实时事件 |

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
| `traceId`、`spanId` | RPC 阶段再评估 | 兼容变更；Phase 6 决定推迟，理由见 [subagent.md](../architecture/subagent.md) 第 13 节 |

## 3. 事件类型

### 3.1 持久化事件

| 类型 | turnId | payload |
|---|---|---|
| `session.created` | — | `formatVersion`、`nocturneVersion`、`cwd`、`workspaceRoot`、`model: ModelRef`、`permissionPreset`、`reasoningEffort?`（思考档位，ADR-0018；缺省按 `off` 处理）、`parent?`（`{ sessionId, callId }`，仅子会话存在；Phase 6，[subagent.md](../architecture/subagent.md) 第 5 节） |
| `session.config_changed` | — | 变化的字段：`model?`、`permissionPreset?`、`reasoningEffort?`（思考档位切换，ADR-0018）、`shell?: { kind, path }`（shell 切换，ADR-0022：折叠时在该事件位置留 `note` 历史条目给模型，见 [context.md](../architecture/context.md) 第 3 节） |
| `turn.started` | ✓ | `turnIndex` |
| `message.user` | ✓ | `messageId`、`content: ContentBlock[]`、`attachments?: ImageAttachment[]`、`fileRefs?: FileRef[]`（用户引用的快照元数据，见第 4 节） |
| `message.assistant` | ✓ | `messageId`、`model: ModelRef`、`content: ContentBlock[]`、`toolCalls: ToolCallRef[]`、`usage?: Usage`、`finishReason: FinishReason \| "aborted"`、`protocol?: "openai-compatible" \| "anthropic" \| "openai-responses"`（产生该消息时的生效协议，ADR-0026 §6、ADR-0031 §1；旧日志无此字段，缺省时 `providerData` 回传只比较服务商） |
| `tool.started` | ✓ | `callId`、`name`、`input`（规范化后）、`subjects: PermissionSubject[]`（解析后）、`permission: { action, source, rule? }`（`rule` 为命中规则的人读说明，见 [permissions.md](../architecture/permissions.md) 5.3） |
| `permission.requested` | ✓ | `requestId`、`callId`、`subjects`、`reason`、`options`（完整选项集：`allow_once`、`allow_session`、`allow_project`、`deny`、`deny_stop`） |
| `permission.resolved` | ✓ | `requestId?`、`callId`、`action: "allow" \| "deny"`、`source: "user" \| "rule" \| "grant" \| "non_interactive" \| "cancelled" \| "hook"`、`rule?`、`remember?`、`feedback?` |
| `tool.completed` | ✓ | `callId`、`name`、`status`、`modelContent`、`output?`、`error?`、`truncated?`、`spillPath?`（超预算输出的落盘文件绝对路径，见 [tools.md](../architecture/tools.md) 第 4 节）、`attachments?: ImageAttachment[]`（v0.5 新增：工具结果图片的附件引用，字节已落盘，见 [tools.md](../architecture/tools.md) 第 4 节）、`durationMs?` |

| `context.compacted` | ✓ 或 — | `kind: "prune" \| "summary"`、`throughSeq`、`summary?`（规则见 [context.md](../architecture/context.md) 第 6 节） |
| `turn.completed` | ✓ | `reason`、`steps`、`usage`、`error?`、`recovered?` |

`todo_write` 不新增事件类型或 `formatVersion`：成功且已持久化的 `tool.completed` 在 `output.items` 中携带规范化后的完整清单。折叠规则与边界见 [sessions.md](../architecture/sessions.md) 和 [tool-api.md](tool-api.md)；其他状态和无效输出均不改变当前清单。

`tool.completed.status`：`ok`、`error`、`denied`、`cancelled`、`interrupted`（仅恢复修复产生）。

`turn.completed.reason`：

| reason | 含义 |
|---|---|
| `done` | 模型以 `stop` 结束且没有工具调用 |
| `truncated` | 模型输出达到长度上限（`length`） |
| `refused` | 内容被 Provider 过滤（`content_filter`） |
| `aborted` | 用户中断，或在权限确认中选择"拒绝并停止" |
| `max_steps` | 达到单 Turn 步数上限：只在显式配置主会话 `turn.maxSteps` 或子代理独立上限（默认 50）时出现；主对话默认不限步数 |
| `error` | 不可恢复的错误：Provider 错误重试耗尽、意外的结束原因、压缩失败、Runtime 内部错误；`TurnStart` Hook 拦截时为 `error.code = "hook_blocked"`（hooks.md 第 1 节）。恢复修复补写的 Turn 也使用 `error`，`error.code = "process_exited"`，`recovered: true` |

`permission.resolved` 在以下情况发出：经过用户确认的请求（有 `requestId`）；被规则直接拒绝的调用；由会话或项目授权放行原本需要确认的调用（`source: "grant"`）；Hook 直接结算的调用（`source: "hook"`——`PreToolUse` 的 deny/allow 与 `PermissionRequest` 的 allow/deny，`rule` 字段记 Hook 条目的人读描述，见 [hooks.md](../architecture/hooks.md)）。规则直接允许的调用不单独发事件，其决定记录在 `tool.started.permission` 中。

### 3.2 临时事件

| 类型 | turnId | payload |
|---|---|---|
| `message.assistant.delta` | ✓ | `messageId`、`kind: "text" \| "reasoning"`、`delta` |
| `tool.input.delta` | ✓ | `callId`、`name`、`delta`（参数 JSON 片段，仅供显示） |
| `tool.progress` | ✓ | `callId`、`stream: "stdout" \| "stderr" \| "info"`、`chunk` |
| `runtime.status` | ✓ 或 — | `status: "idle" \| "thinking" \| "running_tool" \| "waiting_permission" \| "waiting_user" \| "retrying" \| "compacting" \| "failed"` |
| `question.requested` | ✓ | `requestId`、`callId`、`questions: QuestionItem[]`（ADR-0032；等待 `respondQuestion`，回复校验失败返回 `invalid_reply` 且请求保持等待） |
| `provider.retry` | ✓ | `attempt`、`maxAttempts`、`delayMs`、`error: { kind, message }` |
| `runtime.warning` | ✓ 或 — | `code`、`message`（Phase 5 增补的 `code`：`project_config_untrusted`（含被忽略的 `mcp`/`hooks` 段）、`mcp_server_failed`、`mcp_server_crashed`、`mcp_tool_conflict`、`mcp_env_missing`、`hook_failed`、`debug_sink_failed`、`grant_persist_failed` 等；v0.2 增补 `model_capabilities_defaulted`、`provider_setup_invalid`，见 [provider-setup.md](../architecture/provider-setup.md)；ADR-0022 增补 `shell_env_invalid`（非法 `NOCTURNE_SHELL` 回退自动）、`shell_overridden`（settings 层的 shell 选择被 env/config 覆盖）；ADR-0025 增补 `provider_thinking_levels_ignored`（旧向导配置的服务商级 `thinking.levels` 已忽略，需逐模型设置）） |
| `runtime.error` | ✓ 或 — | `code`、`message`（例如日志写入失败导致会话进入 `failed` 状态） |
| `mcp.server` | — | `server`、`state: "starting" \| "ready" \| "failed" \| "crashed" \| "stopped"`、`toolCount?`、`error?`（Phase 5，MCP 服务器生命周期状态转移，见 [mcp.md](../architecture/mcp.md) 第 7 节） |

临时事件的信息要么包含在随后的持久化事件中（增量 → 完整消息），要么是可丢弃的状态提示。客户端丢失临时事件不影响正确性。

Phase 5 新增事件的取舍：`mcp.server` 与 Hook 执行记录都选**临时事件/诊断**而非持久化——MCP 服务器进程是本次打开的运行态，恢复时重新拉起；Hook 的效果已体现在 `permission.resolved`、`tool.completed`、`turn.completed` 里。若写进持久日志，包含这些事件的会话将无法被旧版本 Runtime 恢复（第 8 节），没有对应收益。

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
  inputTokens: number       // 本次请求模型看到的全部输入 token，包含缓存读取与缓存写入
  outputTokens: number
  cacheReadTokens?: number  // inputTokens 的子集：命中缓存读取的部分
  cacheWriteTokens?: number // inputTokens 的子集：本次写入缓存的部分
  reasoningTokens?: number
}

/** 解析后的权限主体，见 permissions.md */
type PermissionSubject = {
  kind: "read" | "edit" | "shell" | "network" | "mcp" | "subagent"   // subagent：Phase 6
  target: string            // 工具给出的目标（规范化路径、命令、网络主机）
  detail?: string           // 仅供显示的补充说明，不参与规则、Grant 或 Hook 判定
  resolved?: string         // 路径类：解析符号链接 / junction 后的真实路径
  where?: "workspace" | "outside"
  shell?: string            // shell 主体：执行该命令的 shell 种类（ADR-0022；旧日志缺省按 POSIX 方言保守求值）
}

/** v0.5 新增（ADR-0023）：图片附件引用。字节不进事件——附件文件
    落盘在 <sessionsDir>/attachments/<sessionId>/ 下，事件里只存引用 */
type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

/** ADR-0033：用户消息附带的 @ 引用，缺省时沿用旧消息显示。 */
type FileRef = {
  path: string
  kind: "file" | "directory" | "image"
  lines?: number            // 文本实际附带的行数
  totalLines?: number       // 文件总行数，换行规则同 read
  chars: number             // 附带原文的字符数（不含行号/标签）；图片为 0
  truncated: boolean
}

type ImageAttachment = {
  type: "image"
  file: string              // 相对 <attachmentsDir>/<sessionId>/ 的文件名，如 "img-3.png"
  mimeType: ImageMimeType
  bytes: number             // 原始字节数
  sha256: string            // 小写 hex，load 时校验
  width?: number
  height?: number
  label?: string            // 人读名（如原始文件名）
  source: "paste" | "read" | "mcp"   // 附件来源
}

/** ask_user 提问条目（ADR-0032 §1）；字段边界与校验规则
    见 tool-api.md「ask_user」段，此处只列形状 */
type QuestionItem = {
  question: string
  header?: string
  options?: { label: string; description?: string }[]  // 省略/为空 = 自由文本题
  multiSelect?: boolean
}

/** 用户对单题的答复（ADR-0032 §2）：按位置与 questions[i] 对应；
    selected 是已提供选项中被选中的 label 集（单选至多一项），
    text 为「其他」/自由文本题的回答（去首尾空白、至多 2000 字符） */
type QuestionAnswer = { declined: true } | {
  selected: string[]
  text?: string
}
```

`inputTokens` 统一为包含口径：服务商分开报告未缓存输入与缓存读写时（如 Anthropic 原生 usage），由 Provider 适配器相加后写入；已是包含口径的来源（AI SDK 的 `LanguageModelUsage`，其 Anthropic provider 已完成相加）直接透传。Core 与客户端据此计算缓存命中率（`cacheReadTokens / inputTokens`）和上下文估算（[context.md](../architecture/context.md) 第 5 节），不再按服务商区分口径。

`providerData` 只能回传给 `provider` 字段所示的 Provider，且要求同一协议（ADR-0026 §6），见 [context.md](../architecture/context.md) 第 7 节。

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
| `submit({ text?, content?, attachments? })` | 会话空闲，否则返回 `session_busy`；`attachments` 是可选的 `{ data, mimeType, label? }[]`，由 Core 校验并落盘；文本中的 `@文件` 由 Core 读取并固定为快照 | `turn.started`、`message.user`（含 `attachments`、`fileRefs`）、…… | 图片见 ADR-0023；文件引用见 ADR-0033 |
| `interrupt()` | 有运行中的 Turn，否则无操作 | `turn.completed(reason="aborted")` | Phase 1 |
| `fileIndex()` | 会话可用；首次请求建立工作区索引，每个 Turn 后失效 | 无事件，返回至多 20,000 个文件与目录候选；规则见 [tools.md](../architecture/tools.md) | ADR-0033 |
| `respondPermission(requestId, reply)` | 请求处于等待中，否则返回 `unknown_request` | `permission.resolved` | Phase 2 起 ask 流程生效；Phase 3 起 `reply.remember` 生效，生成对应范围的 Grant（[permissions.md](../architecture/permissions.md) 5.4） |
| `respondQuestion(requestId, reply)` | 请求处于等待中，否则返回 `unknown_request`；`reply` 为 `{ answers: QuestionAnswer[] }`，逐题为 `{ selected: string[], text?: string }` 或 `{ declined: true }`；拒绝项同时带 selected/text、答案数/选项归属与问题不匹配、单选多项或 text 超过 2000 字符返回 `invalid_reply` 且请求保持等待 | 无独立结算事件：等待中的 `ask_user` 调用以 `tool.completed` 结算（回答与逐题拒绝均为 `ok`；中断为 `cancelled`）；`runtime.status` 离开 `waiting_user` | ADR-0032 |
| `setModel(ref)` | 会话空闲（Turn 进行中返回 `session_busy`）；未知 provider 返回 `invalid_model`；Provider 启用严格清单（`strictModels`，默认）且模型不在清单内同样 `invalid_model` | `session.config_changed` | Phase 2（`/model`） |
| `setPermissionPreset(name)` | 会话空闲；未知预设名返回 `invalid_command` | `session.config_changed`（`permissionPreset`）；生效的是**下一次**权限求值 | Phase 3（`/preset`） |
| `setReasoningEffort(level)` | Turn 进行中同样允许（`config_changed` 无 turnId，对重放不变量无影响）；档位名未知或当前模型未声明该档位返回 `invalid_command`，并列出可用档位 | `session.config_changed`（`reasoningEffort`）；生效的是**下一个 Turn**——本 Turn 请求沿用 Turn 开始快照（Anthropic 单一思考模式约束） | ADR-0018（CLI `/effort`、TUI Shift+Tab） |
| `compact()` | 会话空闲（Turn 进行中返回 `session_busy`）；上一次摘要进行中返回 `compaction_in_progress`，请求被中断返回 `compaction_interrupted`，Provider 失败或无可行边界返回 `compaction_failed` | `context.compacted(kind="summary")` | Phase 2（`/compact`，一次模型调用生成摘要；失败或中断不写入任何事件、历史不变，见 [context.md](../architecture/context.md) §6.2/§6.6） |
| `setShell(kind)` | 会话可用；未知种类或目标未安装（`auto` 无可解析结果同理）返回 `invalid_command` 并列出可选项——拒绝发生在写 settings.json 之前，不产生事件（Turn 进行中也可切换，已执行的命令不受影响） | 实际生效变化时发 `session.config_changed`（`shell: { kind, path }`）；生效的是**下一次** shell 工具调用——选择逐次解析、不在 Turn 开始快照。`"auto"` 清除 settings.json 的选择；被 `NOCTURNE_SHELL`/`config.json` 覆盖时照常写入但不生效、发 `runtime.warning(shell_overridden)`，不发 `config_changed` | ADR-0022（CLI/TUI `/shell`） |

会话处于 `failed` 状态时，除 `close` 外的命令都返回 `session_failed`。

## 8. 演进与未知内容

**读取方分两类，规则不同：**

| 读取方 | 未知持久化事件类型 | 已知事件中的未知字段 | `formatVersion` 高于自身支持 |
|---|---|---|---|
| Runtime（要恢复并继续写入会话） | 拒绝恢复，报 `session_log_newer`：不认识的事件可能改变状态语义，按旧逻辑折叠会得到错误状态 | 忽略 | 拒绝恢复 |
| 客户端 / 只读查看 | 忽略 | 忽略 | 尽力展示已知内容 |

演进规则：

- 新增临时事件类型、在已知事件中新增可选字段：兼容变更。新增字段不得改变已有字段的含义。v0.5 的 `message.user.attachments` 与 `tool.completed.attachments` 属于此类：不提升 `formatVersion`，旧版本按上表忽略未知字段。
- 新增持久化事件类型：旧版本 Runtime 将无法恢复包含它的会话（见上表）。这是有意的保守选择；变更说明中需写明。
- 删除字段、改变字段含义：不兼容变更，提升 `formatVersion`，提供旧格式日志的读取迁移，并新增 ADR。
