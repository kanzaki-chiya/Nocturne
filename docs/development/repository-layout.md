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
│       │   ├── config/          配置分层加载（Phase 3 创建）
│       │   └── platform/        文件系统、子进程、路径（跨平台）
│       └── test/                集成测试（脚本化的假 Provider 驱动完整 Turn）
└── apps/
    └── cli/                     nctrn
        ├── README.md
        ├── package.json         bin: nctrn
        ├── src/
        │   ├── main.ts          入口：参数解析、模式分流、退出码
        │   ├── args.ts          命令行解析（util.parseArgs 封装）
        │   ├── config.ts        Provider 配置收集（环境变量 + 参数，cli.md 第 7 节）
        │   ├── repl.ts          交互循环与权限确认提示
        │   ├── commands.ts      斜杠命令分发（/model、/context、/compact 等）
        │   └── render.ts        事件 → 终端文本的纯函数渲染映射
        └── test/                离线单测（*.test.ts）与冒烟（*.smoke.ts）
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

## 6. 工具链选型（Phase 1 确定）

| 用途 | 选择 | 理由 | 备选 / 退路 |
|---|---|---|---|
| 测试框架 | **Vitest**（精确版本） | 原生 ESM + TS、Jest 兼容 API、可按 glob 把真实服务的冒烟测试排除在默认集之外 | `node:test`（零依赖但体验弱） |
| 运行时 schema 校验 | **Zod 4**（内部数据：事件、配置、Provider 响应）+ **AJV 8**（工具 `inputSchema`） | `inputSchema` 本身是发给模型的 JSON Schema，必须由 JSON Schema 校验器执行；内部数据用 Zod 写起来可读且能推导 TS 类型。两者均 MIT | 纯 AJV（事件 schema 手写啰嗦）、valibot（JSON Schema 互操作弱） |
| 构建 | **tsdown**（rolldown 系，`packages/core` 打 ESM + d.ts） | 单库包，配置最少，自动生成声明 | `tsc` 逐文件输出（零额外依赖，配置稍繁；tsdown 出现问题时降级到此） |
| 依赖方向检查 | **dependency-cruiser** | modules.md 第 1 节点名；可把"protocol 无依赖""platform 只允许 node:*""业务模块不碰 node:fs/child_process"等规则写成 JSON 配置进 CI | eslint `import/no-restricted-paths`（表达力不足）、自写 grep（脆弱） |
| Lint / Format | **ESLint 9**（flat config）+ **typescript-eslint** + **eslint-config-prettier** + **Prettier 3** | 标准组合；格式与语义分离，Prettier 不管规则、ESLint 不管格式 | Biome / oxlint（规则覆盖与生态尚浅） |
| OpenAI 兼容传输 | **`@ai-sdk/openai-compatible`**（peer：`ai`） | 专为"只实现 Chat Completions 的第三方服务"设计，覆盖 DeepSeek/GLM/OpenRouter/Ollama/vLLM/LM Studio；SDK 类型不泄漏到 Core（ADR-0005） | 适配器内自建 `fetch` + SSE 解析（拿不到必需字段时降级） |
| Anthropic 传输 | **`@ai-sdk/anthropic`**（peer：`ai`） | 与 openai-compatible 共用同一传输栈与归一化路径（[ADR-0006](../decisions/ADR-0006-anthropic-transport.md)） | 官方 `@anthropic-ai/sdk` 或适配器内自建 `fetch` + SSE |
| CLI 运行时依赖 | **零**：`util.parseArgs` + `node:readline` + `util.styleText` | Phase 2 的 CLI 需求（单值参数、行输入、着色）Node 内置已够；不引 commander/chalk 类依赖（[apps/cli.md](../apps/cli.md) 第 8 节） | 需求超出内置能力时（如交互式选择列表）再评估 |

版本策略：全部依赖写精确版本（不浮动、不用 `latest`），由 `pnpm-lock.yaml` 保证；`engines.node >= 24`；许可证均与 GPL-3.0 兼容（MIT / Apache-2.0）。OpenAI 兼容适配器的传输选型理由与限制记录在 [providers.md](../architecture/providers.md) 适配器表。
