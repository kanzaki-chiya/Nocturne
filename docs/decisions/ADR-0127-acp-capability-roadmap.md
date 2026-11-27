# ADR-0127：ACP 能力分期

- 状态：已接受（分期方向已确认，本轮实施范围为第一阶段）
- 日期：2026-11-27

基线为公开版本 v0.68.0。后续阶段单独派发和验收。参考现有 ADR-0120、ADR-0049、ACP 配置协议与目标版本的 Paseo provider SDK。

## 第一阶段：派单时选择模型和思考强度

`nctrn acp` 使用工作区的真实模型目录和会话当前值，提供 `model` 和模型支持的 `thought_level` 选项。通过 `session/new` 的 `configOptions` 和 `session/set_config_option` 接入 Core。切换模型后回报完整配置和有效档位；宿主忽略配置时沿用现有默认选择。区分进行中轮次的快照与下轮配置。核查目标版本 Paseo 的建单前目录探测、配置 setter 与空目录兼容；确有差异再在插件端适配。

验收：同一 Paseo 宿主为两个 Nocturne 任务分别指定不同模型和档位，用实际 provider 请求或可复核的测试 provider 记录核对选择、生效值与会话隔离；注明真实模型和测试替身各自覆盖的环节。非法配置保持原值，新建会话仍可按默认值运行。

## 第二阶段：跨进程恢复同一会话

从已持久化的 Nocturne 会话实现 `session/load`。恢复时检查工作区和会话归属，重建本次宿主的 MCP 工具和审批回调，回放保留的历史。优先支持按已知 ID 恢复，是否提供会话列表单独决定。

验收：结束实际 ACP 进程，新进程加载同一 ID，先前的对话和工具记录只出现一次，模型记得之前的决定，随后能完成新的需审批操作。验证换宿主工具配置和错误工作区的行为。

## 第三阶段：让用户回答 agent 的问题

核对锁定 SDK 和目标宿主的 elicitation 能力，支持时将 Core 提问映射到宿主交互。区分回答、用户主动拒答、取消以及宿主不支持；不支持时以可见的普通问题交给用户，允许下一轮带答案继续。

验收：同一任务在支持结构化提问的客户端和仅支持文本的客户端各跑一次，检查用户看到的问题、实际回传值、取消后的结束状态。

## 第四阶段：图片、文件与执行进度

分两笔交付。先支持模型能处理的图片和内嵌文本资源，保留资源链接语义、大小限制和已有读文件权限。再映射计划、压缩、用量及内部子代理进度；按目标 SDK 与客户端能力提供。以用户实际使用的斜杠命令补充命令发现。

验收：从宿主发送截图和代码片段，检查模型收到的内容及不支持时的反馈。用长任务检查计划和压缩状态的开始、结束及归属；若展示子代理，区分 Nocturne 内部子代理与 Paseo 自己创建的 worker。

## 第五阶段：Nocturne 调用外部 agent 时支持续派

维护外部 worker 在宿主中的稳定标识，关联 provider、外部会话 ID 和工作树。支持恢复的 provider 可以继续同一会话；只支持单次执行的 provider 显示实际能力。允许按任务显式注入限定的团队 MCP 工具。单次 `task(agent=…)` 的调用语义保留。此阶段可用 Nocturne 自身流程验收，Matins 不构成前置依赖。

验收：外部实现 agent 交付，审查 agent 提出具体问题。重启宿主，再按原 worker ID 将意见交回，实现 agent 在原工作树基于原上下文修改；核对其他 worker 无法收到专属工具。

## 取舍

建议先做第一阶段，再依次推进恢复和提问。第四阶段的进度项可以单独选做。额外工作目录、宿主追加系统提示、音频及会话管理操作等需求，等有明确消费者再排期。每阶段固定记录 Nocturne、ACP SDK、宿主及插件版本，分别列出协议测试和真实宿主验收结果。

## 实施记录

### 第二阶段（2026-11-27 验收）

实现要点：

- `nctrn acp` 的 `session/new` 在 `session.created.client` 写入 `{ kind: "agent", name: "acp" }` 归属标记（复用 ADR-0074 已有可选字段，兼容变更不提升 formatVersion）。`session/load` 按已知 ID 恢复：校验请求 `cwd` 为绝对路径且目录存在、会话归属 ACP 且不是子会话、请求 `cwd` 与会话当前执行目录一致（`config.worktree.current ?? meta.cwd`，按真实路径比较）；不符合的 ID、外来会话与子会话一律 `resourceNotFound`，工作区不匹配 `invalidParams(workspace_mismatch)`，锁被占用返回 `session_locked` 错误且不强制夺锁。
- 恢复经 Core `resumeSession` 并注入本次连接的宿主 MCP（`ResumeSessionOptions.sessionMcp`），历史按协议时序在 load 响应之前回放：`user_message_chunk`（`userEntryText` 去快照块）、`agent_message_chunk`/`agent_thought_chunk`、终态 `tool_call`——不重新执行工具、不重放审批、历史不重复计入上下文。
- `initialize` 广告 `loadSession: true`；旧宿主 `new/prompt` 流程不变。

返工修正（2026-11-27，本阶段验收前）：资格校验的次序与路径比较按主审意见修正——

- 归属、子会话与工作区校验原先在 `resumeSession` 返回完整会话之后才做，Core 会先取锁、装配宿主 MCP 并包装会话，可能在拒绝前误关闭借来的会话或启动宿主工具。修正为把这三项校验放进 `resumeSession` 新增的 `validate` 回调：在取得会话锁、读取持久化状态之后，装配宿主 MCP、绑定工具或投递历史之前执行；校验失败关闭会话、释放锁，宿主工具从未绑定，且与最终恢复读取同一份会话状态（无读改竞态）。id 格式、`cwd` 合法性等不依赖持久化状态的校验仍在锁前完成。
- 工作区比较原先对所有平台一律 `.toLowerCase()` 并替换反斜杠，会把 POSIX 上大小写或反斜杠不同的独立目录误判为相同。修正为用平台真实路径语义（`paths.equals` 按平台大小写规则 canonicalize）：POSIX 保持区分，Windows 等价路径仍正常匹配；会话工作目录 realpath 失败时拒绝恢复，不再回退到未经验证的字符串比较。

收尾修正（2026-11-27，本阶段验收后）：受校验恢复的入口唯一化——

- `resumeSession` 对活动合奏/组曲成员本有共享快路径（`ensembleMember`/`suiteThread`，命中即返回 Runtime 托管的借用 proxy），原先在 `validate` 之前执行，命中会跳过校验。修正为：携带 `validate` 的恢复从进入 Core 起只走取锁、校验、包装这一条路径，整体跳过共享快路径——不查询、不打开、不借用共享成员。是否为合格顶层会话正是 `validate` 的职责，不能由快路径截胡；且 `openOrGetMemberBySessionId` 可能懒打开尚未在用的成员，校验中的恢复不应触发这种副作用。活动成员会话因被 Runtime 托管持锁，受校验恢复在取锁时以 `session_locked` 拒绝——这是预期结果：宁可不恢复，也不返回绕过资格校验的借用会话。未携带 `validate` 的调用方（桌面端等）共享行为不变。合成 Core fixture 对比见 `packages/core/test/ensemble-member-close.test.ts` 的「受校验恢复与普通恢复的共享成员分流」。

版本：Nocturne 0.68.0（开发分支）、ACP SDK `@agentclientprotocol/sdk` 1.7.0（Nocturne 侧）/ 1.9.0（Paseo 侧捆绑）、Paseo daemon 与 `@getpaseo/plugin` 0.17.5。Paseo 0.17.5 无需插件改动：其 acp-internal 连接在 `agentCapabilities.loadSession` 时自动广告 `session.persistence`，`session.open` 带 persistence 时调用 `loadSession` 并在 ready 前消费回放。

验收结果：

- 协议测试：真实 stdio 进程 A/B——A 建会话跑工具轮后 EOF 退出（锁释放），B 同 NOCTURNE_HOME 以 `session/load` 恢复：用户 chunk 恰 1 条、agent text 含合成标记、工具帧全终态、零权限请求、新轮 provider 请求体中标记恰出现 1 次、错误 cwd `-32602`、重复 load `-32600`、无锁泄漏（`apps/cli/test/acp-stdio.test.ts` 9/9）。单测覆盖归属标记、无效/外来/子会话拒绝、并发重复 load、占用冲突、断线与失败清理（`packages/acp/test/agent.test.ts` 29/29）。
- 真实宿主验收（隔离 Paseo daemon `127.0.0.1:6933` + 测试 capture provider `127.0.0.1:13552`，证据在 `Z:\nocturne-mockups\impl\r1126k\testhost\`）：Paseo agent `75c078f3` 经 nocturne provider 创建，首轮写入含合成决定 `KESTREL-7821` 的 write 工具调用（经审批桥批准），记录 ACP sessionId `202611262113-a3f8c373`；daemon `restart`（worker 102208→74484→94524）后 `agent reload` 重开——同一 sessionId 恢复、persistence 不变、时间线恰一份（连续多次 reload 条目数不重复累积）、恢复后新轮 provider 请求体中 `KESTREL-7821` 恰 1 份且消息数逐轮递增、恢复后新的 write 审批正常出现并被批准、宿主注入 MCP（`mcp__paseo__*` 19 项）在每次新连接的新轮 tools 中齐备。
- 限制：第一阶段之前创建的旧 ACP 会话没有归属标记，按设计**不可**经 `session/load` 恢复（拒绝为 `resourceNotFound`）——恢复接口不成为打开任意本地会话的入口。Paseo `agent reload` 在 idle 宽限期内会话本就关闭时也能重开（Paseo 0.17.5 idle-keep-alive 设计），锁文件按 ADR-0009 失效判定清理。

### 第三阶段（2026-11-27 验收）

实现要点：

- `ask_user` 产生的 `question.requested` 按宿主能力分流。宿主在 `initialize` 显式声明 `clientCapabilities.elicitation.form` 时走结构化 `elicitation/create` 请求：把 Nocturne `questions` 映射为 form JSON Schema——每题占 `q1..qN` 属性，单选选项题用 `oneOf`（`title`/`description` 保留标签与说明），多选题用 `array`+`anyOf`，自由文本题用 `string`，自由文本边界 `maxLength: 2000`（与 ADR-0032 一致）；请求带 `sessionId` 与 `toolCallId`，用户可据此确认在回答哪个会话的哪个问题。`accept` 的 `content` 按位置映射回 `QuestionAnswer[]`（选项题进 `selected`、自由文本进 `text`）经 `respondQuestion` 回写原会话、原轮次、原请求；**只有用户明确拒绝才**逐题写成 `declined`；`cancel`、`elicitation/create` 请求失败或返回未知 action 一律取消当前 Turn（`turn.completed` 按中断结算），**绝不**写成「用户拒绝回答」。
- 宿主未声明 `elicitation.form`（Paseo 0.17.5 发送 `clientCapabilities: {}`）时按文本退化路径：把问题与编号选项（含多选/自由文本提示）作为 `agent_message_chunk` 交给宿主展示，然后经 Core 新增的 `RuntimeSession.questionSuspend(requestId)` 把等待中的提问结算为 `handoff_suspended`——ask_user 的工具结果不是「用户拒绝回答」，而是明确指引「宿主已把问题展示给用户并交还控制，当前轮按挂起结束。不要就同一问题再次提问，也不要按假设执行依赖该选择的动作；等用户在下一轮给出答复后继续」。这样当前轮以可见问题收尾、控制正常交还宿主，下一轮用户答复作为普通消息进入、由模型按真实回答继续；`handoff_suspended` 不会中断 Turn、不算错误失败，模型在没有答复前不执行依赖该选择的下游动作。`questionSuspend` 仅用于宿主已完整展示问题但不能结构化回收的场景；用户明确拒绝仍走 `respondQuestion` 的 `declined`，取消/断连走 `interrupt`。
- Core 侧为 broker 增加最小的挂起语义（`packages/core/src/tools/types.ts`、`tools/question.ts`）：`AskUserReply` 新增 `{ kind: "suspended" }`，`QuestionBroker` 增加 `suspend(requestId)`/`pendingKeys()`；`questionSuspend` 是进程内接口（`RuntimeSession`），不暴露 RPC——只有同进程的 ACP 宿主通道使用。
- 结构性约束：审批桥只服务于权限请求，与提问通道完全分离；`elicitation` 不映射权限、权限请求不混入提问。文本退化路径在 `session/load` 回放已持久化历史时不重新弹出旧问题——文本问题块本就是当轮的 `agent_message_chunk`（不持久化），load 只回放持久化的用户/助手/工具帧。

版本：Nocturne 0.68.0（开发分支）、ACP SDK `@agentclientprotocol/sdk` 1.7.0（Nocturne 侧）/ 1.9.0（Paseo 侧捆绑）、Paseo daemon 与 `@getpaseo/plugin` 0.17.5。Paseo 0.17.5 的 acp-internal 连接发送 `clientCapabilities: {}`，实测本阶段在 Paseo 走的是文本退化路径；结构化 elicitation 路径由协议测试与真实 stdio 客户端验收，不能写为 Paseo 的能力。

验收结果：

- 协议单测：elicitation schema 映射（单选/多选/自由文本）、`accept` 回写真实答案、`decline` 逐题 `declined`、`cancel`/请求失败/未知 action 取消 Turn、取消后会话仍可接受下一轮、两个并发会话互不串答、`session/load` 不重弹旧问题（`packages/acp/test/agent.test.ts` 480，含 1 跳过）；Core 挂起语义钉住测试（`packages/core/test/ask-user-handoff.test.ts` 3/3）。
- 真实 stdio 客户端（`apps/cli/test/acp-stdio.test.ts` 13/13）：声明 `elicitation.form` 的客户端接到 `elicitation/create` 并以 `accept` 回应后，provider 第二轮请求携带所选答案（非「用户拒绝回答」）；`decline` 让 provider 看到「用户拒绝回答」、`cancel` 使本轮 `stopReason=cancelled`；未声明 elicitation（Paseo 风格 `{}`）的客户端看到编号选项文本、`handoff_suspended` 收尾、下一轮由用户答复继续。stdout 全程只写合法 JSON-RPC 帧。
- 真实宿主验收（隔离 Paseo daemon `127.0.0.1:6933` + 测试 capture provider `127.0.0.1:13552`，本分支打包的 nctrn 0.68.0，证据在 `Z:\nocturne-mockups\impl\r1126l\testhost\`）：agent `f69f2621` 首轮触发 ask_user 决策题「发布策略用哪个通道？」，Paseo 时间线如实展示编号选项文本，ask_user 结算为 `handoff_suspended`（不是「用户拒绝回答」）、当前轮正常结束；用户下一轮发「1」后，再发 `RELEASE-CHECK` 触发依赖该选择的下游 write——经真实审批桥批准后 `release-channel.txt` 落盘内容恰为 `通道A-金丝雀`。全程 provider 请求日志中 `declinedMentions=0`（从未把挂起/取消误写为用户拒答）。取消后（`stop` 回 idle）会话仍可接受下一轮并正确回复；daemon `restart`（worker 109136→112520）后 `agent reload` 经 `session/load` 恢复，时间线不重复累积、旧问题不重新弹出（文本问题块仅出现于当轮）。
- 限制：文本退化路径的用户答复是下一轮普通消息、由模型自由解读（宿主不做结构化映射）；多题/多选在文本路径按编号文本作答，精度依赖模型理解。`elicitation` 的 `url` 模式未使用（Nocturne 提问不涉及跳转外部 URL）。`questionSuspend` 不暴露 RPC，远程客户端不能触发挂起——只有同进程 ACP 宿主使用。

返工修正（2026-11-27，本阶段验收后复审发现四项行为未真正落实）：

- **挂起后本轮有序收尾**：`questionSuspend` 原先只结算 broker——`ask_user` 返回常规工具错误后运行时仍发起下一次推理，可能执行依赖答复的批内后续动作。修正为运行时控制（`packages/core/src/agent/turn.ts` + `packages/core/src/index.ts`）：broker 在 `suspend` 结算时登记 `turnId`（`suspendedTurns`），顶层会话 TurnDeps 注入 `shouldFinish: (_state, turnId) => questions.isTurnSuspended(turnId)`——handoff 的 `tool.completed` 写入后命中 `shouldFinish`，本轮以 `done` 有序收尾、不再发起下一次推理，批内未开始调用由 `finish()` 结算为 cancelled。判定按结果语义（`isTurnSuspended`）而非工具名，不写工具名分支。ACP 端 `stopReason` 为 `end_turn`。钉住测试：`packages/core/test/ask-user-handoff.test.ts` 的「挂起后本轮有序收尾」用 FakeProvider handler 精确计数推理次数——第 2 次推理若发生会返回依赖答复的合成写操作（`dependent-write.txt`/`ASSUMED-WRITE`），正确行为下该 write 不落盘、handoff 轮内推理恒为 1 次；用户答复后新一轮按真实值继续。
- **恢复可见问题**：此前文本退化路径的问题块是当轮临时 `agent_message_chunk`（不持久化），提问后、回答前重开会话时历史里看不到此前的问题。修正为 `session/load` 回放时重建（`packages/acp/src/agent.ts` 的 `replayHistory`/`flushTool`）：handoff 的 `ask_user` 输入（含完整 `questions`）本就随 `tool.started.input` 持久化，回放检测到 `tool.completed.error.code === "handoff_suspended"` 的 `ask_user` 时从其 input 用 `formatTextQuestions` 重建同一份问题展示、作为 `agent_message_chunk` 投影——用户在等待回答中重开会话仍能看到问题与选项，历史展示恰一份、不重新发 elicitation（这里只是历史投影，不触发新的提问请求）。确定性回归：`packages/acp/test/agent.test.ts` 的「提问后、回答前重开会话」断言 load 回放中问题与编号选项恰出现一份、新轮仍可正常进行。
- **forwardQuestion 轮次绑定**：原先 `forwardQuestion` 的异步 elicitation 处理不区分轮次——旧轮迟到的 cancel/错误会 `cancelEntry` 取消正在运行的新轮；accept 中缺失/非法答案被 `respondQuestion` 以 `invalid_reply` 拒绝时只记录诊断，broker 悬空等待。修正（`packages/acp/src/agent.ts`）：`ManagedSession` 增加 `activeTurnId`（`turn.started` 置位、`turn.completed` 清除）与 `pendingQuestions`（requestId → 发起时 turnId）；响应到达先 `settleQuestion` 再校验 `isLiveQuestion()`（发起轮仍是活动轮）——旧轮迟到的响应记录 `question_response_stale` 诊断后丢弃，不作答、不取消新轮；`invalid_reply` 时记录 `question_accept_invalid` 诊断并对活动轮 `cancelEntry` 明确收尾（broker 不悬空）。确定性回归：「旧轮取消、新轮运行后才收到旧 elicitation 响应」用可控挂起的 elicitation 与 `wait` 脚本制造真竞态，断言新轮 `stopReason` 为 `end_turn`；「无效 accept」断言本轮 `cancelled`、不写成「用户拒绝回答」、会话仍可用。反向验证：移除轮次保护后旧响应确实取消新轮、移除 invalid accept 的 `cancelEntry` 后 broker 悬空（测试超时）——两处保护均被测试真正抓住。
- **真实 Paseo 文本端按真实回答继续**：复验确认用户只发实际选择（对决策题答「1」）即可继续原任务，无需另发触发词。本分支打包 nctrn 0.68.0（tgz sha256 `2C8C1FF2…`），隔离 daemon `127.0.0.1:6933` + capture provider `127.0.0.1:13552`：turn1 `ask_user` 结算 `handoff_suspended`、agent 回 idle、provider 日志在 ask_user 后无多余推理；用户发「1」后 capture provider 直接发起依赖该选择的 write（唯一标记 `RLSE25A7`），经真实审批桥 `permit allow` 批准后 `release-channel.txt` 落盘内容恰为 `RLSE25A7-通道A-金丝雀`；全程 `declinedMentions=0`。daemon `restart`（worker 114992→114068）后重新加载，时间线仍能看到此前的问题与编号选项、恰一份、连续两次加载条目数不累积（6=6），恢复后新轮正常回复。证据在 `Z:\nocturne-mockups\impl\r1126l\testhost\evidence\f*.json`、`f9-versions.txt`。
### 第四阶段（2026-11-27 验收）

分两笔交付：第一笔图片与内嵌文本附件（含交错排序），第二笔执行进度与命令发现。

实现要点（第一笔，附件）：

- `convertPromptBlocks`（`packages/acp/src/agent.ts`）把 ACP prompt 块保序转换：`text` 块按序进 content，`image` 块落 attachments 并用 `afterBlock` 记录它应插入到第几个文本块之后（交错位置提示，不默认移到所有文字后面），`resource`（内嵌文本资源）转为带 `<resource uri=…>` 围栏的有序快照块，`resource_link` 保留链接语义（投影为 markdown 链接文本，**不**抓取 URL 或文件、不绕开既有读文件权限）。
- `afterBlock` 交错位置贯穿 Core：协议类型 `ImageAttachment.afterBlock`、持久化校验（`tools/file-attachments.ts` 要求非负整数）、上下文投影（`context/build.ts` 有位置时把附件占位文本穿插到对应文本块之后、图片引用保留 `afterBlock`）、provider 适配器（`provider/adapters/ai-sdk-common.ts` 把带 `afterBlock` 的图片 `image_url` 部件穿插到对应文本块之后，无 `afterBlock` 的旧附件仍追加末尾——旧消息兼容）。
- 模型能力校验：图片内容只在当前模型 `capabilities.imageInput === true` 时提交；不支持时 `session/prompt` 整体拒绝 `image_input_unsupported` 并明确反馈，**不**降级丢弃图片、**不**提交残缺消息。能力声明与实际支持相符。

实现要点（第二笔，进度与命令发现）：

- 成功的 `todo_write` → 完整清单替换式 `plan` 更新（ACP 语义：每次发送完整清单；签名去重避免重复投影，状态按条目映射）。
- `turn.completed.usage` 加 `describeContext` 水位 → `usage_update`：`used` 取当前上下文估算 `estimatedTokens`、`size` 取预算 `budgetTokens`，跨轮累计用量进 `_meta` 供需要总量的宿主读取；`describeContext` 失败时静默跳过（不影响主事件流）。
- 压缩生命周期：`runtime.status=compacting` 开启一段、`context.compacted` 完成它、无配对 `idle` 终态化为 `cancelled`；`compaction_update` 带会话内唯一 `compactionId` 配对（压缩在 Turn 外进行，按 session 归属）。
- `available_commands_update` 只公布 `/compact`——它是唯一经 ACP 真实可工作的会话命令：`session/prompt` 拦截裸 `/compact` 单文本块调用 `session.compact()`，**不进入模型推理**；其余 CLI 斜杠命令依赖 TUI/REPL 交互，不予公布。

版本：Nocturne 0.68.0（开发分支，本分支打包 `nocturne-cli-0.68.0.tgz` sha256 `83B0EF29AA00AE04F9E9BD0A761A471630F871900629F216D9C9E1F2E2EB7953`）、ACP SDK `@agentclientprotocol/sdk` 1.7.0（Nocturne 侧声明）。Paseo daemon 与 `@getpaseo/plugin` 0.17.5，其实际用于 acp-internal 连接的 ACP SDK 为 `@getpaseo/plugin` 嵌套的 **1.4.0**（注：第二、三阶段实施记录写的「Paseo 侧捆绑 1.9.0」经本次复核不确——嵌套副本实测 1.4.0，顶层另有 0.17.1 副本非 acp-internal 所用）。

验收结果：

- 协议单测：混合文本与图片保序（content 块按 textA/B/C 顺序、images 各带正确 `afterBlock`）、内嵌文本资源转有序快照块、`resource_link` 保留链接语义不抓取、`image_input_unsupported` 拒绝残缺、`/compact` 拦截触发压缩且不进入推理、plan 签名去重、usage/compaction 配对与归属、available_commands 只含 compact（`packages/acp/test/agent.test.ts` 57/57）；Core 上下文投影交错（context 106/106）、openai-compatible 适配器 `image_url` 穿插（37/37）。混合顺序的失败回归经 stash 实现后验证测试确实失败（鉴别力）。
- 真实 stdio 客户端（`apps/cli/test/acp-stdio.test.ts` 17/17）：混合图片与文本附件按 `text A/image1/text B/image2/text C` 顺序投影到真实 provider 请求（逐 part 断言类型与顺序）；`/compact` 真实 stdio 压缩配对 `compaction_update` 且不进入推理；长任务核对 plan/usage/commands 事件顺序与归属（available_commands 早于 plan、plan 早于 usage）。
- 真实宿主验收（隔离 Paseo daemon `127.0.0.1:6934` + 测试 capture provider `127.0.0.1:13553`，本分支打包 nctrn 0.68.0，证据在 `Z:\nocturne-mockups\impl\r1126n\testhost\evidence\`）：Paseo agent `a20edfb7` 首轮经 `--image` 提交合成截图，capture provider 日志 `e1-cap-log-turn1.jsonl` 记录 partShape `[text:TRACK-WORK…|image]`——**交错顺序真实到达宿主**（图片未移到文字后）；图片指纹 `{mime:image/png,base64Len:236,head:iVBORw0KGgoAAAANSUhEUgAA,tail:SUVORK5CYII=}` 真实到达 provider 请求体（`e4-cap-log-image-fingerprint.jsonl`）。`TRACK-WORK` 触发 `todo_write` 后宿主时间线 `e2-timeline-progress.json` 出现独立 `todo` 条目（3 项）——**plan 更新被 Paseo 真实渲染为 todo**。usage_update 经 Paseo acp-internal 连接（connection.js 1326 行）映射为 `session.usage`、compaction_update（1341 行）映射为 timeline `compaction` 条目——均非落 default 丢弃。
- 限制（宿主边界，重要修正）：Paseo 0.17.5 的 agent-message 通道把**所有**消息——包括斜杠命令——包装为 `<paseo-system version="1" kind="agent-message">` XML 信封。经宿主 MCP 驱动发送 `/compact` 时，到达 ACP 的文本是信封包裹而非裸 `/compact`，因此**不**命中裸命令拦截、按普通用户输入进入推理（capture log `e7-cap-log-all.jsonl` 末行 msgCount 递增为证）。这是宿主信封机制的固有边界，不是实现缺陷：裸 `/compact` 拦截在协议层与真实 stdio 客户端验收中正确工作（对照实验：全新 agent `ff47b344` 直接 `paseo run '/compact'` 首条消息为裸 `/compact` 时，capture log 无新增普通推理、timeline 出现 compaction 条目与「压缩失败：没有可行的压缩边界」真实反馈——拦截生效且压缩流程真实执行）。`plan`/`usage_update`/`compaction_update`/`available_commands_update` 在 Paseo 0.17.5 均经 acp-internal 连接真实处理；`elicitation` 仍因 Paseo 发送 `clientCapabilities: {}` 走文本退化（第三阶段结论不变）。Nocturne 内部子代理（task 工具）与宿主 MCP 创建的 Paseo agent 分属不同计数：内部子代理进度不映射为 ACP 宿主可见更新（ACP 无对应更新类型），仅宿主自己创建的 worker 在宿主侧计数。
