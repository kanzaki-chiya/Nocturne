# 仓库结构

> 状态：已接受 v0.2 ｜ 模块职责与依赖方向以 [modules.md](../architecture/modules.md) 为准，本文只说明"代码放在哪里"。

## 1. 当前结构

```text
nocturne/
├── README.md                    面向用户
├── AGENTS.md                    面向 Coding Agent 与贡献者的规则
├── LICENSE                      GPL-3.0
├── THIRD-PARTY-NOTICES.md       直接依赖的许可说明
├── CHANGELOG.md                 面向用户的版本变化
├── package.json                 pnpm workspace 根
├── pnpm-workspace.yaml
├── scripts/
│   └── update-models-dev-snapshot.mjs  手动更新内置 models.dev 裁剪快照
├── tsconfig.base.json
├── docs/                        所有正式文档
├── packages/
│   ├── core/                    @nocturne/core：Runtime，无 UI 依赖
│   │   ├── README.md            简短说明 + 链接
│   │   ├── package.json         exports: "." 与 "./protocol"
│   │   ├── src/
│   │   │   ├── index.ts         公开 API（createRuntime 等）
│   │   │   ├── protocol/        事件、命令、公共类型、SessionView
│   │   │   ├── session/         日志、发布、状态折叠、恢复、锁
│   │   │   ├── agent/           Agent Loop、子代理 launcher
│   │   │   ├── context/         Context Builder、token 预算、压缩
│   │   │   ├── provider/        Provider 接口、模型目录
│   │   │   │   └── adapters/    openai-compatible、anthropic
│   │   │   ├── tools/           注册表、执行管线、结果预算、图片附件存储
│   │   │   │   └── builtin/     read、write、edit、grep、glob、shell、task
│   │   │   ├── permission/      规则求值、权限闸门、审查器与 Grant 匹配
│   │   │   ├── config/          配置分层加载、项目信任、Grant 文件读写、models.dev 缓存与快照
│   │   │   │   └── models-dev-snapshot.ts  随版本内置的裁剪模型表（由脚本生成）
│   │   │   ├── hooks/           HookRunner：外部命令 + JSON 契约
│   │   │   ├── diagnostics/     调试诊断 JSONL 记录与脱敏
│   │   │   └── platform/        文件系统、子进程、路径（含 spawnPipe）
│   │   └── test/                集成测试（脚本化假 Provider）
│   ├── mcp/                     @nocturne/mcp：MCP 客户端（ADR-0011）
│   │   ├── package.json         依赖 @nocturne/core 公开入口与 @modelcontextprotocol/sdk
│   │   └── src/                 connector、stdio 传输、工具包装
│   └── rpc/                     @nocturne/rpc：JSON-RPC 服务端与类型化客户端（ADR-0044）
│       ├── package.json         exports: "./server" 与 "./client"；依赖 @nocturne/core 公开入口
│       ├── src/                 server（方法映射、订阅回放）、client、shared（报文、方法表、传输）
│       └── test/                内存管道 + FakeProvider 的离线测试
└── apps/
    ├── cli/                     nctrn 命令行入口
    │   ├── src/                 main、args、config、repl、session-switch、commands、render
    │   └── test/                离线测试、真实进程验收与独立冒烟测试
    ├── tui/                     Ink 终端客户端，经 nctrn --tui 进入
    │   ├── src/                 app、commands、session-view、components 等
    │   └── test/                ink-testing-library 渲染与按键测试
    └── desktop/                 桌面端（Tauri 外壳 + React 前端，ADR-0046）
        ├── index.html、vite.config.ts、vitest.config.ts
        ├── src/                 host 抽象、TauriLineTransport、BackendPool、会话树、界面
        ├── test/                vitest + jsdom 离线测试（进默认测试集）
        └── src-tauri/           Rust 外壳：五个命令、行切分、Node 查找、Job Object（cargo test 手动跑）
```

单元测试与源文件放在一起（`*.test.ts`）；跨模块的 Turn 级测试放在 `packages/core/test/`，使用按脚本返回流式事件的假 Provider，使 Agent Loop 的行为可以确定性地测试，不依赖真实模型服务。

## 2. 包边界

- `packages/core`、`packages/mcp`、`packages/rpc`、`apps/cli`、`apps/tui`、`apps/desktop` 是六个 workspace 包；Core 不依赖客户端或 MCP SDK，MCP、RPC 和客户端只使用 Core 的公开入口。桌面端边界更窄：只能引 `@nocturne/rpc/client` 与 `@nocturne/core/protocol`。
- Core 内部的模块边界用目录加静态依赖检查维护，不再拆成十几个包。
- `protocol` 以子路径导出（`@nocturne/core/protocol`），客户端可以只导入类型，为将来独立成包提前划好界线。

## 3. 何时拆包

满足任一条件再拆，并更新本文与 [modules.md](../architecture/modules.md)：

| 拆出 | 条件 |
|---|---|
| `packages/protocol` | 出现第一个进程外客户端（RPC）需要只依赖协议类型 |
| `packages/provider-<name>` | 某个适配器引入较重的依赖，不应让所有用户安装 |

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

运行时数据不写入仓库，统一位于 `NOCTURNE_HOME`（默认 `~/.nocturne`）：

```text
<NOCTURNE_HOME>/
├── config.json                       用户手写配置（程序从不改写，config.md）
├── settings.json                     程序维护的设置（/shell 写入 shell/shellPath，原子写；config.md 第 2 节，ADR-0022）
├── trust.json                        可信工作区列表（nctrn trust/untrust，原子写）
├── providers.json                    向导配置（nctrn setup、/provider，原子写；v0.2）
├── credentials.json                  凭据索引：DPAPI 密文或系统密钥库引用，不含明文（v0.2，provider-setup.md）
├── recent-models.json                最近使用的模型列表（最多 10 条，原子写；v0.2）
├── cache/models-dev.json              models.dev 裁剪数据及拉取时间（刷新时原子写；ADR-0025）
├── AGENTS.md                         用户级项目指令（可选）
├── grants/<workspaceKey>.json        按工作区保存的项目级 Grant（ADR-0008）
├── logs/debug-<ts>-<pid>.jsonl       诊断日志（--debug / NOCTURNE_DEBUG，observability.md）
└── sessions/
    ├── <sessionId>.jsonl             会话事件日志
    ├── <sessionId>.lock              会话锁（ADR-0009）
    ├── <sessionId>.jsonl.tail-<ts>   崩溃截断下来的损坏尾部（诊断用）
    └── attachments/<sessionId>/            按会话隔离的工具输出落盘目录：
        ├── <callId>.txt                       超预算工具输出（tools.md 第 4 节）
        └── img-<n>.<ext>                      read/粘贴/MCP 的图片附件字节（tools.md，n 会话内递增）
```

目录权限：POSIX 上 `NOCTURNE_HOME` 以 `0700` 创建——会话日志里有代码与对话内容，`credentials.json` 另以 `0600` 写（provider-setup.md 第 3 节）；Windows 维持用户目录的默认权限（凭据保护由 DPAPI 承担）。

仓库内只可能出现项目级配置 `.nocturne/`（其中的 allow 规则受信任限制，见 [permissions.md](../architecture/permissions.md)）与 `AGENTS.md`。

## 6. 工具链选型（Phase 1 确定）

| 用途 | 选择 | 理由 | 备选 / 退路 |
|---|---|---|---|
| 测试框架 | **Vitest**（精确版本） | 原生 ESM + TS、Jest 兼容 API、可按 glob 把真实服务的冒烟测试排除在默认集之外 | `node:test`（零依赖但体验弱） |
| 运行时 schema 校验 | **Zod 4**（内部数据：事件、配置、Provider 响应）+ **AJV 8**（工具 `inputSchema`） | `inputSchema` 本身是发给模型的 JSON Schema，必须由 JSON Schema 校验器执行；内部数据用 Zod 写起来可读且能推导 TS 类型。两者均 MIT | 纯 AJV（事件 schema 手写啰嗦）、valibot（JSON Schema 互操作弱） |
| 构建 | **tsdown**（rolldown 系，`packages/core` 打 ESM + d.ts） | 单库包，配置最少，自动生成声明 | `tsc` 逐文件输出（零额外依赖，配置稍繁；tsdown 出现问题时降级到此） |
| 依赖方向检查 | **dependency-cruiser** | modules.md 第 1 节点名；可把"protocol 无依赖""platform 只允许 node:*""业务模块不碰 node:fs/child_process"等规则写成 JSON 配置进 CI | eslint `import/no-restricted-paths`（表达力不足）、自写 grep（脆弱） |
| Lint / Format | **ESLint 10**（flat config）+ **typescript-eslint** + **eslint-config-prettier** + **Prettier 3** | 标准组合；格式与语义分离，Prettier 不管规则、ESLint 不管格式 | Biome / oxlint（规则覆盖与生态尚浅） |
| OpenAI 兼容传输 | **`@ai-sdk/openai-compatible`**（peer：`ai`） | 专为"只实现 Chat Completions 的第三方服务"设计，覆盖 DeepSeek/GLM/OpenRouter/Ollama/vLLM/LM Studio；SDK 类型不泄漏到 Core（ADR-0005） | 适配器内自建 `fetch` + SSE 解析（拿不到必需字段时降级） |
| Anthropic 传输 | **`@ai-sdk/anthropic`**（peer：`ai`） | 与 openai-compatible 共用同一传输栈与归一化路径（[ADR-0006](../decisions/ADR-0006-anthropic-transport.md)） | 官方 `@anthropic-ai/sdk` 或适配器内自建 `fetch` + SSE |
| CLI 运行时依赖 | **零**：`util.parseArgs` + `node:readline` + `util.styleText` | Phase 2 的 CLI 需求（单值参数、行输入、着色）Node 内置已够；不引 commander/chalk 类依赖（[apps/cli.md](../apps/cli.md) 第 9 节）。零第三方依赖约定只对 `apps/cli` 生效（workspace 包除外）；`packages/core` 的运行时依赖是本表列出的 `ai`、`@ai-sdk/*`、AJV、Zod，以及 ADR-0033 批准的 `node-html-markdown`，`apps/tui` 与 `packages/mcp` 的依赖分别由 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)、[ADR-0011](../decisions/ADR-0011-mcp-client.md) 批准。ADR-0010 中"core 保持零依赖"的表述不准确，以本表为准 | 需求超出内置能力时（如交互式选择列表）再评估 |
| TUI 渲染 | **Ink + React**（`apps/tui`） | 选型见 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)；全屏滚动见 [ADR-0020](../decisions/ADR-0020-tui-fullscreen-rendering.md) | 自研 ANSI（渲染层收敛在 apps/tui 内，可替换） |
| 桌面端 | **Tauri 2 + Vite + React**（`apps/desktop`） | 选型见 [ADR-0046](../decisions/ADR-0046-desktop-tauri.md)。npm：react-dom、`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-opener`（运行时，MIT/Apache-2.0）、`@tauri-apps/cli`、`vite`、`@vitejs/plugin-react`、`jsdom`、`@testing-library/react`、`@testing-library/dom`、`@types/react-dom`（开发，MIT）；Rust crate：tauri、tauri-build、tauri-plugin-dialog、tauri-plugin-opener（Apache-2.0 OR MIT）、serde、windows-sys（MIT OR Apache-2.0），许可证以包元数据为准（THIRD-PARTY-NOTICES.md） | Electron（重）、Svelte/Solid（团队已有 React 经验） |

版本策略：全部依赖写精确版本（不浮动、不用 `latest`），由 `pnpm-lock.yaml` 保证；`engines.node >= 24.14`（根与 CLI）；许可证均与 GPL-3.0 兼容（MIT / Apache-2.0）。OpenAI 兼容适配器的传输选型理由与限制记录在 [providers.md](../architecture/providers.md) 适配器表。
