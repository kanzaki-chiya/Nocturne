# 外部 Agent

Nocturne 支持双向的外部 Agent 协作：既可以让其他 Agent 通过 MCP 接入操控 Nocturne，也可以在 Nocturne 内部调用本机安装的其他 CLI Agent 作为子代理。

## 让外部 Agent 接入 Nocturne（MCP）

通过内置的 `nocturne-mcp` 桥接程序，Claude Code、Codex、Cursor 等外部 Agent 可以查看和操作正在运行的 Nocturne 桌面端会话。

### 配置与配对步骤

1. 确保已安装终端包（提供 `nocturne-mcp` 命令，见 [安装](index.md)）且 Nocturne 桌面端正在运行。
2. 打开桌面端「设置 → 远程连接」，在页面下半部分的「外部 Agent 接入」区域点击「复制 MCP 配置」，将该 JSON 片段加入外部 Agent 的 MCP 配置文件：

```json
{
  "mcpServers": {
    "nocturne": {
      "command": "nocturne-mcp"
    }
  }
}
```

也可以在终端直接运行以下命令写入客户端配置：

```bash
claude mcp add --scope user nocturne -- nocturne-mcp
# 或 Codex
codex mcp add nocturne -- nocturne-mcp
```

3. 当外部 Agent 首次调用 `nocturne_*` 工具时，桌面端「设置 → 远程连接 → 外部 Agent 接入」区域会弹出配对请求，核对 6 位验证码一致后点击「批准」即可完成授权（记录保存在 `~/.nocturne/agent-clients.json`）。你可以随时在「已授权的外部 Agent」列表中点击「撤销」或「全部撤销」吊销权限。

### 可用工具清单

| 工具名 | 功能 |
| --- | --- |
| `nocturne_status` | 查询桌面端连接状态与工作区列表 |
| `nocturne_list_sessions` | 列出最近会话及其运行状态 |
| `nocturne_read_session` | 读取指定会话的消息历史、待决审批与改动摘要 |
| `nocturne_create_session` | 在指定工作区创建新会话并可选发送首条消息 |
| `nocturne_send_message` | 向会话发送新消息、插话（`steer`）或排队消息（`queue`） |
| `nocturne_wait_for_idle` | 阻塞等待指定会话完成当前轮次并返回最新输出 |
| `nocturne_interrupt_session` | 中断正在运行的会话 |

## 在 Nocturne 中调用外部 CLI Agent

Nocturne 可以把本机安装的第三方 CLI Agent 当作 [子代理](subagents.md) 调用：

| 预设名称 | 默认标识 | 默认可执行命令 |
| --- | --- | --- |
| Claude Code | `claude-code` | `claude` |
| Codex | `codex` | `codex` |
| OpenCode | `opencode` | `opencode` |
| Gemini CLI | `gemini` | `gemini` |
| Kimi CLI | `kimi` | `kimi` |

### 启用与配置

1. 打开桌面端「设置 → 外部 Agent」，点击「从预设添加」选择上述 5 种预设之一（或点击「自定义添加」配置任意支持 JSONL / 纯文本协议的 CLI Agent）。
2. 按需确认可执行文件命令、附加参数与环境变量，点击「保存」，并在列表中点击「测试」验证命令可用。
3. 启用后，主代理在调用 `task` 工具时即可将子任务委派给该外部 Agent 执行（配置保存在 `~/.nocturne/external-agents.json`，也可写在 `~/.nocturne/config.json` 的 `externalAgents` 字段中）。
