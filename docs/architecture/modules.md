# 模块边界与依赖方向

> 状态：已接受 v0.2 ｜ 前置阅读：[overview.md](overview.md) ｜ 目录落点：[repository-layout.md](../development/repository-layout.md)

本文是模块职责与依赖方向的唯一主文档。每个模块的内部设计在各自文档中展开，这里只写边界。

## 1. 依赖方向

箭头表示"可以 import"。任何未画出的依赖都视为禁止；禁止循环依赖。

```text
                        apps/cli ──────────────┐
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
- `tools` 可以调用 `permission`，但 `permission` 不知道任何具体工具。
- `provider` 不依赖 `tools`、`session`、`agent`；它只看到中性的消息与工具规格数据。
- `context` 只依赖 `protocol` 与 `provider` 的**类型**，不调用 Provider，也不执行工具。
- 真实 I/O（文件系统、子进程、环境变量、网络之外的系统访问）集中在 `platform` 与 Provider 适配器中，业务逻辑不直接调用 `node:fs`、`node:child_process`。
- 客户端（`apps/*`）只能使用 `@nocturne/core` 的公开入口与 `protocol` 类型，不得深度导入内部路径。

依赖规则在 Phase 1 用静态检查工具（如 dependency-cruiser）固化进 CI，见 [workflow.md](../development/workflow.md)。

## 2. 为什么没有独立的 `events` 模块

事件有两部分：**契约**（事件类型与字段）属于 `protocol`；**发布**（分配序号、持久化、分发给订阅者）是会话的职责，因为序号和日志都是按会话划分的。单独设一个 events 模块只会多出一层转发，所以不设。事件契约见 [events.md](../protocols/events.md)。

## 3. Core 模块

### protocol

- **负责**：事件信封与事件类型；客户端命令类型（submit、interrupt、respondPermission 等）；跨模块公共数据（消息内容块、用量、工具调用引用）。
- **不负责**：任何行为、I/O、状态。
- **公开接口**：`RuntimeEvent`、`EventType`、`ClientCommand`、`ContentBlock`、`Usage` 等类型。
- **依赖**：无。**不能依赖**：一切。

### session

- **负责**：会话的创建、加载、列表；事件发布（为持久化事件分配 `seq`、先写日志再分发；为临时事件分配运行内序号）；把持久化事件折叠成 `SessionState`；日志校验、尾部截断与恢复修复；会话锁；写入失败时进入 `failed` 状态。
- **不负责**：决定下一步做什么（agent）；构建模型请求（context）；渲染。
- **公开接口**：`SessionStore`（create / load / list）、`Session`（`emit`、`state`、`subscribe`、`close`）。
- **依赖**：protocol、platform。**不能依赖**：agent、context、provider、tools。
- 详见 [sessions.md](sessions.md)。

### agent

- **负责**：Turn 与 Step 的循环；调用 Context Builder、Provider、Tool Executor；把结果作为事件写入会话；中断传播、重试、步数上限。
- **不负责**：Provider 协议细节；工具具体行为；权限规则；持久化格式；任何 UI 概念。
- **公开接口**：`AgentRuntime.runTurn(session, input, signal)`，只被 `core/index` 使用。
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

- **负责**：工具注册表；执行管线（输入校验 → 资源解析（经 platform）→ 权限 → 执行 → 结果归一化 → 生命周期事件）；中断与超时；结果大小预算；内置工具实现。
- **不负责**：权限规则本身；决定何时调用工具；渲染工具结果。
- **公开接口**：`ToolRegistry`、`ToolExecutor`、`ToolDefinition`（见 [tool-api.md](../protocols/tool-api.md)）。
- **依赖**：protocol、permission、platform。**不能依赖**：agent、session、provider、context。
- 详见 [tools.md](tools.md)。

### permission

- **负责**：规则分层与求值（allow / ask / deny）；生成决定的理由；管理待确认请求与会话级授权。
- **不负责**：展示确认对话框（客户端）；判断某个工具碰到了什么（工具通过 `permissionSubjects` 声明）；任何 I/O（真实路径等由 Tool Executor 经 platform 解析后传入，见 [permissions.md](permissions.md) 第 4 节）。
- **公开接口**：`PermissionPolicy.evaluate(subjects)`、`PermissionGate.check(request, signal)`。
- **依赖**：protocol。**不能依赖**：tools、agent、任何 UI。
- 详见 [permissions.md](permissions.md)。

### config

- **负责**：按层级加载配置（内置默认 < 用户 < 项目 < 环境变量 < 命令行参数）；校验；记录每个配置值的来源；项目配置的信任判定（`trustedWorkspaces`）；按工作区读写项目 Grant 文件；读取 Provider 凭据所需的环境变量。
- **不负责**：解释配置含义（各模块自己消费自己的配置段）；权限求值（permission 只接收已合并、已标注来源与信任状态的规则与 Grant 集合）。
- **公开接口**：`loadConfig(platform, { cliArgs })` → `RuntimeConfig`（`base` + `forWorkspace(workspaceRoot)`，见 [config.md](config.md) 第 6 节）。
- **依赖**：protocol、platform。
- 详见 [config.md](config.md)。

### platform

- **负责**：文件系统访问、子进程启动与终止（含进程树）、路径规范化、用户目录解析，屏蔽 Windows / macOS / Linux 差异。
- **不负责**：任何业务判断（例如"是否在工作区内"属于 permission）。
- **依赖**：无（仅 Node.js 标准库）。

### core/index（公开 API）

客户端看到的全部能力都经由这里：

```ts
const runtime = await createRuntime({ cwd, providerConfigs, interactive, config })  // 选项见 RuntimeOptions
const session = await runtime.createSession({ model: "provider/model" })  // 或 resumeSession(id, { force? }) / listSessions()
const unsubscribe = session.subscribe((event) => render(event))
await session.submit({ text: "修复登录测试" })                 // 返回在 Turn 结束时 resolve
session.interrupt()
await session.respondPermission(requestId, { decision: "allow", remember: "project" })  // Phase 3 起生成 Grant
await session.setModel({ provider: "…", model: "…" })          // → session.config_changed
await session.setPermissionPreset("auto-edit")                // → session.config_changed（Phase 3）
await session.compact()                                       // → context.compacted("summary")
const { report, overBudget } = session.describeContext()       // ContextReport 查询，不产事件
runtime.listModels()                                          // 全部可用模型（/model 用）
await session.close()
```

`createRuntime` 的选项（`RuntimeOptions`）直接接收各模块的配置：`cwd`、`workspaceRoot`、`sessionsDir`、`providers`（直接注入的 Provider 实例，如测试用 `FakeProvider`）、`providerConfigs`（声明式 Provider 配置：`openai-compatible` 与 `anthropic` 的判别联合）、`modelOverrides`、`policy`、`permissions`、`interactive`（是否有回复权限请求的客户端；默认 `false`）、`instructions`、`turn`（`maxSteps` / `retryLimit` / `retryBaseDelayMs`）、`config`。

`permissions` 选项在 Phase 3 扩展为：`{ preset?: PermissionPresetName, rules?: { user?: PermissionRule[], cli?: PermissionRule[] }, autoApproveAsk?: boolean }`——预设与按层标注的规则；项目层规则与 Grant 集合在 `wrapSession` 时按会话的 `workspaceRoot` 从 `config` 取得（[config.md](config.md) 第 6 节），因为项目配置的信任与生效范围都以会话绑定的目录为准。`policy` 直注入保留，用于测试与特殊客户端；给定 `policy` 时规则系统不生效。

`config` 是 `loadConfig` 返回的 `RuntimeConfig`（可选）：缺省时等价于 Phase 2 行为——无配置文件、固定 `default` 预设、无项目层与 Grant 持久化。CLI 在启动时调用 `loadConfig(platform, { cliArgs })` 并把结果连同 `providerConfigs`、`turn` 等派生字段一起注入（见 [apps/cli.md](../apps/cli.md) 第 7 节）。

恢复相关的会话 API：`resumeSession(id, { force?: boolean })`（`force` 对应强制解锁，见 [sessions.md](sessions.md) 第 4 节）；`listSessions({ cwd? })` 的摘要含 `locked` 字段；`session.recovery` 暴露本次打开执行的修复（截断尾部、补齐调用与 Turn）。

`describeContext` 与 `listModels` 是**只读查询**：不改变会话状态、不产生事件，只为客户端展示服务。

这组命令与事件就是将来 RPC 需要序列化的全部内容；进程内客户端和远程客户端使用同一份语义（见 [ADR-0002](../decisions/ADR-0002-ui-independent-core.md)）。

## 4. 客户端

### apps/cli（`nctrn`）

- **负责**：参数解析；REPL 输入；把事件渲染为终端输出（流式文本、工具状态、diff 摘要）；权限确认提示并调用 `respondPermission`；退出码。
- **不负责**：任何 Agent 行为、会话状态、权限判定、上下文构建。
- **依赖**：`@nocturne/core` 公开 API 与 `protocol`。
- 详见 [apps/cli.md](../apps/cli.md)。

## 5. 未来模块（现在不创建目录）

| 模块 | 接入点 | 依赖约束 |
|---|---|---|
| `tui` | 与 CLI 同为客户端，订阅事件；需要的派生视图由 `protocol` 提供纯函数 reducer | 只依赖公开 API 与 protocol |
| `mcp` | 把 MCP 服务器的工具包装成 `ToolDefinition` 注册进 `ToolRegistry`；工具名带命名空间 `mcp__<server>__<tool>` | 依赖 tools 的注册接口与 platform；Core 不依赖 mcp |
| `hooks` | Tool Executor 与 Agent Loop 在固定点位调用可选的 `HookRunner` 接口（PreToolUse、PostToolUse 等） | 接口定义在 tools / agent；未配置时 Runtime 行为不变 |
| `subagent` | 一个内置工具通过注入的 `SubagentLauncher` 创建子会话并运行受控 Turn | 工具不 import agent；launcher 由 agent 注入，避免循环 |
| `rpc` | 服务端把公开 API 映射到传输层（stdio / WebSocket）；客户端只依赖 protocol | 服务端依赖公开 API；RPC 客户端不依赖 Core 实现 |

新增这些模块时，先更新本文与对应架构文档，再写代码。
