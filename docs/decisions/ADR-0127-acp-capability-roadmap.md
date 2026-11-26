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

版本：Nocturne 0.68.0（开发分支）、ACP SDK `@agentclientprotocol/sdk` 1.7.0（Nocturne 侧）/ 1.9.0（Paseo 侧捆绑）、Paseo daemon 与 `@getpaseo/plugin` 0.17.5。Paseo 0.17.5 无需插件改动：其 acp-internal 连接在 `agentCapabilities.loadSession` 时自动广告 `session.persistence`，`session.open` 带 persistence 时调用 `loadSession` 并在 ready 前消费回放。

验收结果：

- 协议测试：真实 stdio 进程 A/B——A 建会话跑工具轮后 EOF 退出（锁释放），B 同 NOCTURNE_HOME 以 `session/load` 恢复：用户 chunk 恰 1 条、agent text 含合成标记、工具帧全终态、零权限请求、新轮 provider 请求体中标记恰出现 1 次、错误 cwd `-32602`、重复 load `-32600`、无锁泄漏（`apps/cli/test/acp-stdio.test.ts` 9/9）。单测覆盖归属标记、无效/外来/子会话拒绝、并发重复 load、占用冲突、断线与失败清理（`packages/acp/test/agent.test.ts` 29/29）。
- 真实宿主验收（隔离 Paseo daemon `127.0.0.1:6933` + 测试 capture provider `127.0.0.1:13552`，证据在 `Z:\nocturne-mockups\impl\r1126k\testhost\`）：Paseo agent `75c078f3` 经 nocturne provider 创建，首轮写入含合成决定 `KESTREL-7821` 的 write 工具调用（经审批桥批准），记录 ACP sessionId `202611262113-a3f8c373`；daemon `restart`（worker 102208→74484→94524）后 `agent reload` 重开——同一 sessionId 恢复、persistence 不变、时间线恰一份（连续多次 reload 条目数不重复累积）、恢复后新轮 provider 请求体中 `KESTREL-7821` 恰 1 份且消息数逐轮递增、恢复后新的 write 审批正常出现并被批准、宿主注入 MCP（`mcp__paseo__*` 19 项）在每次新连接的新轮 tools 中齐备。
- 限制：第一阶段之前创建的旧 ACP 会话没有归属标记，按设计**不可**经 `session/load` 恢复（拒绝为 `resourceNotFound`）——恢复接口不成为打开任意本地会话的入口。Paseo `agent reload` 在 idle 宽限期内会话本就关闭时也能重开（Paseo 0.17.5 idle-keep-alive 设计），锁文件按 ADR-0009 失效判定清理。
