# ADR-0089：Swarm 执行方式（协调者、常驻成员与共享留言板）

- 状态：已接受
- 日期：2026-11-11
- 修订：[subagent.md](../architecture/subagent.md)（§7.1 成员权限确认冒泡、§16 范围更新）、[permissions.md](../architecture/permissions.md)（§5.4、§7、§8）、[modules.md](../architecture/modules.md)、[events.md](../protocols/events.md)、[view.md](../protocols/view.md)、[rpc.md](../protocols/rpc.md)、[ADR-0076](ADR-0076-work-modes.md)

## 背景

[ADR-0076](ADR-0076-work-modes.md) 引入了多代理攻坚 `/boost`，复用后台子代理（[ADR-0073](ADR-0073-background-subagents.md)）与工作树隔离（[ADR-0075](ADR-0075-worktree-isolation.md)）并行执行独立子任务。但 `/boost` 的子代理是一次性的：

1. 子代理跑完 `finish` 即关闭，无法在审查发现问题后被直接叫醒返工，只能由父代理自己修或重开一个丢掉上下文的新子代理；
2. 子代理之间不能直接通气（例如共用类型定义或接口变更），一切中转都压在父会话上下文上；
3. 子代理是无交互 gate（[subagent.md](../architecture/subagent.md) §7.1），在默认的 `default` 权限预设下任何写文件和执行命令都会直接被 `non_interactive` 拒绝，导致 `/boost` 在默认预设下退化为「并行调查 + 主代理串行实现」；
4. 主代理自己仍有改文件工具，模型容易绕过委派自己动手，破坏协调职责与验证闭环。

参照 Google Antigravity 的 Swarm 设计（Coordinator + 常驻命名成员 + 公开任务书 Charter + 共享留言板 `@` 提及唤醒 + 独立 Verifier 返工闭环），我们需要一种面向复杂多模块改造的执行方式 **Swarm**。本 ADR 定下 Swarm 的全部架构、协议与运行时边界；本轮只落地 ADR、Core、协议与测试，不做三端界面。

### 与 Antigravity Swarm 的对应与差异

| 维度 | Antigravity Swarm | Nocturne Swarm（本决定） |
|---|---|---|
| 协调者角色 | 当前会话成为协调者，只拆解、建成员、派活、验收汇总，不直接改代码 | 一致：协调者期间按工具特性卸载文件编辑工具与 `task`，保留只读工具、`shell`、`apply_subagent_changes` 与 Swarm 工具 |
| 成员与任务书 | 有名字的常驻子会话，带公开任务书（负责什么、不许碰什么、怎样算完成） | 一致：名字 `[a-z0-9-]+`，三段任务书必填，加入时发一条公开帖子到留言板 |
| 通信与唤醒 | 共享留言板，用 `@name`、`@all`、数字后缀组名 `@fix` 提及唤醒 | 一致：提及目标经待发输入通道（[ADR-0070](ADR-0070-steer-and-queue-input.md)）送达，忙时安全点插入、空闲开新轮 |
| 验证闭环 | 验证成员审查改动、跑测试，问题直接 `@作者` 返工 | 一致：验证成员支持重置并分离头指针检出独立工作树作者的最新提交后审查 |
| 工作区隔离 | 默认共用工作区按任务书划界，冲突或构建干扰时用独立 git worktree | 一致：默认共用主工作区；`isolated: true` 复用 ADR-0075 工作树并在每轮及发帖前增量提交 |
| 权限确认 | 成员的权限请求等用户确认 | 一致：修订 `subagent.md` §7.1，Swarm 成员使用交互式 gate，确认挂在成员会话上并在协调者派生视图中汇总 |
| 留言板存储 | 独立留言板存储 | 作为协调者会话日志中的 `swarm.*` 持久事件，天然支持回放、回退、重启恢复，并随协调者事件流同步到远程端，不新开通道 |
| 停滞检测 | 独立 `@monitor` 成员定期跑模型巡检，或固定返工轮数上限 | **零 token 的 Runtime 安静提醒**：全员等待或暂停且无待送达帖子时，Runtime 以作者 `Runtime` 发一条帖子 `@coordinator`，每段安静期只发一次，有新帖后重计；不设固定返工轮数上限 |
| 模型选择 | 为不同成员选不同模型（如异构验证） | 复用模型选择器的已启用模型清单与 [ADR-0058](ADR-0058-subagent-profiles.md) 子代理档位（互斥），带价格写入工具说明；外部 ACP agent 不可作为成员 |

## 决定

### 1. 入口与生命周期

- `SubmitInput.workMode` 与 `WORK_MODE_NAMES` 增加 `"swarm"`，客户端斜杠解析支持 `/swarm <任务>`。名称固定为 `swarm`，不用 `team`（保留给未来可能的多人协作 teamwork）。
- Swarm 与 `/goal` 一样跨多轮持续生效，直至协调者调用 `swarm_end` 工具、用户调用 `RuntimeSession.endSwarm()`，或对话回退到 Swarm 建立之前。一个会话同一时刻至多有一个活动 Swarm；已有活动 Swarm 时再次提交 `workMode: "swarm"` 返回 `invalid_command`。
- 准入前提与 `/boost` 相同：宿主开启 `RuntimeOptions.subagent.background === true`、子代理未停用（`subagent.enabled !== false`）、非无人值守定时任务会话（`meta.schedule === undefined`），否则拒绝并返回 `invalid_command`；`nctrn -p` 与定时任务因此不支持。

### 2. 协调者与工具集收窄

- Swarm 期间（从 `workMode: "swarm"` 启动轮开始，至 Swarm 结束为止），协调者会话不暴露任何文件编辑工具（`write`、`edit`、`apply_patch` 等），也不暴露一次性 `task` 工具。
- 工具收窄沿用会话级 `ToolRegistry` 按 `ToolTraits.editTool !== undefined` 声明式特性装卸的现有机制完成（与 `update_goal`、技能与子代理工具装卸同层），**不在 Agent Loop 或 Context Builder 中按工具名或模式名写任何分支**，也不把会话权限预设改成 `read-only`（以免影响成员继承的预设及协调者自身的 `shell` / `apply_subagent_changes`）。Swarm 结束后立即恢复原编辑工具与 `task`。
- 协调者保留只读工具、`shell`（及后台命令工具，用于在并回后在主工作区跑回归检查）、`apply_subagent_changes`、`todo_write`、`ask_user`、`skill` 与 MCP 工具，并挂载六个 Swarm 编排工具：
  - `swarm_init({ title })`：建立留言板并设定标题；
  - `swarm_add_member({ name, charter, model?, profile?, effort?, preset?, isolated? })`：添加常驻成员；
  - `swarm_post({ text })`：在留言板发帖并按 `@` 提及唤醒成员；
  - `swarm_change_model({ name, model?, profile?, effort? })`：切换成员模型或档位；
  - `swarm_remove_member({ name, reason? })`：移除成员；
  - `swarm_end({ summary? })`：结束 Swarm 并清理已并回的工作树。
- 协调者自己也是留言板参与者（标识 `coordinator`，中文别名 `@协调者`）：派活后结束当前 Turn 进入空闲等待，不轮询；当成员、用户或 Runtime 的帖子 `@coordinator`（或 `@协调者`、`@all`）时，帖子作为待发输入唤醒协调者开启新 Turn。

### 3. 常驻成员、公开任务书与模型选择

- 每名成员是一个常驻内置子会话（`session.created.parent = { sessionId: coordinatorId, callId: "swarm:" + name }`）：
  - **名称**：匹配 `/^[a-z0-9-]+$/`，在同一 Swarm 内唯一（已移除成员的名字也不复用，保持留言板历史无歧义）；`coordinator`、`协调者`、`all`、`user`、`runtime` 为保留名，冲突或使用保留名均以 `invalid_input` 拒绝。
  - **公开任务书（Charter）**：`{ owns, handsOff, doneWhen }` 三段必填且非空（负责什么、不许碰什么、怎样算完成），缺段或空白以 `invalid_input` 拒绝。成员加入时自动向留言板发出一条公开任务书帖子（记录 `charterOf: name`；该初始建档帖不单独唤醒他人，等待协调者发派工帖或在同一帖指派）。
  - **模型与档位**：`swarm_add_member` 与 `swarm_change_model` 接受可选 `model`（用户在模型选择器中可选的任一已启用模型，支持 `provider/model` 或唯一匹配的模型短名）或 `profile`（ADR-0058 已启用内置档位），两者互斥（同时给出报 `invalid_input`）；均省略时继承协调者当前模型与思考强度。可选档位与可选已启用模型清单（带每百万 token 输入/输出价格，复用 `subagentSelectionTable` 同源价格格式）写进这两个工具的英文 `description`，供模型匹配用户在 `/swarm` 正文中点名的模型；不在已启用清单内的模型或不可用档位一律报 `invalid_input` 并列出全部可选项，绝不静默替换成其他模型。外部 ACP agent 不能作为 Swarm 成员（显式传 `agent` 或将外部 agent 名传入 `model`/`profile` 均报 `invalid_input`）。
  - **工具集与持久记录**：成员实际解析出的 `model`、`reasoningEffort`、可选 `profile`、`preset`（`"general" | "explore"`，只读调查成员用 `"explore"`；`"explore"` 档位不可放宽为 `"general"`）与 `isolated` 写入 `swarm.member_added` 持久事件。换模型时更新成员子会话的 `session.config_changed`，完整保留成员原有对话历史。
  - **工具边界**：成员只挂载留言板工具 `swarm_post`（独立工作树成员另挂载只读切换审查提交的 `swarm_checkout`），没有 `swarm_init` / `swarm_add_member` / `swarm_change_model` / `swarm_remove_member` / `swarm_end`，没有 `task`，也没有 `finish`；成员完成当前工作后通过 `swarm_post` 汇报并自然结束本轮 Turn 进入等待。
  - **数字后缀组提及**：同类成员使用 `<prefix>-<n>` 命名（如 `fix-1`…`fix-4`）时，帖文中写 `@fix` 自动展开为该前缀下全部未移除成员。

### 4. 工作区、每轮增量提交与审查检出

- **默认共用主工作区**：`isolated` 缺省为 `false`，成员与协调者共用主工作区目录，靠公开任务书划分文件边界，协调者说明块要求同一文件只归一名成员修改。
- **独立工作树**：多成员改动交叉或构建/测试互相干扰时，协调者可指定 `isolated: true`，复用 [ADR-0075](ADR-0075-worktree-isolation.md) 的 `createWorktree`、路径映射提示与权限层 `WORKTREE_DENY`。
- **增量提交**：有独立工作树的成员在调用 `swarm_post` 发送消息前以及每轮 Turn 收尾时，若工作树存在未提交改动，自动在自身分支上提交一次（`checkpointWorktreeTurn`，复用 `settleWorktree` 的提交身份 `Nocturne <nocturne@localhost>`、`--no-verify` 与变更统计，但无改动时不删除常驻工作树）。
- **验证成员分离头指针审查**：`agent/worktree.ts` 新增从指定提交创建工作树（`createWorktree` 的可选 `commit` / `detach`）以及将现有工作树干净重置并分离头指针检出指定提交的 `resetWorktreeToCommit(worktree, commit)`（执行 `git reset --hard`、两次 `git clean -fd` 清除未跟踪且未被忽略的残留文件，再 `git checkout --detach <commit>`；不带 `-x`，因为按 [ADR-0075](ADR-0075-worktree-isolation.md) 依赖由成员在副本里自行安装，`.worktreeinclude` 复制进来的环境文件如 `.env.local` 也属于被忽略文件，若带 `-x` 会使验证成员每次审查都丢掉依赖与环境文件）。当独立工作树作者发帖 `@` 具有独立工作树的验证成员且该成员自身分支无未并回改动时，Runtime 在开轮前自动将其工作树重置到作者最新提交；独立工作树成员也可显式调用 `swarm_checkout({ member })` 切换到任意独立工作树成员的最新提交审查（调用前先对调用者做一次检查点，若调用者自身分支已有未并回改动则以 `invalid_input` 拒绝，防止丢弃改动或进入分离头指针后漏提交）。
- **并回与移除保护**：协调者的 `apply_subagent_changes` 支持按成员 `childSessionId` 或成员 `name` 查找并应用独立工作树成员相对当前基准 `base` 的增量改动，应用成功后推进成员记录的 `base = head`。移除有独立工作树的成员会删除其工作树与分支，因此移除前若检测到仍有未并回提交（`head !== base` 或有未提交改动），拒绝移除并返回错误提示协调者先用 `apply_subagent_changes` 并回；当允许移除或并回后清理工作树/分支失败时，沿用 ADR-0075 发出 `runtime.warning`（`worktree_cleanup_failed`），不阻断 `swarm.member_removed` 写入或 `apply_subagent_changes` 成功结果。

### 5. 成员状态与共享派生视图

- 成员生命周期有四种状态：
  - `working`：正在运行一轮 Turn（含等待用户确认权限期间）；
  - `waiting`：空闲等待，不发模型请求、不占并发槽；
  - `paused`：上一轮 Turn 以非用户中断的错误结束（如额度用尽、重试耗尽、步数上限或重复调用保护）；待发输入暂停，**不自动重试**；当有新帖 `@` 它、协调者为它调用 `swarm_change_model` 换模型，或用户直接向该成员会话发消息时恢复；
  - `removed`：已移除，子会话关闭，不能恢复或再次被唤醒；后续需要时添加新成员。
- 状态按 [view.md](../protocols/view.md) 规则由 `protocol` 层的纯函数归约进 `SessionView.swarm`：持久骨架由协调者日志中的 `swarm.*` 事件重建，成员实时运行态（`working` / `waiting` / `paused`、当前工具行摘要 `toolActivity`、暂停错误 `pauseError`、等待确认的权限请求 `pendingPermissions`）经协调者会话的临时事件 `swarm.member_updated` 更新（新订阅者连接时立即推送活动快照）。视图包含协调者与每名成员的模型、最近帖子编号 `lastPostNumber`、最近活动摘要 `activity`（工具行摘要、等待确认摘要、暂停原因或最近帖子首行）以及 `awaitingPermissionMembers` 列表，供桌面端、TUI 与手机网页共用。

### 6. 唤醒与并发排队

- 帖子解析正文中代码块外的 `@目标`（排除作者自身）：`@<成员名>` 唤醒对应成员，`@<前缀>` 唤醒 `<前缀>-<数字>` 整组未移除成员，`@coordinator` / `@协调者` 唤醒协调者，`@all` 送达除作者外的全体在场者（全部未移除成员及协调者）。提及已移除成员时报错且不唤醒。
- 帖子经目标会话的待发输入通道（`PendingInputStore`，`mode: "swarm"`）送达：目标正在跑 Turn 时在安全点作为插话（`steer: true`）并入当前 Turn；目标空闲时开启新 Turn。
- **并发控制**：只有正在跑一轮 Turn 的成员占用 Runtime 级 `maxConcurrent` 并发槽（默认 4，不改默认值）；`waiting` 与 `paused` 的成员不占 `maxConcurrent` 槽，也不占 `maxBackground`。成员总数不设默认上限。
- **槽满排队且无死锁证明**：普通 `task` 子代理可嵌套派生（`depth < maxDepth`），若父子代理持槽等待子子代理拿槽会形成等待环，故 `task` 采用 `tryAcquire` 立即失败；而 Swarm 协调者是顶层会话（不占 `subagentLimiter` 槽），Swarm 成员没有 `task` 工具也不能添加成员（无嵌套派生），持槽成员必然在单轮 Turn 结束后释放槽位（或等用户确认），资源等待图是深度为 1 的无环图，因此 Swarm 成员唤醒遇到槽满时安全排队等待（`limiter.acquire(signal)`），槽释放后按 FIFO 依次执行，不报错。

### 7. 留言板持久事件、`<swarm-post>` 格式、回退、分叉、重启与远程

- **协调者持久事件**：新增六个会话级持久事件类型（无 `turnId`）：
  - `swarm.created`：`{ title }`
  - `swarm.member_added`：`{ name, childSessionId, charter: { owns, handsOff, doneWhen }, model, reasoningEffort?, profile?, preset, isolated, worktree?: { path, branch, base } }`
  - `swarm.posted`：`{ number, from, fromKind: "coordinator" | "member" | "user" | "runtime", text, mentions, recipients, charterOf? }`（`number` 从 1 起连续递增）
  - `swarm.member_model_changed`：`{ name, model, reasoningEffort?, profile? }`
  - `swarm.member_removed`：`{ name, reason? }`
  - `swarm.ended`：`{ reason: "coordinator" | "user" | "rewound", summary?, unmerged?: SwarmUnmergedWorktree[] }`
- **送达消息格式与兼容依据**：投递到成员（及协调者）日志的帖子是一条普通 `message.user`，携带可选扩展字段 `swarm: { postNumber, from, fromKind }`（运行中安全点插入时另带 `steer: true`）。给模型看的英文文本包裹格式参照 `<subagent-result>`：
  ```xml
  <swarm-post n="3" from="verifier">
  @orders Quantity 0 still passes validation in src/orders.ts:42. Add a > 0 check and rerun tests.
  </swarm-post>
  ```
  `message.user.swarm` 是已知事件上的可选新增字段，解码 schema 非严格，旧版本读取成员日志时忽略未知字段并按普通用户消息展示，不提升 `formatVersion`（协调者日志含新增 `swarm.*` 持久事件，按 [events.md](../protocols/events.md) §8 既有规则旧 Runtime 拒绝恢复、只读端忽略未知事件，同样不提升 `formatVersion`）。
- **回退**：对话回退（`mode` 为 `both` 或 `conversation`）的目标早于或等于 `swarm.created`（`targetSeq <= createdSeq`，含撤回启动 `/swarm` 的那条用户消息）时，Runtime 停止全部成员并写入 `swarm.ended({ reason: "rewound" })`，恢复协调者编辑工具。
- **分叉**：`forkSession` 产生的新会话不继承原会话在分叉点及之前的 Swarm（归约与恢复均在 `forkedFrom.seq` 边界清零，不复活旧成员）。
- **重启恢复**：协调者会话恢复时保留活动 Swarm，全部未移除成员初始为 `waiting`；成员子会话不在恢复时批量加载，而是在下次被 `@` 或被用户打开时按需从日志恢复。协调者恢复时比对 `swarm.posted.recipients` 与目标会话日志中已落盘的 `message.user.swarm.postNumber`：凡被 `@` 但目标日志尚未写入对应消息的帖子，参照 ADR-0073 §4 重启补报做法，作为**已暂停（`paused: true`）**的 `swarm` 待发输入补入目标队列，不自动唤醒。
- **远程**：留言板与成员状态更新均随协调者会话事件流下发，不新开专用传输通道。

### 8. 权限确认（对 `subagent.md` §7.1 的修订）

- **修订内容与理由**：[subagent.md](../architecture/subagent.md) §7.1 原规定所有子会话一律使用 `interactive: false`，剩余 `ask` 直接 `deny(source: "non_interactive")`。这对短命一次性 `task` 成立，但在 Swarm 中协调者自身没有改文件工具，全部实现与测试执行都由成员完成；若成员仍按非交互直接拒绝，在默认的 `default` 预设下 Swarm 无法写任何文件或跑任何非常规命令。因此修订为：**交互宿主下的 Swarm 常驻成员使用交互式 `PermissionGate`，其权限 `ask` 请求等待用户确认，不再按非交互直接拒绝**（一次性 `task` 子代理与外部 ACP agent 保持非交互收敛不变）。
- **挂接与视图路由**：权限请求原样挂在**成员自己的子会话**上，发出成员会话的 `permission.requested` 持久事件并经成员会话既有的 `respondPermission(requestId, reply)` 结算；成员子会话与父协调者共享同一 `workspaceRoot`、权限预设、项目 Grant、会话树内存 `sessionGrants` 与 `smart` 安全审查器（`smart` 下照常先经审查器，`unsure` 才询问用户；其他预设与授权规则不变，不自动放宽）。等待确认期间该成员保持 `working` 状态并继续占用并发槽。协调者会话通过 `swarm.member_updated` 在 `SessionView.swarm.awaitingPermissionMembers` 与对应成员的 `pendingPermissions` 中实时反映待确认项，供客户端提示用户并跳转到该成员会话确认。

### 9. Runtime 安静提醒

- 当满足以下全部条件时，Runtime 自动向留言板发出一条作者为 `Runtime`（`fromKind: "runtime"`）的英文提醒帖 `@coordinator`：
  1. Swarm 已建立且处于 `active`；
  2. 本次运行周期内已发生过至少一次活动推进（刚从磁盘 `resumeSession` 打开、尚未产生新活动时不主动唤醒）；
  3. 协调者处于空闲等待（无进行中 Turn，且协调者待发队列中无未暂停条目）；
  4. 全部未移除成员均处于 `waiting` 或 `paused`（无成员正在 `working`、排队等槽或正在投递唤醒）；
  5. 所有未移除成员均无未暂停的待送达帖子；
  6. 当前安静期尚未发送过安静提醒（`quietReminderSent === false`）。
- 安静提醒发出后置 `quietReminderSent = true`；此后若协调者处理后决定等待用户而未发新帖，再次归于空闲时**不再重复发送**；一旦留言板出现任何非 `runtime` 作者的新帖子，`quietReminderSent` 重置为 `false`，下一段安静期重新计。
- 不设硬性返工轮数上限，提示词中不写「最多 N 轮」；单轮内异常循环沿用 [ADR-0063](ADR-0063-loop-guard.md) 重复调用保护，用户也可随时移除成员或调用 `endSwarm()`。

### 10. 用户参与接口与 RPC

- `RuntimeSession` 新增三个会话方法并映射到 `@nocturne/rpc`（会话内操作，本机与远程连接均可用）：
  - `postToSwarm({ text })` / `session.postToSwarm`：以作者 `user` 在留言板发帖；解析正文中的 `@名字` / `@组名` / `@all` / `@coordinator`（`@协调者`），若未提及任何目标则默认 `@coordinator`；
  - `removeSwarmMember({ name })` / `session.removeSwarmMember`：移除指定成员（独立工作树有未并回提交时同样拒绝并提示先并回）；
  - `endSwarm()` / `session.endSwarm`：结束当前 Swarm，返回 `{ unmerged }`。
- **直接与成员对话**：Swarm 存续期间，用户可通过 `runtime.resumeSession(childSessionId)`（RPC `session.open`）打开未移除成员的子会话并直接调用 `submit`、`enqueueInput`、`respondPermission`、`respondQuestion`、`interrupt`（托管会话复用同一活动实例，无文件锁冲突）；用户直接发给成员会话的 `submit` 消息只进入该成员自己的上下文并唤醒它（若处于 `paused` 一并恢复），**不上协调者留言板**。Swarm 结束或成员被移除后，成员子会话不再接受新的 `submit` / `enqueueInput`。

### 11. 结束与工作树清理

- 协调者调用 `swarm_end` 或用户调用 `endSwarm()` 时：
  1. 中断并关闭全部仍在运行或常驻打开的成员会话，清空未消费待发输入；
  2. 对有独立工作树的成员先完成工作树快照结算：已并回（`head === base` 或已合并入主仓库 `HEAD`，调用 `cleanupMergedWorktrees`）的工作树与 `nocturne/` 分支自动清理；仍有未并回提交的工作树与分支完整保留，写入 `swarm.ended.unmerged` 并在返回值/工具输出中逐项列出；
  3. 立即恢复协调者的文件编辑工具与 `task` 工具。

## 与 `/boost` 和后台子代理的区别

| 对比项 | 后台子代理（ADR-0073） | `/boost`（ADR-0076 §6） | `/swarm`（本 ADR） |
|---|---|---|---|
| 会话寿命 | 一次性，`finish` 后关闭 | 一次性后台子代理组合，单轮引导 | 跨轮常驻子会话，可反复 `@` 唤醒与追问 |
| 角色分工 | 父代理既可自己改也可派子代理 | 主代理仍持有编辑工具，可自己兜底改文件 | 协调者卸载编辑工具，强制「协调 + 实现 + 验证」分离 |
| 代理间通信 | 无，结果只回父代理 | 无，全部回主代理汇总 | 共享留言板，成员与验证者直接 `@` 协作与返工 |
| 工作区默认策略 | 可写后台默认建独立工作树 | 实现类子任务各自建独立工作树 | 默认共用主工作区按任务书划界，按需开启独立工作树 |
| 权限确认 | 非交互，剩余 `ask` 直接拒绝 | 同左，`default` 预设下写操作受阻 | 交互式 gate，成员权限请求等用户确认 |
| 并发满时行为 | `tryAcquire` 立即报 `subagent_concurrency` | 受 `maxBackground`（3）与 fail-fast 限制 | 仅 `working` 成员占 `maxConcurrent`（4），满槽排队等待 |

## 本轮不做的事

- **TUI 界面**：已实现对话里的工具行标签与帖子送达、输入框下方的 Swarm 状态块（成员活动与等待确认）、`/swarm board` 全屏留言板与成员会话切换；`--inline` 只提供状态块，不提供留言板。权限跳转沿用现有权限确认框与「需要确认」响铃，成员会话切换不中断、不关闭 Runtime 托管的成员。
- **关系图可视化**：不做节点连线拓扑图。
- **外部 ACP agent 成员**：外部命令行 agent 无同构常驻会话锁、事件流与交互式权限挂载，不能作为 Swarm 成员。
- **嵌套 Swarm**：成员会话不接受 `workMode`、不挂载 `swarm_add_member` 或 `task`，不支持 Swarm 内再开子 Swarm。

## 修订（2026-11-12）

- 活动摘要改为结构化：`SessionView.swarm` 中协调者与成员的 `activity` 改为 `SwarmActivity`（`tool` / `permission` / `paused` / `post` / `charter` / `removed`），`swarm.member_updated.toolActivity` 与成员视图的 `toolActivity` 改为 `{ tool, detail? }`，协议层不再产出英文句子，文字由客户端组成（字段见 [view.md](../protocols/view.md) §4）；`swarm.member_updated` 是临时事件，不涉及日志兼容，不提升 `formatVersion`。
- 客户端斜杠解析增加 `/swarm board`（打开留言板）与 `/swarm end`（结束 Swarm）两个子命令，规则同 `/goal stop`：整行恰好是子命令才算，其余文字仍作为任务提交。
- `swarm` 加入 `BUILTIN_SLASH_COMMANDS`，同名技能按既有规则标 `commandConflict`。

## 修订（2026-11-14）

- **Swarm 成员不再登记为「运行中的子代理」**：成员的状态与展示全部归属 `SessionView.swarm` 及成员会话标签，不再调用 `subagentRegistry.register`，`listSubagents`、`observeSubagent`、`readSubagentAttachment` 与活动态 `listSubagentWorktrees` 均排除 Swarm 成员（不论处于 `working`、`waiting`、`paused`、已移除、已结束或重启后均不出现在任何「子代理」列表中）。
  - 原因：原实现把常驻成员按默认后台子代理登记进 `subagentRegistry`（且写死了 `profile: "default"` 与 `"Swarm member"`），导致成员完成工作进入 `waiting` 后仍被客户端子代理概览/侧栏显示为「运行中的后台子代理」并持续计时、出现取消按钮。
  - 原先依赖登记表承担的保护已改由协调者与会话目录直接承接：非隔离成员所在工作区的分支切换保护由 `branchBusy` 检查 `SwarmController.hasWorkspaceMembers()` 维持；父会话与成员的授权共享与 `sessionGrantRoot` 查找继续通过 `subagentRegistry.trackSession`（`liveSession`）沿 `session.created.parent` 解析；活动隔离成员的工作树删除保护由 `deleteSubagentWorktree` 检查活动 Swarm 成员集合（仍报 `子代理仍在运行`）维持；`session.open` 成员会话标签、权限确认与关闭/重启收尾不受影响。

## 修订（2026-11-14）：对外改名「合奏」（Ensemble）与界面一轮

- **对外名称**：用户可见界面（桌面、手机、TUI 面板标签、页标题、命令菜单、工具行、错误提示等）与给模型看的说明文字统一改称「合奏」（英文 `Ensemble`）；原因：避免与借鉴对象同名，同时呼应 Nocturne 作为夜曲的名称——合奏指各声部分工合成一首。
- **命令与别名**：斜杠命令改为 `/ensemble <任务>`、`/ensemble board`、`/ensemble end`，用法提示为「用法：/ensemble 任务」；历史兼容保留 `/swarm` 作为不显示的别名（正常解析，但不出现在命令菜单、补全或用户文档中）。`BUILTIN_SLASH_COMMANDS` 同时包含 `"ensemble"` 与 `"swarm"`。
- **内部标识保留不变**（保证已落盘日志、prefs 与 RPC 协议向后兼容）：

| 类别 | 内部标识（不变） | 对外显示 / 提示（新名称） |
|---|---|---|
| 执行方式名 | `WORK_MODE_NAMES` / `workMode.name = "swarm"` | `/ensemble`（`workModeDisplayText` / `workModeCommandName`） |
| 持久 / 临时事件 | `swarm.created` / `member_added` / `posted` / `member_model_changed` / `member_removed` / `ended` / `member_updated` | 合奏 |
| 编排与协作工具 | `swarm_init` / `swarm_add_member` / `swarm_post` / `swarm_change_model` / `swarm_remove_member` / `swarm_end` / `swarm_checkout` | `swarm_init` 标签「合奏」，工具说明称 `Ensemble` / `ensemble` |
| 派生视图与 RPC 方法 | `SessionView.swarm`、`postToSwarm` / `removeSwarmMember` / `endSwarm` | 合奏留言板、成员页 |
| 文件、类型与 prefs | `SwarmView`、`SwarmPane`、`panelSessions` 中的 `swarm` 标记 | — |
- **入口迁移与留言板调整**：桌面端与手机端对话流不再渲染入口行与无单位「成员数 · 帖子数」，改在桌面会话概览浮层与手机侧边栏展示「合奏」分组；留言板新增作者头像列（`swarmAuthorColor` 按加入顺序轮转 `--a-cat1..5`）、帖子头剔除作者自身并区分正文样式，桌面/手机/TUI 发帖框支持 `@` 补全。详情见 [desktop.md](../apps/desktop.md)、[tui.md](../apps/tui.md) 与 [ADR-0084 §2 修订](ADR-0084-phone-side-panel.md)。

