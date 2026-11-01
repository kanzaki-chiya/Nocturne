# TUI 和命令行

## 启动参数

在终端运行 `nocturne` 默认进入全屏交互式 TUI。常用启动参数如下：

| 参数 | 说明 |
| --- | --- |
| `nocturne [prompt]` / `-p, --prompt <text>` | 单次非交互执行给定提示词，完成后直接退出 |
| `-c, --continue` | 继续最近一次会话 |
| `-r, --resume [session-id]` | 恢复指定 ID（或前缀）的会话；省略 ID 时打开最近会话列表供选择 |
| `-fork, --fork-session` | 配合 `-c` 或 `-r` 使用，从目标会话分叉出新会话而不修改原会话 |
| `-m, --model <provider/model>` | 覆盖本次运行使用的模型（如 `anthropic/claude-sonnet-4-6`） |
| `--permission <preset>` | 覆盖本次运行的权限预设：`read-only`、`auto-edit`、`smart`、`guarded`（或 `full-access`） |
| `-C, --cwd <path>` | 指定工作区根目录 |
| `--plain` | 禁用全屏 TUI，改用传统滚动行编辑 REPL |
| `--json` | 单次执行时将全部运行时事件以 NDJSON（每行一个 JSON）输出到 `stdout` |
| `--setup` | 启动服务商与凭据交互式配置向导 |
| `--import-skills` | 从本机 Claude Code、Codex、Cursor 等外部工具目录导入技能后退出 |
| `-v, --version` | 打印版本号 |
| `-h, --help` | 打印命令行帮助 |

## 单次执行

在脚本、CI 或管道中调用 Nocturne 时，直接传入提示词或通过标准输入管道传入内容：

```bash
# 直接执行一句话任务
nocturne -p "运行测试并总结失败原因"

# 从管道读取内容并以 NDJSON 流输出事件
git diff | nocturne -p "审查这份 diff 中的边界条件问题" --json
```

单次执行处于非交互模式，未预先授权且需要人工确认的操作会被拒绝；需要自动修改文件或运行命令时可配合 `--permission auto-edit` 或 `--permission smart`。

## 斜杠命令

在 TUI 或 REPL 输入框中输入 `/` 可调用以下内置命令（输入 `/` 时同样会列出可用 [技能](skills.md)）：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看斜杠命令与快捷键帮助 |
| `/new`、`/clear` | 开始一个全新的空会话 |
| `/resume [query]` | 搜索并切换到已有历史会话 |
| `/fork` | 从当前会话分叉出一条独立的新会话 |
| `/rewind` | 打开回退面板，回到某条历史消息之前（见 [回退和分叉](rewind.md)） |
| `/model [provider/model]` | 查看或切换当前会话的模型 |
| `/effort [level]` | 查看或切换推理强度（`none` / `low` / `medium` / `high` / `xhigh` / `auto`） |
| `/provider` | 管理服务商、API 密钥、登录与自定义模型 |
| `/permissions [preset]` | 切换当前会话的权限模式 |
| `/grants` | 查看与撤销当前会话授权、项目授权与项目信任 |
| `/context` | 查看当前上下文窗口的分项 Token 占用 |
| `/compact [instructions]` | 立即将早期对话历史压缩为摘要（可附带保留说明） |
| `/usage [7\|30\|all]` | 查看本地 Token 用量与费用统计 |
| `/mcp` | 查看与管理 MCP 服务器连接状态 |
| `/skills` | 查看已发现的技能列表与加载诊断信息 |
| `/subagents` | 打开子代理视图，查看各子代理进展或向后台子代理发消息 |
| `/settings` | 打开全局设置面板 |
| `/steer <message>` | 模型运行中发送插话（下一工具间隙立即注入） |
| `/queue <message>` | 模型运行中将消息排入待发队列（本轮结束后自动发送） |
| `/copy` | 将最近一条助手回复复制到系统剪贴板 |
| `/exit`、`/quit` | 结束当前会话并退出 Nocturne |

## TUI 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Enter` | 发送消息（模型运行中为发送插话） |
| `Alt+Enter` | 模型运行中将消息加入待发队列 |
| `Shift+Enter` / `Ctrl+J` / `\` + `Enter` | 输入框内换行 |
| `Esc` | 中断当前模型运行，或关闭当前弹出面板 |
| `Esc` `Esc`（连按两次） | 空闲且输入框为空时打开 `/rewind` 回退面板 |
| `Shift+Tab` | 循环切换权限模式（`只读` / `自动编辑` / `智能` / `完全访问`） |
| `Ctrl+T` | 循环切换模型推理强度 |
| `Ctrl+O` | 展开或折叠所有工具调用详情 |
| `Ctrl+G` | 打开或关闭子代理视图 |
| `PageUp` / `PageDown` | 上下翻页滚动对话历史 |
| `Alt+↑` | 输入框为空时，取回最近一条待发消息重新编辑 |
| `Ctrl+C` | 清空当前输入；连按两次退出 |
