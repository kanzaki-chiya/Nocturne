# ADR-0091：一次性内置子代理权限确认向父会话转发

- 状态：已接受
- 日期：2026-11-14
- 修订：[subagent.md](../architecture/subagent.md)（§4、§7.1–§7.3、§12、§20）、[permissions.md](../architecture/permissions.md)（§5.4、§7、§8）、[events.md](../protocols/events.md)、[view.md](../protocols/view.md)、[rpc.md](../protocols/rpc.md)、[ADR-0013](ADR-0013-subagent.md)（内置 `task` 在交互父会话下支持 `ask` 转发）、[ADR-0056](ADR-0056-session-notifications.md)（父会话转发子请求参与失焦通知）、[ADR-0060](ADR-0060-desktop-side-panel.md)（桌面右侧子代理标签在有活动转发权限时可就地回应）、[ADR-0073](ADR-0073-background-subagents.md)（父 `interrupt` 结算等待请求的精确范围）

## 背景

[ADR-0013](ADR-0013-subagent.md) 决定将一次性 `task` 子代理置于无交互模式下运行：任何最终判定为 `ask` 的工具调用都会被权限门直接以 `non_interactive` 拒绝。[ADR-0089](ADR-0089-ensemble.md) 只对常驻合奏（Ensemble）成员放开了交互权限门，把待确认请求挂在成员自身会话并通过 `ensemble.member_updated` 汇报给指挥；但日常通过内置 `task` 派生的前/后台一次性子代理（含 `general`、`explore`、共享工作区或独立工作树隔离）在 `default` 等严格权限预设下仍会因无法请示用户而被直接拒绝，导致可写或需执行命令的子任务受阻。

同时，[subagent.md](../architecture/subagent.md) 第 7.1 节已预留了「方案 (a)：把子会话的确认请求冒泡到父客户端」的方向。本决定将这一能力完整落地，并明确权限、持久化、生命周期清理、双层/祖先超时排除与多端一致边界。

## 决定

### 1. 适用范围与不变边界

- **转发范围**：交互式父会话（`interactive: true`）派生的全部内置 `task` 一次性子代理——涵盖前台与后台（`background: true`）、`general` 与 `explore` 角色、共享工作区与独立工作树（`isolation: "worktree"`）模式，以及 `maxDepth > 1` 时的直接后代与嵌套后代。
- **保持不变的场景**：
  - 非交互宿主（`interactive: false`、定时任务会话、`nctrn -p`）下的子代理仍维持 `non_interactive` 拒绝行为，不产生等待。
  - `--yes`、规则命中、Hook、项目 Grant、`autoApproveAsk` 与 `smart` 审查链均保持原有语义不变；子代理有效权限仍不宽于父会话（包括嵌套后代继承更窄的祖先边界）。
  - 外部 ACP agent（`task({ agent })`）及 `ask_user` 工具（[ADR-0032](ADR-0032-ask-user-tool.md)，子代理不挂载该工具）保持原样，不参与本转发机制。
- **硬性约束**：不在 Agent Loop 或 Context Builder 中按工具名写分支；权限判定与等待完全停留在权限层（`createPolicyGate` 注入 `interactive: true`、`pauseTimeouts`、`onPendingSettled`）与 `SubagentPermissionsDeps` 活动转发池接线中。

### 2. 协议、视图聚合与持久化隔离

协议类型与排序辅助导出自 `@nocturne/core/protocol`（并由 `@nocturne/core` 与 `@nocturne/rpc/client` 重导出）：

- **`PendingPermission.seq?`**：`reduceSessionView` 归约持久化 `permission.requested` 时填入 `event.seq`，供父会话自身确认请求与转发的子代理确认请求按到达顺序混排。
- **`SubagentPendingPermission extends PendingPermission`**：附带路由与展示字段：
  - `childSessionId`：请求来源子会话 ID（含嵌套后代自身的子会话 ID），作为回应路由入参；
  - `parentCallId`：父会话发起该子代理链路最外层 `task` 的 `callId`（嵌套后代沿用根 `task` `callId`）；
  - `profile`：与 `SubagentSummary.profile` 同口径（`preset` 优先，其次非 `default` 的 `profile`，缺省 `""`）；
  - `taskSummary`：与 `SubagentSummary.taskSummary` 同口径（单行最多 120 码点）；
  - `afterSeq`：请求进入父转发池时父会话的 `lastSeq`；
  - `order`：父会话内单调递增到达序号（从 `1` 起）。
- **`SessionView.pendingSubagentPermissions`**：由 `createSessionView()` 与 `replaySessionView()` 恒初始化为 `[]`。
- **临时快照事件 `"subagent.permissions"`**：载荷为 `SubagentPermissionsPayload = { pending: SubagentPendingPermission[] }`。每次增删、结算或父关闭清理向父订阅者推送完整当前快照；父会话 `subscribe()` 时若存在未决子请求，立即补发一条 `eseq: 0` 快照。
- **全局混排助手 `allPendingPermissions(view)`**：返回 `AggregatedPendingPermission[]`（`{ kind: "session", permission } | { kind: "subagent", permission }`），按 `session` 键 `(seq ?? 0, 0)` 与 `subagent` 键 `(afterSeq, order)`（`order >= 1`）升序合并，支持并发多请求按到达顺序独立呈现与回应。
- **持久化严格隔离**：`permission.requested` 与 `permission.resolved` **只**写入发起请求的子会话自身日志；父会话日志绝不落盘外来 `callId` 或子会话权限事件。进程重启后 `replaySessionView` 的 `pendingSubagentPermissions` 恒为空，不恢复过期实时等待。

### 3. 回应路由、树共享授权与安全边界

- **`RuntimeSession.respondSubagentPermission(childSessionId, requestId, reply)`**：
  - 仅在当前父会话通过 `SubagentPermissionsDeps` 维护的活动转发池中按 `(childSessionId, requestId)` 精确匹配。直接后代与嵌套后代（`maxDepth > 1`）的转发请求均登记在最外层交互父会话的活动转发池中，因此无需先切入中间或目标子会话即可在父会话直接回应。
  - 未匹配、已结束或跨会话树的调用一律抛出 `RuntimeCommandError("unknown_request", ...)`，且不触碰或清除其他未决条目。
  - 校验通过后直接委托目标子会话原 `gate.respond(requestId, reply)`：保留 `confirmationOptions` 校验与 `invalid_reply` 报错，且在校验或并发写盘完成前不先移除 pending 条目（防止非法回复或写盘竞争误清请求）。
  - 选项集合与父会话完全一致：`allow`（`remember: "session"`）写入父子共享的会话树 `sessionGrants`（父会话及同树其余/后续子代理对同一范围不再重复询问）；`remember: "project"` / `"always"` 沿用父会话 `saveAppPermissions` / 项目 Grant 写入。
  - 原 `respondPermission` 仍只处理当前会话自身的 `gate`。
- **RPC 与远程边界**：
  - `packages/rpc` 新增 `"session.respondSubagentPermission"`（入参 `SessionParams & { childSessionId: string; requestId: string; reply: PermissionReply }`，返回 `null`）。
  - 该方法纳入 `REMOTE_METHODS`，并在 `checkRemote` 中与 `session.respondPermission` 同口径拦截 `remember === "project" || remember === "always"`（抛 `remote_not_allowed` 且不清除 pending）。
  - `AGENT_READONLY_METHODS` 与 `AGENT_RUN_METHODS` 保持拒绝，外部 agent 不得越界调用。

### 4. 生命周期、中断清理与不中断边界

- **保留无等待后台不中断契约**：严格保留 [ADR-0073](ADR-0073-background-subagents.md) 已有行为——当用户对父会话执行 `interrupt` 时，**未处于等待权限确认状态的后台子代理继续运行，不被中断**。
- **精准结算等待请求与对应操作**：父会话 `interrupt` 时，必须结算当时挂在该父会话活动转发池中的全部未决转发请求（及父自身未决请求），并仅中止对应等待确认的操作或等待中的子代理（含持有该待决后台子代理的独立等待中止控制器 `rootBackgroundController`），不得泛化为取消全部后台子代理。
- **取消与关闭清理**：用户取消特定子代理（`subagent.cancel` / 中止对应子树）或关闭父会话（`session.close`）时，同步结算并撤除关联的活动转发请求，经 `clearChild` 等清理父活动转发池与 `pendingSubagentPermissions`，防止留下挂起 Promise 或误放行后续工具执行。

### 5. 超时排除确认等待

- **不新增确认等待超时**：用户在交互父会话确认权限的等待不设超时期限。
- **各层显式运行时限扣除等待时间**：通过可暂停计时器（`createPausableTimeout`）贯穿 `task` 调用显式 `timeoutMs`、子代理 `profile.timeoutMs` 以及 launcher / `Runtime` 包装层的超时计时；当同一子树内任意关联的转发权限处于等待用户确认期间，通过 `pauseTimeouts` 暂停各层计时器（包括嵌套子代理的祖先层），直到确认结算（`onPendingSettled` / `cleanup`）后恢复。

### 6. 客户端与通知一致性

- **父会话统一确认**：桌面端、手机端、TUI 与 CLI 均在父会话中以现有同一套确认交互（同一 `PermissionCard` 按钮/选项集合或确认提示）按到达顺序混排展示并直接回应子代理请求；子代理来源直接复用既有 `profile`（`preset` 优先，其次非 `default` 档位）与 `taskSummary`，不新增额外的说明文字、副标题或徽标。
- **桌面端与手机端状态表达**：
  - 桌面端当存在 `parentCallId` 匹配的待决子代理请求时，父对话对应 `task` 工具行、会话概览浮层对应子代理行以及右侧面板对应子代理标签（标签图标与文字）均呈警告色（`--a-warning`）；右侧子代理标签在有活动转发权限时复用同一张确认卡，经父会话 `respondSubagentPermission` 直接回应（无活动请求或重启只读重放时仍保持只读）。
  - 桌面端窗口失焦或未在看时，复用合奏成员通知模式（`decideSubagentPermissionNotification` 识别 `subagent.permissions` 的实时推送，跳过 `!live || eseq === 0` 初始快照并通过 `seenRequestIds` 去重，resolved 后同链路新请求仍可触发），以父会话标题发出需要确认通知并响应点击切回父会话（`ask_user` 仍不转发、不混淆）。
  - 手机端会话与侧边栏子代理行同步显示警告色，侧边栏子代理详情在存在活动待确认请求时同样复用确认卡经父会话 `respondSubagentPermission` 回应，并沿用远程确认选项裁剪规则（隐藏 `remember: "project"` / `"always"`）。
- **终端**：TUI 与逐行 CLI 复用既有权限确认快捷键与交互，并在提示头部明确标出子代理来源（档位/摘要）与当前是代表子代理确认。
