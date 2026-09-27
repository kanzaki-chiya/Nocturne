# 上下文管理（Context）

> 状态：已接受 v0.3 ｜ 前置阅读：[sessions.md](sessions.md) ｜ 相关契约：[provider-api.md](../protocols/provider-api.md)

## 1. 两个不同的东西

| | 会话历史（Session History） | 模型上下文（Model Context） |
|---|---|---|
| 是什么 | 会话日志折叠出的完整历史 | 某一个 Step 实际发给模型的请求 |
| 生命周期 | 持久化，只追加 | 每个 Step 临时构建，用完即弃 |
| 大小 | 可以无限增长 | 受模型上下文窗口限制 |
| 所有者 | session | context |

Context Builder 的职责就是：**从会话历史中选出、变换出一个装得进窗口、对模型有用、前缀尽量稳定的请求。** 两者永远不能混为一谈：压缩上下文不会删除历史，只会追加一个"从这里开始用摘要代替"的事件。

## 2. 输入与输出

```text
build({
  state: SessionState,            # 历史、配置
  model: ModelInfo,               # 上下文窗口、能力
  tools: ToolSpec[],              # 由 agent 从 ToolRegistry 取得后作为数据传入
  instructions: InstructionSet,   # 已加载的 AGENTS.md 等
  environment: EnvironmentInfo,   # 操作系统、shell、cwd、会话日期
}) → BuiltContext {
  request: ModelRequest,          # 中性请求，交给 Provider
  report: ContextReport,          # 每个部分的来源与 token 估算，用于调试与 /context 命令
  overBudget: boolean,            # 当前请求超出可用预算
  compaction?: CompactionPlan,    # 建议或必须执行的压缩（第 6 节）
  mustCompact: boolean,           # 不压缩就无法发出请求
}
```

Context Builder 不做 I/O，也不调用 Provider：指令文件由 `config` / `platform` 在会话开始时读取并传入；需要模型参与的摘要由 Agent Loop 按计划执行。这让它可以用纯数据测试。

## 3. 组装顺序（稳定的放前面）

1. **基础系统提示**：英文的 Nocturne 身份、先读后改与验证的工作方式、工具使用约定（命令输出自动收集，勿接分页工具；大量输出先重定向到文件再用 `grep` 工具搜索）、安全边界、按用户语言回复。正文以 [ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 第 9 条及附录为准。随版本变化，会话内不变。可由 `BuildContextInput.basePrompt` 覆盖——唯一的用户是子会话（Phase 6），它换成中文的"子代理 + `finish` 提交协议"提示，并与主提示对齐验证与安全要求（[subagent.md](subagent.md) 第 8 节）。
2. **工具规格**：名称、描述、输入 schema。会话内通常不变。
3. **项目指令**：用户级 `<NOCTURNE_HOME>/AGENTS.md`，以及从 `workspaceRoot` 到 `cwd` 路径上各级目录的 `AGENTS.md`。前言说明这些是用户和项目指令，冲突时优先于默认做法。每个文件有大小上限，超出截断并在报告中标注。
4. **环境信息**：操作系统、实际 shell 命令形态、工作目录、会话创建日期。shell 可执行文件与参数和 `spawnShell` 同源；`cmd`/`cmd.exe` 说明 cmd 语法，并提醒 `findstr` 的控制台代码页关键词无法匹配 UTF-8 输出中的非 ASCII 文字，只用 ASCII 关键词；`sh` 说明 POSIX sh 语法，其他仅如实报告。取会话级的值，不在每个 Step 刷新，避免破坏缓存前缀。
5. **历史**：最近一个压缩边界之后的消息与工具结果；若存在摘要，摘要作为历史的第一条。

Builder 在 `BuiltContext` 中标出"可缓存前缀"的边界，是否以及如何使用提示缓存（例如 Anthropic 的 cache breakpoint）由 Provider 适配器决定。

## 4. 基本原则

- **增量构建**：除压缩边界外，不改写已经发给模型的历史，让相邻 Step 的请求共享最长前缀。
- **每一项都有上限**：工具结果在执行时就按预算截断（见 [tools.md](tools.md)），指令文件有上限，任何注入内容都不能无界增长。上下文层不负责修补无界输入。
- **可解释**：`ContextReport` 列出每一部分的来源与估算 token，用户和开发者能看到"窗口被什么占满了"。

## 5. Token 预算

```text
可用输入预算 = model.contextWindow − 输出预留（min(maxOutputTokens, 上限)；maxOutputTokens 未知时按兜底值预留，只用于本地估算，见 [provider-setup.md](provider-setup.md) 第 7 节）− 安全余量
当前估算     = 上一次请求 Provider 报告的输入 token 数 + 此后新增内容的估算（字符数 / 4）
```

没有 Provider 用量数据时（第一个 Step、刚切换模型）完全使用估算。估算只用于决定是否压缩，不需要精确。

## 6. 压缩

### 6.1 两级压缩

每一级都以持久化事件 `context.compacted` 记录，使后续构建结果确定、可恢复：

| 级别 | 做法 | 成本 | 事件内容 |
|---|---|---|---|
| L1 修剪（prune） | 把 `throughSeq` 及之前的工具结果替换为占位说明（保留工具名、参数摘要与"输出已省略"），工具调用与结果本身仍然成对保留 | 无模型调用，确定性 | `kind: "prune"`、`throughSeq` |
| L2 摘要（summary） | 用模型把 `throughSeq` 及之前的历史总结为一段结构化摘要（目标、已完成、关键文件、未决事项） | 一次模型调用 | `kind: "summary"`、`throughSeq`、`summary` |

### 6.2 职责划分

```text
Context Builder（纯计算）  → CompactionPlan { kind, throughSeq, summaryRequest? }
Agent Loop                 → prune：直接写入事件
                             summary：用 summaryRequest 调用 Provider，成功后写入事件
```

### 6.3 边界规则

`throughSeq` 必须指向一个**已闭合的步骤边界**，即以下两者之一：

- 某个 `turn.completed` 事件；
- 某条 `message.assistant` 的所有工具调用都已结算后，其最后一个 `tool.completed` 事件。

因此压缩永远不会把一对工具调用与结果拆到边界两侧，也不会切进一条消息内部。

进行中的 Turn 被摘要覆盖时（长 Turn 的中途压缩），该 Turn 的 `message.user` 原文在摘要之后保留，模型不会丢失当前任务的原始要求。

### 6.4 多次压缩的叠加

- 同一会话中，每种压缩的 `throughSeq` 必须严格递增；Agent Loop 保证这一点，折叠时遇到不递增的压缩事件视为不变量被破坏（记录诊断并忽略该事件）。
- **摘要是累积的**：新摘要的输入是"上一个摘要 + 其后到新边界为止的历史"，因此只有最新的摘要生效，更早的摘要与其覆盖的历史都不再进入上下文。
- **修剪只作用于最新摘要之后的历史**：生效的修剪截止点是最新摘要之后、`throughSeq` 最大的那次修剪；在其之前的工具结果显示为占位说明。
- 有效历史 = 最新摘要（若有）+ 摘要之后的事件（修剪截止点之前的工具输出替换为占位）+ 被覆盖的进行中 Turn 的 `message.user` 原文。

### 6.5 触发

- 构建结果超过预算的某个阈值（默认 80%）时，Builder 先给出 prune 计划；修剪后仍超出阈值，给出 summary 计划。这类压缩是预防性的（`mustCompact = false`）。
- 请求已超出预算，或 Provider 返回 `context_overflow` 时，`mustCompact = true`（见 [agent-loop.md](agent-loop.md) 第 3.5 节）。
- 用户可以用 `/compact` 手动触发摘要，走同一条路径。

落地细节（自动摘要自 Phase 3 起启用，与手动 `/compact` 共用同一条 L2 路径）：

- Builder 的 `compaction` 计划按序给出：估算超过阈值且存在更新于当前修剪点的闭合边界 → `prune`；prune 之后仍超阈值（或 prune 无可行边界）且存在可行摘要边界 → `summary`（`CompactionPlan` 携带 `summaryRequest`）。两种计划的判定都在 Builder 内完成，Agent Loop 只按计划执行。
- **每个 Turn 每种压缩至多执行一次**（成功或失败均不重复）：预防性压缩失败后本 Turn 不再尝试（§6.6）；`context_overflow` 到达时从未尝试过的下一级继续（prune 未试过先 prune，否则 summary），两级都已尝试后仍溢出发 `compaction_failed`。
- `summary` 计划执行成功后重建一次；重建结果仍超硬预算时不再追加尝试，Turn 以 `error(code = "compaction_failed")` 结束。
- 摘要可以在 Turn 进行中发生：此时摘要边界只落在已闭合的步骤边界上（6.3），被覆盖的进行中 Turn 的 `message.user` 原文由 Builder 依据 `state.openTurn` 在摘要后重新注入。
- prune 的呈现：最新摘要之后、`throughSeq` 及之前的工具结果替换为占位说明（保留工具名与参数摘要，标注"输出已省略"）；参数摘要来自 `tool.started.input` 折叠进历史条目的 `inputSummary` 字段（`HistoryEntry` 的兼容新增可选字段，见 [events.md](../protocols/events.md) 第 8 节）。

### 6.6 摘要请求本身的约束与失败处理

- **摘要请求必须装得进窗口**：Builder 选择边界时保证"上一个摘要 + 待总结历史（先按修剪规则省略工具输出）+ 摘要指令"在预算内；装不下就把边界提前到更早的闭合边界；不存在任何可行边界时不给出计划。
- **边界只取新内容**：候选边界必须落在最新摘要的 `throughSeq` 之后（即摘要覆盖之后存在新的闭合边界）；最新摘要之后没有新内容时不给出计划，手动 `/compact` 因此返回 `compaction_failed` 而不是对同一历史再压出第二份摘要。
- **摘要输出有上限**（默认约 4,000 token），并作为有界内容写入事件。
- **失败、超时、被中断**：不写任何压缩事件，会话历史不变。
  - 预防性压缩失败：本 Step 照常使用未压缩的上下文，并发出 `runtime.warning`；本 Turn 内不再尝试预防性压缩，避免每个 Step 重复失败。
  - 必须压缩却失败（或没有可行边界）：Turn 以 `error` 结束，`error.code = "compaction_failed"`，提示用户手动 `/compact` 或切换到更大窗口的模型。
- 摘要请求遵守与普通请求相同的重试规则，但只尝试一轮，不嵌套压缩。

### 6.7 阶段安排

Phase 2 提供自动修剪与手动 `/compact`；Phase 3 加入自动摘要（6.5）。

## 7. 切换模型或 Provider

历史中的内容大多是中性的（文本、工具调用、工具结果），可以直接用于新模型。例外：

- 推理内容若携带 Provider 专有数据（签名、加密内容），只能回传给产生它的 Provider；切换后 Builder 丢弃这类推理块，只保留普通文本。
- 新模型不支持的输入类型（例如图片）替换为文字占位。
- 新模型窗口更小时，按第 6 节的规则压缩。

这些判断依据 `ModelInfo.capabilities` 与内容块上记录的来源 Provider，而不是按 Provider 名字写分支。

## 8. 暂不设计

仓库地图（repo map）、语义检索、长期记忆、跨会话知识。它们将来作为新的上下文来源（section）接入第 3 节的顺序中，并在 `ContextReport` 中可见。
