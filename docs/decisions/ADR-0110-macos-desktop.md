# ADR-0110：macOS 桌面端一期（Apple Silicon）

- 状态：已接受
- 日期：2026-11-22
- 修订：[ADR-0046](ADR-0046-desktop-tauri.md)「第一版不包含……macOS/Linux 安装包」一句（macOS Apple Silicon 安装包按本 ADR 提供，Linux 不变）；[ADR-0050](ADR-0050-distribution.md) 第 1 节「平台」与第 4 节发布流水线（新增 macOS 桌面端构建任务）
- 相关：[ADR-0056](ADR-0056-session-notifications.md)（系统通知）、[ADR-0060](ADR-0060-desktop-side-panel.md)（右侧面板、终端、浏览器）、[ADR-0070](ADR-0070-steer-and-queue-input.md)（关闭窗口时的待发输入确认）、[ADR-0078](ADR-0078-browser-settings.md)（浏览数据）、[ADR-0104](ADR-0104-orphan-process-watchdog.md)（孤儿进程看门狗）

## 背景

桌面端到目前只在 Windows 上构建和验收过：

- `scripts/fetch-node.mjs` 只下载 `win-x64.zip`；
- `scripts/fetch-computer.mjs` 在非 Windows 平台直接抛错，而它挂在 `tauri.conf.json` 的 `beforeDevCommand` 和 `beforeBuildCommand` 上；
- `bundle.targets` 只有 `nsis`，`bundle.resources` 写死了 `node/node.exe`；
- `release.yml` 只在 `windows-latest` 上构建桌面端，`macos-latest` 只跑 tgz 安装冒烟；`ci.yml` 没有 macOS 任务。

Rust 外壳里很多平台相关代码只有 `cfg(windows)` 实现，非 Windows 分支直接返回 `unsupported` 或空实现。主要有：

- 系统通知；
- 终端剪贴板读写；
- 下载另存为；
- 文件「打开方式」应用列表；
- 清除浏览数据；
- 模型操控的面板浏览器（`agent_browser`）；
- 电脑操控。

维护者没有 Mac。能用的 macOS 环境只有 GitHub Actions 的 `macos-latest` 构建机，以及用于一次性实机验收的云端 macOS（Devin）。

## 决定

### 1. 目标平台

- 只支持 Apple Silicon（`aarch64-apple-darwin`），不出 Intel 包，也不出通用包。
- 最低系统版本为 macOS 14。理由见第 5 节：WKWebView 没有 `data_directory`，独立数据存储 `WKWebsiteDataStore(forIdentifier:)` 要 macOS 14 起才有。低于 14 时 wry 会退回默认存储，网页标签就会和主界面共用一份数据。
- 不做 Apple 开发者签名，也不做公证，只用 ad-hoc 签名。

### 2. 打包

- 新增 `apps/desktop/src-tauri/tauri.macos.conf.json`，由 Tauri 在 macOS 上自动合并。它包含：
  - `bundle.targets: ["app", "dmg"]`；
  - `bundle.macOS.signingIdentity` 设为 ad-hoc 签名所需的取值；
  - `bundle.macOS.minimumSystemVersion: "14.0"`；
  - 主窗口改用系统标题栏按钮（见第 4 节）。
- 保留 Windows 的逐文件映射。macOS 配置用 JSON Merge Patch 的 `null` 移除 `resources/node/node.exe`、`resources/computer/`，新增 `resources/node/node`；不映射整个 Node 目录，以免带入本地校验标记。
- 随附 Node 使用官方 `darwin-arm64` 压缩包，版本与 Windows 相同。`node-version.json` 改为按平台记录 `url` 与 `sha256`，哈希取自 nodejs.org 对应版本的 `SHASUMS256.txt`。
- 电脑操控驱动一期不随附。`fetch-computer.mjs` 在 macOS 上跳过并输出一行说明，`resources/computer/` 映射只在 Windows 配置里保留。

### 3. 更新与发布

- macOS 更新包是 Tauri 生成的 `.app.tar.gz` 及其 `.sig`，使用现有的 updater 私钥签名。在 `latest.json` 里登记为 `darwin-aarch64` 平台。
- 发布资产新增两个文件：
  - `Nocturne_<版本>_aarch64.dmg`，供首次安装；
  - `Nocturne_<版本>_aarch64.app.tar.gz`，即更新包，`.sig` 随附。
- `release.yml` 新增 macOS 任务，排在 tgz 冒烟之后、安卓之前，避免多个任务同时改草稿说明。任务步骤：
  1. 在 `macos-latest` 上构建；
  2. 启动冒烟（第 8 节）；
  3. 上传 dmg 和更新包；
  4. 把 `darwin-aarch64` 一项合并进草稿里的 `latest.json`，覆盖上传；
  5. 在说明里追加结果行。
- macOS 任务失败时：
  - `latest.json` 不含 `darwin-aarch64`，已安装 macOS 版的用户收不到这一版更新；
  - Windows 资产与更新不受影响；
  - 说明里写「macOS 桌面端：构建失败」。
- 收集产物、生成平台条目、合并 `latest.json` 的逻辑写在脚本里，分支 workflow（第 8 节）跑的是同一段代码。没有签名私钥时也要能走完，只是不生成 `.sig`、不产出平台条目。签名私钥只出现在 `release.yml`。
- 第一个附带 macOS 安装包的正式版本，以第 9 节实机验收通过为前提。在那之前，`release.yml` 的 macOS 任务照常构建，但不上传资产、不改 `latest.json`。仓库变量 `RELEASE_MACOS_DESKTOP` 取值 `true` 时才附带。没有 updater 私钥时只关闭 `createUpdaterArtifacts`，由脚本归档 ad-hoc 签名后的 `.app`；不使用会同时跳过应用签名的 `--no-sign`。

### 4. 窗口与快捷键

- **标题栏**：macOS 上主窗口使用 `decorations: true`、`titleBarStyle: "Overlay"`、`hiddenTitle: true`、`trafficLightPosition: { x: 16, y: 24 }`（匹配 40px 标题栏高度，使系统按钮垂直居中）：
  - 左上角显示系统的红黄绿按钮；
  - 隐藏前端自绘的最小化、最大化、关闭按钮；
  - 品牌区左侧预留 84px 给系统按钮让位，面板停靠占位不再扣除右侧自绘按钮宽度（138px）。
  - Windows 外观不变。
- **主修饰键**：前端只用一处判断平台（`apps/desktop/src/platform.ts`，`navigator.userAgent` 含 `Macintosh`，支持测试注入）。规则如下：
  - Windows 上用 `Ctrl` 的应用快捷键，在 macOS 上一律改用 `Cmd`。
  - `Ctrl` 加字母在 macOS 上不再被应用占用，原样交给终端和输入框。这保证 `Ctrl+C`、`Ctrl+B` 这类终端控制键可用；`Ctrl+Alt+Esc`（停止电脑操控）在 macOS 上不注册。
  - 面板终端：有选区时 `Cmd+C` 复制；`Cmd+V` 粘贴。
  - 界面上的快捷键提示（`<Kbd>`）显示为 `⌘`、`⇧`、`⌥`、`⌃`。
- **菜单与退出**：Tauri 默认应用菜单里的 `PredefinedMenuItem::quit` 直接映射到 AppKit `terminate:`，触发 `applicationWillTerminate` → `RunEvent::Exit`，绕过可阻止的 `ExitRequested` / `CloseRequested`，拦截不住待发输入确认。因此 macOS 上由外壳自建中文应用菜单替换默认菜单：应用子菜单含关于 Nocturne、隐藏 Nocturne、隐藏其他、全部显示、分隔线与自定义「退出 Nocturne」（快捷键 `Cmd+Q`，在 `on_menu_event` 中接入 `request_close`，与点红色关闭按钮走同一条关闭确认流程，见 ADR-0070）；编辑子菜单保留预定义项（撤销、重做、分隔线、剪切、复制、粘贴、全选）以保障输入框 `Cmd+C/V/X/A/Z` 可用；窗口子菜单含最小化、缩放。
- **关闭行为**：关闭窗口即退出应用，与 Windows 一致，一期不做「关窗后留在 Dock」。

### 5. 网页数据隔离

- `data_directory` 在 WKWebView 上不生效。wry 0.57.0 在 macOS 上只认 `data_store_identifier`：macOS 14 起使用 `dataStoreForIdentifier`，否则退回 `defaultDataStore`。
- macOS 上，用户浏览使用固定的 16 字节标识；为 agent 浏览独立预留另一个标识（一期不创建 agent webview）。两个标识由外壳写死在 `browser_policy` 里；主界面使用默认存储。设了 `WEBVIEW2_USER_DATA_FOLDER` 时的隔离环境：
  - 不能挪动存储位置；
  - 改为由该路径派生两个不同的标识，与正式环境的标识也不同。
- 清除浏览数据：wry 0.57.0 的 `clear_all_browsing_data`（`src/wkwebview/mod.rs:832-842`）在 macOS 上向 `removeDataOfTypes:modifiedSince:completionHandler:` 传入空回调块后立即返回，不等实际删除完成。外壳改为临时建一个挂到对应 `data_store_identifier`（用户浏览、agent 浏览各自使用 `browser_policy` 里的标识）的隐藏子 webview，经 `Webview::with_webview` 在主线程取得 `WKWebView` 的 `configuration().websiteDataStore()`，直接调用 `removeDataOfTypes:modifiedSince:completionHandler:`（`allWebsiteDataTypes`、`NSDate::distantPast()`），等完成回调后再经 `browser::close_later` 关掉临时 webview。只作用于这一份存储，另一份和主界面不受影响。
- macOS 上拿不到这两份存储的占用大小，设置页不显示大小，只保留「清除」（`browser_data_sizes` 与 `browser_data_clear` 均返回 `0`）。

### 6. 登录 shell 环境

从访达或程序坞启动的应用，`PATH` 只有系统默认的几项，看不到 Homebrew、nvm 等装的命令。外壳启动时在后台线程运行一次用户的登录 shell（`$SHELL`，缺省 `/bin/zsh`，用登录交互模式），读取 `PATH`：

- 输出前后加标记行，只取标记之间的内容，忽略 shell 配置打印的其他内容；
- 超时 10 秒；
- 失败时在系统默认 `PATH` 前补 `/opt/homebrew/bin`、`/usr/local/bin`，并在外壳日志记一行；
- 结果用于启动后台和面板终端，不改外壳进程自身的环境；
- Windows 不做这一步。

### 7. 一期功能范围

**本期移植，分两轮实现：**

| 功能 | macOS 实现 | 轮次 |
|---|---|---|
| 终端剪贴板读写 | 系统自带 `pbpaste` / `pbcopy`，文本经 stdin/stdout | 第一轮 |
| 下载另存为 | `rfd` 的 macOS 保存对话框（下载回调已是跨平台的 `on_download`） | 第一轮 |
| 面板终端 shell | Core 的 `runtime.listShells` 不包含 `zsh`，一期不改 Core：外壳新增 `terminal_login_shell` 命令返回登录 shell（`$SHELL` 在 `/etc/shells` 内时采用，否则 `/bin/zsh`），前端 `TerminalPane` 将其置为下拉第一项并默认打开，后面接 Core 列出的 shell（macOS 白名单放行 `zsh` / `bash` / `sh` / `fish`）；`validate_shell` 在 Unix 上接受 `/etc/shells` 中的绝对路径，`zsh` / `bash` / `fish` 用 `-l -i`，`sh` 用 `-i` | 第一轮 |
| 网页数据隔离与清除 | 隔离见第 5 节；清除时临时建隐藏子 webview 挂到用户/agent 各自 `data_store_identifier`，经 `with_webview` 调 `WKWebsiteDataStore::removeDataOfTypes:modifiedSince:completionHandler:` 等完成回调后再经 `close_later` 关掉，前端不显示大小仅保留「清除」 | 第一轮（隔离）、第二轮（清除） |
| 系统通知 | `UNUserNotificationCenter`（`objc2-user-notifications`）：启动时先检查 `NSBundle::mainBundle().bundleIdentifier()`，为空时不调用系统接口并返回 `unsupported`；有 bundle 时注册常驻 `UNUserNotificationCenterDelegate`；`notify_show` 异步查询 `getNotificationSettingsWithCompletionHandler:`（未决定时请求 `Alert \| Sound` 授权且不阻塞主线程，拒绝或通知面全关返回 `disabled`，查询失败照发）；同一会话沿用 `toast_id` 64 字符截断标识就地替换；前台展示回调返回 `Banner \| List`（`sound = true` 时加 `Sound`）；点击回调（默认动作）从请求标识还原会话 id，调 `unminimize` + `set_focus` 后发 `notify-activated`；`notify_dismiss` 同时移除已送达和待送达通知 | 第二轮 |
| 文件「打开方式」 | `NSWorkspace`（`objc2-app-kit`）：`URLsForApplicationsToOpenURL:` 与 `URLForApplicationToOpenURL:` 枚举应用（键为应用包路径，默认排第一），`NSFileManager::displayNameAtPath:` 取本地化显示名，`iconForFile:` + CoreGraphics `CGBitmapContextCreate` 转 32×32 PNG data URL；打开时按 `id` 重新枚举并走 `openURLs:withApplicationAtURL:configuration:completionHandler:`；通过 `NSBundle::bundleIdentifier` 识别 VS Code（`com.microsoft.VSCode`）与 Cursor（`com.todesktop.230313mzl4w4u92`），配合 `find_editor`（PATH、`/opt/homebrew/bin`、`/usr/local/bin` 与包内 `Contents/Resources/app/bin/<cmd>`）走 `-g file:line` 并取两应用包图标作兜底；防误运行拦截 `.command` / `.tool` / `.terminal`、`.app` / `.pkg` / `.mpkg`、`.workflow` / `.action` 与带可执行位且非已知文本文档名的无扩展名文件（`open_with_default` 改为在访达中显示返回 `Revealed`）；前端界面文案改「访达」/「在访达中显示」 | 第二轮 |

Tauri 自带的通知插件在桌面端没有点击回调（见 `notify.rs` 文件头），满足不了 ADR-0056 的「点通知切到会话」，所以要直接调系统接口。

**本期不可用：**

- 模型操控的面板浏览器、电脑操控，在 macOS 上不出现：
  - 外壳不向后台传对应的启动凭证，Core 不注册相关工具，模型看不到；
  - 设置里对应的分组在 macOS 上隐藏；
  - 二期另立 ADR。

### 8. 持续集成

新增 `.github/workflows/macos.yml`。触发条件：推送 `main`、推送 `macos/**` 分支、手动触发。它与 `ci.yml` 相互独立，失败不影响 Windows 检查。包含两个任务：

- **测试**：`pnpm build` 后，跑 `packages/core`、`packages/rpc`、`packages/mcp`、`apps/cli`、`apps/tui` 的 vitest。
  - 只在 Windows 上成立的测试，用 `skipIf` 跳过并写明原因；
  - 其余失败按平台缺陷修复。
- **桌面端**：
  1. 取随附 Node；
  2. `cargo test`；
  3. `tauri build`（产出 `.app` 和 `.dmg`，无签名私钥）；
  4. 启动冒烟：
     - 用临时 `NOCTURNE_HOME` 启动 `.app` 里的可执行文件；
     - 20 秒后进程仍在，且有随附 Node 的子进程；
     - 尝试截一张屏幕截图，作为 workflow 产物上传（截不到不算失败，记一行）；
     - 再 `kill -9` 外壳，10 秒内 Node 子进程应退出；
  5. dmg 作为 workflow 产物上传，保留 7 天。

`release.yml` 的 macOS 任务复用同一个冒烟脚本。

### 9. 实机验收

以下项目在构建机上验证不了，第一个附带 macOS 安装包的版本发布前，在实机（Devin 或真机）上逐项确认：

1. 从浏览器下载 dmg 后，首次打开弹什么提示、怎样放行。验证前，用户文档不写放行方法。
2. 标题栏、系统按钮、快捷键、输入框复制粘贴、`Cmd+Q` 退出确认。
3. 面板终端打开 zsh，能找到 Homebrew 装的命令。
4. 网页标签登录状态与主界面互不影响；清除后只清这一份。
5. 系统通知首次授权、点击切会话、同会话替换、切过去后移除。
6. 自动更新：旧版检测到新版，下载、替换后能直接启动；通知授权在更新后仍在。

### 10. 文档

- 实现时同步更新内部文档：本 ADR、ADR-0046 与 ADR-0050 的修订说明、`docs/apps/desktop.md` 的平台差异、`docs/development/workflow.md` 的发布流程（打标签前等哪几条 workflow；发布核对加上「附带 macOS 时 `latest.json` 含 `darwin-aarch64`」）。
- 用户文档（`site-docs/index.md`、`README.md`、主页下载入口）在第一个附带 macOS 安装包的版本里一并更新。主页会在推送 `main` 时部署，提前更新会让下载链接指向不存在的文件。

## 影响

- 发布门槛是 macOS CI 通过并完成第 9 节实机验收；通过前不对外提供下载。
- 发布流水线变长：macOS 任务串在冒烟与安卓之间。
- 没有开发者签名，用户首次打开要手动放行，具体步骤待实机确认。
- 平台代码分支增多。macOS 分支只能靠 `macos.yml` 编译和冒烟，本机无法验证；改动 macOS 分支时必须让该 workflow 通过。

## 不做

- Intel 与通用包。
- 开发者签名、公证、Mac App Store。
- 关窗留在 Dock、菜单栏图标、Touch Bar。
- 面板浏览器、电脑操控（二期）。
- Linux 桌面包。
