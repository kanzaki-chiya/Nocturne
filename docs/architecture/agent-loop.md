# Agent Loop

> 状态：已接受 v0.2 ｜ 前置阅读：[overview.md](overview.md) ｜ 相关契约：[events.md](../protocols/events.md)、[tool-api.md](../protocols/tool-api.md)、[provider-api.md](../protocols/provider-api.md)

本文定义一次 Turn 从开始到结束的完整流程。Agent Loop 只做编排：它不知道工具的具体行为、不知道 Provider 的协议、不知道权限规则、也不知道界面如何显示。

## 1. Turn 的边界

- **开始**：客户端调用 `session.submit(input)`，会话处于空闲状态。Runtime 写入 `turn.started` 与 `message.user`。
- **进行中**：若干个 Step。每个 Step 是一次模型请求；模型返回工具调用时执行工具，然后进入下一个 Step。
- **结束**：写入 `turn.completed`。`reason` 的取值与含义见 [events.md](../protocols/events.md) 第 3.1 节。**任何出口**在写入 `turn.completed` 之前，都必须先结算本 Turn 中所有尚未结算的工具调用（第 2 节的 `finish`）。

MVP 中会话同一时间只有一个 Turn。Turn 进行中再次 `submit` 会被拒绝（`session_busy`）；CLI 在 Turn 期间只接受中断。运行中追加指令（steering）和输入排队属于后续设计。

## 2. 伪代码

以下为设计说明，不是实现代码。所有 `emit` 持久化事件都会等待日志写入完成；写入失败时抛出 `PersistenceError`，处理见第 3.6 节。

```text
runTurn(session, input, signal):
  emit turn.started, message.user(input)
  hooks?.run("TurnStart", { text: input })          # Phase 5，可选；block → return finish("error", hook_blocked)
  step = 0

  loop:
    if signal.aborted:           return finish("aborted")
    if config.maxSteps 已设置 and step >= config.maxSteps:
                                 return finish("max_steps")
    step += 1

    # 1. 构建上下文（纯计算）；需要压缩时执行压缩计划后重建
    built = contextBuilder.build(session.state, tools.specs(), model)
    while built.compaction and 该计划类型本 Turn 未尝试过:
      ok = runCompaction(built.compaction, signal)       # 见第 3.7 节；每类每 Turn 至多一次
      if not ok and built.mustCompact: return finish("error", compaction_failed)
      built = contextBuilder.build(session.state, tools.specs(), model)
    if built.overBudget:         return finish("error", compaction_failed)

    # 2. 调用模型并消费流
    messageId = newId()
    result = streamWithRetry(provider, built.request, signal):
      text / reasoning 增量 → emit message.assistant.delta（临时）
      tool_call             → 分配 callId，记录 providerCallId
      usage / finish        → 记录
    emit message.assistant(messageId, content, toolCalls, usage, finishReason)

    # 3. 按结束原因决定去向（在执行任何工具之前）
    switch result.finishReason:
      "aborted"        → return finish("aborted")          # 流式中被中断；不完整的工具调用已丢弃
      "length"         → return finish("truncated")
      "content_filter" → return finish("refused")
      "stop"           → if toolCalls is empty: return finish("done")
      "tool_calls"     → if toolCalls is empty: return finish("error", unexpected_finish)
      "other"          → return finish("error", unexpected_finish)
    # 只有 stop / tool_calls 且存在工具调用时才会走到这里

    # 4. 按模型给出的顺序执行工具
    for call in toolCalls:
      if signal.aborted: break
      outcome = toolExecutor.execute(call, scope(session, signal))
      # execute 内部：校验 → PreToolUse Hook → 输入预检（可选 validateInput，
      #   tools.md 第 3 节 2.6 步）→ 权限主体 → 解析资源 → 权限（ask 时先经
      #   PermissionRequest Hook，可能等待用户）→ tool.started → 执行
      #   → PostToolUse Hook → 归一化 → tool.completed
      if outcome.stopTurn: return finish("aborted")         # 用户选择"拒绝并停止"；剩余调用由 finish 结算
      if deps.shouldFinish?(session.state): return finish("done")   # Phase 6 注入点（subagent.md 第 2 节）
    if signal.aborted: return finish("aborted")
    # 回到循环顶部：工具结果已写入会话，下一次 build 会把它们带给模型

finish(reason, error?):
  for call in session.state.unsettledCalls(turnId):         # 本 Turn 中还没有 tool.completed 的调用
    emit tool.completed(call, status = "cancelled", error = { code: cancelCode(reason) })
  emit turn.completed(reason, steps, usage, error)
  hooks?.run("TurnEnd", { reason, steps, usage })           # Phase 5，可选；仅通知，无效果
```

`finish` 是 Turn 的唯一出口。第 3 步中因 `length` 等原因结束时，该 assistant 消息里的工具调用同样由 `finish` 记为 `cancelled`，因此"每个调用恰好一个 `tool.completed`"在所有出口上都成立。

## 3. 关键行为

### 3.1 工具结果如何回到模型

工具结果不经由内存中的"消息数组"传回，而是：`tool.completed` 写入会话 → `SessionState` 折叠出历史 → 下一个 Step 由 Context Builder 重新构建请求。内存状态与持久化状态始终一致，恢复会话时不需要额外逻辑。

### 3.2 一个 Step 返回多个工具调用

- 按模型给出的顺序执行，结果按同样顺序记录；每个调用都有且只有一个 `tool.completed`（包括拒绝、取消、失败）。
- 工具调用的标识是 Runtime 分配的 `callId`（会话内唯一）。Provider 返回的 ID 只保证在一次响应内唯一，不同 Step 可能重复（例如都叫 `call_1`），因此只作为 `providerCallId` 保存，用于回传 Provider。
- MVP 串行执行。之后可以把连续的、声明了 `concurrencySafe` 且权限结果为 allow 的调用并行执行，只改变 Tool Executor 的调度，不改变事件语义。
- 权限确认一次只弹一个，按调用顺序进行。

### 3.3 中断如何传播

每个 Turn 持有一个 `AbortController`，其 `signal` 传给：Provider 流、Tool Executor、每个工具的 `ToolContext`、等待中的权限请求、等待中的提问（ADR-0032）、压缩用的摘要请求。

| 中断发生时 | 处理 |
|---|---|
| 模型流式输出中 | 停止读取流；已收到的文本写入 `finishReason = "aborted"` 的 assistant 消息；不完整的工具调用丢弃 |
| 等待权限确认 | 权限请求以取消结束，该调用记为 `cancelled` |
| 等待提问回答（`waiting_user`） | 提问请求以取消结束，该调用记为 `cancelled`（ADR-0032） |
| 工具执行中 | 工具收到 signal 自行停止（shell 终止进程树）；超出宽限期由执行器放弃等待；记为 `cancelled` |
| 同一 Step 中尚未开始的调用 | 由 `finish` 记为 `cancelled` |
| 压缩的摘要请求中 | 放弃摘要，不写压缩事件 |

中断以 `turn.completed(reason="aborted")` 收尾，会话回到空闲状态，可以继续对话。
`close()` 在提交准备、流式执行或压缩尚未收束时也先发出中断信号，等待收束后才关闭日志和释放会话锁。

### 3.4 错误的分类

| 类别 | 来源 | 处理 | 是否结束 Turn |
|---|---|---|---|
| 工具失败 | 工具返回 `status: "error"`、输入校验失败、工具不存在、超时 | 作为工具结果（`isError`）交给模型，模型可以自我修正 | 否 |
| 权限拒绝 | 规则 deny 或用户拒绝 | 作为工具结果交给模型，附带理由和用户反馈 | 否（"拒绝并停止"时是） |
| 模型未正常结束 | `length`、`content_filter`、意外的结束原因 | 分别以 `truncated`、`refused`、`error` 结束 | 是 |
| Provider 错误 | `ProviderError` | 可重试的按策略重试；否则结束 | 重试耗尽或不可重试时是 |
| 中断 | 用户 | 见 3.3 | 是 |
| 持久化失败 | 日志写入失败 | 见 3.6 | 是（会话进入 `failed`） |
| Runtime 内部错误 | 代码缺陷、不变量被破坏 | 记录错误并结束 Turn；不把内部堆栈交给模型 | 是 |

工具的异常必须在 Tool Executor 内转换为工具结果；Provider 的错误必须被适配器归一化为 `ProviderError`，Agent Loop 只看 `kind` 与 `retryable`，不解析错误文本。

### 3.5 重试

- 只有在**本次请求尚未产生任何输出事件**时才重试，避免重复的文本和工具调用。已经开始流式输出后失败，已收到的文本按中断同样的方式保存，Turn 以 `error` 结束。
- Provider 失败或用户中断时，若没有任何 assistant 内容和工具调用，不写入空的 `message.assistant`；Turn 仍以对应原因结束。已有部分输出时照常保存。
- 仅当 `ProviderError.retryable` 为真时重试；指数退避，优先遵守 `retryAfterMs`；次数上限可配置（默认 4 次）。每次重试发出临时事件 `provider.retry`。
- 公共流包装分别限制首个事件等待和事件间空闲（默认 30 秒、120 秒；`turn.firstEventTimeoutMs` / `turn.idleTimeoutMs` 可调）。超时视为 `ProviderError(kind="timeout", retryable=true)`；已有输出时遵守上条规则，不重发。普通 Step、自动与手动摘要共用这一限制，见 [ADR-0014](../decisions/ADR-0014-stream-timeout-empty-response.md)。
- `stop` 但没有文本与工具调用时，Agent Loop 在持久化 assistant 消息前按可重试的空响应处理；受同一重试上限约束，用尽后以 `error.code="provider_empty_response"` 结束。该判断不改变 Provider 的公共事件与错误类型，因此没有新的 Provider kind；错误语义变化见同一 ADR。
- `context_overflow` 不重试同一请求，而是要求 Context Builder 给出压缩计划（`mustCompact`）并重建后重试一次；可尝试的计划按 prune → summary 顺序，每类每 Turn 至多一次，都已尝试后仍溢出则以 `error(code="compaction_failed")` 结束。

### 3.6 持久化失败

任何持久化事件写入失败，会话进入 `failed` 状态（[sessions.md](sessions.md) 第 5 节）：Agent Loop 立即停止，不再发起模型请求、不再开始工具执行，也**不再尝试写入** `tool.completed` 或 `turn.completed`。未结算的调用与未结束的 Turn 留给下次恢复时的修复逻辑处理。这是 `finish` 唯一不执行的情况，因为此时已无法可靠写入。

### 3.7 压缩的执行

Context Builder 是纯计算，不调用 Provider。需要压缩时它返回压缩计划，由 Agent Loop 执行：

- `prune` 计划：直接写入 `context.compacted(kind="prune")`。
- `summary` 计划：用计划中给出的摘要请求调用 Provider（同样受中断信号与重试规则约束），成功后写入 `context.compacted(kind="summary")`；失败、超时或被中断时不写任何压缩事件。

计划的边界规则、叠加方式与失败处理见 [context.md](context.md) 第 6 节。

### 3.8 步数上限

主对话默认不限制单 Turn 步数：`maxSteps` 未配置（undefined）时 Turn 不会因步数上限结束；正常由模型 `stop` 或用户中断收尾，其余结束原因（Provider 错误、截断、拒绝、持久化失败等）遵循原有规则。显式配置 `maxSteps`（正整数）后达到上限时 Turn 以 `max_steps` 结束，用户可以发送"继续"开启新 Turn。子会话不受此默认影响：Subagent 始终有自己的独立上限（`maxStepsPerTurn`，默认 50，见 [subagent.md](subagent.md)）。重复调用检测作为后续改进。

### 3.9 Turn 的可选注入点（Phase 6）

`TurnDeps` 的三个可选字段为 Subagent 引入，缺省时行为与既有版本逐项一致：

| 字段 | 作用 |
|---|---|
| `basePrompt?: string` | 覆盖基础系统提示段（context.md 第 3 节第 1 项）；子会话用它换成子代理提示 |
| `shouldFinish?(state): boolean` | 每个工具调用结算后检查；返回 true 即 `finish("done")`。谓词由调用方注入，Agent Loop 不读工具名 |
| `toolChoice?: { name: string }` | 设置时进入本 Turn 每个 `ModelRequest`（强制调用某工具，见 provider-api.md 第 3 节）；仅 Subagent 的催促兜底轮使用 |

子会话由 `SubagentLauncher` 用同一 `runTurn` 驱动另一条会话日志（[subagent.md](subagent.md)）——没有"子会话模式"的 Agent Loop 分支。

## 4. 运行状态

Agent Loop 通过临时事件 `runtime.status` 告知客户端当前状态：

```text
idle ──submit──▶ thinking ──工具调用──▶ running_tool ──ask──▶ waiting_permission
  ▲                 │  ▲                     │└─提问─▶ waiting_user │
  │                 │  └──────下一个 Step─────┘◀──回复/回答/跳过──────┘
  └──turn.completed─┘   retrying（Provider 重试等待中）  compacting（执行摘要）
                        failed（持久化失败，见 3.6）
```

`waiting_user` 是 ADR-0032 的提问等待态：`needsUser` 工具经 `ToolContext.askUser` 发出 `question.requested` 后进入；`respondQuestion` 到达或提问被取消后回到 `running_tool` 继续本 Step。

状态是派生信息，丢失不影响正确性。

## 5. 明确不在 Agent Loop 中的内容

- 按工具名或 Provider 名的分支；
- "是否需要确认"的判断；
- 渲染、颜色、spinner；
- 持久化格式；
- 计划模式、目标管理、定时任务等产品功能（将来若需要，作为独立模块通过工具或事件接入）。
