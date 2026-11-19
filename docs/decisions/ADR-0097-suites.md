# ADR-0097：长期工作流「组曲 / Suite」：常驻指挥 + 线程 + 总览

- 状态：已接受
- 日期：2026-11-19
- 参照：Claude Code Projects（https://code.claude.com/docs/en/claude-projects）
- 复用：[ADR-0089](ADR-0089-ensemble.md) 合奏、[ADR-0073](ADR-0073-background-subagents.md) 后台子代理、[ADR-0075](ADR-0075-worktree-isolation.md) 工作树隔离、[ADR-0064](ADR-0064-scheduled-tasks.md) 定时任务

## 0. 已定

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| 1 | 名字 | **组曲（Suite）** | 「项目」已经指工作区：侧栏按项目分组会话、「信任此项目」、技能页「项目」层、ADR-0008。再用「项目」会撞名。合奏、夜曲都是音乐词，组曲的意思是一组相关的曲子，正好对应一串相关的任务 |
| 2 | 线程是什么 | **组曲指挥的子会话**（`parent = 指挥会话`），不进侧栏会话列表，只在组曲页出现 | 常驻子会话机制已经提供交互式权限确认、并发槽排队、工作树、成员会话标签和私信，可直接复用；做成顶层会话需要另做一套归属、列表过滤和权限路由 |
| 3 | 线程怎么汇报 | **每轮结束自动汇报**：线程一轮跑完，Runtime 把最后一条助手回复包成 `<thread-report>` 送进指挥的待发输入。线程不需要发帖工具 | 和 Claude Projects 一样（"reports back to the conversation when it finishes"）。合奏的留言板 `@` 机制是给成员互相通气用的，组曲的线程之间不需要直接通气 |
| 4 | 一期范围 | **只做 Core、协议、RPC 和文档**；桌面端界面二期，手机和 TUI 三期 | 先抽出 `resident` 共享层并入库本 ADR，再实现 `suites` 主体，界面分期跟进 |

## 1. 背景

合奏解决的是「一个大任务拆给几名常驻成员」。它活在一个会话里，`/ensemble` 开始、`ensemble_end` 收场，指挥期间不能改文件。

用户实际的工作方式是另一种：一个长期目标（例如「Nocturne 插件兼容」「v0.54 发版」）下面陆续冒出一串任务。用户把任务丢进来，由一个协调者写提示词、开编码会话、等结果、核对、返工、合并。今天这个流程靠外部的 Claude Code 窗口加 Nocturne MCP（`nocturne_start_session` / `nocturne_send` / `nocturne_wait`）手工完成。

Claude Code Projects 把这种用法做成了产品：一条常驻的协调对话、一组各自独立上下文的线程、一个按状态分组的总览，以及每个线程开局都带上的项目说明和记忆。

## 2. 与合奏、Claude Projects 的对应

| 维度 | 合奏 | Claude Projects | 组曲（本决定） |
|---|---|---|---|
| 存在方式 | 会话里的一种执行方式，有开始和结束 | 独立实体，长期存在 | 独立实体，长期存在，侧栏有自己的入口 |
| 协调者 | 指挥，期间卸载编辑工具 | 项目对话 | 组曲指挥，**始终**没有编辑工具，保留只读工具、`shell`、`apply_subagent_changes` |
| 工人 | 有名字、带任务书的常驻成员 | 线程，各自上下文 | 线程，各自上下文，复用合奏成员的常驻子会话机制 |
| 汇报 | 留言板发帖 `@maestro` | 结束时汇报 | 每轮结束自动汇报给指挥 |
| 接新活 | 不接，一次一个任务 | 新消息分给已有线程或开新线程 | 同 Claude Projects |
| 共享上下文 | 任务书 | 项目说明、项目记忆、仓库 CLAUDE.md | 组曲说明、组曲记忆、工作区 AGENTS.md（已有） |
| 总览 | 概览里的合奏分组 | Overview 按状态分组 | 右侧面板「总览」，按状态分组 |
| 运行位置 | 本机 | 云端为主，可回本机 | **只在本机**，手机经中继查看和插话 |
| PR | 无 | 开 PR、盯 CI、自动修 | **不做**，用工作树分支 + `apply_subagent_changes` 并回 |

## 3. 决定

### 3.1 模块边界

- 一期前置先从合奏抽出中性的常驻子会话共享层 `packages/core/src/resident/index.ts`（`resident` 模块），导出与合奏无关的类型与纯函数：
  - `ResidentKind`（`"ensemble" | "suite"`）、`residentCallId(kind, name)`、`residentKindOf(callId)`；
  - `ResidentChildSession`（由原 `ManagedMemberSession` 改名而来）、`ResidentChildOpenSpec`（由原 `EnsembleMemberOpenSpec` 改名而来，增加 `kind: ResidentKind`）；
  - `ResidentWorktreeHandle` 与 `ResidentWorktreeOps`（由原 `EnsembleWorktreeHandle` / `EnsembleWorktreeOps` 改名而来）。
- `packages/core/src/index.ts` 将原合奏专用装配类型与内部控制符号改为中性的 `ResidentChildAssemblyOptions`（带 `kind: ResidentKind`）、`ResidentChildInternalControls` 与 `RESIDENT_CHILD_CONTROLS`，并在 `assembleSession` 作用域内提取可复用的 `openResidentChild(spec, isParentActive)` 与 `residentWorktreeOps(parentSessionId, activeIsolatedChildIds)`，由 `ensemble` 控制器与后续 `suites` 指挥共同注入；`session/subagent-observe.ts` 经注入的 `isResidentParent`（底层调用 `residentKindOf`）排除常驻子会话；`protocol/types.ts` 的 `PendingInputMode` 预留 `"suite"` 类型成员。
- `packages/core/src/ensemble/controller.ts` 改用 `resident` 层的类型并在导出入口保留原别名（`ManagedMemberSession`、`EnsembleMemberOpenSpec`、`EnsembleWorktreeHandle`、`EnsembleWorktreeOps`）；合奏行为不变，既有测试原样通过即为验收标准。
- 后续组曲实现新增 `packages/core/src/suites/`，与 `ensemble/` 平级，**不 import `ensemble/`**，实际文件与导出接口如下：
  - `packages/core/src/suites/store.ts`：`createSuiteStore`、`isValidSuiteId`、`newSuiteId`、`SuiteStore`（读写 `<NOCTURNE_HOME>/suites/<suiteId>/suite.json`，走 `config/files.ts` 的 `enqueueConfigWrite` 与 `writeJsonAtomic`）；
  - `packages/core/src/suites/prompts.ts`：`buildSuiteCoordinatorPrompt`、`buildSuiteThreadPrompt`（`SuiteCoordinatorPromptInput`、`SuiteThreadPromptInput`）；
  - `packages/core/src/suites/tools.ts`：`createSuiteCoordinatorTools`、`SUITE_COORDINATOR_TOOL_NAMES`、`SUITE_THREAD_READ_DEFAULT_LIMIT`（5）、`SUITE_THREAD_READ_MAX_LIMIT`（50）及相关类型（五个指挥工具 `thread_start` / `thread_send` / `thread_list` / `thread_read` / `thread_resolve`）；
  - `packages/core/src/suites/controller.ts`：`createSuiteController`、`SuiteController`、`SuiteControllerDeps`、`SuiteEnabledModelEntry`、`SuiteAvailableProfileEntry`（管理线程生命周期、常驻子会话懒打开、工作树增量检查点与并回、每轮 `<thread-report>` 自动汇报、状态广播、重启补报、用户直连动作与关闭收尾）；
  - `packages/core/src/suites/index.ts`：统一导出以上模块，仅由 `packages/core/src/index.ts` 引入；
  - `packages/core/src/protocol/suite.ts`：组曲记录/输入类型（`SuiteRecord`、`CreateSuiteInput`、`UpdateSuiteInput`）、事件 payload、`<thread-report>` 格式化与 `SessionView.suite` 归约纯函数（`computeSuiteThreadGroup`、`reduceSuiteDurable`、`applySuiteThreadUpdated`、`summarizeSuiteToolCall` 等）。
- `docs/architecture/modules.md` 与 `.dependency-cruiser.cjs` 增加 `resident` 一节及 `resident-deps` 规则：`resident` 只依赖 `protocol`、`platform` 与 `tools`（`ToolDefinition` 类型），不得依赖 `ensemble`、`agent`、`session`；`ensemble` 可以依赖 `resident`。`suites` 由 `suites-deps`（允许 `resident`、`protocol`、`platform`、`config`、`tools`、`provider`）与 `only-index-imports-suites` 规则约束，不依赖 `ensemble`、`agent`、`session`。

### 3.2 存储

- `<NOCTURNE_HOME>/suites/<suiteId>/suite.json`：`{ version: 1, id, name, goal?, workspaces: string[], instructions, coordinatorSessionId, threadDefaults: { model?, reasoningEffort?, preset?, isolated? }, createdAt }`。程序维护，走配置写入队列和原子写，与 `mcp.json`、`plugins.json` 同一规则。
- 组曲记忆复用 [ADR-0098](ADR-0098-memory.md) 的 `suite` 范围（`<NOCTURNE_HOME>/memory/suites/<suiteId>/`），取消单独的 `memory.md`；指挥可读写，线程只读，用户可在界面管理。
- 线程名单与状态写在**指挥会话日志**的持久事件里（见 3.5），与合奏一样随事件流回放和远程同步。
- 不往仓库里写任何文件。

### 3.3 指挥

- 每个组曲有且只有一个指挥会话，`session.created.meta.suite = { id, role: "coordinator" }`。它不进侧栏会话列表，从组曲入口打开。
- 指挥长期存在，靠现有自动压缩控制长度。组曲没有「结束」，只能归档。
- 工具：只读工具、`shell`、后台命令、`apply_subagent_changes`、`todo_write`、`ask_user`、`skill`、MCP 工具，加组曲工具：
  - `thread_start({ title, task, model?, profile?, effort?, preset?, isolated?, workspace? })`：开线程，未给的字段取 `threadDefaults`，再取指挥自己的模型；
  - `thread_send({ thread, text })`：把后续消息交给已有线程（忙时作为插话，空闲时开新一轮）；
  - `thread_list()`：列出线程、状态和最近汇报首行；
  - `thread_read({ thread, limit? })`：读某个线程最近几轮的汇报全文；
  - `thread_resolve({ thread, reopen? })`：标记完成或重新打开；
  - 记忆读写使用 [ADR-0098](ADR-0098-memory.md) 的 `memory_read` / `memory_write({ scope: "suite", ... })` / `memory_delete`（取消 `suite_remember`）。
- 指挥的系统上下文带组曲名、目标、说明、记忆和线程名单摘要。
- 指挥收到用户消息后自己决定：直接回答、开新线程、还是交给已有线程。这条规则写在指挥的系统提示里，不在 Agent Loop 里写分支。

### 3.4 线程

- 线程是指挥的常驻子会话（`parent = { sessionId: 指挥, callId: "suite:" + threadId }`），复用 `resident` 层：交互式权限确认（与合奏成员相同，修订 `subagent.md` §7.1 的适用范围）、并发槽排队（成员总数不设上限，只受 `maxConcurrent` 约束）、可选独立工作树和每轮增量提交。
- 线程开局的上下文：组曲说明、组曲记忆、工作区自己的 AGENTS.md，加上指挥给的 `task`。
- 线程没有 `task`、`thread_*`、`memory_write`、`memory_delete` 工具（对 `suite` 范围仅可使用 `memory_read`）。线程想记一条组曲记忆时写在汇报里，由指挥决定是否记。
- **汇报**：线程每轮结束（含出错暂停）时，Runtime 把最后一条助手回复包成
  ```xml
  <thread-report thread="t3" title="设置页插件列表" status="idle">…</thread-report>
  ```
  作为待发输入送给指挥。指挥忙时排队，空闲时开新一轮。
- 用户可以直接打开线程会话私信、确认权限、回答提问和中断，复用合奏的「成员会话」标签。

### 3.5 持久事件与状态

- 指挥日志新增持久事件：`suite.thread_started`、`suite.thread_reported`、`suite.thread_resolved`、`suite.thread_reopened`、`suite.thread_model_changed`。线程实时状态走临时事件 `suite.thread_updated`，由 protocol 纯函数归约进 `SessionView.suite`，三端共用。
- 线程状态 → 总览分组：

| 分组 | 条件 |
|---|---|
| 等你处理 | 有待确认的权限或提问，或上一轮出错暂停 |
| 进行中 | 正在跑一轮，或排队等并发槽 |
| 待并回 | 独立工作树有未并回的提交 |
| 空闲 | 以上都不是，且未标记完成 |
| 已完成 | 用户或指挥标记完成 |

- 不做「一周无活动自动完成」，也不设线程数上限。
- **回退与分叉**：指挥的对话回退只回退对话，不回收线程，也不撤销线程事件；指挥会话不提供分叉。线程会话的回退和分叉照常。
- **重启**：指挥恢复时线程都按 `空闲` 或 `等你处理` 处理；线程子会话按需打开。已发出但未落到指挥日志的汇报按合奏的补报规则以暂停状态补回。

### 3.6 Runtime 与 RPC

- Runtime：`listSuites()`、`createSuite({ name, goal?, workspaces, instructions? })`、`updateSuite({ id, ... })`、`archiveSuite(id)`、`openSuite(id)`（返回指挥会话句柄）。组曲记忆管理复用 [ADR-0098](ADR-0098-memory.md) 的 `describeMemory` / `readMemory` / `deleteMemory` / `clearMemory`。
- 会话方法：`resolveThread({ thread, reopen? })`、`sendToThread({ thread, text })`（用户绕过指挥直接派活时用）。
- RPC 名称 `suites.*`、`session.resolveThread`、`session.sendToThread`。本机和远程连接都可用（手机要能看总览、插话、确认权限）。
- Nocturne MCP（ADR-0074）以后可以加 `nocturne_suite_send` 一类工具，本 ADR 不做。

### 3.7 界面（二期，桌面端已实现）

- 侧栏顶部「定时任务」之下加「组曲」入口，进入组曲列表（新建 / 编辑 / 归档确认）；树里「置顶」后「对话」前展示未归档组曲。组曲页 = 指挥对话（复用 `Conversation` 与 `Composer`，`suiteReport` 渲染为可点击的汇报行，不提供分叉）+ 右侧面板「组曲」标签（打开组曲页时自动打开）。
- 总览按 3.5 的五组列线程（空组隐藏、「已完成」默认折叠）：一行 = 状态圆点 + 标题 + 模型 + 第二段摘要；左键在面板里打开线程会话标签（底部发送走 `sendToThread`，不提供附件入口），右键支持「完成」/「重开」（`resolveThread`）。另有「记忆」与「说明」两个标签：「记忆」按条目列出组曲记忆（复用记忆管理的行、详情与删除确认，不做整段编辑）；「说明」可直接编辑保存（`updateSuite`）。
- 界面不加任何说明文字、占位提示和模式徽标；文案复用现有词（「等待确认」「已完成」等）。

### 3.8 手机（三期，手机网页与安卓已实现）

- 手机网页与安卓共用 `apps/desktop/src/web`，不单独改动安卓工程。首页「定时任务」之下提供「组曲」入口（无组曲时也显示），进入只读的 `SuitesPage`（不提供新建、编辑与归档，空列表留白）。
- 点击组曲经远程 `openSuite` 打开指挥会话并复用 `SessionScreen`：顶栏标题为组曲名，不提供分叉，汇报行（`suiteReport`）点按进入对应线程页。`PhoneSessions` 遵循与桌面 `conversations.ts` 一致的释放规则：有线程运行、待确认权限或待回答提问时不将指挥会话按空闲释放，重连时同样保留并经 `openSuite` 恢复。
- 指挥会话的侧边栏总览在原「合奏」区位置展示「组曲」区，复用 `suite-ui.ts` 的五组归约与行字段（空组隐藏、「已完成」默认折叠，点击展开），不做「记忆」与「说明」标签。
- 点击线程行或汇报行压入一条 history，经远程 `session.open` 打开 `childSessionId` 并复用 `SessionScreen` 查看过程、确认权限与回答提问；底部发送走指挥会话的 `sendToThread`（关闭附件入口与执行方式切换，空文本静默不发），顶栏标题为线程标题，「…」菜单提供「完成」/「重开」调用 `resolveThread`，返回回到指挥会话页。

## 4. 明确不做

- 云端运行、合上电脑继续跑；
- GitHub App、开 PR、盯 CI、自动修；
- Library 文件库（线程产出的文件在工作树里，用「变更」面板看）；
- 组曲级定时任务（以后可以让定时任务把提示词投给指挥）；
- 线程之间直接通信（需要时用合奏）。

## 5. 与 Compline 的关系

Compline（独立常驻 agent，见 `compline-brief.md`）也需要长期记忆和永续对话。组曲记忆是「一个组曲内共享的纯文本」，范围小、由指挥和用户维护，不做跨组曲检索。将来 Compline 设计长期记忆时可以复用这里的存储形状，但两者不合并。

## 6. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| 一期 | 抽出 `resident` 层（合奏测试原样通过）、`suites` 模块、存储、指挥工具、线程汇报、持久事件与视图、Runtime/RPC、文档 | 离线测试覆盖：开线程、自动汇报、`thread_send` 插话、权限冒泡、工作树并回、重启补报、指挥回退不影响线程 |
| 二期 | 桌面端组曲入口、组曲页、总览面板、记忆与说明编辑 | 真实截图，两种主题 |
| 三期 | 手机网页 / 安卓、TUI（`/suite` 与总览块） | 真实截图 / 帧文本 |

## 修订（2026-11-19）

- 配合 [ADR-0098](ADR-0098-memory.md) 长期记忆模块落地，修订第 3.2、3.3、3.4、3.6 节中的组曲记忆存储与接口：
  - 第 3.2 节：组曲记忆改用 ADR-0098 的 `suite` 范围（`<NOCTURNE_HOME>/memory/suites/<suiteId>/`），取消单独的 `<NOCTURNE_HOME>/suites/<suiteId>/memory.md`。
  - 第 3.3、3.4 节：取消 `suite_remember`，指挥改用 `memory_write({ scope: "suite", ... })`（及 `memory_read` / `memory_delete`）维护组曲记忆；线程按 ADR-0098 常驻子会话策略保持只读（无 `memory_write` / `memory_delete`）。
  - 第 3.6 节：去掉 Runtime 方法 `readSuiteMemory` 与 `writeSuiteMemory`，组曲记忆查询与清理复用 ADR-0098 的 `describeMemory` / `readMemory` / `deleteMemory` / `clearMemory`。
