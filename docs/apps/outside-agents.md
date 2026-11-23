# 对外 MCP 接口（外部 Agent 接入指南）

> 状态：已接受（v0.23）｜ 决策：[ADR-0074](../decisions/ADR-0074-mcp-server-for-outside-agents.md) ｜ 代码：`packages/mcp-server`、`packages/rpc`

`nctrn mcp` 把当前正在运行的 Nocturne 桌面端会话暴露为标准 stdio MCP 服务器，供 Claude Code、Codex 等外部 agent 列出、读取和驱动会话。

## 1. 工作原理与前置条件

- **保持 Nocturne 桌面端处于打开状态**：`nctrn mcp` 本身不创建 Runtime、不直接读写会话日志或凭据，而是通过本机加密管道连接桌面端后台（Windows 为命名管道 `\\.\pipe\nocturne-agent-<SID哈希>`，macOS / Linux 为 `<nocturneHome>/agent.sock`）。
- 桌面端未运行时，`nctrn mcp` 的 MCP `initialize` 与 `tools/list` 仍正常返回（避免宿主启动报错），调用工具时返回明确提示请先打开桌面应用。
- 外部 agent 创建或驱动的会话在桌面端实时可见；遇到提问（`question.requested`）或权限审批（`permission.requested` / 子代理转发审批）时，桌面端照常弹出，用户与创建该会话的外部 agent 任一方先回复即生效：可运行范围的外部 agent 可回答自己创建的会话中的提问，并可拒绝自己创建的会话中的审批；仅当该 agent 登记的权限上限为 `bypass` 时，方可对其自己创建的会话做非持久允许（本次 / 本会话），持久授权（`project` / `always`）一律拒绝。

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
   - **可运行（`run`）**：允许全部工具，并指定新建会话的**权限上限**（默认 `default`，可选 `read-only` / `default` / `auto-edit` / `guarded` / `smart` / `bypass`）；重命名（`runtime.renameSession`）、回答提问（`session.respondQuestion`）与处理审批（`session.respondPermission` / `session.respondSubagentPermission`）仅允许作用于该外部 agent 自己创建的会话（子代理审批按父会话 `client.id` 判定）。处理审批时拒绝类回复（`deny` / `deny` + `stop`）在任意上限下均允许；允许类回复（本次允许 / `remember: "session"`）仅在权限上限为 `bypass` 时允许；持久授权变体（`remember: "project"` / `"always"`）一律返回 `agent_not_allowed`。
3. **注意事项**：可运行范围的外部 agent 能向任何非子代理会话发送消息，消息按**该会话自己的权限预设**执行；权限上限仅约束外部 agent 新建的会话。
4. 已批准的外部 agent 显示在桌面端「设置 › 远程 › 外部 Agent」分组中，可随时调整范围、修改权限上限或吊销；吊销后立即断开当前连接。

## 4. 提供的 MCP 工具

| 工具 | 所需范围 | 说明 |
|---|---|---|
| `nocturne_list_sessions` | 只读 | `{ cwd?, limit? }`：列出最近会话（默认 20 条）。 |
| `nocturne_read_session` | 只读 | `{ sessionId, turns? }`：读取会话状态与最近 `turns`（默认 3）轮的用户消息、单行工具摘要与最终回复（单次输出上限 64 KB）。 |
| `nocturne_list_models` | 只读 | `{ workspaceRoot? }`：列出可用模型与默认模型。 |
| `nocturne_start_session` | 可运行 | `{ cwd, prompt, title?, model?, reasoningEffort?, permissionPreset?, wait?, timeoutSeconds? }`：在已信任或已有会话用过的工作区新建会话并发送首条消息。传入 `title` 时，在会话建立后、发送首条消息前调用 `runtime.renameSession` 设为手动标题（不被自动标题覆盖）；若改名失败，会话照常创建与运行，返回中附带 `renameError`。`wait: false` 仅返回排队状态（`sessionId`、`title`、`status`、`queuedInputs`、`message`）；`wait: true` 共用下方等待与增量摘要规则。 |
| `nocturne_send` | 可运行 | `{ sessionId, prompt, wait?, timeoutSeconds? }`：向已有会话发送消息。采用 `queue` 排队模式，**从不打断**正在运行的轮次。`wait: false` 仅返回排队状态（`sessionId`、`title`、`status`、`queuedInputs`、`message`）；`wait: true` 共用下方等待与增量摘要规则。 |
| `nocturne_wait` | 可运行 | `{ sessionId?, sessionIds?, timeoutSeconds? }`（`sessionId` 与 `sessionIds` 二选一；默认 300s，上限 600s）：等待单个或多个会话的当前轮及正常 `done` 接续的排队轮次结束；传 `sessionIds` 时，任意一个会话满足停止条件（或调用时已满足）即立即返回 `{ timedOut, readySessionIds, sessions }`，列明就绪会话及各会话状态；超时返回各会话 `running` 不中断会话；停在权限确认或提问上时立即返回 `waiting_for_permission` / `waiting_for_answer`；若因中断或出错导致待发队列暂停，立即返回 `status: "paused"` 及刚结束轮次的 `turnOutcome`（`"aborted"` / `"error"`）。对子代理会话调用等待类工具会直接报错并给出其父会话 ID（取自 `SessionSummary.parent`）。 |
| `nocturne_interrupt` | 可运行 | `{ sessionId }`：中断指定会话当前正在运行的轮次。 |
| `nocturne_answer` | 可运行 | `{ sessionId, requestId, answers, wait?, timeoutSeconds? }`：回答自己创建的会话当前挂起的提问（`answers` 与 `session.respondQuestion` 一致：每题为 `{ selected, text? }` 或 `{ declined: true }`）。非本 agent 创建的会话报 `agent_not_allowed`；`wait: true`（默认）共用等待与增量摘要规则。 |
| `nocturne_respond_permission` | 可运行 | `{ sessionId, requestId, childSessionId?, reply, wait?, timeoutSeconds? }`：回复自己创建的会话挂起的权限审批（`reply` 沿用 `PermissionReply`；子代理转发审批传父会话 `sessionId` 与 `childSessionId`，走 `session.respondSubagentPermission`）。拒绝在任意上限下可用，非持久允许（本次 / `remember: "session"`）仅在上限为 `bypass` 时可用，持久授权（`project` / `always`）及非本 agent 会话由 RPC 接入层返回 `agent_not_allowed`；`wait: true`（默认）共用等待与增量摘要规则。 |

### 等待类返回增量摘要规则

适用于 `nocturne_wait`（单会话与多会话的每个会话条目）以及 `nocturne_start_session` / `nocturne_send` / `nocturne_answer` / `nocturne_respond_permission` 带 `wait: true` 的返回：

- **用户输入截断与额外输入计数**：`lastTurn.userText` 只保留本轮首条用户提交文本，超出 **300 字符**时以 `…` 截断；本轮其余用户条目（如后台命令结束后的 `<shell-result>`、插话、Runtime 注入等）不放原文，仅在数量大于 0 时通过 `lastTurn.extraInputs` 给出条数。
- **按连接增量输出**：同一 MCP 连接内，对同一会话在同一轮次下只列出上一次等待返回后新增（或状态变化）的工具调用，并在 `lastTurn.omittedPreviousTools` 中注明本次之前已省略的条数；首次等待或进入新轮次时从本轮开头算；不同连接互不影响，连接断开重连后从本轮开头算。
- **单行压缩与截断上限**：每条工具调用压成单行 `[工具名] 状态 — 目标`；`shell` 命令只取第一个非空行，换行与连续空白折叠为单空格，目标文本长度上限为 **120 字符**（超出或存在后续行时以 `…` 截断）。
- **单次条数上限**：每次最多列出最近 **20 条**新工具调用，超出时在 `lastTurn.omittedExcessTools` 中注明省略条数。
- **助手回复与总上限**：助手回复仅放在顶层 `reply`（不再在 `lastTurn` 中重复输出），最后一段完整回复不截断，其前的过程说明文字按 **300 字符**截断；单次输出整体仍受 64 KB 上限约束，查看完整过程或原文调用 `nocturne_read_session`。

## 5. 安全边界说明

本机管道（Windows 命名管道 ACL / POSIX 套接字 `0600`）只允许当前操作系统用户连接。本机配对用于可见性与误触发隔离（明确哪个外部 agent 正在驱动会话、限制其操作范围与新建会话的权限上限），**防不住本机同一操作系统用户下的恶意程序**（同一用户下的进程可读取 `~/.nocturne/mcp-bridge/` 下的身份文件，这与 `~/.nocturne` 本身的信任边界一致）。
