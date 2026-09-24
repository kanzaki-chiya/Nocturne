# 架构总览

> 状态：已接受 v0.2 ｜ 读者：所有人 ｜ 读完后下一步：[modules.md](modules.md)

本文只回答五个问题：Nocturne 是什么、按什么原则设计、由哪些模块组成、一次请求的数据怎样流动、详细内容去哪里找。细节一律链接到专门文档。

## 1. Nocturne 是什么

1. **定位**：一个开源的 Coding Agent Runtime，外加以它为核心的命令行助手 `nctrn`。用户在代码仓库中用自然语言下达任务，Agent 通过工具阅读、搜索、修改代码并运行命令。
2. **当前能力**：CLI 与 TUI 共用 Runtime，提供流式输出、内置与 MCP 工具、Hooks、子代理、权限审批和可恢复的会话。
3. **长期目标**：同一套 Runtime 被 CLI、TUI、RPC 服务以及更远的 Web / Desktop / IDE 客户端复用。客户端增多时 Runtime 不需要改变。
4. **Runtime 与 UI 分离**：Runtime 只产生结构化事件、接收结构化命令；它不知道自己被谁驱动、怎样渲染。
5. **一个事实来源**：会话的持久化事实是一条追加式事件日志（见 [sessions.md](sessions.md)）。会话状态、模型上下文、界面视图都从它派生，不存在第二份需要同步的"真相"。
6. **显式声明优于隐式判断**：工具声明自己的副作用，权限按规则判定，Provider 声明模型能力。核心流程里不按工具名或 Provider 名写分支。
7. **可观测、可恢复**：每一步都有事件；中断、错误、权限决定都有明确的归属和记录；崩溃后能恢复到最后一个完整的事实。
8. **正确且简单优先于为假想需求而复杂**：MCP、Hooks、Subagent 已按路线图实现；RPC 等能力仍未排期。

**Nocturne 不是**：多 Agent 编排框架、云端服务、带账号体系的商业产品、浏览器或桌面自动化工具，也不是任何现有产品的 fork。

## 2. 核心概念

| 概念 | 含义 |
|---|---|
| **Runtime** | 进程内的 Nocturne 核心实例，管理会话、配置、Provider 与工具注册表。 |
| **Session** | 一次持续的对话与任务，绑定一个工作目录，持久化为事件日志。 |
| **Turn** | 用户一次输入触发的完整处理过程，直到 Agent 给出最终回复、被中断或出错。 |
| **Step** | Turn 内的一次模型请求。模型返回工具调用时，执行工具后进入下一个 Step。 |
| **Tool Call** | 模型请求执行的一次工具调用，由 Runtime 分配会话内唯一的 `callId`。 |
| **Event** | Runtime 发出的结构化事实。一部分持久化（构成会话日志），一部分只用于实时显示（如文本增量）。 |
| **Context** | 每个 Step 发给模型的请求内容，由 Context Builder 从会话状态临时构建，不等于会话历史。 |

## 3. 系统结构与数据流

```text
┌──────────────── Client：CLI / TUI / 将来的 RPC、Web、IDE ────────────────┐
│  只负责：输入采集、渲染、交互（如权限确认对话框）                          │
└──────┬───────────────────────────────────────────────────────▲───────────┘
       │ 命令：submit / interrupt / respondPermission / ...     │ 事件流
       ▼                                                       │
┌──────────────────────────── Core Runtime ──────────────────────────────────┐
│  Session Handle（公开 API）                                                │
│       │                                                                   │
│       ▼                                                                   │
│  Agent Loop ──emit──▶ Session（分配 seq → 持久化事件 → 发布给订阅者）──────┘
│   │   ▲                    │ 派生状态（历史、配置、用量）
│   │   └── Context Builder ◀┘ 构建本 Step 的模型请求
│   ▼
│  Provider（归一化流式输出）──▶ 模型服务
│   │ 工具调用
│   ▼
│  Tool Executor：校验 → 解析资源 → Permission Policy → 执行 → 结果归一化
│   │                  │ ask：发出 permission.requested 事件，等待客户端回复
│   ▼                  ▼
│  内置工具 ──▶ Platform（文件系统、子进程）
│   │ ToolResult
│   └──▶ Agent Loop 记录结果 → 下一个 Step（或结束 Turn）
└───────────────────────────────────────────────────────────────────────────┘
```

与"User → Session → Runtime → Context → Provider → Tool → Event → Runtime"这种线性流水线相比，有三点刻意不同：

- **Session 不是流水线的一站**，而是 Agent Loop 读取和写入的状态所有者；
- **Event 不是回到 Runtime 的一站**，而是每一步向外发布、同时写入日志的旁路输出；工具结果回到模型的路径是"记录到会话 → Context Builder 重新构建请求"；
- **Permission 位于 Tool Executor 的管线内部**，Agent Loop 无法绕过它；需要用户确认时，请求经事件流交给客户端，回复经命令回到 Runtime。

一次 Turn 的详细步骤见 [agent-loop.md](agent-loop.md)。

## 4. 模块一览

| 模块 | 一句话职责 | 详细文档 |
|---|---|---|
| `protocol` | 客户端与 Runtime 之间共享的类型：事件、命令、公共数据结构 | [events.md](../protocols/events.md) |
| `session` | 会话日志、事件发布、状态折叠、恢复修复 | [sessions.md](sessions.md) |
| `agent` | Agent Loop：驱动 Turn 与 Step | [agent-loop.md](agent-loop.md) |
| `context` | 从会话状态构建模型请求，管理 token 预算与压缩 | [context.md](context.md) |
| `provider` | Provider 接口、模型能力、各模型服务的适配器 | [providers.md](providers.md) |
| `tools` | 工具注册表、执行管线、内置工具 | [tools.md](tools.md) |
| `permission` | 权限规则求值与审批请求 | [permissions.md](permissions.md) |
| `config` | 配置分层加载与合并、项目信任、Grant 持久化 | [config.md](config.md) |
| `diagnostics` | 脱敏诊断日志 | [observability.md](observability.md) |
| `hooks` | 生命周期与工具事件点的外部命令 | [hooks.md](hooks.md) |
| `packages/mcp` | MCP stdio 客户端与工具包装 | [mcp.md](mcp.md) |
| `subagent` | 受控子会话与结果返回 | [subagent.md](subagent.md) |
| `platform` | 文件系统、子进程、路径等跨平台 I/O | [modules.md](modules.md) |
| `apps/cli` | `nctrn` 命令行客户端 | [apps/cli.md](../apps/cli.md) |
| `apps/tui` | Ink 终端客户端 | [apps/tui.md](../apps/tui.md) |

模块边界、公开接口与依赖方向见 [modules.md](modules.md)；目录结构见 [repository-layout.md](../development/repository-layout.md)。

## 5. 为什么这样设计

关键取舍记录在 ADR 中：

- [ADR-0001](../decisions/ADR-0001-typescript-node.md)：TypeScript + Node.js
- [ADR-0002](../decisions/ADR-0002-ui-independent-core.md)：Core 与 UI 解耦，客户端通过命令与事件交互
- [ADR-0003](../decisions/ADR-0003-session-event-log.md)：追加式事件日志作为会话唯一事实来源
- [ADR-0004](../decisions/ADR-0004-permission-rules.md)：规则化的权限策略层
- [ADR-0005](../decisions/ADR-0005-own-provider-interface.md)：自有 Provider 接口，不暴露第三方 SDK 类型
- [ADR-0006](../decisions/ADR-0006-anthropic-transport.md)：anthropic 适配器传输选型
- [ADR-0007](../decisions/ADR-0007-config-format.md)：配置文件格式与分层
- [ADR-0008](../decisions/ADR-0008-project-trust-grants.md)：项目配置信任模型与 Grant 持久化
- [ADR-0009](../decisions/ADR-0009-session-lock.md)：会话锁机制
- [decisions/README.md](../decisions/README.md)：后续已接受的 ADR-0010–0014 与全部决策索引

这些决定的研究依据见 [research/zcode-review.md](../research/zcode-review.md)。
