# Nocturne

Nocturne 是一个开源的 Coding Agent Runtime，以及基于它的命令行编程助手 `nctrn`。

在代码仓库里启动 `nctrn`，用自然语言描述任务，Nocturne 会阅读代码、搜索文件、修改文件、运行命令，并在执行有风险的操作前征求你的同意。

项目形象：**Nocteria**。

## 设计目标

- **Runtime 与界面分离**：Agent 的推理、会话、工具、权限都在 Core Runtime 中完成；CLI、TUI 以及未来的其他客户端只负责输入、渲染和交互。
- **工具是一等公民**：每个工具都有 schema、声明自身副作用、支持中断、返回结构化结果。
- **权限是独立的策略层**：读、写、执行命令等操作统一按 `allow` / `ask` / `deny` 规则判定，规则可配置、可解释。
- **会话可恢复**：会话以追加式日志保存，退出或崩溃后可以恢复并继续。
- **多模型**：通过统一的 Provider 接口接入 OpenAI 兼容接口、Anthropic 等模型服务。

## 使用

```bash
pnpm install && pnpm build

export NOCTURNE_API_KEY=...        # 或 ANTHROPIC_API_KEY（--api-type anthropic）
export NOCTURNE_BASE_URL=...       # OpenAI 兼容端点，anthropic 可省略
export NOCTURNE_MODEL=...          # 模型 id

cd <你的代码仓库>
node /path/to/nocturne/apps/cli/dist/main.js          # 交互模式
node /path/to/nocturne/apps/cli/dist/main.js -p "..." # 非交互模式
```

参数与行为约定见 [docs/apps/cli.md](docs/apps/cli.md)。

## 当前状态

Nocturne 处于早期开发阶段。架构与接口约定见 [docs/](docs/README.md)。

## 文档

- [文档索引](docs/README.md)
- [架构总览](docs/architecture/overview.md)
- [贡献者与 Coding Agent 须知](AGENTS.md)

## 许可证

[GNU General Public License v3.0](LICENSE)
