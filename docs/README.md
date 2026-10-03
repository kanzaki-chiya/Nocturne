# Nocturne 文档索引

本页是导航索引，不是介绍文档。每篇文档只负责一个概念；按"总览 → 模块设计 → 协议"逐层深入，只读与当前任务相关的部分。

文档状态：**已接受；Phase 0–6 已验收**。各文档开头的 `v0.x` 是文档修订号，不是产品版本号。修改需走 [development/workflow.md](development/workflow.md) 中的流程，影响多个模块或难以逆转的修改需要新增 ADR。

## 从这里开始

| 读者 | 建议阅读顺序 |
|---|---|
| 第一次了解项目 | [../README.md](../README.md) → [architecture/overview.md](architecture/overview.md) |
| 准备写代码 | [../AGENTS.md](../AGENTS.md) → [architecture/overview.md](architecture/overview.md) → [architecture/modules.md](architecture/modules.md) → 相关模块文档 |
| Coding Agent | [../AGENTS.md](../AGENTS.md) 第 1、2 节给出按任务的阅读清单 |

## Architecture（设计与行为）

| 文档 | 回答的问题 |
|---|---|
| [overview.md](architecture/overview.md) | Nocturne 是什么、设计原则、核心模块、一次请求的数据流 |
| [modules.md](architecture/modules.md) | 每个模块负责什么、不负责什么、公开接口、依赖方向 |
| [agent-loop.md](architecture/agent-loop.md) | 一次 Turn 如何开始、执行工具、处理错误与中断、结束 |
| [sessions.md](architecture/sessions.md) | 会话的持久化、生命周期、恢复与崩溃处理 |
| [context.md](architecture/context.md) | 如何从会话历史构建模型上下文，token 预算与压缩 |
| [tools.md](architecture/tools.md) | 工具注册、执行管线、结果归一化、内置工具 |
| [permissions.md](architecture/permissions.md) | allow / ask / deny 规则模型、默认规则、审批流程 |
| [config.md](architecture/config.md) | 分层配置、程序设置与 Runtime 设置接口、配置文件格式、项目信任模型、Grant 持久化 |
| [mcp.md](architecture/mcp.md) | MCP 客户端：stdio 传输、服务器生命周期、工具包装与结果映射、`mcp` 权限类别 |
| [hooks.md](architecture/hooks.md) | Hooks：事件点、外部命令契约、与权限的关系、项目信任 |
| [subagent.md](architecture/subagent.md) | Subagent（子代理）：`task` 工具契约、Launcher 注入、子会话生命周期、受限工具集与权限收敛 |
| [observability.md](architecture/observability.md) | 诊断日志：开关与输出位置、记录种类、脱敏规则 |
| [providers.md](architecture/providers.md) | Provider 抽象、模型能力、流式与错误归一化 |
| [provider-setup.md](architecture/provider-setup.md) | 服务商配置向导（`nctrn setup`、`/provider`）、向导配置层、操作系统凭据后端、模型限额以上游为准；v0.3 起向导不再选模型，模型选择收归 `/model`（v0.2/v0.3） |
| [pitfalls.md](architecture/pitfalls.md) | 最容易犯的架构错误、早期症状与规避方式 |

## Apps（客户端）

| 文档 | 回答的问题 |
|---|---|
| [apps/cli.md](apps/cli.md) | `nctrn` 命令行客户端：参数、REPL、事件渲染、权限确认、会话恢复、退出码、配置来源 |
| [apps/tui.md](apps/tui.md) | 终端界面客户端：布局、主题、欢迎框、状态栏、模型选择页、服务商页、键位、降级行为；TTY 时为 `nctrn` 默认界面 |

## Protocols（精确契约）

修改接口、事件字段或跨模块数据结构时阅读。

| 文档 | 内容 |
|---|---|
| [events.md](protocols/events.md) | 事件信封、事件类型、持久化规则、顺序与关联 |
| [view.md](protocols/view.md) | `SessionView` 派生视图：reducer 状态形状、归约规则、重放等价不变量 |
| [rpc.md](protocols/rpc.md) | RPC 协议：JSON-RPC 2.0 报文、握手、方法映射、订阅回放、错误码、生命周期（`@nocturne/rpc`） |
| [tool-api.md](protocols/tool-api.md) | `ToolDefinition`、`ToolContext`、`ToolResult` |
| [provider-api.md](protocols/provider-api.md) | `Provider`、`ModelInfo`、`ModelRequest`、`ModelStreamEvent`、`ProviderError` |

## Development（开发流程）

| 文档 | 内容 |
|---|---|
| [repository-layout.md](development/repository-layout.md) | 仓库目录、代码放在哪里、何时拆包 |
| [workflow.md](development/workflow.md) | 修改流程、文档同步清单、测试要求 |

## Decisions（架构决策记录）

[decisions/README.md](decisions/README.md) 列出全部 ADR 及其状态。

`edit` 未命中诊断与 diff 显示方案见 [ADR-0027](decisions/ADR-0027-edit-diagnostics-diff-display.md)。

会话任务清单工具与进度显示方案见 [ADR-0028](decisions/ADR-0028-session-task-list.md)。

TUI 深浅主题与配色切换方案见 [ADR-0029](decisions/ADR-0029-tui-themes.md)。

TUI 对话框式设置页方案见 [ADR-0030](decisions/ADR-0030-dialog-settings-pages.md)。

OpenCode Zen / Go 预设、Responses 协议与会话标识请求头方案见 [ADR-0031](decisions/ADR-0031-opencode-presets-responses.md)。

向用户提问工具方案见 [ADR-0032](decisions/ADR-0032-ask-user-tool.md)。

网页抓取工具与 `@文件` 引用方案见 [ADR-0033](decisions/ADR-0033-web-fetch-file-refs.md)。

设置层与 `/settings` 页方案见 [ADR-0034](decisions/ADR-0034-settings-layer.md)。

当前 TUI 交互规格见 [apps/tui.md](apps/tui.md)；v0.4 的普通屏幕与临时切屏方案见 [ADR-0021](decisions/ADR-0021-tui-daily-usability.md)，它部分取代已接受的 [ADR-0020](decisions/ADR-0020-tui-fullscreen-rendering.md)。

## Roadmap

[roadmap/roadmap.md](roadmap/roadmap.md)：阶段划分与验收标准。

## Persona（角色设定）

[persona.md](persona.md)：看板娘 Noctelia（夜璃）的命名与人设，供后续人设功能与文案参考。

## Research（研究记录，按需阅读）

研究记录是写作当时的快照，不随代码维护，不作为约束来源。

| 文档 | 内容 |
|---|---|
| [research/zcode-review.md](research/zcode-review.md) | ZCode 源码架构评审：哪些借鉴、哪些简化、哪些不带入 |
| [research/provider-oauth.md](research/provider-oauth.md) | 主流 Provider OAuth 官方开放范围、首批选型与接入边界 |
