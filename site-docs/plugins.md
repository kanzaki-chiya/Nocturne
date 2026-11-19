# 插件

Nocturne 可以只读读取本机已安装的 Codex 与 Claude Code 插件，在用户核对并显式启用后，接入其生命周期 Hook 与技能目录。Nocturne 不会修改 `~/.codex` 或 `~/.claude` 下的任何文件。

## 发现哪些已装插件

打开「设置」→「插件」时，Nocturne 按宿主分组列出已发现的插件：

- **Codex**：只读解析 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）中 `[plugins."<name>@<marketplace>"]` 且 `enabled = true` 的条目，并在 `$CODEX_HOME/plugins/cache/<marketplace>/<name>/` 下选取活跃版本（存在 `local` 时优先，否则按版本号取最新），读取 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json`。
- **Claude Code**：只读解析 `$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json`（默认 `~/.claude/plugins/installed_plugins.json`）中 `scope` 为 `"user"` 的安装路径与 `settings.json` 中 `enabledPlugins[id] === true` 的条目，读取 `.claude-plugin/plugin.json`（缺失时按默认布局尝试 `hooks/hooks.json` 与 `skills/`）。

同一插件在两个宿主同时安装时互相独立，各自单独启停。Codex 系统市场（`openai-bundled`、`openai-primary-runtime`）中的插件，以及解析后既无受支持 Hook 又无技能（含仅有不受支持 Hook）的插件会被跳过，不列出也不加载。

## 默认不启用与确认流程

- **默认不启用**：新发现的插件初始为停用状态，不会自动运行 Hook 或加载技能。
- **启用前核对 Hook**：打开开关时先弹出确认对话框，列出该插件将执行的 Hook（点位、matcher 与命令）、提供的技能，以及被跳过的条目；核对无误后点击「启用」才会保存。停用插件不弹确认框。
- **信任与存储**：启用状态与插件整目录的 SHA-256 指纹保存在 `~/.nocturne/plugins.json`，不写入 `config.json`。含符号链接或非普通文件/目录的插件会校验失败并禁止启用。
- **文件变化后重新确认**：每次会话打开与刷新插件列表都会重新计算整目录指纹。若插件文件被修改或校验失败，状态会变为「已更改」，其 Hook 停止运行、技能立即移除，并在会话打开时发出警告；需要在插件列表点「重新确认」或重新打开开关，再次核对后启用才会恢复。Hook 变更对之后打开的会话生效。

## 支持的四个 Hook 点位

插件 Hook 仅接入以下四个点位：

| 点位 | 触发范围 | 作用 |
|---|---|---|
| `SessionStart` | 仅父会话 | 会话新建、恢复、分叉首次打开及压缩后注入上下文 |
| `UserPromptSubmit` | 仅父会话 | 用户提交输入时注入上下文或拦截本次输入 |
| `SubagentStart` | 仅子会话 | 子代理启动前注入上下文 |
| `SessionEnd` | 仅父会话 | 会话结束时运行清理钩子 |

插件 Hook 在最小白名单环境变量下执行，可使用插件根目录与 Nocturne 分配的数据目录（`~/.nocturne/plugins/data/<name>-<marketplace>`），不读写 `~/.codex` 或 `~/.claude` 运行时数据目录。

## 插件技能的优先级

已启用且未变化的插件所含技能目录（清单 `skills` 字段或默认 `skills/`）会作为用户级来源排在 `skills.extraDirs` 之后，**优先级最低**：任何用户技能或项目技能同名时都会覆盖插件技能。插件停用或变为「已更改」后，其技能立即从可用列表中移除。详见 [技能](skills.md)。

## 不支持的内容

以下内容在 Nocturne 中不会运行（确认框与插件详情的「不运行」分组会列出跳过原因）：

- **其他 Hook 点位**：如 `PreToolUse`、`PermissionRequest`、`PostToolUse` 等工具与权限点位（标为「不支持的点位」）。
- **非命令型 Hook**：`prompt`、`agent`、`mcp_tool` 等非 `command` 类型（标为「不支持的类型」）。
- **异步 Hook**：`async: true` 的条目（标为「异步」）。
- **用户配置占位符**：命令或参数包含 `${user_config.*}` 的条目（标为「需要用户配置」）。
- **自定义命令与界面扩展**：不支持 `commands/`（Codex `.toml` / Claude `.md` 自定义斜杠命令），也不支持 `modules`、band、statusline 等宿主界面扩展。
- **安装与升级**：Nocturne 不提供从 Git 地址自行安装或升级插件的功能。
