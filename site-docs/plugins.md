# 插件

Nocturne 支持自有插件（随发行包提供的内置插件与本地目录安装的插件），同时可只读读取本机已安装的 Codex 与 Claude Code 插件，统一接入其技能、Hook 与 stdio MCP 服务器。Nocturne 不会修改 `~/.codex` 或 `~/.claude` 下的任何文件。

## 来源与发现

打开「设置」→「插件」时，Nocturne 按来源分组列出已发现的插件：

- **内置**：随 Nocturne 桌面安装包或 `nctrn` npm 包分发的插件，位于发行包自带的 `plugins/<name>/` 目录，使用 `.nocturne-plugin/plugin.json` 清单，标识为 `nocturne:<name>@builtin`。
- **Nocturne（本地安装）**：位于 `~/.nocturne/plugins/installed/local/<name>/<version>/` 的插件，标识为 `nocturne:<name>@local`；优先读取 `.nocturne-plugin/plugin.json`，不存在时依次回退 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`。
- **Codex**：只读解析 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）中 `[plugins."<name>@<marketplace>"]` 且 `enabled = true` 的条目，并在 `$CODEX_HOME/plugins/cache/<marketplace>/<name>/` 下选取活跃版本（存在 `local` 时优先，否则按版本号取最新），读取 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json`。
- **Claude Code**：只读解析 `$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json`（默认 `~/.claude/plugins/installed_plugins.json`）中 `scope` 为 `"user"` 的安装路径与 `settings.json` 中 `enabledPlugins[id] === true` 的条目，读取 `.claude-plugin/plugin.json`（缺失时按默认布局尝试 `hooks/hooks.json` 与 `skills/`）。

同一插件在不同宿主同时存在时互相独立，各自单独启停。Codex 系统市场（`openai-bundled`、`openai-primary-runtime`）中的插件，以及解析后既无受支持 Hook、又无技能、也无受支持 MCP 服务器的插件会被跳过，不列出也不加载。

## 自有清单格式

自有插件在插件根目录下放置 `.nocturne-plugin/plugin.json`：

- `name` 只允许小写字母、数字和连字符；可选字段包括 `version`、`description`、`skills`、`hooks`、`mcpServers` 与 `interface`（`displayName`、`composerIcon`、`logo` 等）。
- 清单内的相对路径必须以 `./` 开头且解析后不得越出插件根目录。
- 插件图标优先取 `interface.composerIcon`，回退 `interface.logo`（仅接受插件目录内不超过 64 KB 的 png / jpg / webp / svg）。

## 启用与信任

- **内置插件**：随 Nocturne 版本分发，默认开启且不做整目录指纹确认；关闭后在 `~/.nocturne/plugins.json` 记录 `{ "enabled": false }`，再开启时恢复。
- **其他插件（本地安装、Codex、Claude Code）**：默认不启用；打开开关前会弹出确认对话框，列出将运行的 Hook、技能、MCP 服务器及不运行项。启用状态与整目录 SHA-256 指纹保存在 `~/.nocturne/plugins.json`，不写入 `config.json`。含符号链接或非普通文件/目录的插件会校验失败并禁止启用。
- **文件变化后重新确认**：每次会话打开与刷新插件列表都会重新计算非内置插件的整目录指纹。若文件被修改或校验失败，状态变为「已更改」，其 Hook 停止运行、技能与 MCP 服务器立即移除，并在会话打开时发出警告；重新确认启用后恢复。
- **生效时机**：插件启停后，技能与 MCP 服务器在空闲会话立即更新（运行中会话在 Turn 边界应用），Hook 对之后打开的会话生效。

## Hook

- **自有清单（`.nocturne-plugin/plugin.json`）**：支持 Nocturne 全部 9 个 Hook 事件点（含 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`TurnStart`、`TurnEnd`、`UserPromptSubmit`、`SessionStart`、`SubagentStart`、`SessionEnd`），输入、输出、超时与执行方式与配置文件 Hook 一致（`PreToolUse` 无 `allow`，仅 `PermissionRequest` 可放宽 `ask`）。子进程运行在最小白名单环境，叠加 `PLUGIN_ROOT`、`PLUGIN_DATA`，命令和参数中的 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 按字符串单次替换。
- **兼容清单（Codex / Claude Code 来源及本地兼容清单）**：仅接入以下 4 个点位：

| 点位 | 触发范围 | 作用 |
|---|---|---|
| `SessionStart` | 仅父会话 | 会话新建、恢复、分叉首次打开及压缩后注入上下文 |
| `UserPromptSubmit` | 仅父会话 | 用户提交输入时注入上下文或拦截本次输入 |
| `SubagentStart` | 仅子会话 | 子代理启动前注入上下文 |
| `SessionEnd` | 仅父会话 | 会话结束时运行清理钩子 |

插件 Hook 均在最小白名单环境变量下执行，可使用插件根目录与 Nocturne 分配的数据目录（`~/.nocturne/plugins/data/<name>-<marketplace>`），不读写 `~/.codex` 或 `~/.claude` 运行时数据目录。

## MCP 服务器

插件可在清单的 `mcpServers` 字段声明 MCP 服务器（内联对象或指向 `{ "mcpServers": { ... } }` 的 `./` 相对路径），省略时读取插件根目录的 `.mcp.json`（若存在）：

- 仅接入 **stdio** 传输；`type: "http"` 的条目会被跳过并记入不运行项与插件详情。
- `command`、`args`、`env` 中的 `${PLUGIN_ROOT}`、`${PLUGIN_DATA}`、`${NOCTURNE_NODE}` 按字符串单次替换，其中 `${NOCTURNE_NODE}` 指向当前运行 Nocturne 的 Node 可执行文件。
- 插件不能声明 `{ stored: true }` 凭据引用。
- 服务器 id 与用户、项目或 `mcp.json` 中的服务器同名时，配置文件优先，插件条目跳过并发出告警。
- 工具名、权限主体（`mcp <server>/<tool>`）、按需加载、重连与输出预算与普通 MCP 服务器相同；插件自带的服务器在「设置 › 插件」的插件详情里查看和启停，已启用插件的服务器同时列在「设置 › MCP」的「来自插件」分组（见 [MCP](mcp.md)）。

## 插件技能的优先级

已启用且未变化的插件所含技能目录（清单 `skills` 字段或默认 `skills/`）会作为用户级来源排在 `skills.extraDirs` 之后，**优先级最低**：任何用户技能或项目技能同名时都会覆盖插件技能。插件停用或变为「已更改」后，其技能立即从可用列表中移除。详见 [技能](skills.md)。

## 不支持的内容

以下内容在 Nocturne 中不会运行（确认框与插件详情会列出跳过原因）：

- **兼容清单的工具与权限点位**：如 `PreToolUse`、`PermissionRequest`、`PostToolUse` 等（标为「不支持的点位」）。
- **非命令型 Hook 与 HTTP MCP**：`prompt`、`agent`、`mcp_tool` 等非 `command` 类型 Hook，以及 `type: "http"` MCP 服务器。
- **异步 Hook**：`async: true` 的条目（标为「异步」）。
- **用户配置占位符与凭据库引用**：Hook 含 `${user_config.*}`，或插件 MCP 声明 `{ stored: true }`。
- **自定义命令、界面扩展与子代理定义**：不支持 `commands/`、`modules`、band、statusline 等宿主界面扩展。
