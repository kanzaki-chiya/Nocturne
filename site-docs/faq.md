# 常见问题

## 桌面端启动提示「需要安装 Node.js 24 或更高版本」

Nocturne 的核心运行时运行在本机 Node.js 24+ 进程上。

- 直接点击提示界面上的「下载 Node.js 24 LTS (v24.14.1)」按钮下载安装；
- 如果你使用 `fnm`、`nvm` 或 `volta` 管理 Node 版本，安装 24+ 版本后点击界面上的「重新检测」即可（桌面端会自动扫描常见版本管理器目录）。

## Windows 弹出 SmartScreen 拦截或 macOS 提示无法验证开发者

Nocturne 安装包未购买商业代码签名证书，首次打开时按以下方式放行：

- **Windows**：在「Windows 已保护你的电脑」窗口点击「更多信息」→「仍要运行」。
- **macOS**：在访达中按住 `Control` 点击 Nocturne 图标选择「打开」，或在「系统设置 → 隐私与安全性」底部点击「仍要打开」。

## 连接服务商超时或报错网络不可达

如果你的网络环境需要通过代理访问外部模型接口：

1. 在桌面端打开「设置 → 通用 → 网络代理」，选择「自定义代理地址」并填写本地代理（如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`）；
2. 或在 `~/.nocturne/config.json` 中配置 `"network": { "proxy": "http://127.0.0.1:7890" }`；
3. 默认情况下（`network.proxy` 为 `"system"`），Nocturne 也会自动读取系统环境变量 `HTTPS_PROXY` 和 `HTTP_PROXY`。

## 项目里的 `.nocturne/config.json` 没有生效

为了防止打开未知代码仓库时自动执行恶意命令，未信任项目的 `.nocturne/config.json` 与 `.nocturne/config.local.json` 不会加载生效；且 `externalAgents` 字段永远只允许在用户全局配置中声明。

解决办法：在桌面端打开该项目并在首次项目信任提示或权限审批中选择信任该项目（可在「设置 → 权限 → 已信任的项目」或 TUI `/grants` 中查看）。

## 配置文件报错 `config_credential_rejected`

为了防止 API 密钥随配置文件被提交到代码仓库，Nocturne 拒绝在 `config.json` 的 `providers` 条目中直接写 `apiKey`、`token` 等明文字段，也拒绝在 `mcp.servers.*.env` 中写明文密钥字面量。

解决办法：在桌面端「设置 → 服务商」中选择「直接输入（加密保存）」，或在 `config.json` 中改用 `"apiKeyEnv": "OPENAI_API_KEY"`（MCP 环境变量写成 `"API_KEY": "${API_KEY}"`）。

## 回退或撤销代码时，为什么部分文件没有恢复

Nocturne 的检查点快照只记录通过内置文件编辑工具（`write`、`edit`）修改或删除的文件。如果模型通过 `shell` 工具执行脚本、构建命令或 `git` 命令改动了文件，这些文件不在检查点快照范围内，需要通过 `git status` / `git checkout` 手动还原（详见 [回退和分叉](rewind.md)）。

## 定时任务到了时间没有执行，或执行时操作被拒绝

- **未触发执行**：定时任务由桌面端内置调度器运行，仅在 Nocturne 桌面端打开期间触发。关闭期间错过的任务会在下次打开桌面端时补跑最近一次。
- **操作被拒绝**：定时任务触发的运行处于无人值守状态，任何需要弹窗确认的操作都会被直接拒绝。请根据任务需要将其权限设为「自动编辑」或「智能」（详见 [定时任务](schedule.md)）。
