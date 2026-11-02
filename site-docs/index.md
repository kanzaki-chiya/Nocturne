# 安装

Nocturne 提供 Windows 桌面端和终端命令行 `nctrn`。两者共用本地的 `~/.nocturne` 目录（可通过环境变量 `NOCTURNE_HOME` 修改），会话、服务商和权限配置互通。

## 桌面端（Windows x64）

1. 前往 [GitHub Releases](https://github.com/kanzaki-chiya/Nocturne/releases) 下载 `Nocturne_{{version}}_x64-setup.exe`（或直接下载 [v{{version}} 安装包](https://github.com/kanzaki-chiya/Nocturne/releases/download/v{{version}}/Nocturne_{{version}}_x64-setup.exe)）。
2. 双击运行安装程序。安装包内置了 Node.js 运行时，按当前用户安装，不需要管理员权限，也不需要单独安装 Node.js。
3. 安装包暂未做代码签名。如果 Windows SmartScreen 弹出拦截提示，点击「更多信息」→「仍要运行」。

### 升级桌面端

桌面端默认开启自动检查更新，启动后每 24 小时检查一次新版本。发现新版本时，主窗口底部会显示提示条，点击「立即更新」即可下载并安装；如果当时有正在运行的会话，会先弹出确认框，点击「继续更新」后关闭窗口完成升级并自动重启。

你也可以点左栏底部「设置」，在「常规」页的「更新」分组中切换「自动检查更新」开关，或点击「检查更新」立即手动检查；也可以直接下载新版 `Nocturne_{{version}}_x64-setup.exe` 覆盖安装。

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
