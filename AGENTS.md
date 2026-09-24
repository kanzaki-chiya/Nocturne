# AGENTS.md

本文件给在本仓库工作的 Coding Agent（以及人类贡献者）提供**最少必要的规则**。它不是设计文档；设计内容一律在 [docs/](docs/README.md)，这里只做指引。

## 1. 先读什么（按需加载，不要通读 docs/）

1. 本文件。
2. [docs/README.md](docs/README.md)：文档索引，找到与任务相关的那一篇。
3. 相关的 `docs/architecture/*.md`。
4. 只有在修改接口、事件或跨模块数据时，才读对应的 `docs/protocols/*.md`。

不要为了"了解背景"一次性读取整个 `docs/`，也不要读 `docs/research/`，除非任务明确与之相关。

## 2. 修改模块前必须读的文档

| 要修改的内容 | 先读 |
|---|---|
| Agent Loop、Turn 流程、中断、重试 | [architecture/agent-loop.md](docs/architecture/agent-loop.md) |
| 会话、持久化、恢复 | [architecture/sessions.md](docs/architecture/sessions.md) |
| 事件类型或字段 | [protocols/events.md](docs/protocols/events.md) |
| 上下文构建、压缩、提示词组装 | [architecture/context.md](docs/architecture/context.md) |
| 工具运行时或内置工具 | [architecture/tools.md](docs/architecture/tools.md)、[protocols/tool-api.md](docs/protocols/tool-api.md) |
| 权限规则、审批流程 | [architecture/permissions.md](docs/architecture/permissions.md) |
| 配置文件、分层加载、项目信任、Grant | [architecture/config.md](docs/architecture/config.md) |
| MCP 服务器接入、MCP 工具 | [architecture/mcp.md](docs/architecture/mcp.md)、[decisions/ADR-0011](docs/decisions/ADR-0011-mcp-client.md) |
| Hooks（PreToolUse 等事件点） | [architecture/hooks.md](docs/architecture/hooks.md)、[decisions/ADR-0012](docs/decisions/ADR-0012-hooks.md) |
| 诊断日志、调试输出 | [architecture/observability.md](docs/architecture/observability.md) |
| 子代理（task 工具、子会话） | [architecture/subagent.md](docs/architecture/subagent.md)、[decisions/ADR-0013](docs/decisions/ADR-0013-subagent.md) |
| Provider、模型能力、流式归一化 | [architecture/providers.md](docs/architecture/providers.md)、[protocols/provider-api.md](docs/protocols/provider-api.md) |
| CLI 参数、REPL、事件渲染、权限确认 | [apps/cli.md](docs/apps/cli.md) |
| 模块划分、依赖方向、目录 | [architecture/modules.md](docs/architecture/modules.md)、[development/repository-layout.md](docs/development/repository-layout.md) |

## 3. 硬性约束

- Core（`packages/core`）不得依赖任何 UI、终端或客户端代码；客户端只能通过 Core 的公开 API 和 `protocol` 类型与 Runtime 交互。
- 不得在 Agent Loop 中按工具名写分支（`if tool === "shell"`）；工具差异通过工具声明表达。
- 不得在 Agent Loop 或 Context 中按 Provider 写分支；Provider 差异在 Provider 适配器内归一化。
- 权限判定只能发生在权限层；工具实现和 UI 中不得自行决定"是否需要确认"。
- 模块依赖方向以 [modules.md](docs/architecture/modules.md) 为准，禁止循环依赖。

## 4. 文档同步（未同步视为任务未完成）

修改以下任一项时，必须检查并更新对应文档：架构、公开接口、协议/事件、模块职责、生命周期、配置行为、用户可见行为。

- 一个概念只有一个主文档；其他位置只写一句摘要并链接，不复制内容。
- 新增重要文档时同步更新 [docs/README.md](docs/README.md)。
- 实现与文档冲突时，不能默认"代码才是真相"：要么改实现，要么正式修改文档并说明原因；影响多个模块或难以逆转的决定，新增 ADR（见 [decisions/](docs/decisions/README.md)）。

## 5. 测试

修改代码 → 运行相关测试 → 必要时补充或更新测试 → 检查对应文档。代码、测试、文档三者出现冲突时必须显式指出，不得静默忽略。

验证命令（仓库根目录，详见 [development/workflow.md](docs/development/workflow.md) 第 5 节）：

```bash
pnpm typecheck      # tsc --noEmit（src + test）
pnpm lint           # eslint
pnpm format:check   # prettier --check
pnpm test           # vitest run，默认测试集完全离线
pnpm depcheck       # dependency-cruiser 依赖方向检查
pnpm build          # tsdown 构建
pnpm test:smoke     # 真实 OpenAI 兼容服务冒烟（需 NOCTURNE_SMOKE_* 环境变量，与默认测试集分离）
```

## 6. 本文件的维护

保持简短。新增规则前先判断它是否属于某篇正式文档；属于的话写在那篇文档里，这里只加一行链接。
