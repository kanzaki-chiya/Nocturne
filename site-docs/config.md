# 配置参考

## 文件位置

Nocturne 的配置、凭据与会话数据全部存放在本地磁盘：

| 文件或目录 | 用途 |
| --- | --- |
| `~/.nocturne/config.json` | 用户全局配置文件 |
| `<workspace>/.nocturne/config.json` | 项目级共享配置文件（可提交到 Git） |
| `<workspace>/.nocturne/config.local.json` | 项目级个人覆盖配置（建议加入 `.gitignore`） |
| `~/.nocturne/credentials.json` | 加密保存的 API 密钥与登录凭据（主密钥由系统凭据库保护） |
| `~/.nocturne/grants.json` | 项目级持久授权记录 |
| `~/.nocturne/trusted-projects.json` | 已信任的项目路径列表 |
| `~/.nocturne/mcp.json` | 界面添加的 MCP 服务器配置 |
| `~/.nocturne/external-agents.json` | 界面添加的外部 CLI Agent 配置 |
| `~/.nocturne/schedules.json` | 定时任务定义（运行历史位于 `~/.nocturne/schedules/history/`） |
| `~/.nocturne/remote.json` | 手机远程配对设备与身份密钥 |
| `~/.nocturne/agent-clients.json` | 已授权的外部 Agent MCP 客户端记录 |
| `~/.nocturne/sessions/` | 会话历史事件日志（JSONL）、工作区文件快照检查点（`checkpoints/`）与后台子代理工作树（`worktrees/`） |
| `~/.nocturne/AGENTS.md` | 用户全局协作指令文件 |
| `<workspace>/AGENTS.md` | 项目级协作指令文件（兼容读取 `CLAUDE.md`） |

可通过环境变量 `NOCTURNE_HOME` 修改 `~/.nocturne` 的所在目录。

## 分层与覆盖优先级

配置按以下顺序从高到低合并（高优先级覆盖低优先级）：

1. **命令行参数与环境变量**：如 `--model`、`--permission`、`NOCTURNE_MODEL`、`NOCTURNE_PERMISSION_PRESET`；
2. **项目本地配置**：`<workspace>/.nocturne/config.local.json`；
3. **项目共享配置**：`<workspace>/.nocturne/config.json`；
4. **用户全局配置**：`~/.nocturne/config.json`；
5. **内置默认值**。

### 未信任项目与凭据安全限制

- **未信任项目**：在项目被标记为信任前，该项目下的 `.nocturne/config.json` 和 `.nocturne/config.local.json` 不会加载生效。即便项目已信任，`externalAgents` 也只允许在用户级配置中声明，项目级配置中的 `externalAgents` 永不生效。
- **严禁内联明文凭据**：`config.json` 的 `providers` 条目不允许直接写 `apiKey`、`token` 等明文字段（否则会报错 `config_credential_rejected`），请通过界面加密保存或使用 `apiKeyEnv` 指定环境变量名。

## 常用配置字段

以下为 `config.json` 支持的常用字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `defaultModel` | `string` | `"magpie/claude-opus-4.6"` | 默认模型，格式为 `"<provider>/<model>"` |
| `reasoningEffort` | `string` | 模型默认 | 默认推理强度：`"none"`、`"low"`、`"medium"`、`"high"`、`"xhigh"` |
| `shell` | `string` | `"auto"` | `shell` 工具使用的终端：Windows 可选 `"auto"`、`"pwsh"`、`"powershell"`、`"git-bash"`、`"cmd"`、`"wsl"`；macOS/Linux 可选 `"auto"`、`"zsh"`、`"bash"`、`"sh"` |
| `network.proxy` | `string` | `"system"` | 网络代理地址（如 `"http://127.0.0.1:7890"`、`"socks5://127.0.0.1:1080"`、`"system"` 或 `"none"`） |
| `network.noProxy` | `string[]` | `[]` | 绕过代理的主机名或域名后缀列表 |
| `magpie.enabled` | `boolean` | `true` | 是否启用内置免费 Magpie 服务商 |
| `providers` | `array` | `[]` | 服务商定义数组（每项含 `id`、`name`、`type`、`baseURL`、`apiKeyEnv`、`models` 等） |
| `permissions.preset` | `string` | `"auto-edit"` | 默认权限预设：`"read-only"`、`"auto-edit"`、`"smart"`、`"guarded"`（兼容 `"full-access"`） |
| `permissions.rules` | `array` | `[]` | 自定义权限规则列表（见 [权限模式](permissions.md)） |
| `security.reviewer` | `object` | `undefined` | 智能模式安全审查器（`backend: "jev"` 或 `"model"`） |
| `security.reviewerRules` | `object` | `undefined` | 附加审查说明（`ask` 与 `allow`，各最多 1000 字） |
| `context.compaction.auto` | `boolean` | `true` | 是否开启自动上下文压缩 |
| `context.compaction.threshold` | `number` | `0.8` | 自动压缩触发阈值（`0.5`–`0.95`） |
| `context.compaction.instructions` | `string` | `undefined` | 压缩时附加的持久保留要求 |
| `turn.maxSteps` | `number` | `undefined` | 单轮对话最大工具调用步数 |
| `turn.loopGuard` | `object \| false` | `{ "warnAt": 3, "stopAt": 6 }` | 连续重复工具调用保护；设为 `false` 关闭 |
| `subagents.profiles` | `object` | `{}` | `quick`、`deep` 及自定义子代理档位配置（见 [子代理](subagents.md)） |
| `externalAgents` | `array` | `[]` | 用户级外部 CLI Agent 配置列表（见 [外部 Agent](outside-agents.md)） |
| `mcp.servers` | `object` | `{}` | MCP 服务器定义字典（见 [MCP](mcp.md)） |
| `mcp.toolSearch` | `string` | `"auto"` | MCP 工具按需搜索模式：`"auto"`、`"always"`、`"never"` |

## 完整配置示例

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-6",
  "reasoningEffort": "high",
  "shell": "pwsh",
  "network": {
    "proxy": "http://127.0.0.1:7890",
    "noProxy": ["localhost", "127.0.0.1", ".internal.example.com"]
  },
  "providers": [
    {
      "id": "my-gateway",
      "name": "内部网关",
      "type": "openai-compatible",
      "baseURL": "https://llm.internal.example.com/v1",
      "apiKeyEnv": "INTERNAL_LLM_KEY",
      "models": [
        {
          "id": "qwen3-coder",
          "name": "Qwen 3 Coder",
          "contextWindow": 131072,
          "maxOutputTokens": 16384,
          "pricing": {
            "input": 0.8,
            "output": 2.4
          }
        }
      ]
    }
  ],
  "permissions": {
    "preset": "smart",
    "rules": [
      { "tool": "shell", "action": "allow", "match": { "command": "pnpm test*" } },
      { "tool": "shell", "action": "ask", "match": { "command": "git push*" } }
    ]
  },
  "context": {
    "compaction": {
      "auto": true,
      "threshold": 0.8
    }
  }
}
```
