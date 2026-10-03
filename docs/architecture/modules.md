# 模块边界与依赖方向

> 状态：已接受 v0.2 ｜ 前置阅读：[overview.md](overview.md) ｜ 目录落点：[repository-layout.md](../development/repository-layout.md)

本文是模块职责与依赖方向的唯一主文档。每个模块的内部设计在各自文档中展开，这里只写边界。

## 1. 依赖方向

箭头表示"可以 import"。任何未画出的依赖都视为禁止；禁止循环依赖。

```text
                        apps/cli ──────────────┐
                        apps/tui ──────────────┤
                           │ 只用公开 API        │ 只用类型
                           ▼                    ▼
                    core/index（公开 API） ──▶ protocol
                           │
                           ▼
                         agent
          ┌────────┬───────┼─────────┬──────────┐
          ▼        ▼       ▼         ▼          ▼
       session  context  provider   tools     config
          │        │       │         │  ╲        │
          │        │       │         ▼   ╲       │
          │        │       │     permission ╲    │
          ▼        ▼       ▼         ▼       ▼   ▼
       platform   (types)  protocol protocol platform
```

规则汇总：

- `protocol` 不依赖任何模块，只包含类型和少量纯函数。
- `agent` 是 Core 内唯一的编排者，位于依赖图顶端；除 `core/index` 外，任何模块都不能 import `agent`。
- `tools` 可以调用 `permission`，但 `permission` 不知道任何具体工具。`permission` 可调用 `provider` 的公开接口实现安全审查；不按工具名、Provider 或模型写分支。
- `provider` 不依赖 `tools`、`session`、`agent`；它只看到中性的消息与工具规格数据。
- `context` 只依赖 `protocol` 与 `provider` 的**类型**，不调用 Provider，也不执行工具。
- 真实 I/O（文件系统、子进程、环境变量、网络之外的系统访问）集中在 `platform` 与 Provider 适配器中，业务逻辑不直接调用 `node:fs`、`node:child_process`。
- `hooks`（实现模块）依赖 protocol、platform、diagnostics；`HookRunner` 接口定义在 `permission`（`tools` 保留类型重导出），实例由 `core/index` 按会话配置装配注入——`tools` 与 `agent` 只见接口，不 import 实现（见 [hooks.md](hooks.md)）。
- `diagnostics`（调试通道）只依赖 protocol、platform；被 agent / context / tools / hooks / index 经注入使用，并经 `McpConnector` 传给 `packages/mcp`（见 [observability.md](observability.md)）。
- `packages/mcp`（`@nocturne/mcp`）只允许依赖 `@nocturne/core` 的 `index` / `protocol/index` 两个入口与 `@modelcontextprotocol/sdk`——与 `apps/*` 同一检查规则；**Core 不依赖 `mcp`**（见 [mcp.md](mcp.md)、[ADR-0011](../decisions/ADR-0011-mcp-client.md)）。
- 客户端（`apps/*`）只能使用 `@nocturne/core` 的公开入口与 `protocol` 类型，不得深度导入内部路径。CLI 对 TUI 可惰性 `import()` 主入口，或静态引用 `@nocturne/tui/slash-catalog` 与 `@nocturne/tui/text-format`；命令表不得 import 任何模块，纯文本入口仅复用格式函数、protocol 类型与 `string-width`，保证逐行模式不加载 Ink/React。其余 apps→apps 依赖禁止（[tui.md](../apps/tui.md) 第 9 节）。

依赖规则已由 dependency-cruiser 固化，见 [workflow.md](../development/workflow.md)。

## 2. 为什么没有独立的 `events` 模块

事件有两部分：**契约**（事件类型与字段）属于 `protocol`；**发布**（分配序号、持久化、分发给订阅者）是会话的职责，因为序号和日志都是按会话划分的。单独设一个 events 模块只会多出一层转发，所以不设。事件契约见 [events.md](../protocols/events.md)。

## 3. Core 模块

### protocol

- **负责**：事件信封与事件类型；客户端命令类型（submit、interrupt、respondPermission 等）；跨模块公共数据（消息内容块、用量、工具调用引用）；面向客户端的派生视图 reducer（`SessionView`，Phase 4，见 [view.md](../protocols/view.md)）。
- **不负责**：任何行为、I/O、可变状态（reducer 是纯函数，状态由调用方持有）。
- **公开接口**：`RuntimeEvent`、`ClientCommand`、`ContentBlock`、`Usage` 等类型；`createSessionView` / `reduceSessionView` / `replaySessionView`；`firstUserText`（用户消息原文首行）、`parseCompactionThreshold` 与 `estimateTokens`（共享的 token 估算）。
- **依赖**：无。**不能依赖**：一切。

### session

- **负责**：会话的创建、加载、列表；事件发布（为持久化事件分配 `seq`、先写日志再分发；为临时事件分配运行内序号）；把持久化事件折叠成 `SessionState`；日志校验、尾部截断与恢复修复；会话锁；写入失败时进入 `failed` 状态。
- **不负责**：决定下一步做什么（agent）；构建模型请求（context）；渲染。
- **公开接口**：`SessionStore`（create / load / list）、`Session`（`emit`、`state`、`subscribe`、`close`）。
- **依赖**：protocol、platform。**不能依赖**：agent、context、provider、tools。
- 详见 [sessions.md](sessions.md)。

### agent

- **负责**：Turn 与 Step 的循环；调用 Context Builder、Provider、Tool Executor；把结果作为事件写入会话；中断传播、重试、步数上限；`SubagentLauncher` 的实现（`agent/subagent.ts`，Phase 6）——唯一能 import `runTurn` 的地方，接口定义在 `tools`，由 `core/index` 装配进 `task` 工具。
- **不负责**：Provider 协议细节；工具具体行为；权限规则；持久化格式；任何 UI 概念。
- **公开接口**：`AgentRuntime.runTurn(session, input, signal)`、`createSubagentLauncher`，只被 `core/index` 使用。
- **依赖**：session、context、provider、tools、permission（仅用于组装 `PermissionGate` 并转交客户端回复）、config、protocol。**不能依赖**：apps、platform（通过 tools 与 session 间接使用）。
- 详见 [agent-loop.md](agent-loop.md)。

### context

- **负责**：系统提示与项目指令（`AGENTS.md` 等）的收集；从 `SessionState` 选取有效历史；token 估算与预算；压缩（截断旧工具输出、摘要）；输出中性的 `ModelRequest`。
- **不负责**：发送请求；决定会话历史如何存储。
- **公开接口**：`ContextBuilder.build(input): BuiltContext`、`ContextBuilder.estimate(...)`。
- **依赖**：protocol、provider（仅类型）。**不能依赖**：agent、tools（工具规格作为数据传入）、session 的持久化实现。
- 详见 [context.md](context.md)。

### provider

- **负责**：`Provider` 接口；`ModelInfo` 与能力声明；各模型服务适配器，把中性请求转换为服务协议、把流式响应归一化为 `ModelStreamEvent`、把错误归一化为 `ProviderError`。
- **不负责**：重试策略（由 agent 决定）；工具执行；上下文裁剪。
- **公开接口**：见 [provider-api.md](../protocols/provider-api.md)。
- **依赖**：protocol。**不能依赖**：agent、session、tools、context。
- 详见 [providers.md](providers.md)。

### tools

- **负责**：工具注册表；执行管线（输入校验 → 资源解析（经 platform）→ 权限 → 执行 → 结果归一化 → 生命周期事件）；中断与超时；结果大小预算；内置工具实现；图片附件存储（`AttachmentStore`，ADR-0023——字节落盘在 tools，Agent Loop 经注入接口读回，依赖方向不变）。
- **不负责**：权限规则本身；决定何时调用工具；渲染工具结果。
- **公开接口**：`ToolRegistry`、`ToolExecutor`、`ToolDefinition`（见 [tool-api.md](../protocols/tool-api.md)）；重导出权限层的 `HookRunner`（hooks 实现的注入点），另定义 `McpConnector` / `McpSession`（`packages/mcp` 的装配点）与 `SubagentLauncher`（`agent` 的注入点，Phase 6，见 [subagent.md](subagent.md)）类型。
- **依赖**：protocol、permission、platform、diagnostics（仅接口注入，未启用时为空实现）。**不能依赖**：agent、session、provider、context、hooks（实现）。
- 详见 [tools.md](tools.md)。

### permission

规则求值与异步闸门都在本模块；闸门负责审查、缓存、超时、一次性选项与确认，模型后端通过 Provider 公开接口调用。

- **负责**：规则分层与求值（allow / ask / deny）；生成决定的理由；管理待确认请求与会话级授权。
- **不负责**：展示确认对话框（客户端）；判断某个工具碰到了什么（工具通过 `permissionSubjects` 声明）；文件系统 I/O（真实路径等由 Tool Executor 经 platform 解析后传入，见 [permissions.md](permissions.md) 第 4 节）。
- **公开接口**：`PermissionPolicy.evaluate(subjects)`、`PermissionGate.check(request, signal)`、`SecurityReviewer.review(input, signal)`。
- **依赖**：protocol、provider。**不能依赖**：tools、agent、任何 UI。
- 详见 [permissions.md](permissions.md)。

### config

- **负责**：按层级加载配置（模型字段加入内置目录 < models.dev < 上游 < 用户编辑 < 手写配置）；校验并标注来源；项目配置的信任判定；按工作区读写项目 Grant 文件；读取 Provider 凭据所需的环境变量；在 config 层读取内置 models.dev 快照、原子缓存和显式刷新。config 只产生模型字段声明，Provider 层负责解释能力与档位；依赖方向仍为 config → platform/protocol，Provider 装配消费 config 结果。
- **不负责**：解释配置含义（各模块自己消费自己的配置段）；权限求值（permission 只接收已合并、已标注来源与信任状态的规则与 Grant 集合）。
- **公开接口**：`loadConfig(platform, { cliArgs })` → `RuntimeConfig`（`base` + `forWorkspace(workspaceRoot)`，见 [config.md](config.md) 第 6 节）。v0.2 增补向导写入与凭据读取（`saveSetupProvider`、`setCredential`、`removeSetupProvider`、`describeProviders`、`credentials`），以及 `runtime.updateProviders`，见 [provider-setup.md](provider-setup.md) 第 6 节。ADR-0022 增补 `shellSetting()` / `setShellSetting(kind, path?)`——`settings.json` 的读取与原子写。
- **依赖**：protocol、platform。
- 详见 [config.md](config.md)。

### diagnostics

- **负责**：接收各模块的诊断记录（模型请求、上下文构成、token、工具耗时、权限决定、Hook/MCP 调用），脱敏后写 JSONL 文件或 stderr；未启用时为零开销空实现。
- **不负责**：会话事件（那是 session/protocol 的职责）；日志轮转与上传。
- **依赖**：protocol、platform。**不能依赖**：agent、session、tools、hooks。
- 详见 [observability.md](observability.md)。

### hooks

- **负责**：`HookRunner` 的实现——按配置在固定事件点 spawn 外部命令、stdin 传 JSON、解析 stdout JSON / 退出码、超时与输出上限控制。
- **不负责**：决定 Hook 输出如何生效（`PreToolUse`/`PostToolUse` 的效果合并在 tools 管线，`PermissionRequest` 在 gate，生命周期点在 index/agent）；信任判定（config 层按 `trust.json` 决定项目 Hook 是否进入配置）。
- **依赖**：protocol、platform、diagnostics。**不能依赖**：agent、tools、session。
- 详见 [hooks.md](hooks.md)。

### platform

- **负责**：文件系统访问、子进程启动与终止（含进程树）、路径规范化、用户目录解析、剪贴板图片读取（Windows PowerShell 5.1 STA，其他平台暂不支持），屏蔽 Windows / macOS / Linux 差异；shell 种类描述符与安装探测（`shells.ts`，ADR-0022：调用形态、语法说明、分页器名单、大小写敏感性等元数据随 `ShellDescriptor` 交给 tools / permission 消费，platform 不 import 权限语义）。
- **不负责**：任何业务判断（例如"是否在工作区内"属于 permission；shell 命令的风险判定同）。
- `configureEnvProxy()` 提供显式进程入口代理初始化，公开经 `core/index` 导出；导入与 Runtime 创建不自动调用，行为见 [config.md](config.md#网络代理)。
- **依赖**：无（仅 Node.js 标准库）。

### input-history（`src/input-history.ts`，单文件）

- **负责**：交互输入历史的读写——`<NOCTURNE_HOME>/history.jsonl`（明文 JSONL），按工作区过滤、连续去重、满 1000 条截断重写；由 `core/index` 装配进 `RuntimeSession.readInputHistory` / `recordInputHistory`（见 [config.md](config.md) 第 1 节）。
- **不负责**：历史的上屏与键位（各客户端实现）。
- **依赖**：platform。**不能依赖**：session、agent、tools 等其余模块。

### core/index（公开 API）

客户端看到的全部能力都经由这里：

```ts
const runtime = await createRuntime({ cwd, providerConfigs, interactive, config })  // 选项见 RuntimeOptions
const session = await runtime.createSession({ model: "provider/model" })  // 或 resumeSession(id, { force?, model? }) / listSessions()
const unsubscribe = session.subscribe((event) => render(event))
session.durableEvents()                                      // 已写入日志的持久事件（旧→新）；先回放再 subscribe，见 view.md 第 6 节
await session.submit({ text: "修复登录测试" })                 // 返回在 Turn 结束时 resolve
session.interrupt()
await session.respondPermission(requestId, { decision: "allow", remember: "project" })  // Phase 3 起生成 Grant
await session.setModel({ provider: "…", model: "…" })          // → session.config_changed
await session.setPermissionPreset("auto-edit")                // → session.config_changed（Phase 3）
await session.setReasoningEffort("high")                      // → session.config_changed；Turn 中允许，下一个 Turn 生效（ADR-0018）
await session.setShell("pwsh")                                // → session.config_changed（shell）；下一次 shell 调用生效（ADR-0022）
session.shellInfo() / session.listShells()                    // 生效 shell 与来源层 / 全部种类的探测结果（含不可用）
await session.compact()                                       // → context.compacted("summary")
const { report, overBudget } = session.describeContext()       // ContextReport 查询，不产事件
runtime.listModels()                                          // 全部可用模型（/model 用）
await session.close()
```

`createRuntime` 的选项（`RuntimeOptions`）直接接收各模块的配置：`cwd`、`workspaceRoot`、`sessionsDir`、`providers`（直接注入的 Provider 实例，如测试用 `FakeProvider`）、`providerConfigs`（声明式 Provider 配置：`openai-compatible` 与 `anthropic` 的判别联合）、`modelOverrides`、`policy`、`permissions`、`interactive`（是否有回复权限请求的客户端；默认 `false`）、`instructions`、`turn`（`maxSteps` / `retryLimit` / `retryBaseDelayMs`）、`config`、`mcp`（`McpConnector`，`packages/mcp` 装配）、`debug`（诊断开关，`{ enabled?, file? }`）。

`permissions` 选项在 Phase 3 扩展为：`{ preset?: PermissionPresetName, rules?: { user?: PermissionRule[], cli?: PermissionRule[] }, autoApproveAsk?: boolean }`——预设与按层标注的规则；项目层规则与 Grant 集合在 `wrapSession` 时按会话的 `workspaceRoot` 从 `config` 取得（[config.md](config.md) 第 6 节），因为项目配置的信任与生效范围都以会话绑定的目录为准。`policy` 直注入保留，用于测试与特殊客户端；给定 `policy` 时规则系统不生效。

Phase 6 增补：`subagent` 选项（`enabled`/`maxDepth`/`maxConcurrent`/`maxStepsPerTurn`/`maxAttempts`/`timeoutMs`）控制子代理特性；启用时 `wrapSession` 创建 `SubagentLauncher` 并把 `task` 工具注册进会话注册表（[subagent.md](subagent.md) 第 3 节）。

`config` 是 `loadConfig` 返回的 `RuntimeConfig`（可选）：缺省时等价于 Phase 2 行为——无配置文件、固定 `default` 预设、无项目层与 Grant 持久化。CLI 在启动时调用 `loadConfig(platform, { cliArgs })` 并把结果连同 `providerConfigs`、`turn` 等派生字段一起注入（见 [apps/cli.md](../apps/cli.md) 第 8 节）。

`RuntimeConfig` 与 `Runtime` 的通用字符串偏好读写接口及未注入配置时的行为见 [config.md](config.md) 第 2 节；Core 不解释 TUI 主题取值。

恢复相关的会话 API：`resumeSession(id, { force?: boolean })`（`force` 对应强制解锁，见 [sessions.md](sessions.md) 第 4 节）；`listSessions({ cwd? })` 的摘要含 `locked` 字段；`session.recovery` 暴露本次打开执行的修复（截断尾部、补齐调用与 Turn）。

`RuntimeSession` 只暴露上面这些方法，不暴露内部 `Session` 对象：客户端回放视图用 `durableEvents()`，不得绕道读会话内部状态（[ADR-0044](../decisions/ADR-0044-rpc-stdio.md) 第 5 节）。Core 与客户端自己的测试需要直接发事件时，经 `createRuntime` 挂在会话对象上的 `Symbol.for("nocturne.core.internalSession")` 属性取内部 `Session`——该属性不在公开类型里，也不可枚举。

`describeContext` 与 `listModels` 是**只读查询**：不改变会话状态、不产生事件，只为客户端展示服务。

Phase 4 增补的客户端共享入口（已验收，[apps/tui.md](../apps/tui.md) 第 9 节）：`normalizeModelRef`（`provider/model` 归一化，CLI 与 TUI 的 `/model` 共用）。配置收集与会话打开语义留在 CLI，`nctrn --tui` 在打开会话后把 `Session` 交给 `runTui`。

这组命令与事件就是将来 RPC 需要序列化的全部内容；进程内客户端和远程客户端使用同一份语义（见 [ADR-0002](../decisions/ADR-0002-ui-independent-core.md)）。

`session.mcpServers()` 是 Phase 5 增补的只读查询：返回本会话各 MCP 服务器的状态（`McpServerStatus[]`），不产事件，供 `/mcp` 命令展示（见 [mcp.md](mcp.md) 第 7 节）。

### packages/mcp（独立于 Core 的包）

`@nocturne/mcp` 是 MCP 客户端实现：按 `McpConnector` 接口把 MCP 服务器（stdio 子进程）的工具包装成 `ToolDefinition`，并管理服务器进程生命周期（启动、initialize、崩溃重连、关闭时进程树清理）。只依赖 `@nocturne/core` 的公开入口与 `@modelcontextprotocol/sdk`；由 `apps/cli` 装配后经 `RuntimeOptions.mcp` 注入。详见 [mcp.md](../architecture/mcp.md) 与 [ADR-0011](../decisions/ADR-0011-mcp-client.md)。

## 4. 客户端

### apps/cli（`nctrn`）

- **负责**：参数解析；REPL 输入；把事件渲染为终端输出（流式文本、工具状态、diff 摘要）；权限确认提示并调用 `respondPermission`；退出码。
- **不负责**：任何 Agent 行为、会话状态、权限判定、上下文构建。
- **依赖**：`@nocturne/core` 公开 API 与 `protocol`；`rpc --stdio` 入口使用 `@nocturne/rpc/server`；对 `apps/tui` 仅有 `@nocturne/tui` 的惰性 `import()` 及 `@nocturne/tui/slash-catalog`、`@nocturne/tui/text-format` 的静态引用。
- 详见 [apps/cli.md](../apps/cli.md)。

### apps/tui（Phase 4，已验收）

- **负责**：终端界面客户端——会话回放、工具状态与 diff、权限对话框、状态栏、会话选择器、鼠标滚轮翻阅与拖动选中复制；渲染 `SessionView`，把按键翻译为公开命令。
- **不负责**：任何 Agent 行为、事件投影（用 `protocol` 的 reducer）、权限判定；不复用 CLI 渲染代码。
- **依赖**：`@nocturne/core` 公开 API 与 `protocol`；终端依赖 Ink、React、`string-width` 按 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)，Markdown 词法分析依赖 `marked` 按 [ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 批准。
- 详见 [apps/tui.md](../apps/tui.md)。

### packages/rpc（v0.5，[ADR-0044](../decisions/ADR-0044-rpc-stdio.md)）

- **负责**：把 `Runtime` / `RuntimeSession` 的公开 API 映射成 JSON-RPC 2.0 方法，把会话事件推成 `event` 通知（`@nocturne/rpc/server`，与传输无关）；提供类型化客户端（`@nocturne/rpc/client`）。方法、报文与错误码见 [rpc.md](../protocols/rpc.md)。
- **不负责**：任何 Agent 行为、权限判定（只转发 `permission.requested` 与回复）、配置加载与 MCP 装配（由 `apps/cli` 的 `nctrn rpc --stdio` 入口完成）、传输之外的网络与鉴权。
- **依赖**：服务端依赖 `@nocturne/core` 公开入口；客户端运行时只依赖 `@nocturne/core/protocol`，对 `@nocturne/core` 只有 `import type`，不用 Node 内置模块。由 depcheck 的 `rpc-*` 规则强制。

## 5. 未来模块（现在不创建目录）

目前没有待创建的模块。WebSocket 等网络传输、`packages/protocol` 拆包、多客户端共享后台，都留到真实需求出现时再写 ADR。

`subagent` 已在 Phase 6 落地：它不是独立模块——接口在 `tools`、实现在 `agent`、装配在 `core/index`，见 [subagent.md](subagent.md) 第 3 节。

新增这些模块时，先更新本文与对应架构文档，再写代码。
