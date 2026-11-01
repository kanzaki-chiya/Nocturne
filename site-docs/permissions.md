# 权限模式

## 四种权限预设

Nocturne 将工具操作分为五类：读取文件（`read`）、修改文件（`edit`）、执行命令（`shell`）、网络访问（`network`）和 MCP 工具调用（`mcp`）。默认预设为「自动编辑」。

| 预设 | 配置值 | 工作区内读写 | 执行命令 | 工作区外路径 / 网络 / 写状态 MCP |
| --- | --- | --- | --- | --- |
| 只读 | `read-only` | 仅允许读取，禁止修改 | 禁止 | 工作区外路径与网络每次询问，写状态 MCP 禁止 |
| 自动编辑（默认） | `auto-edit` | 自动放行（敏感文件除外） | 每次询问 | 每次询问 |
| 智能 | `smart` | 自动放行（敏感文件除外） | 只读命令与未受污染的工作区测试/构建脚本自动放行，其余先由安全审查器判断 | 先由安全审查器判断，存疑再询问用户 |
| 完全访问 | `guarded`（兼容 `full-access`） | 自动放行（敏感文件除外） | 自动放行（高风险命令除外） | 自动放行（工作区外敏感文件除外） |

即使在「完全访问」或「智能」模式下，以下两类操作仍会强制弹出确认：

- **高风险命令**：如 `rm -rf`、`git reset --hard`、`git push --force`、`Remove-Item -Recurse -Force`、`format`、`dd` 以及带 `-EncodedCommand` 的不透明 PowerShell 命令。
- **敏感路径**：`.env`、`.env.*`、`.ssh`、`.aws`、`.kube`、`.gnupg`、`.npmrc`、`.pypirc`、`.netrc`、`credentials.json`、`*.pem`、`*.key`、`.git/hooks`、`.git/config`、`.nocturne`。

### 切换权限预设

- **桌面端**：点击输入框底部工具栏的权限预设按钮（或按 `Shift+Tab`）可切换当前会话预设；在「设置 → 通用 → 默认权限」中可修改全局默认预设，并在「智能权限审查」中配置审查方式（「Jev 专用小模型」或「使用已配置的对话模型」）以及「附加审查规则」。
- **终端 TUI**：按 `Shift+Tab` 循环切换，或输入 `/permissions` 选择；启动时可传 `--permission <preset>`。

## 审批操作

当操作需要确认时，界面会展示待审批的工具、目标路径或命令：

- **桌面端审批卡片**：
  - 点击「允许」仅放行当前这一次操作；
  - 点击「本会话总是允许」，在当前会话关闭前对同类目标自动放行；
  - 点击「此项目总是允许」，将授权持久化保存在本机 `~/.nocturne/grants.json`；
  - 点击「拒绝」取消执行（可在输入框填写拒绝原因告诉模型，引导其换用其他方案）。
- **终端 TUI 审批面板**：按 `y`（允许本次）、`a`（本会话允许同类）、`p`（本项目允许同类）或 `n` / `Esc`（拒绝，按 `Tab` 可输入拒绝原因）。

## 自定义权限规则

你可以在 `~/.nocturne/config.json` 或 `<workspace>/.nocturne/config.json` 的 `permissions.rules` 中编写细粒度规则：

```json
{
  "permissions": {
    "preset": "auto-edit",
    "rules": [
      { "tool": "shell", "action": "allow", "match": { "command": "pnpm test*" } },
      { "tool": "shell", "action": "ask", "match": { "command": "git push*" } },
      { "tool": "edit", "action": "allow", "match": { "path": "docs/**", "scope": "workspace" } },
      { "tool": "network", "action": "deny", "match": { "host": "internal.example.com" } }
    ]
  }
}
```

权限层的判定优先级从高到低依次为：用户 `deny` 规则 → 会话临时授权 → 项目持久授权 → 用户 `allow` / `ask` 规则 → 当前预设规则 → 兜底询问。

## 查看与撤销授权

- **本会话授权**：在桌面端输入框底部的状态栏中，如有本会话记住的授权会显示「N 项会话授权」按钮，点击即可逐条移除或点击「全部清除」。
- **跨会话持久授权**：打开桌面端「设置 → 权限」（或 TUI 输入 `/grants`），在项目授权列表和「已信任的项目」分组中点击任意条目右侧的「撤销」（TUI 按 `d` / `Delete`），或点击「全部撤销」。
