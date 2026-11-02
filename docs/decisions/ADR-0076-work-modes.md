# ADR-0076：四种执行方式（追问需求、目标模式、计划模式、多代理攻坚）

- 状态：已接受
- 日期：2026-11-02
- 修订：[agent-loop.md](../architecture/agent-loop.md)（§3.10 新增注入点 `continueTurn`）、[events.md](../protocols/events.md)、[view.md](../protocols/view.md)、[rpc.md](../protocols/rpc.md)、[tools.md](../architecture/tools.md)、[cli.md](../apps/cli.md)、[tui.md](../apps/tui.md)、[desktop.md](../apps/desktop.md)

## 背景

[路线图](../roadmap/roadmap.md)「之后」参照 Antigravity 列了四种执行方式，按代价从低到高：追问需求 `/grill-me`、目标模式 `/goal`、计划模式 `/plan`、多代理攻坚 `/boost`。[agent-loop.md](../architecture/agent-loop.md) 第 5 节要求计划模式、目标管理这类产品功能作为独立模块，通过工具或事件接入，不进 Agent Loop。可用的基础已经齐了：向用户提问（[ADR-0032](ADR-0032-ask-user-tool.md)）、运行中插话的安全点（[ADR-0070](ADR-0070-steer-and-queue-input.md)）、后台子代理（[ADR-0073](ADR-0073-background-subagents.md)）与工作树隔离（[ADR-0075](ADR-0075-worktree-isolation.md)）、六种权限预设。

本 ADR 定下四个模式的入口、状态存放与恢复、`/goal` 的上限、`/plan` 的批准流程、`/boost` 的并行上限，以及各客户端的支持范围。

## 决定

### 1. 统一入口：提交时带 `workMode`

- `SubmitInput` 增加可选 `workMode: "grill-me" | "plan" | "goal" | "boost"`，与 `skill`、`delegate` 互斥（同时出现报 `invalid_command`）。字段名不用 `mode`，因为 `enqueueInput` 的 `mode` 已经表示插话或排队。
- 用户正文就是任务（`/goal` 的目标、`/plan` 的任务……），去首尾空白后不得为空，否则 `invalid_command`。
- Core 在提交准备阶段（与技能正文同处）给消息末尾追加一个英文说明块 `<work-mode name="…">…</work-mode>`，`message.user` 带可选字段 `workMode: { name, body, source? }`，`body` 即该块正文。这和技能快照同构：回放、回退、分叉、导出都沿用快照，不重新生成。兼容扩展，旧版本按普通用户消息显示，不提升 `formatVersion`。
- `source` 区分写入来源（修订 2026-11-02）：用户提交的消息不带；Runtime 自己写的模式消息（目标核对与收尾说明、`resumeGoal` 的继续说明、`approvePlan` 的「批准」）带 `source: "runtime"`。未知值同样按非用户提交处理。客户端据此决定重发：用户提交的模式消息重发、编辑并重发时带原 `workMode` 重新提交，照常走模式起始流程（切预设、设定目标）；Runtime 写入的消息不提供重发。不按正文是否为空判断，因为「批准」有正文。
- 回退列表（`rewindTargets`）对执行方式消息给出带命令名的首行与回填文字（如 `/goal 修好测试`），不含说明块，回填后按原模式重新解析；Runtime 写入的消息回填文字为空。
- 待发输入：`enqueueInput("queue", { workMode })` 可以排队，模式的副作用（切换预设、设定目标）在这条输入被取出、新 Turn 开始前生效；`enqueueInput("steer", { workMode })` 报 `invalid_command`（插话并入当前 Turn，不能在中途换模式）。
- 子会话不接受 `workMode`（`invalid_command`）。
- 没有采用「内置技能」：技能可以被同名用户技能覆盖、可以停用、会出现在技能设置页和模型目录里；而 `/plan`、`/goal` 带状态，四个模式需要同一套入口与显示。四个名字加入 `BUILTIN_SLASH_COMMANDS`，同名技能按既有规则标 `commandConflict`。

### 2. 状态存放：`session.config_changed` 的两个可选字段

不新增持久事件类型（新增类型会让旧版本无法恢复会话，[events.md](../protocols/events.md) 第 8 节），沿用 ADR-0071 的做法，在已知事件里加可选字段：

```ts
goal?: {
  objective: string
  status: "active" | "met" | "blocked" | "limit" | "stopped"
  maxMinutes: number      // 默认 60
  maxRounds: number       // 默认 10
  reason?: string         // blocked 的原因、stopped 的来源（"user" | "interrupted" | "rewound"）
}
plan?: { restorePreset: string } | null   // null = 退出计划模式
```

- `SessionState` 与 `SessionView` 各折叠出 `goal`（附 `since`：最近一次变为 `active` 的事件 seq）与 `plan`。
- **回退**（修订 2026-11-02，原决定是「与预设一样回退不撤销」）：对话回退（`both`、`conversation`）的目标早于或等于设定当前目标的那条用户消息时，Runtime 在 `session.rewound` 之后写 `goal.status: "stopped", reason: "rewound"`；早于或等于进入当前计划的那条用户消息（自上次退出计划模式后第一条 `/plan`，之后的 `/plan` 只是修订）时，按放弃计划处理：写 `permissionPreset: restorePreset`、`plan: null`。回退到这些消息之后的位置不受影响；只还原文件不改变两项。起点只认用户提交的模式消息（`source` 缺省）。写入走 `config_changed`，恢复会话后状态一致。
  - 理由：预设是用户自己选的会话设置，与对话内容无关；目标和计划却是由那条消息设定的，消息撤回后它们失去来源。目标若保留，回退后再发一句别的话，这一轮结束仍会被核对说明接管，去做用户已撤回的目标——与 §4.5 中断即停止的理由相同；计划若保留，会话仍是 `read-only`，「批准」按钮也还在。
- **恢复会话**：两项都从日志原样恢复。目标处于 `active` 时不自动开新 Turn，下一个 Turn 照常受目标约束；计划模式下预设本来就以 `config_changed` 记着 `read-only`，批准按钮照常出现。
- **分叉**：复制日志，状态一并继承。
- 这两个字段不生成历史说明（`note`），也不在对话里生成提示条；计划模式开始时的预设切换沿用既有的预设切换提示。

### 3. 追问需求 `/grill-me`

只是一段说明，没有状态。说明要求模型：先读代码和文档，能自己查到的不问；用 `ask_user` 一次只问一个问题，有推荐时推荐项放第一位并按 ADR-0032 的约定标「（推荐）」；剩下的只是小的不确定时停止追问，把达成一致的需求整理成清单，再用一次 `ask_user` 确认后开始实现。非交互会话里 `ask_user` 返回 `not_interactive`，模型按默认继续。

### 4. 目标模式 `/goal`

#### 4.1 设定

`workMode: "goal"` 的输入在 Turn 开始前写 `config_changed.goal = { objective: 用户正文, status: "active", maxMinutes: 60, maxRounds: 10 }`。说明块要求模型先写出可核对的交付清单，再开始做，做完时用 `update_goal` 报告。

#### 4.2 `update_goal` 工具

- 只在目标为 `active` 时注册（在 Turn 边界按状态安装或移除，同技能工具）。输入 `{ status: "met" | "blocked", checklist?: Array<{ item: string, evidence: string }>, reason?: string }`：`met` 要求 `checklist` 至少一项且每项 `evidence` 非空；`blocked` 要求 `reason` 非空。
- `permissionSubjects` 为 `[]`，`traits.mutates = false`、`fileEffects: "none"`。执行时由目标模块写 `config_changed.goal`（`met` 或 `blocked`，`reason` 记原因），`tool.completed.output` 保存清单与证据。目标已不是 `active`（例如用户刚停止）时以 `invalid_input` 结算。

#### 4.3 拦下与续跑

Agent Loop 增加一个通用注入点 `continueTurn?(signal): Promise<PreparedInput | undefined>`，与 `takeSteers` 同形：只在安全点 2（模型以 `stop` 结束、没有工具调用、也没有待消费插话、本来要 `done`）调用；返回内容时按插话写入 `message.user(steer: true)` 并继续下一个 Step，返回空就照常 `done`。Agent Loop 不知道它来自目标模式。

目标模块的判断顺序：

1. 目标不是 `active`：不续。
2. 处于计划模式（修订 2026-11-02）：不续，上限也不检查。计划回复要等用户评论或批准，续跑会让「批准」因会话忙而不出现、核对说明空转到上限。先设目标再进计划、先进计划再设目标都一样；批准或放弃后目标若仍是 `active` 就照常生效：批准开的实施 Turn 在安全点 2 照常核对，放弃后的下一条消息同样如此。
3. 本会话还有运行中的后台子代理（ADR-0073）：不续。Turn 照常结束，子代理收束时结果作为待发输入唤起新 Turn，那一轮想结束时再判断。
4. 待发列表里有未暂停的排队输入：不续，让排队先发。
5. 已达上限（4.4）：写 `status: "limit"`，返回一次收尾说明（要求停止工作，列出已完成与未完成的项及证据），这一轮随后照常结束。
6. 否则返回核对说明：要求按交付清单逐条核对证据；全部满足就调用 `update_goal(met)` 后结束；有未满足的就接着做；离开用户无法继续时调用 `update_goal(blocked)`。核对说明的 `message.user.workMode` 为 `name: "goal"`、`source: "runtime"`，用户正文为空。

整个目标通常在一个 Turn 里完成，会话通知（ADR-0056）只在真正结束时提醒一次。

#### 4.4 上限

- `maxRounds`：自 `since` 起写入的核对说明条数（`workMode.name === "goal"` 且 `steer`），默认 10。
- `maxMinutes`：自 `since` 起各 Turn 的运行时长之和（`turn.started` 到 `turn.completed` 的墙钟时间，进行中的 Turn 算到当前），默认 60 分钟。会话空闲、进程退出的时间不计。
- 都从持久事件算出，恢复会话后照常累计。第一版不按金额限额：不少模型没有价格数据，算不出费用；轮数与时长对所有模型都成立。
- 上限只在安全点 2 检查，不打断进行中的工具或模型输出。

#### 4.5 停止、中断与继续

- `RuntimeSession.stopGoal()`：写 `status: "stopped", reason: "user"`；Turn 进行中也可以，当前 Turn 不再续跑。
- 用户中断（Turn 以 `aborted` 结束）时写 `status: "stopped", reason: "interrupted"`，避免之后的普通对话被核对说明接管。其他非 `done` 结束（错误、截断等）不改变状态。
- `RuntimeSession.resumeGoal()`：目标存在且不是 `active` 时写 `status: "active"`（`since` 随之更新，轮数与时长重新计算）；会话空闲时立即用一条核对说明开新 Turn，进行中时留给该 Turn 的安全点 2。没有目标时 `invalid_command`。
- 新的 `/goal <目标>` 直接替换旧目标。

### 5. 计划模式 `/plan`

- **开始**：`workMode: "plan"` 的输入在 Turn 开始前写一个 `config_changed`：`permissionPreset: "read-only"`、`plan: { restorePreset: 当前预设 }`（已在计划模式时保留原来的 `restorePreset`）。说明块要求：只读探索，必要时用 `ask_user` 问需要用户拍板的事，然后以完整的 Markdown 实施计划作为本轮最后的回复（目标、按文件或模块的改动、步骤顺序、验证方式、风险与待定事项），不做任何修改。用户回复意见时修改计划并重新完整给出。
- **评论**：计划就是一条普通的助手消息，用户在输入框里直接回复意见即可；计划模式下的普通消息仍是只读。
- **批准**：`RuntimeSession.approvePlan()`，会话须空闲（否则 `session_busy`），且处于计划模式（否则 `invalid_command`）。写 `config_changed`：`permissionPreset` 取 `restorePreset`（它是 `read-only` 时改用 `default`）、`plan: null`；随即开新 Turn，用户正文为「批准」，说明块要求按已批准的计划实施并验证，`workMode` 为 `name: "plan"`、`source: "runtime"`。
- **放弃**：`RuntimeSession.cancelPlan()`，写 `permissionPreset: restorePreset`、`plan: null`，不开 Turn。
- 计划模式期间用户手动切换预设照常生效；批准与放弃仍按 `restorePreset` 恢复。

### 6. 多代理攻坚 `/boost`

- **前提**：宿主开启了后台子代理（ADR-0073 §5 的 `RuntimeOptions.subagent.background`）且子代理未停用；否则 `invalid_command`（「当前环境不支持后台子代理」）。`nctrn -p` 与定时任务因此不支持。
- **并行上限**：沿用每个父会话的 `maxBackground`（默认 3），由 Runtime 强制；说明块写明这个数和工作区是否为 git 仓库（决定能否用工作树隔离）。
- **说明块**要求：先把任务拆成互不依赖的子任务；调查类用只读后台子代理，实现类用 `background: true, isolation: "worktree"`；同时运行的不超过上限；启动后不轮询，等结果作为消息送达；逐个审查结果，用 `apply_subagent_changes`（或 git）并回、解决冲突；最后在主工作区跑项目的测试或回归检查，按子任务汇总结果。工作区不是有提交的 git 仓库时，有可写子任务就先用 `ask_user` 问要不要初始化并提交，同意后走工作树隔离；不同意或无法提问时只并行调查，实现由主代理自己顺序完成。能拆出两块以上互相独立的工作就默认委派，不拆要说明理由。
- 不改变权限预设：可写子代理是非交互的，`default` 预设下它们的写入与命令会被拒绝（ADR-0075 §3），需要 `guarded`、`smart`、`bypass` 或相应授权。说明块提示模型遇到拒绝时改为自己完成该子任务。

### 7. 客户端

斜杠命令：

| 命令 | 作用 |
|---|---|
| `/grill-me 需求` | `workMode: "grill-me"` |
| `/goal 目标` | `workMode: "goal"` |
| `/goal` | 显示当前目标：目标、状态、已用轮数与时长 |
| `/goal stop`、`/goal resume` | `stopGoal()`、`resumeGoal()` |
| `/plan 任务` | `workMode: "plan"` |
| `/plan approve`、`/plan cancel` | `approvePlan()`、`cancelPlan()` |
| `/boost 任务` | `workMode: "boost"` |

子命令只匹配整行恰好是该单词的情况，其余文字都按任务处理。

| | TUI | 逐行 CLI | 桌面端 | 手机网页 | `nctrn -p` |
|---|---|---|---|---|---|
| `/grill-me` | ✓ | ✓ | ✓ | ✓ | — |
| `/goal` | ✓ | ✓ | ✓ | ✓ | — |
| `/plan` | ✓ | ✓ | ✓，计划消息下方加「批准」按钮 | ✓，同桌面端 | — |
| `/boost` | ✓ | ✓ | ✓ | ✓ | — |

- `nctrn -p` 不解析斜杠命令。逐行 CLI 在 Turn 期间只接受中断，命令在空闲时输入。桌面端与手机网页运行中发送带模式的命令按排队处理。
- 用户消息显示：在用户正文旁显示命令名（如 `/plan`），可展开查看说明块；核对说明只有命令名。Runtime 写入的模式消息（§1 `source`）不显示「编辑并重发」「重发」。不加模式徽标、状态说明、副标题或占位提示；「批准」按钮只在计划模式、会话空闲时出现在最后一条助手消息下方。
- RPC 新增 `session.approvePlan`、`session.cancelPlan`、`session.stopGoal`、`session.resumeGoal`，`session.submit` / `session.enqueueInput` 接受 `workMode`；都属于会话内操作，远程连接可用（ADR-0052 第 7 轮的口径）。对外 MCP 接口（ADR-0074）不变。

## 后果

- 四个模式都不在 Agent Loop 里按工具名或模式名分支；Agent Loop 只多一个与 `takeSteers` 同形的注入点。
- 状态在已知事件的可选字段里，旧版本照常恢复含这些字段的会话（只是不再按模式行事）。
- 目标模式会在用户不操作时继续花费，上限默认 10 轮、60 分钟；中断即停止。
- `/boost` 的效果取决于权限预设与仓库条件，说明块给模型留了退路，但在 `default` 预设下基本退化为「并行调查 + 主代理实现」。
- 计划的「评论」就是普通回复，不支持按行批注。

## 备选方案

- **新增持久事件 `goal.updated` / `plan.updated`**：语义更直白，但旧版本会拒绝恢复会话；不采用。
- **目标续跑开新 Turn（与排队同路径）**：Agent Loop 完全不动，但每轮都会触发 Turn 结束通知、TurnEnd Hook，用户看到的是一串 Turn；不采用。
- **目标完成靠解析回复里的标记文本**：不需要工具，但容易误判，也拿不到结构化的清单；不采用。
- **计划用专门的 `submit_plan` 工具提交**：结构更清楚，但多一个工具和一套显示；计划本来就是一条 Markdown 回复，第一版不做。
- **按金额限制目标花费**：依赖价格数据，很多模型没有；以后有统一价格来源再加。
- **`/boost` 自动切到 `guarded`**：静默放宽权限违背用户意图；不采用。

## 修订（2026-11-03：`/boost` 默认委派）

实测 `/boost` 在非 git 目录从不派可写子代理，因为说明块要求主代理自己写所有文件。现在非 git 时先问用户是否初始化；说明块写明这是用户的明确选择，能拆就默认委派，派完结束本轮。基础系统提示和 `task` 说明不再断言写操作一定被拒绝，改为按当前权限判定。

## 修订（2026-11-02：取消固定目标上限）

本修订覆盖 §2 的新目标字段、§4.3 的上限判断、§4.4 的轮数/时长停止规则、§4.5 的继续计时，以及 §7 与「后果」中的上限描述；历史正文保留作为原决定记录。新目标事件不写 `maxRounds`/`maxMinutes`，旧日志中的这两个可选字段和旧 `limit` 状态仍可读取、显示并继续。目标没有轮数或时长停止条件；仅连续三轮目标核对都没有任何工具调用时自动转为 `blocked`（`update_goal` 也算工具），原因固定为 `No progress: three consecutive goal checks completed without any tool calls. Resume when you can take action.`，用户界面显示中文。一轮有工具即清零，计数由持久事件折叠。`resumeGoal` 重算 `since` 与 `rounds`，但 `activeMs` 累计；空闲和暂停不计时。

`cancelGoal()` 立刻中断运行中的 Turn 并写 `goal: null`，无需确认；没有目标时返回 `invalid_command`。`/goal cancel` 与 RPC 同步提供。状态显示共用 `visibleGoal`：active、blocked、stopped（user/interrupted）及旧 limit 可见，met、取消和 rewound 隐藏。桌面目标行在 TodoPanel 内，手机在输入上方，不移动任务清单；展开默认收起且不持久化，不改变 `todosCollapsed`。时长显示共用 `formatGoalDuration`（毫秒换算，例如 8秒、12分8秒、1小时0分8秒），秒表只更新目标小组件。TUI 增一行目标状态，`/goal` 核对消息仅显示原文，不加图标或计时；CLI 不设常驻目标行。

后果：不再以固定轮数或时长截断正常的长任务，主对话也不默认限制步数；需要停止时由用户取消、中断或由无工具进展保护阻断。旧 `limit` 只是历史状态，不再由新目标产生。

兼容边界：新版本恢复旧目标不丢失状态；尚不认识 goal 的旧版本忽略该字段。最初要求两个上限字段且不接受 null 的中间版本无法解析新目标事件，需升级；取消 RPC 对不支持它的旧服务端返回未知方法。日志格式版本保持不变。
