# 外部 Agent

如果你本机已经安装了 Codex、omp 等支持 ACP（Agent Client Protocol）的编码命令行工具，可以把它们接入 Nocturne：既能由主会话通过 `task` 工具委派独立任务，也能在输入框里用斜杠命令直接跟它对话。

（若要反过来从其他编码工具通过 MCP 操控 Nocturne 桌面端，请见 [MCP](mcp.md) 中的 `nctrn mcp` 说明。）

## 添加与测试外部 Agent

1. 在桌面端打开「设置」→「子代理」，点击右上角「添加 agent」。
2. 在「从预设填入」下拉框中选择内置预设，或手动填写任意支持 ACP 的命令：

| 内置预设名 | 默认命令 (`command`) | 默认参数 (`args`) |
|---|---|---|
| `codex` | `npx` | `@agentclientprotocol/codex-acp` |
| `omp` | `omp` | `--mode`、`acp` |

3. 根据需要填写「名称」、「描述」、「命令」、「参数（逐行一个）」、「模式 id（可选）」和「环境变量（JSON 对象）」。
4. 点击「测试连接」：Nocturne 会按配置启动进程并执行 ACP 握手。探测成功后，表单下方会显示对方支持的「登录方式」和「会话配置项」下拉框（例如选择对方使用的模型或模式，点击「恢复默认」可还原，也可直接编辑 `configOptions（JSON 对象）`）。
5. 勾选「启用 agent」，点击「保存」。界面中添加的外部 Agent 保存在 `~/.nocturne/external-agents.json`，也可以手写在 `~/.nocturne/config.json` 的 `externalAgents` 字段中（归入左列「只读」分组；出于安全原因，项目级 `.nocturne/config.json` 中的 `externalAgents` 不会生效）。

在终端（TUI 与 CLI）中，输入 `/agents` 可列出已配置的外部 Agent 及其状态。

## 两种使用方式

### 1. 在输入框用 `/<name>` 直接对话

在会话输入框输入 `/<name>` 加任务内容（例如输入 `/codex` 后跟你的问题）：

- 这一轮提问**不经过当前会话的模型**，而是直接转发给该外部 Agent 执行；外部 Agent 的流式回复、思考过程和工具调用会实时显示在对话流中。
- 后续再次使用 `/<name>` 会复用同一个外部 Agent 会话，支持连续多轮追问。
- 如果外部 Agent 的名称与内置斜杠命令或已启用技能重名，`/` 菜单优先触发内置命令或技能（设置页会显示「名称冲突」提示），此时可使用下面的 `task` 工具委派。

### 2. 由主会话通过 `task` 工具委派

已启用的外部 Agent 会自动加入内置 `task` 工具的 `agent` 参数可选列表，主会话可在需要时将子任务委派给它：

通过 `task` 委派时默认不设固定超时，随主会话取消；可在调用中显式传入 `timeoutMs`，已有 ACP 可选超时仍生效。直接用 `/<name>` 对话不经 `task`，按该入口的会话中断操作处理。

- **启动前审批**：委派外部 Agent 属于 `subagent` 权限类别（目标为 `external:<name>`），由于外部进程开启后将使用其自身的工具链直接读写文件或执行命令，Nocturne 在全部权限预设下默认均会先询问你（`ask`），批准后才会启动进程。
- **Worktree 隔离改动**：主会话委派时若传入 `isolation: "worktree"`，外部 Agent 会在独立的 Git worktree 目录中工作；任务完成后，主会话可调用 `apply_subagent_changes`（「并回子代理改动」）将外部 Agent 的代码修改合入主会话当前工作树（见 [子代理](subagents.md) 与 [切换工作树](context.md#切换工作树)）。
