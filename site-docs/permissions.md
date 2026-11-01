# 权限模式

每次工具调用前，Nocturne 的权限层都会按预设、规则与授权计算 `allow`（放行）、`ask`（询问）或 `deny`（拒绝）。权限判定在调用发生前执行，不是操作系统沙箱。

## 六种权限预设

点击会话输入框左下方的权限预设按钮（终端输入 `/preset` 或启动时加 `--preset <name>`）可切换当前会话的预设；在「设置」→「常规」的「权限」分组可设置「默认权限预设」。回合进行中也可以切换预设，从下一次权限判定起生效。

| 预设 | 工作区读 / 改 | 外部读 / 改 | `shell` | `network` / `mcp` | 内置子代理 |
|---|---|---|---|---|---|
| `read-only`（只读） | `allow` / `deny` | `ask` / `deny` | `ask` | `ask` | `ask` |
| `default`（默认） | `allow` / `ask` | `ask` / `ask` | `ask` | `ask` | `explore` 放行，其余 `ask` |
| `auto-edit`（自动编辑） | `allow` / `allow` | `ask` / `ask` | `ask` | `ask` | `explore` 放行，其余 `ask` |
| `guarded`（守护） | `allow` / `allow` | `allow` / `ask` | `allow`（高风险 `ask`） | `allow` | `allow` |
| `smart`（智能） | `allow` / `allow` | `allow` / `ask` | 只读白名单 `allow`，其余送审 | 送审（只读 MCP `allow`） | `allow` |
| `bypass`（全部放行） | `allow` / `allow` | `allow` / `allow` | `allow` | `allow` | `allow` |

补充保护规则：

- **凭据硬拒绝**：`<NOCTURNE_HOME>/credentials.json` 与外部登录文件（如 `~/.grok/auth.json`）的 `read` / `edit` 在所有预设下直接 `deny`，任何规则、授权或 `--yes` 都不能放开。
- **受保护路径**：除 `read-only`（直接拒绝修改）和 `bypass` 外，修改 `.git/`、`.nocturne/`、Nocturne 授权与配置文件或定时任务文件至少触发 `ask`；`bypass` 仍对 `.nocturne/`、Nocturne 授权配置、定时任务文件以及可能读取凭据的命令保留 `ask`。
- **外部 Agent 与定时任务**：委派外部 Agent（`subagent` 类别下的 `external:*`）与修改定时任务（`schedule`）在全部预设下默认 `ask`。
- **高风险命令**：在 `guarded` 和 `smart` 下，`rm -rf`、`git push --force`、`git reset --hard`、`Remove-Item -Recurse -Force` 以及带 `-EncodedCommand` 的 PowerShell 命令不会直接放行，而是降为 `ask` 或送交审查。

### 配置 `smart` 安全审查器

`smart` 预设会把只读白名单之外的待确认请求先交给安全审查器判断：审查器确认无风险或符合你的明确指令时自动放行，拿不准（`unsure`）时交给你确认。

在「设置」→「常规」的「执行」分组中点击「安全审查」右侧的「编辑」，可在「关闭」、「Jev」和「小模型」之间切换：

- 选择「小模型」时，从已配置的模型列表中选一个模型负责审查；
- 选择「Jev」时，可选择接入点（`opencode-zen`、`typesafe` 或「自定义地址」）、凭据来源（「沿用服务商」、「环境变量」或「单独密钥」）和「置信度阈值」（默认 `0.7`）；
- 下方的「额外交人」和「额外放行」文本框可补充自定义审查要求（对应的配置字段为 `permission.reviewer` 与 `permission.reviewerRules`）。

## 审批操作

当调用需要确认时，对话内会弹出「需要确认」卡片，按数字键 `1`–`5` 或点击按钮回复，按 `Esc` 直接拒绝：

- 「允许一次」：只放行本次调用；
- 「本会话允许」：在当前会话内存中记住该精确目标（子代理只读继承），关闭会话即失效；
- 「本项目允许」：将该精确目标写入本机 `<NOCTURNE_HOME>/grants/` 下对应工作区的授权记录，此后在该工作区自动放行（命中高风险命令、工作区外修改或 `schedule` 操作时不提供此项）；
- 「拒绝」：拒绝本次调用，可填写反馈告诉模型原因，当前回合继续；
- 「拒绝并停止」：拒绝本次调用并立即中止当前回合。

## 自定义规则

需要按通配符批量放行或禁止某类操作时，在用户级 `~/.nocturne/config.json` 或项目级 `.nocturne/config.json` 的 `permissions.rules` 中编写规则（见 [配置参考](config.md)）：

```json
{
  "permissions": {
    "preset": "default",
    "rules": [
      { "kind": "shell", "pattern": "pnpm test*", "action": "allow" },
      { "kind": "edit", "pattern": "secrets/**", "action": "deny" }
    ]
  }
}
```

`kind` 支持 `read`、`edit`、`shell`、`network`、`mcp`、`subagent`、`schedule`（省略或 `*` 匹配全部）；`action` 取 `allow`、`ask`、`deny`。同一层内后写的规则优先。

仓库内的 `.nocturne/config.json` 默认处于「未信任」状态：未信任项目的 `allow` 规则会被忽略，`ask` / `deny` 只能收紧权限。只有信任项目后，项目的放宽规则、MCP 服务器与 Hook 才会生效。

## 查看与撤销授权、管理项目信任

- **查看或撤销本会话授权**：点击输入框左下方的权限预设按钮，菜单底部列出本会话已允许的临时授权条目，可逐条点击「撤销」或点击「全部撤销」→「确认全部撤销」，也可点「管理项目授权 →」跳到授权设置页。
- **管理项目授权与项目信任（桌面端）**：点击「设置」→「授权」，在左列选择工作区：
  - 在「配置」分组查看「项目信任」状态，点击「信任此项目」（核对项目声明的 MCP 服务器、Hook 与放宽规则）或「取消信任」；
  - 在「项目授权」表格中查看已持久化的授权，按行点击「撤销」或点击右上角「全部撤销」→「确认全部撤销」。
- **终端命令**：
  - 查看项目授权：运行 `nctrn grants`（可加 `--workspace <dir>` 指定工作区）；
  - 撤销单条或全部项目授权：运行 `nctrn grants revoke` 加编号或 `--all`；
  - 信任或取消信任当前目录：运行 `nctrn trust` 或 `nctrn untrust`。
