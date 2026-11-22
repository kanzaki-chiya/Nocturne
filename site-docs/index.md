# 安装

Nocturne 提供桌面端（Windows x64、macOS Apple Silicon）和终端命令行 `nctrn`。两者共用本地的 `~/.nocturne` 目录（可通过环境变量 `NOCTURNE_HOME` 修改），会话、服务商和权限配置互通。

## 桌面端（Windows x64）

1. 前往 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases) 下载 `Nocturne_{{version}}_x64-setup.exe`（或直接下载 [v{{version}} 安装包](https://github.com/kanzaki-chiya/Nocturne/releases/download/v{{version}}/Nocturne_{{version}}_x64-setup.exe)）。
2. 双击运行安装程序。安装包内置了 Node.js 运行时，按当前用户安装，不需要管理员权限，也不需要单独安装 Node.js。
3. 安装包暂未做代码签名。如果 Windows SmartScreen 弹出拦截提示，点击「更多信息」→「仍要运行」。

## 桌面端（macOS Apple Silicon）

需要 macOS 14 或更新，Apple 芯片（M 系列）。

1. 前往 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases) 下载 `Nocturne_{{version}}_aarch64.dmg`（或直接下载 [v{{version}} 安装包](https://github.com/kanzaki-chiya/Nocturne/releases/download/v{{version}}/Nocturne_{{version}}_aarch64.dmg)）。
2. 打开 dmg，把 Nocturne 拖进「应用程序」。安装包内置了 Node.js 运行时，不需要单独安装 Node.js。
3. 安装包没有 Apple 开发者签名。第一次打开时系统提示无法验证、没有打开，到「系统设置 › 隐私与安全性」页面底部点「仍要打开」，再确认一次即可。

macOS 版暂不提供「模型操作网页」（Agent 浏览器）和「电脑操控」。

再次打开桌面端时，侧栏会立即显示上次的会话列表，后台连上后自动更新。此时点击会话会在连接完成后自动打开。

### 升级桌面端

桌面端默认开启自动检查更新，启动后每 24 小时检查一次新版本。发现新版本时会弹出更新窗口，列出从当前版本到最新版本之间每个版本的更新日志，点击「立即更新」即可下载并安装；如果当时有正在运行的会话，会在弹窗内先确认是否中断会话，点击「继续更新」后关闭窗口完成升级并自动重启。

你也可以点左栏底部「设置」，在「常规」页的「更新」分组中切换「自动检查更新」开关，或点击「检查更新」立即手动检查；也可以直接下载新版安装包覆盖安装（Windows 运行 `Nocturne_{{version}}_x64-setup.exe`，macOS 把新的 Nocturne 拖进「应用程序」替换）。

## 终端命令行（`nctrn`）

命令行版需要 **Node.js `>=24.16`**。

1. 从 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases) 下载 [nctrn-{{version}}.tgz](https://github.com/kanzaki-chiya/Nocturne/releases/download/v{{version}}/nctrn-{{version}}.tgz)。
2. 在下载目录全局安装：

```sh
npm install -g ./nctrn-{{version}}.tgz
```

3. 验证安装并配置服务商：

```sh
nctrn --version
nctrn setup
```

### 升级命令行

下载新版本的 `nctrn-{{version}}.tgz` 后，再次运行 `npm install -g ./nctrn-{{version}}.tgz` 即可覆盖升级。

下一步见 [连接服务商](providers.md)。
