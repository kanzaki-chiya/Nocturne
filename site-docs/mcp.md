# MCP

## 接入外部 MCP 服务器

Nocturne 支持接入本地进程（`stdio`）和远程 Streamable HTTP（`http`）两类 MCP（Model Context Protocol）服务器。

### 在桌面端添加或导入

1. 打开「设置 → MCP 服务器」。
2. 点击右上角的「添加」，选择传输类型（「本地进程 (stdio)」或「远程 HTTP」），填写名称、命令或 URL、参数、环境变量等字段并点击「保存」。
3. 如果本机已安装 Claude Desktop、Claude Code、Cursor、Windsurf 或 VS Code，点击右上角的「从外部导入」可自动扫描并导入已配置的 MCP 服务器。
4. 在服务器列表中可查看每个服务器的连接状态、展开查看其暴露的工具列表，或点击「重连」、启用/停用开关、「编辑」与「删除」。

在终端 TUI 中，输入 `/mcp` 可查看与管理 MCP 服务器连接状态。

### 在配置文件中定义

桌面端添加的服务器保存在 `~/.nocturne/mcp.json`；你也可以在 `~/.nocturne/config.json` 或 `<workspace>/.nocturne/config.json` 的 `mcp.servers` 字段中配置：

```json
{
  "mcp": {
    "toolSearch": "auto",
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      },
      "remote-docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "${DOCS_MCP_AUTH}"
        }
      }
    }
  }
}
```

注意：

- 出于安全保护，未信任项目的项目级配置文件不会生效（参见 [权限模式](permissions.md)）。
- `env` 和 `headers` 中涉及密钥或 Token 的字段不能写明文字面量，必须写成 `"${ENV_VAR}"` 引用环境变量。

## 工具命名与按需搜索

- 接入后的 MCP 工具在会话中统一命名为 `mcp__<server>__<tool>`。
- 当所有 MCP 工具定义总计超过上下文窗口的 **10%** 时（默认 `mcp.toolSearch: "auto"`），Nocturne 会自动切换为按需搜索模式：不在每轮请求中全量注入所有工具 schema，而是只提供 `mcp_search` 和 `mcp_call` 两个工具，由模型按关键词搜索后再调用。你可以在 [配置参考](config.md) 的 `mcp.toolSearch` 中将其设为 `"always"` 或 `"never"`。

## 对外提供 MCP

Nocturne 同时提供 `nocturne-mcp` 桥接程序，可将正在运行的 Nocturne 桌面端作为 MCP 服务器暴露给 Claude Code、Codex、Cursor 等外部 Agent 调用，实现跨工具创建会话、发送指令和读取结果。具体配对步骤与暴露的 7 个工具见 [外部 Agent](outside-agents.md)。
