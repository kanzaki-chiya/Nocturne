# Nocturne 文档索引

本页是导航索引，不是介绍文档。每篇文档只负责一个概念；按"总览 → 模块设计 → 协议"逐层深入，只读与当前任务相关的部分。

文档状态：**Architecture v0.2（已接受）**。这是 Phase 1 实现的基线；修改需走 [development/workflow.md](development/workflow.md) 中的流程，影响多个模块或难以逆转的修改需要新增 ADR。各文档开头标注自身版本。

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
| [config.md](architecture/config.md) | 分层配置、配置文件格式、项目信任模型、Grant 持久化 |
| [providers.md](architecture/providers.md) | Provider 抽象、模型能力、流式与错误归一化 |
| [pitfalls.md](architecture/pitfalls.md) | 最容易犯的架构错误、早期症状与规避方式 |

## Apps（客户端）

| 文档 | 回答的问题 |
|---|---|
| [apps/cli.md](apps/cli.md) | `nctrn` 命令行客户端：参数、REPL、事件渲染、权限确认、会话恢复、退出码、配置来源 |

## Protocols（精确契约）

修改接口、事件字段或跨模块数据结构时阅读。

| 文档 | 内容 |
|---|---|
| [events.md](protocols/events.md) | 事件信封、事件类型、持久化规则、顺序与关联 |
| [tool-api.md](protocols/tool-api.md) | `ToolDefinition`、`ToolContext`、`ToolResult` |
| [provider-api.md](protocols/provider-api.md) | `Provider`、`ModelInfo`、`ModelRequest`、`ModelStreamEvent`、`ProviderError` |

## Development（开发流程）

| 文档 | 内容 |
|---|---|
| [repository-layout.md](development/repository-layout.md) | 仓库目录、代码放在哪里、何时拆包 |
| [workflow.md](development/workflow.md) | 修改流程、文档同步清单、测试要求 |

## Decisions（架构决策记录）

[decisions/README.md](decisions/README.md) 列出全部 ADR 及其状态。

## Roadmap

[roadmap/roadmap.md](roadmap/roadmap.md)：阶段划分与验收标准。

## Research（研究记录，按需阅读）

研究记录是写作当时的快照，不随代码维护，不作为约束来源。

| 文档 | 内容 |
|---|---|
| [research/zcode-review.md](research/zcode-review.md) | ZCode 源码架构评审：哪些借鉴、哪些简化、哪些不带入 |
