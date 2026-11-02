# 配置参考

Nocturne 的所有用户级数据默认存放在 `~/.nocturne`（可通过环境变量 `NOCTURNE_HOME` 修改目录），工作区项目级配置存放在 `<workspaceRoot>/.nocturne/config.json`。

## 文件位置与职责

程序自动维护的 JSON 文件与你手写的 `config.json` 严格分离——**Nocturne 从不改写你手写的 `config.json`**：

| 路径 | 读写方 | 用途 |
|---|---|---|
| `~/.nocturne/config.json` | 用户手写（只读） | 用户级手写配置 |
| `<workspaceRoot>/.nocturne/config.json` | 项目仓库（只读） | 项目级配置（需信任项目后才完全生效） |
| `~/.nocturne/settings.json` | 程序维护 | 界面与 `/settings` 保存的默认模型、档位、权限预设、审查器、压缩阈值、主题与通知偏好 |
| `~/.nocturne/providers.json` | 程序维护 | 服务商配置页、`nctrn setup` 与 `/provider` 保存的服务商与模型微调（`userModels`） |
| `~/.nocturne/credentials.json` | 程序维护 | 凭据索引与加密凭据记录（配合 Windows DPAPI 等系统凭据库） |
| `~/.nocturne/mcp.json` | 程序维护 | 桌面端「设置」→「MCP」管理的外部 MCP 服务器 |
| `~/.nocturne/external-agents.json` | 程序维护 | 桌面端「设置」→「子代理」管理的外部 ACP Agent |
| `~/.nocturne/trust.json` | 程序维护 | 已信任工作区的真实路径列表 |
| `~/.nocturne/grants/` | 程序维护 | 按工作区保存的项目级「本项目允许」授权记录 |
| `~/.nocturne/schedules.json` | 程序维护 | 定时任务定义（运行历史在 `schedules/history/` 下） |
| `~/.nocturne/remote.json` | 程序维护 | 手机远程中继登记与已配对设备公钥 |
| `~/.nocturne/sessions/` | 程序维护 | 本机全部会话的事件日志（`.jsonl`）与检查点快照 |

桌面端「设置」→「外观」中的「主题」（跟随系统 / 月之亮面 / 月之暗面）、「界面字体」、「代码字体」与「字号」（12–20，默认 14）保存在桌面端本机偏好中，修改后立即在桌面界面与面板终端生效；手机端只使用自身的主题切换，不应用桌面字体与字号。

桌面端进入设置区时会预加载各页数据，离开后仍保留已加载的内容；再次进入先显示已有数据，再后台刷新。设置保存和服务商、模型变更会刷新相关数据，后台重新连接后重新加载，避免沿用另一后台的数据。外观页直接使用本机偏好。

## 配置分层优先级

从低到高依次合并（高层覆盖低层，`permissions.rules` 与 `hooks` 按层追加）：

1. 内置默认值与 `models.dev` 模型能力元数据
2. 程序维护层：`providers.json`、`mcp.json`、`external-agents.json`、`userModels`、`settings.json`
3. 用户手写配置：`~/.nocturne/config.json`
4. 项目级配置：`<workspaceRoot>/.nocturne/config.json`（**未信任时**仅其中的 `ask` / `deny` 收紧规则生效，`allow` 规则、模型、服务商、`mcp` 与 `hooks` 全部忽略）
5. 环境变量：`NOCTURNE_MODEL`、`NOCTURNE_BASE_URL` 等
6. 命令行参数：`nctrn` 启动参数（优先级最高）

## `config.json` 常用字段

`config.json` 使用严格 JSON 格式（不支持注释或尾逗号）：

```json
{
  "model": "deepseek/deepseek-chat",
  "reasoningEffort": "medium",
  "modelRoles": {
    "task": "deepseek/deepseek-chat",
    "vision": "openai/gpt-4.1",
    "smol": "deepseek/deepseek-chat"
  },
  "permissions": {
    "preset": "default",
    "rules": [
      { "kind": "shell", "pattern": "pnpm test*", "action": "allow" },
      { "kind": "edit", "pattern": ".env*", "action": "deny" }
    ]
  },
  "compaction": {
    "threshold": "90%",
    "pruneLimit": 200000
  },
  "shell": "pwsh",
  "turn": {
    "maxSteps": 50,
    "retryLimit": 10,
    "loopGuard": { "warnAt": 3, "stopAt": 6 }
  },
  "skills": {
    "sources": { "agents": true, "claude": true },
    "extraDirs": ["~/my-skills"]
  }
}
```

| 字段 | 可选值 / 子字段 | 说明 |
|---|---|---|
| `model` | `"provider/model"` | 新会话默认模型 |
| `reasoningEffort` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | 新会话默认思考档位 |
| `modelRoles` | `task`、`vision`、`smol` | 子代理默认模型、图片描述视觉模型、标题与摘要轻量模型 |
| `subagents.profiles` | `Record<string, SubagentProfileConfig>` | 自定义子代理档位（见 [子代理](subagents.md)） |
| `permissions.preset` | `read-only`、`default`、`auto-edit`、`guarded`、`smart`、`bypass` | 默认权限预设（见 [权限模式](permissions.md)） |
| `permissions.rules` | `PermissionRule[]` | 追加的权限规则（`kind`、`pattern`、`action`） |
| `permission.reviewer` | `SecurityReviewerConfig` | `smart` 预设使用的安全审查器配置（`off`、`jev` 或 `model`） |
| `permission.reviewerRules` | `ask`、`allow` | 追加给安全审查器的自然语言「额外交人」与「额外放行」规则 |
| `compaction.threshold` | `"90%"`、`"200k"` 或正整数 | 自动压缩摘要阈值，默认 `"90%"` |
| `compaction.pruneLimit` | `number` | 预防性修剪绝对上限，默认 `200000`（设 `0` 关闭绝对上限） |
| `shell` | `auto`、`pwsh`、`powershell`、`bash`、`cmd`、`sh` | `shell` 工具使用的命令行解释器 |
| `shellPath` | `string` | 非标准安装位置的 Shell 可执行文件绝对路径 |
| `turn.maxSteps` | `number` | 单回合最大步数上限（默认不限制） |
| `turn.retryLimit` | `number` | 网络或上游瞬态错误自动重试次数（默认 `10`） |
| `turn.loopGuard` | `warnAt`、`stopAt` 或 `false` | 重复工具调用保护阈值（默认 `warnAt` 为 `3`、`stopAt` 为 `6`，设 `false` 关闭） |
| `mcp.servers` | `Record<string, McpServerEntry>` | 手写配置的 MCP 服务器 |
| `mcp.toolSearch` | `auto`、`always`、`never` | MCP 工具按需搜索模式（默认 `auto`，工具定义估算超过 10,000 tokens 时启用） |
| `skills` | `sources`（`agents`、`claude`）、`extraDirs` | 技能兼容目录开关与附加扫描目录（仅用户级生效） |
| `externalAgents` | `ExternalAgentConfig[]` | 手写配置的外部 ACP Agent（仅用户级生效） |
| `notifications` | `enabled`、`events`、`doneAfterSeconds`、`sound` | 会话通知与完成提醒秒数阈值（默认 `60` 秒） |
| `modelsDev` | `false` | 设为 `false` 时不联网更新 `models.dev` 缓存，仅用内置快照 |

## 环境变量

| 环境变量 | 作用 |
|---|---|
| `NOCTURNE_HOME` | 修改用户数据与配置主目录（默认 `~/.nocturne`） |
| `NOCTURNE_MODEL` | 覆盖默认模型（如 `deepseek/deepseek-chat`） |
| `NOCTURNE_API_TYPE` | 合成服务商协议（`openai-compatible` 或 `anthropic`） |
| `NOCTURNE_BASE_URL` | 合成服务商接口地址 |
| `NOCTURNE_API_KEY` | 合成服务商默认读取的 API Key 变量 |
| `NOCTURNE_SHELL` | 覆盖 Shell 选择（种类名或可执行文件路径） |
| `NOCTURNE_DEBUG` | 设为 `1` 或 `true` 启用诊断日志输出 |
| `NOCTURNE_DEBUG_FILE` | 指定诊断日志文件路径（`-` 为 `stderr`） |
| `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` | 进程网络代理与绕过列表（小写同名变量优先） |
