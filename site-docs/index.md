# 安装

## Node.js 版本要求

桌面端和终端版都需要本机安装 **Node.js 24.0.0 或更高版本**（推荐 `24.14.1` LTS）。

在终端运行以下命令检查当前版本：

```bash
node --version
```

若未安装或版本低于 `v24.0.0`，请前往 [nodejs.org](https://nodejs.org/) 下载 Node.js 24 LTS，或使用 `fnm`、`nvm`、`volta` 安装。桌面端启动时若未检测到符合要求的版本，会显示「需要安装 Node.js 24 或更高版本」并提供「下载 Node.js 24 LTS (v24.14.1)」按钮，安装完成后点击「重新检测」即可进入应用。

## 桌面端安装

前往 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases/latest) 下载当前版本（`v{{version}}`）对应系统的安装包：

| 系统 | 安装包 | 说明 |
| --- | --- | --- |
| Windows (x64) | `Nocturne_{{version}}_x64-setup.exe` | 双击运行，按当前用户安装，无需管理员权限 |
| macOS | `.dmg` | 打开映像后将 Nocturne 拖入「应用程序」 |
| Linux | `.AppImage` / `.deb` | 赋予执行权限直接运行，或用 `dpkg -i` 安装 |

### 系统拦截处理

安装包未购买商业代码签名证书，首次运行遇到系统拦截时按以下方式放行：

- **Windows SmartScreen**：弹出「Windows 已保护你的电脑」时，点击「更多信息」→「仍要运行」。
- **macOS Gatekeeper**：提示无法验证开发者时，在访达中按住 `Control` 点击应用选择「打开」，或在「系统设置 → 隐私与安全性」底部点击「仍要打开」。

## 终端版安装

终端版包含全屏 TUI（`nocturne`）、单次执行命令行以及 MCP 桥接进程（`nocturne-mcp`）。

通过 npm 或 pnpm 全局安装：

```bash
npm install -g @nocturne-ai/cli
# 或
pnpm add -g @nocturne-ai/cli
```

也可以从 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases/latest) 下载离线包安装：

```bash
npm install -g ./nctrn-{{version}}.tgz
```

安装完成后运行 `nocturne --version` 验证。

## 升级

### 桌面端升级

桌面端启动后会自动在后台检查更新：

1. 发现新版本时，左侧边栏底部会显示「更新至 v…」，点击即可在后台下载更新包。
2. 下载完成后按钮变为「重启更新至 v…」，点击即可完成替换并重启。
3. 你也可以随时打开「设置 → 通用」，在「更新」区域点击「检查更新」。

### 终端版升级

重新执行全局安装命令即可更新到最新版本：

```bash
npm install -g @nocturne-ai/cli@latest
```
