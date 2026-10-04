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
  attachmentData?: Map<sha256, base64>,  # 图片附件字节，由 Agent Loop 预先读入（见下）
}) → BuiltContext {
  request: ModelRequest,          # 中性请求，交给 Provider
  report: ContextReport,          # 每个部分的来源与 token 估算，用于调试与 /context 命令
  overBudget: boolean,            # 当前请求超出可用预算
  compaction?: CompactionPlan,    # 建议或必须执行的压缩（第 6 节）
  mustCompact: boolean,           # 不压缩就无法发出请求
  missingAttachments?: ImageAttachment[],  # 引用了但取不到字节的附件，由 Loop 记诊断
}
```

Context Builder 不做 I/O，也不调用 Provider：指令文件由 `config` / `platform` 在会话开始时读取并传入；需要模型参与的摘要由 Agent Loop 按计划执行。这让它可以用纯数据测试。

用户的 `@文件` 引用在 Core `submit` 时读取并固定为消息快照：原文之后追加 `<file>` 或 `<directory>` 文本块，图片使用既有 `attachments` 通道；读取与截断规则见 [tools.md](tools.md#用户文件引用)。`fileRefs` 只供客户端显示摘要，Builder 不据此读取文件或区别处理内容，文件块照常参与上下文预算与压缩，恢复时使用日志中的内容。

图片附件（ADR-0023）：历史条目上的 `attachments` 只是引用（events.md 第 4 节）。每个 Step 构建前，Agent Loop 先调 `attachmentsToLoad(history, model)`——与构建共用同一套 6.4 压缩边界——得到本次会作为图片发出的引用集（模型 `imageInput` 为 false 时为空；跳过摘要/修剪覆盖的条目；含进行中 Turn 被摘要覆盖而重注入的 `message.user`；按 `sha256` 去重、只取最新 20 个引用），再经会话的 `AttachmentStore` 读字节、转 base64 放进 `attachmentData` 传给 Builder。当前模型不能看图且 vision 可用时，Loop 在构建前逐个描述同一投影窗口内最新 20 个图片附件（用户与工具结果均适用），复用 Provider 图片适配器；固定指令附同条用户文字或工具名和路径，最大输出 1000 token，不带工具定义或 reasoningEffort。成功或失败均写 `attachment.described`，每个附件只尝试一次；失败警告后继续，Esc 同时取消正在进行的请求。Builder 只读这些事件，不做 I/O。投影规则：

- `imageInput` 为 true 且 `attachmentData` 命中该 sha256 → 消息带 `images`（`ModelImage`，provider-api.md 第 3 节）；user 消息的图片走消息级 `images` 字段，tool 消息同理。
- `imageInput` 为 false → 有 `attachment.described` 描述的附件投影为 `[图片 #n 描述（由 <模型> 生成）]\n<描述>`；没有描述或描述失败时保留占位文字 `[image omitted: current model does not support image input]`。
- 数据缺失 → `[image unavailable: attachment file missing]`，引用记入 `missingAttachments`；Builder 不记诊断，由 Agent Loop 逐条记 `context.attachment_missing`。
- 占位文字的落位：user 消息追加一个 text 块；tool 消息在 `content` 末尾每个占位前加 `\n` 追加。L1 修剪覆盖的 tool 条目保持原占位说明，不附加任何图片占位或图片。
- `attachmentData` 缺省（`undefined`）是**估算模式**——`describeContext`（`/context` 报告）走这条路：支持看图的模型按将发送的引用数估算，不产生 `images` 也不算缺失。
- 全部消息组装完（含 `pendingMessages`）做一次上限后处理：从最新往前保留 20 张图片，更早的从 `images` 移除并按同一落位规则换成 `[image omitted: exceeds the per-request limit of 20 images]`。

## 3. 组装顺序（稳定的放前面）

1. **基础系统提示**：英文的 Nocturne 身份、先读后改与验证的工作方式、工具使用约定（命令输出自动收集，勿接分页工具——shell 会对末尾接 `more`/`less` 的命令硬拒绝并回以补救说明，见 [tools.md](tools.md) 第 6 节；大量输出先重定向到文件再用 `grep` 工具搜索）、安全边界、按用户语言回复。正文以 [ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 第 9 条及附录为准；其中编辑工具一节经 [ADR-0035](../decisions/ADR-0035-apply-patch.md) 第 7 节修订——提示对编辑工具保持中性（"file-editing tools" 标题、不点名 `edit`/`write`/`apply_patch`），两种 `editTool` 能力下是同一份文本以保住缓存前缀。随版本变化，会话内不变。可由 `BuildContextInput.basePrompt` 覆盖——唯一的用户是子会话（Phase 6），它换成中文的"子代理 + `finish` 提交协议"提示，并与主提示对齐验证与安全要求（[subagent.md](subagent.md) 第 8 节）。
2. **工具规格**：名称、描述、输入 schema。会话内通常不变。
3. **项目指令**：用户级 `<NOCTURNE_HOME>/AGENTS.md`，以及从 `workspaceRoot` 到 `cwd` 路径上各级目录的 `AGENTS.md`。前言说明这些是用户和项目指令，冲突时优先于默认做法。每个文件有大小上限，超出截断并在报告中标注。
4. **环境信息**：操作系统、shell、工作目录、会话创建日期（取会话元数据的创建时间，恢复时不变）。Shell 行由会话级 resolver 在会话打开（新建或恢复）时按当时的生效 shell 生成一次（ADR-0022，与 `spawnShell` 同源），内容为 `Commands run with <名称>（<可执行文件>）<调用形态>: <语法说明>`——`cmd` 说明 `&` 是顺序执行而非后台（长命令直接执行并调大 `timeoutMs`），并提醒 `findstr` 控制台代码页关键词无法匹配 UTF-8 输出中的非 ASCII 文字；`pwsh`/`powershell` 说明 PowerShell 语法（7+ 支持 `&&`/`||`，5.1 不支持）；Git Bash 说明 Windows 路径写法（`C:/…` 或 `/c/…`）与 MSYS 参数转换；`sh` 说明 POSIX sh 语法。取会话级的值，不在每个 Step 刷新，避免破坏缓存前缀。会话中途切换 shell 时该行**不改写**（改它会让整段历史的提示缓存失效）：`session.config_changed { shell }` 折叠时在事件位置生成 `note` 历史条目（`[Environment change] shell is now …`，措辞与 Shell 行同源），Context Builder 把它作为 user 消息在该位置注入；恢复会话后历史中的旧切换说明原样保留。协议约束例外：`/shell` 可在工具调用进行中执行，此时持久序上 note 会落在 `assistant`（含 toolCalls）与对应 `tool` 结果之间——OpenAI/Anthropic 要求 tool 结果紧随其调用，所以投影时这类注入说明先排队，等到该批 toolCalls 的**全部**结果就位（含结果在 `pendingMessages` 中到达的情形）才放行；调用悬空到历史末尾时排在消息尾部。持久化序不变，仅投影序调整。
5. **历史**：最近一个压缩边界之后的消息与工具结果；若存在摘要，摘要作为历史的第一条。

当前任务清单（[ADR-0028](../decisions/ADR-0028-session-task-list.md)，2026-10-01、2026-10-02、2026-10-03 修订）由 Agent Loop 和 `describeContext` 从 `SessionState.todos` 传入 Builder，作为有界的任务数据块附在请求**末尾**（历史之后）：末尾是 user 消息时并入该消息（部分兼容服务拒绝连续两条 user 消息）；末尾是工具结果时以空行分隔追加到最后一条工具结果（另起 user 消息会让推理模型把每一步当成新一轮，丢弃本轮推理，前缀缓存也随之失效）；其余情况另起一条 user 消息；它不写入历史，也不放进 system，因为清单每次更新都会让其后整段历史的提示缓存失效。空清单不注入。全部完成的清单在下一条持久化 `message.user` 到达时归档，因此该消息对应的请求不再附带当前清单块；尚有未完成项时继续注入，历史工具快照仍保留。该块计入 `ContextReport` 的 `todos` section 与预算，不依赖历史中的工具结果，所以 L1 修剪、L2 摘要与恢复后仍是最新状态。清单文字不能覆盖系统、用户或项目指令。

Builder 在请求的 `cachePrefix` 中标出"可缓存前缀"的边界：全部 system 块，加上末尾任务清单之前的全部消息（清单并入末尾 user 消息或工具结果时，该条不计入前缀）。是否以及如何使用提示缓存由 Provider 适配器决定（Anthropic 的做法见 [providers.md](providers.md) 第 4 节）。

## 4. 基本原则

- **增量构建**：除压缩边界外，不改写已经发给模型的历史，让相邻 Step 的请求共享最长前缀。
- 旧会话日志中无内容且无工具调用的 assistant 条目在请求投影时跳过；事件日志本身保持原样，避免向 Messages 接口发送空消息。
- **每一项都有上限**：工具结果在执行时就按预算截断（见 [tools.md](tools.md)），指令文件有上限，任何注入内容都不能无界增长。上下文层不负责修补无界输入。
- **可解释**：`ContextReport` 列出每一部分的来源与估算 token，用户和开发者能看到"窗口被什么占满了"。`history` 段附带 `breakdown`（[ADR-0046](../decisions/ADR-0046-desktop-tauri.md) 第 5 节）：user / assistant / tool / summary 各自的字符数与估算 token，四项之和即该段总数——assistant 的 toolCalls 序列化归 `tool`、推理块归 `assistant`、L1 修剪占位归 `tool`、摘要注入（含最近文件提示）归 `summary`、以 user 角色投影的 note 归 `user`；图片附件不计入任何一项（`report.images` 单列），其占位/描述文字随所在消息归类。估算模式与正式请求同口径给出。

## 5. Token 预算

```text
可用输入预算 = model.contextWindow − 输出预留（min(maxOutputTokens, 上限)；maxOutputTokens 未知时按兜底值预留，只用于本地估算，见 [provider-setup.md](provider-setup.md) 第 7 节）− 安全余量
当前估算     = 最近一次同一模型主请求的 inputTokens + outputTokens + 此后新增内容的估算
```

`inputTokens` 已包含缓存读写，不重复加缓存用量（[events.md](../protocols/events.md) 的 Usage 口径）。锚点之后发生图片描述、压缩或切换模型/服务商（包括切走再切回）即失效；没有有效锚点时完全使用估算，直到主请求再次返回用量。摘要请求不建立锚点。

所有字符估算统一为：CJK 统一表意文字、假名、谚文、全角标点按 1 字 1 token，其余按 4 字符 1 token；适用于纯估算、锚点后的增量、保留区边界和 `/context`。各 section 仍展示本地估算，总用量在有效时采用上游锚点。估算用于预算和压缩判定，不是计费用量。

图片附件按**每张固定 1600 token** 计入估算（`IMAGE_TOKEN_ESTIMATE`），与实际分辨率、base64 长度无关——base64 长度绝不进入字符/token 估算；`report.images` 仅在 count>0 时给出 `{ count, estimatedTokens }`（`/context` 显示为 `images` 行），占位文字按普通字符计入。

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

修剪和摘要共用保留区 `K = min(clamp(0.2·B, 20k, 40k), 0.25·B)`（`B` 为可用输入预算，[ADR-0037](../decisions/ADR-0037-compaction-retention.md)）。从最新摘要之后、之前确有新内容的闭合边界中，选择最早且其后历史估算不超过 `K` 的边界；其后的最近原文保留。最后一步本身超过 `K` 时退到最新闭合边界；摘要请求装不下时继续按 §6.6 提前边界。

进行中的 Turn 被摘要覆盖时（长 Turn 的中途压缩），该 Turn 的 `message.user` 原文在摘要之后保留，模型不会丢失当前任务的原始要求。

### 6.4 多次压缩的叠加

- 同一会话中，每种压缩的 `throughSeq` 必须严格递增；Agent Loop 保证这一点，折叠时遇到不递增的压缩事件视为不变量被破坏（记录诊断并忽略该事件）。
- **摘要是累积的**：新摘要的输入是"上一个摘要 + 其后到新边界为止的历史"，因此只有最新的摘要生效，更早的摘要与其覆盖的历史都不再进入上下文。
- **修剪只作用于最新摘要之后的历史**：生效的修剪截止点是最新摘要之后、`throughSeq` 最大的那次修剪；在其之前的工具结果显示为占位说明。
- 最新摘要之后附上「本会话最近读过或改过的文件」提示：从被覆盖的 `tool.started.subjects` 中取 `kind: read/edit` 的路径，去重、最近优先，最多 20 个；不按工具名判断、不带文件内容。来源仍是持久事件，恢复后投影相同，不改变旧会话的事件重放与状态折叠结果。
- 有效历史 = 最新摘要（若有）+ 最近文件提示 + 摘要之后的事件（修剪截止点之前的工具输出替换为占位）+ 被覆盖的进行中 Turn 的 `message.user` 原文。

### 6.5 触发

- 摘要阈值 `S` 来自 `compaction.threshold`（默认 `90%`，格式与分层见 [config.md](config.md) §2）；修剪阈值 `P = min(0.8·B, S)`。估算超过 `P` 时先尝试修剪；修剪后或不可修剪时仍超过 `S` 才尝试摘要。这类压缩是预防性的（`mustCompact = false`）。
- `S = B`（`100%` 或绝对值达到预算）时两种预防性压缩都停用，只在超预算或 `context_overflow` 时走强制路径。
- 请求已超出预算，或 Provider 返回 `context_overflow` 时，`mustCompact = true`（见 [agent-loop.md](agent-loop.md) 第 3.5 节）。
- 用户可以用 `/compact` 手动触发摘要，走同一条路径。

落地细节（自动摘要自 Phase 3 起启用，与手动 `/compact` 共用同一条 L2 路径）：

- Builder 的 `compaction` 计划按序给出：超过 `P` 且存在更新于当前修剪点的保留区边界时，计算该范围工具输出替换为占位后实际回收的估算 token；只有回收量 ≥ `R = min(20k, 0.1·B)` 才给出 `prune`。不足时跳过；超过 `S` 或必须压缩时再尝试 `summary`（计划携带 `summaryRequest`）。两种计划的判定都在 Builder 内完成，Agent Loop 只按计划执行。
- **每个 Turn 每种压缩至多执行一次**（成功或失败均不重复）：预防性压缩失败后本 Turn 不再尝试（§6.6）；`context_overflow` 到达时从未尝试过的下一级继续（prune 未试过先 prune，否则 summary），两级都已尝试后仍溢出发 `compaction_failed`。
- `summary` 计划执行成功后重建一次；重建结果仍超硬预算时不再追加尝试，Turn 以 `error(code = "compaction_failed")` 结束。
- 摘要可以在 Turn 进行中发生：此时摘要边界只落在已闭合的步骤边界上（6.3），被覆盖的进行中 Turn 的 `message.user` 原文由 Builder 依据 `state.openTurn` 在摘要后重新注入。
- prune 的呈现：最新摘要之后、`throughSeq` 及之前的工具结果替换为占位说明（保留工具名与参数摘要，标注"输出已省略"）；参数摘要来自 `tool.started.input` 折叠进历史条目的 `inputSummary` 字段（`HistoryEntry` 的兼容新增可选字段，见 [events.md](../protocols/events.md) 第 8 节）。

### 6.6 摘要请求本身的约束与失败处理

- **沿用主请求前缀**：摘要请求直接复用主请求的全部 system、工具声明，以及投影中直到边界的消息，包含上一个摘要、修剪占位与当前模型的图片投影；末尾追加一条 user 消息，要求不调用工具，并按目标、已完成、关键文件与工具结果、未决事项和下一步输出摘要。`cachePrefix` 覆盖全部 system 与边界内消息，末尾摘要指令不缓存；不携带 `reasoningEffort`。
- **摘要请求必须装得进窗口**：沿用前缀装不下时，退回独立 system + 文本转录 + 空工具集；转录沿用修剪规则。仍装不下则把边界提前到更早的闭合边界；不存在任何可行边界时不给出计划。自动压缩与 `/compact` 共用该路径。
- **边界只取新内容**：候选边界必须落在最新摘要的 `throughSeq` 之后（即摘要覆盖之后存在新的闭合边界）；最新摘要之后没有新内容时不给出计划，手动 `/compact` 因此返回 `compaction_failed` 而不是对同一历史再压出第二份摘要。
- **摘要输出有上限**（默认约 4,000 token），并作为有界内容写入事件。
- **仅回退转录不携带图片字节**：`renderTranscript` 对每个附件输出文本标记 `[image: <label ?? file>]`（不管模型能力）。正常前缀请求保留主请求的图片投影。
- **摘要只取非空文本**：有非空文本即采用并忽略模型输出的工具调用；只有工具调用、推理或空文本则按摘要失败处理，不执行工具。
- **失败、超时、被中断**：不写任何压缩事件，会话历史不变。
  - 预防性压缩失败：本 Step 照常使用未压缩的上下文，并发出 `runtime.warning`；本 Turn 内不再尝试预防性压缩，避免每个 Step 重复失败。
  - 必须压缩却失败（或没有可行边界）：Turn 以 `error` 结束，`error.code = "compaction_failed"`，提示用户手动 `/compact` 或切换到更大窗口的模型。
- 摘要请求遵守与普通请求相同的重试规则，但只尝试一轮，不嵌套压缩。

### 6.7 阶段安排

Phase 2 提供自动修剪与手动 `/compact`；Phase 3 加入自动摘要（6.5）。

## 7. 切换模型或 Provider

历史中的内容大多是中性的（文本、工具调用、工具结果），可以直接用于新模型。例外：

- 推理内容若携带 Provider 专有数据（签名、加密内容），只能回传给产生它的 Provider **且同一协议**（ADR-0026 §6）：历史 `message.assistant` 记录的协议与当前模型的生效协议相同才保留 `providerData`，否则（跨 Provider、跨协议，或新模型协议无从比对时）丢弃这类推理块的专有数据。历史条目缺 `protocol` 字段（旧日志）时按旧规则只比较服务商。
- 新模型不支持图片输入（`capabilities.imageInput` 为 false）时，历史中的图片附件优先使用已持久化的描述；vision 可用时在下一次请求前补描述，没有描述则投影为占位文字 `[image omitted: current model does not support image input]`——附件引用仍在历史里，切回支持图片的模型后同一附件会重新以图片发出（第 3 节投影规则）。同一逻辑还产出另外两种占位：`[image unavailable: attachment file missing]`（附件文件读不回）与 `[image omitted: exceeds the per-request limit of 20 images]`（超出单请求 20 张上限的较旧图片）。
- 新模型窗口更小时，按第 6 节的规则压缩。

这些判断依据 `ModelInfo.capabilities` 与内容块上记录的来源 Provider，而不是按 Provider 名字写分支。

## 8. 暂不设计

仓库地图（repo map）、语义检索、长期记忆、跨会话知识。它们将来作为新的上下文来源（section）接入第 3 节的顺序中，并在 `ContextReport` 中可见。

## 回退说明

[ADR-0041](../decisions/ADR-0041-checkpoints-rewind-fork.md) 使用既有 `note` 条目：只回退对话时插入「对话已回退，但文件保持回退前的状态，可能包含已撤销对话中的改动」；只还原文件时追加「用户把以下文件还原到了某一轮之前的状态：<成功路径列表>」；两者一起回退无需 note。图片描述与已尝试描述的缓存只从有效事件派生，被撤销的描述不继续投影。压缩边界随有效历史截断，原始日志中的角色用量保持累计。
