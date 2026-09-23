# 仓库结构

> 状态：已接受 v0.2 ｜ 模块职责与依赖方向以 [modules.md](../architecture/modules.md) 为准，本文只说明"代码放在哪里"。

## 1. 目标结构（Phase 1 起逐步出现）

```text
nocturne/
├── README.md                    面向用户
├── AGENTS.md                    面向 Coding Agent 与贡献者的规则
├── LICENSE                      GPL-3.0
├── package.json                 pnpm workspace 根（Phase 1 创建）
├── pnpm-workspace.yaml          （Phase 1）
├── tsconfig.base.json           （Phase 1）
├── docs/                        所有正式文档
├── packages/
│   └── core/                    @nocturne/core：Runtime，无 UI 依赖
│       ├── README.md            简短说明 + 链接
│       ├── package.json         exports: "." 与 "./protocol"
│       ├── src/
│       │   ├── index.ts         公开 API（createRuntime 等）
│       │   ├── protocol/        事件、命令、公共类型（可被客户端单独导入）
│       │   ├── session/         日志、发布、状态折叠、恢复、锁
│       │   ├── agent/           Agent Loop
│       │   ├── context/         Context Builder、token 预算、压缩
│       │   ├── provider/        Provider 接口、模型目录
│       │   │   └── adapters/    openai-compatible/、anthropic/ ……
│       │   ├── tools/           注册表、执行管线、结果预算
│       │   │   └── builtin/     read、write、edit、grep、glob、shell
│       │   ├── permission/      规则求值、权限闸门
│       │   ├── config/          配置分层加载
│       │   └── platform/        文件系统、子进程、路径（跨平台）
│       └── test/                集成测试（脚本化的假 Provider 驱动完整 Turn）
└── apps/
    └── cli/                     nctrn
        ├── README.md
        ├── package.json         bin: nctrn
        └── src/
```

单元测试与源文件放在一起（`*.test.ts`）；跨模块的 Turn 级测试放在 `packages/core/test/`，使用按脚本返回流式事件的假 Provider，使 Agent Loop 的行为可以确定性地测试，不依赖真实模型服务。

## 2. 为什么只有两个包

- `packages/core` 与 `apps/cli` 之间的包边界，物理上保证 CLI 只能使用 Core 的公开 API。
- Core 内部的模块边界用目录加静态依赖检查维护，而不是拆成十几个包。包的版本、构建、导出配置都有成本，在没有第二个使用者之前不值得。
- `protocol` 以子路径导出（`@nocturne/core/protocol`），客户端可以只导入类型，为将来独立成包提前划好界线。

## 3. 何时拆包

满足任一条件再拆，并更新本文与 [modules.md](../architecture/modules.md)：

| 拆出 | 条件 |
|---|---|
| `packages/protocol` | 出现第一个进程外客户端（RPC）需要只依赖协议类型 |
| `packages/provider-<name>` | 某个适配器引入较重的依赖，不应让所有用户安装 |
| `packages/mcp` | 实现 MCP 时（引入 MCP SDK 依赖，且 Core 不应依赖它） |
| `apps/tui` | 实现 TUI 时（作为独立客户端） |
| `packages/server` | 实现 RPC 服务端时 |

## 4. 模块 README

只有包（`packages/*`、`apps/*`）拥有 README，且只写：是什么、负责什么、不负责什么、主要入口、详细文档链接。Core 内部的目录不写 README，它们的设计在 `docs/architecture/` 中。示例：

```markdown
# @nocturne/core

Nocturne 的 Runtime：会话、Agent Loop、上下文、工具、权限、Provider。

负责：Agent 的全部行为与状态。
不负责：任何界面、终端渲染、参数解析。
入口：`src/index.ts`（公开 API）、`src/protocol/`（客户端可用的类型）。
详见：docs/architecture/overview.md、docs/architecture/modules.md
```

## 5. 运行时数据位置

运行时数据不写入仓库：会话日志、用户配置、按工作区保存的权限授权都位于 `NOCTURNE_HOME`（默认 `~/.nocturne`）。仓库内只可能出现项目级配置 `.nocturne/`（其中的 allow 规则受信任限制，见 [permissions.md](../architecture/permissions.md)）与 `AGENTS.md`。

## 6. Phase 1 需要确定并回填到本文的选择

测试框架、运行时 schema 校验库、构建工具、依赖检查工具（如 dependency-cruiser）、lint / format 工具。选定后在此记录名称与理由；若某项选择影响多个模块且难以替换，另写 ADR。
