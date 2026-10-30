# 对外 MCP 接口（外部 Agent 接入指南）

> 状态：已接受（v0.23）｜ 决策：[ADR-0074](../decisions/ADR-0074-mcp-server-for-outside-agents.md) ｜ 代码：`packages/mcp-server`、`packages/rpc`

`nctrn mcp` 把当前正在运行的 Nocturne 桌面端会话暴露为标准 stdio MCP 服务器，供 Claude Code、Codex 等外部 agent 列出、读取和驱动会话。

## 1. 工作原理与前置条件

- **保持 Nocturne 桌面端处于打开状态**：`nctrn mcp` 本身不创建 Runtime、不直接读写会话日志或凭据，而是通过本机加密管道连接桌面端后台（Windows 为命名管道 `\\.\pipe\nocturne-agent-<SID哈希>`，macOS / Linux 为 `<nocturneHome>/agent.sock`）。
- 桌面端未运行时，`nctrn mcp` 的 MCP `initialize` 与 `tools/list` 仍正常返回（避免宿主启动报错），调用工具时返回明确提示请先打开桌面应用。
- 外部 agent 创建或驱动的会话在桌面端实时可见；遇到需要审批的权限请求（`permission.requested`）或提问（`question.requested`）时，仍由用户在桌面端或已配对手机上亲自处理，外部 agent 无法代为批准。

## 2. 在 Claude Code 与 Codex 中登记

### Claude Code

使用 Claude Code CLI 添加用户级或项目级 MCP 服务器：

```bash
claude mcp add --transport stdio nocturne -- nctrn mcp
```

或在 `~/.claude.json`（或项目 `.mcp.json`）的 `mcpServers` 中写入：

```json
{
  "mcpServers": {
    "nocturne": {
      "command": "nctrn",
      "args": ["mcp"]
    }
  }
}
```

### OpenAI Codex

使用 Codex CLI 登记：

```bash
codex mcp add nocturne -- nctrn mcp
```

或在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.nocturne]
command = "nctrn"
args = ["mcp"]
```

### 为不同宿主配置独立身份槽（可选）

默认情况下，同一用户下的外部 agent 共享 `<nocturneHome>/mcp-bridge/identity.json`。若希望在「设置 › 远程」中按宿主分别设置范围或单独吊销，可传入 `--name <label>`：

```bash
# Claude Code
claude mcp add --transport stdio nocturne -- nctrn mcp --name claude-code

# Codex
codex mcp add nocturne -- nctrn mcp --name codex
```

传入 `--name <label>` 时，密钥对保存在 `<nocturneHome>/mcp-bridge/<label>.json`。

## 3. 首次配对与能力范围

1. 外部 agent 首次调用工具连接桌面端时，桌面端弹出**外部 Agent 接入请求**对话框，展示桥的名称与公钥指纹。
2. 用户可选择授权范围：
   - **只读（`read-only`）**：仅允许列出模型、列出会话、读取会话折叠内容；
   - **可运行（`run`）**：允许全部工具，并指定新建会话的**权限上限**（默认 `default`，可选 `read-only` / `default` / `auto-edit` / `guarded` / `smart` / `bypass`）。
3. **注意事项**：可运行范围的外部 agent 能向任何非子代理会话发送消息，消息按**该会话自己的权限预设**执行；权限上限仅约束外部 agent 新建的会话。
4. 已批准的外部 agent 显示在桌面端「设置 › 远程 › 外部 Agent」分组中，可随时调整范围、修改权限上限或吊销；吊销后立即断开当前连接。

## 4. 提供的 MCP 工具

| 工具 | 所需范围 | 说明 |
|---|---|---|
| `nocturne_list_sessions` | 只读 | `{ cwd?, limit? }`：列出最近会话（默认 20 条）。 |
| `nocturne_read_session` | 只读 | `{ sessionId, turns? }`：读取会话状态与最近 `turns`（默认 3）轮的用户消息、单行工具摘要与最终回复（单次输出上限 64 KB）。 |
| `nocturne_list_models` | 只读 | `{ workspaceRoot? }`：列出可用模型与默认模型。 |
| `nocturne_start_session` | 可运行 | `{ cwd, prompt, model?, reasoningEffort?, permissionPreset?, wait?, timeoutSeconds? }`：在已信任或已有会话用过的工作区新建会话并发送首条消息。 |
| `nocturne_send` | 可运行 | `{ sessionId, prompt, wait?, timeoutSeconds? }`：向已有会话发送消息。采用 `queue` 排队模式，**从不打断**正在运行的轮次。 |
| `nocturne_wait` | 可运行 | `{ sessionId, timeoutSeconds? }`（默认 300s，上限 600s）：等待当前轮结束；超时返回 `running` 不中断会话；停在权限确认或提问上时立即返回 `waiting_for_permission` / `waiting_for_answer`。 |
| `nocturne_interrupt` | 可运行 | `{ sessionId }`：中断指定会话当前正在运行的轮次。 |

## 5. 安全边界说明

本机管道（Windows 命名管道 ACL / POSIX 套接字 `0600`）只允许当前操作系统用户连接。本机配对用于可见性与误触发隔离（明确哪个外部 agent 正在驱动会话、限制其操作范围与新建会话的权限上限），**防不住本机同一操作系统用户下的恶意程序**（同一用户下的进程可读取 `~/.nocturne/mcp-bridge/` 下的身份文件，这与 `~/.nocturne` 本身的信任边界一致）。
