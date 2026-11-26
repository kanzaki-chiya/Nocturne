# 外部 Agent

如果你本机已经安装了 Codex、omp 等支持 ACP（Agent Client Protocol）的编码命令行工具，可以把它们接入 Nocturne：既能由主会话通过 `task` 工具委派独立任务，也能在输入框里用斜杠命令直接跟它对话。

（若要反过来从其他编码工具通过 MCP 操控 Nocturne 桌面端，请见 [MCP](mcp.md) 中的 `nctrn mcp` 说明；经 MCP 接入的外部 agent 现可回答它自己创建的会话里的提问。）

## 添加与测试外部 Agent

1. 在桌面端打开「设置」→「子代理」，点击右上角「添加 agent」进入新建子页面。
2. 在「从预设填入」下拉框中选择内置预设，或手动填写任意支持 ACP 的命令：

| 内置预设名 | 默认命令 (`command`) | 默认参数 (`args`) |
|---|---|---|
| `codex` | `npx` | `@agentclientprotocol/codex-acp` |
| `omp` | `omp` | `--mode`、`acp` |

3. 根据需要填写「名称」、「描述」、「命令」、「参数」、「模式 id」和「环境变量」。
4. 点击表单底部「测试连接」：Nocturne 会按配置启动进程并执行 ACP 握手。探测成功后，可在「会话配置项」下拉框中选择对方使用的模型或模式，点击「恢复默认」可还原，也可直接编辑「会话配置项」下的「JSON」。
5. 打开「启用」开关，点击「保存」进入详情，可查看连接配置与最近测试结果；点击页头「子代理」返回列表，在详情右上角「更多」菜单中选择「编辑」或「删除」。界面中添加的外部 Agent 保存在 `~/.nocturne/external-agents.json`，也可以手写在 `~/.nocturne/config.json` 的 `externalAgents` 字段中（在「外部 Agent」分组末尾显示「只读」徽标；出于安全原因，项目级 `.nocturne/config.json` 中的 `externalAgents` 不会生效）。

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

## 在外部宿主（如 Paseo）中运行 Nocturne（`nctrn acp`）

除了由 Nocturne 调用外部 Agent，你也可以反过来让支持 ACP 的多 Agent 宿主（例如 [Paseo](https://paseo.sh/docs/custom-providers)）直接启动 Nocturne 接单，无需打开 Nocturne 桌面端：

1. 安装 `nctrn` CLI 并确认 `nctrn` 在宿主的 `PATH` 中可执行。
2. 先运行 `nctrn setup` 配置好服务商、凭据与默认模型（模型与权限规则沿用本机 Nocturne 配置）。
3. 在 Paseo 的 `~/.paseo/config.json` 中登记自定义 ACP provider：

```json
{
  "agents": {
    "providers": {
      "nocturne": {
        "extends": "acp",
        "label": "Nocturne",
        "command": ["nctrn", "acp"]
      }
    }
  }
}
```

接入后的行为约定：

- **工作目录与工作树**：每个 ACP 会话直接在宿主分配的绝对 `cwd`（包括宿主创建的工作树）中工作，Nocturne 不会替宿主创建或删除工作树。
- **权限审批**：Nocturne 权限层判定为 `ask` 的操作会转发到宿主界面进行一次性批准或拒绝；已有拒绝规则与项目可信度继续生效，宿主拒绝、取消或断开连接时待审操作不会执行。
- **模型与思考档位选择**：`session/new` 会向宿主回报真实 `configOptions`——`model` 选择器列出该工作区已配置的全部可用模型（值为完整 `provider/model` ID，含多段斜杠的模型 ID 原样保留），`thought_level` 选择器列出当前模型实际支持的思考档位（`off` 恒为首项）。宿主经 `session/set_config_option` 切换后立刻生效于下一轮；切换模型后档位集合随之刷新。非法值、会话正忙时切换模型会被拒绝并保留原配置。不支持思考档位的模型不会出现档位选择器；未做配置探测的旧版宿主沿用 `nctrn setup` 的默认模型，行为与此前一致。
- **宿主 MCP 工具注入**：宿主按会话注入的 stdio / Streamable HTTP MCP 工具（例如 Paseo 编排工具）仅在对应会话内生效，凭据按会话内存隔离且不写入本地 MCP 配置；注入工具同样经过 Nocturne 权限层审批。
- **当前范围**：支持文本多轮对话、流式输出、工具状态卡片、运行中取消、会话级宿主 MCP 与模型/思考档位选择；跨进程 `session/load` 与附件输入不在当前范围。
