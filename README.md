# Nocturne

Nocturne 是在代码仓库中工作的命令行编程助手。运行 `nctrn` 后，可以用自然语言让它阅读和搜索文件、修改代码、运行命令；它也能调用 MCP 工具、运行 Hooks，并把独立任务交给子代理。会话保存在本地，可以稍后恢复。写入、执行和外部工具调用受权限预设与规则约束。

## 安装

需要 Node.js 24 或更新版本，以及 pnpm 11.24.0。从源码构建：

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js --version
```

构建后的入口是 `apps/cli/dist/main.js`。以下示例用 `nctrn` 表示运行这个入口；可以按自己的 shell 设置快捷命令：

```powershell
# PowerShell，在 Nocturne 源码目录执行
$nocturneCli = (Resolve-Path ./apps/cli/dist/main.js).Path
function nctrn { node $nocturneCli @args }
```

```sh
# bash / zsh，在 Nocturne 源码目录执行
NOCTURNE_CLI="$(pwd)/apps/cli/dist/main.js"
nctrn() { node "$NOCTURNE_CLI" "$@"; }
```

设置后进入要操作的代码仓库，再运行下文的 `nctrn` 命令。需要长期使用时，把入口的绝对路径写进 shell 配置。

## 配置

凭据放在环境变量里，不要写进配置文件。用户配置位于 `<NOCTURNE_HOME>/config.json`；项目配置位于仓库的 `.nocturne/config.json`。两者都是严格 JSON。可以先用环境变量连接 OpenAI 兼容服务：

```powershell
$env:NOCTURNE_API_KEY = "<你的密钥>"
$env:NOCTURNE_BASE_URL = "https://<服务地址>/v1"
$env:NOCTURNE_MODEL = "<模型 ID>"
nctrn --sessions
```

下面是一份用户配置示例，展示 Provider、模型、权限预设、MCP、Hooks 和子代理的最小写法。把地址、模型 ID 和 MCP 服务器脚本路径换成实际值；`NOCTURNE_API_KEY` 仍须由环境变量提供。MCP 服务器只在会话打开时启动，Hook 命令会在相应事件发生时执行。

```json
{
  "model": "example/example-model",
  "providers": [
    {
      "id": "example",
      "type": "openai-compatible",
      "baseURL": "https://<服务地址>/v1",
      "apiKeyEnv": "NOCTURNE_API_KEY",
      "models": { "example-model": { "contextWindow": 128000 } }
    }
  ],
  "permissions": {
    "preset": "default",
    "rules": [{ "kind": "subagent", "pattern": "explore", "action": "allow" }]
  },
  "mcp": {
    "servers": {
      "example": { "command": "node", "args": ["/path/to/mcp-server.mjs"] }
    }
  },
  "hooks": {
    "TurnEnd": [{ "command": "node", "args": ["/path/to/turn-end.mjs"] }]
  }
}
```

Anthropic 协议可用另一份 Provider 条目，模型引用随之改为 `anthropic/<模型 ID>`；未指定 `baseURL` 时使用官方端点：

```json
{
  "model": "anthropic/<模型 ID>",
  "providers": [
    { "id": "anthropic", "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  ]
}
```

项目配置初次加载时默认不受信任：它不能替换模型或启动 MCP、Hook；收紧权限的规则仍可生效。确认仓库内容可信后，在仓库目录运行 `nctrn trust`；用 `nctrn untrust` 撤销。比如项目配置可以只放一条权限规则：

```json
{
  "permissions": {
    "rules": [{ "kind": "shell", "pattern": "*", "action": "ask" }]
  }
}
```

预设可用 `read-only`、`default`、`auto-edit`、`full-access`；子代理通过内置 `task` 工具使用，`explore` 适合只读探索，`general` 可以承担更广的任务。会话中可用 `/preset` 查看或切换预设。流式首事件与空闲超时可在配置的 `turn.firstEventTimeoutMs`、`turn.idleTimeoutMs` 中调整，默认分别为 30000 和 120000 毫秒。更多配置说明见[项目文档](docs/README.md)。

## 基础用法

在要操作的仓库目录运行：

```sh
nctrn                              # 交互式命令行
nctrn -p "概述这个仓库"             # 执行一次后退出
nctrn --tui                        # 全屏终端界面，需要交互式终端
nctrn -c                           # 继续当前目录最近的会话
nctrn --resume <会话 ID>            # 恢复指定会话
nctrn --sessions                   # 列出会话及 ID
nctrn --debug -p "概述这个仓库"     # 写入诊断日志
```

交互模式常用 `/help` 查看命令，`/model` 和 `/preset` 查看或切换模型与权限预设，`/context` 查看上下文用量，`/compact` 压缩上下文，`/mcp` 查看服务器状态，`/resume` 切换会话，`/exit` 退出。执行时需要确认的操作会显示允许一次、会话内允许、项目内允许或拒绝等选项；非交互模式下需要确认的操作默认拒绝。

## 已知限制

- Nocturne 主进程被强杀时，如果 MCP 服务器在 stdin 关闭后没有自行退出，它可能残留为孤儿进程。Windows 上服务器不会随父进程自动退出；POSIX 上即使服务器处于独立进程组，父进程消失也不会自动向该组发信号。先核对服务器命令行和 PID，再在 Windows 用 `taskkill /PID <PID> /T /F`，或在 POSIX 用 `kill -TERM <PID>`，必要时逐一清理其子进程。正常关闭会话时 Nocturne 会清理服务器。
- Windows 传统 conhost 的 TUI 活动区重绘可能留下残影；建议使用 Windows Terminal。
- 工具返回的图片、音频和二进制资源目前只以文本占位显示。

## 许可证

[GNU GPL v3.0](LICENSE)。
