# 安卓 App

> 状态：外壳、后台保持连接、本地通知、扫码与版本检查已实现｜决策：[ADR-0059](../decisions/ADR-0059-android-app.md)｜实现：`apps/android`

`apps/android` 是 Tauri 2 的安卓工程，把[手机网页](desktop.md#8-手机网页)随 APK 安装：WebView 只加载打包进 APK 的页面，页面代码不再由中继下发。界面、加密通道、RPC 客户端与会话视图全部复用 `apps/desktop/src/web`，App 只补平台差异。App 含会话本地通知、原生扫码配对、版本检查与系统下载管理器下载；拍照发送沿用网页文件输入。Release 流水线已有正式签名与 APK 附件，App 不自动安装更新。

文件附件与自由回答附件复用网页实现（[ADR-0072](../decisions/ADR-0072-file-attachments.md)）：选择任意文件、粘贴／拖入文件、32 KiB 大段粘贴转卡片；发送前检查远程合计原始字节上限，超限保留草稿。对话文件卡片经 `readAttachment` 下载；WebView 下载受宿主沙箱限制时仍可查看名称与大小。

会话页复用手机网页的[右侧侧边栏](../decisions/ADR-0084-phone-side-panel.md)与图片查看器：同步与后台子代理都可只读观察，后台子代理只在子视图取消；图片查看器打开时 Android 返回键先关闭查看器，侧边栏打开时返回先回总览再关闭侧边栏。因 Android System WebView 未注册 Chromium `ImageFileProvider` 且不支持无原生桥接的 `blob:` 下载，App 通过 `PhonePlatform.imageViewer` 隐藏图片查看器的「复制」与「下载」按钮。结果卡片与待发结果行为沿用 [ADR-0073](../decisions/ADR-0073-background-subagents.md) §6；远程接口边界见 [rpc.md](../protocols/rpc.md) §4.1、§7。

## 1. 工程结构

| 路径 | 内容 |
|---|---|
| `index.html`、`vite.config.ts` | App 专属的网页入口，构建到 `dist/`。不带网页版的 service worker、manifest 与 `public-web` |
| `src/main.tsx` | 入口：把 `PhoneApp` 与 `appPlatform(tauriHost)` 接起来，启动探针 |
| `src/host.ts` | `AppHost`：与网页的 `WebHost` 并列的宿主接口，及经 Tauri 调 Kotlin 插件的实现 |
| `src/platform.tsx` | `PhonePlatform` 实现：中继地址取自配对链接、信任说明、「后台保持连接」与「通知」设置区块、「后台探针」页 |
| `src/update.ts`、`src/update-ui.tsx` | 可注入 fetch、时钟与存储的双来源版本检查，以及关于行、首页提示条与不兼容下载入口 |
| `src-tauri/gen/android/app/src/main/java/.../remote/ScanActivity.kt`、`DownloadUrls.kt`、`CameraPermissionClient.kt` | 无 Play 服务依赖的 QR 预览、APK 下载地址白名单，以及拍照授权后重新进入原文件选择处理器 |
| `src/background.ts` | 后台控制器：开关、前台服务启停、常驻通知文案、把连接状态交给探针 |
| `src/probe.ts` | 探针日志与摘要、纯文本导出 |
| `src-tauri/src/lib.rs` | Rust 外壳：窗口与导航锁 |
| `src-tauri/src/background.rs` | 内联插件 `background`：只有一个 `call` 命令，按白名单转发给 Kotlin |
| `src-tauri/gen/android/` | `tauri android init` 生成并提交的 Gradle 工程；`app/src/main/java/.../remote/` 下的 `MainActivity`、`BackgroundPlugin`、`KeepAliveService`、`GuardedWebViewClient`、`NativeLog` 是我们自己的 Kotlin，`generated/` 由 Tauri 生成、不提交 |

网页入口的依赖图里没有任何 App 代码，App 入口的依赖图里没有 service worker、Web Push 与桌面外壳；由 depcheck 的 `android-*` 规则与 `desktop-no-other-workspace` 强制（[模块边界](../architecture/modules.md)）。网页专属的 `browser-push.ts` 只被网页入口 `main.tsx` 引用，`PhoneApp` 的 `push` 由入口注入，App 不传则没有推送区块。

## 2. 构建与运行

需要 JDK 21、Android SDK（含 NDK 27）、Rust 与对应的 Android 目标。系统的 `JAVA_HOME` 如果不是 JDK 21，**只在命令里临时设置，不要改系统或用户环境变量**：

PowerShell：

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\27.0.12077973"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
rustup target add aarch64-linux-android x86_64-linux-android   # 真机 / 模拟器
pnpm android:build            # 真机 debug APK（aarch64）
pnpm android:build:emulator   # 模拟器 debug APK（x86_64）
pnpm android:dev              # 连着设备或模拟器的开发模式（Vite 热更新）
```

Git Bash 同理，用 `export JAVA_HOME=...`。产物在 `apps/android/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。模拟器命令为 `pnpm android:build:emulator` 与 `pnpm android:build:release:emulator`。

本地验收可在单条命令的进程环境中设置 `ORG_GRADLE_PROJECT_nocturneVerification=true`：构建跳过正式签名配置的读取，application ID 附加 `.verification`，与已安装 App 的数据隔离；release 产物未签名，需用 SDK 的 debug keystore 和 apksigner 自签后安装，仅用于 R8 验收。该开关不用于发布，也不写入用户或系统环境。

正式包：`pnpm android:build:release`，产物在 `.../apk/universal/release/app-universal-release.apk`。签名读 `src-tauri/gen/android/keystore.properties`（已被 gitignore，字段 `storeFile`、`storePassword`、`keyAlias`、`keyPassword`）；没有这个文件时构建未签名包。发布时 `release.yml` 的 `android` 任务从 secrets 写入该文件，把 `nocturne-<version>.apk` 附到草稿，见 [workflow.md](../development/workflow.md#81-常规发布顺序)。

手机端页面有错误边界：渲染抛错时保留顶栏并显示错误。App 可能比电脑上的后台旧，确认卡片跳过不认识的选项。

- `tauri.conf.json` 的 `frontendDist` 是 `../dist`；`Cargo.toml` 的 `custom-protocol` feature 必须存在，`tauri build` 才会让 WebView 用打包的页面而不是 `devUrl`。
- Android 15+ 的 16 KB 页面设备要求原生库按 16 KB 对齐，`build.rs` 对安卓目标加 `-Wl,-z,max-page-size=16384`（NDK 27 默认 4 KB，设备会弹「不兼容 16 KB」警告）。
- `minSdk` 为 26：包装 wry 的 WebViewClient 需要 `WebView.getWebViewClient()`（API 26）。
- Rust 单元测试：`cargo test --lib --manifest-path apps/android/src-tauri/Cargo.toml`（桌面目标，不含安卓专属代码；手动跑，不进默认测试集）。

## 3. 与网页版的差异

| | 网页版 | App |
|---|---|---|
| 页面来源 | 中继托管，每次打开可能被替换 | 随 APK 安装，签名保护 |
| 页面源 | 中继的 `publicOrigin` | 固定的 `http://tauri.localhost`（中继的 [Origin 允许表](../protocols/relay.md#origin-允许表)） |
| 中继地址 | 当前页面源 | 配对链接里的地址，随电脑记录保存（`PairedHost.origin`），同一个 App 可连任何中继；链接必须带中继地址，只接受 https 与本机 `http://127.0.0.1` |
| 手机身份 | WebView IndexedDB 里不可导出的 `CryptoKey` | 同左，在 App 私有数据里，不经 Kotlin |
| 推送 | service worker + Web Push | 会话事件本地通知，不依赖 Web Push |
| 后台 | 页面隐藏后连接被系统挂起，回前台再连 | 「后台保持连接」打开时由前台服务保活，WebView 继续持有通道与订阅 |
| 配对 | 打开或粘贴配对链接 | 扫码或粘贴，均经链接校验并进入确认页；拒绝相机权限后可打开系统设置 |
| 版本检查 | 由中继下发网页 | GitHub 与当前电脑双来源，设置页手动检查，首页可关闭的新版本提示 |
| 外链 | 新标签打开 | `on_navigation` 仍只允许 App 源；仅 APK 下载经 `download_apk` 交给系统 `DownloadManager`（不可用时回退 `ACTION_VIEW`），原生只接受本仓库 Release 下载前缀下匹配版本的 HTTPS APK |
| 能力边界 | 白名单 | 不变，App 不改 RPC 白名单 |

共享层的扩展点是 `PhonePlatform`（`apps/desktop/src/web/platform.ts`）：`relay`（`page` / `link`）、`keepConnected`、`observer`（已配对电脑、连接状态、断线、会话事件、生效主题）、`onForeground`（回到前台）、`imageViewer`（图片查看器可用操作，App 设为 `{ copy: false, download: false }`）、`trustText`（只在设置页「关于」完整显示，配对页只留一句指路）、`pairHint`、`background` / `diagnostics`（设置页区块）与 `pages`（App 自己的页面）。网页入口不传即为 `{ relay: "page" }`，行为不变。App 按 `observer.theme` 的实际生效主题调 `set_system_bars` 同步状态栏与导航栏图标深浅。

### 扫码、相机权限与更新

扫码使用 ZXing Android Embedded 4.3.0（Apache-2.0，默认 API 24+；工程 minSdk 26），不依赖 Google Play 服务，不带原生 `.so`。`ScanActivity` 是竖屏全屏相机预览，只显示取景框与返回图标（`contentDescription = "返回"`，并通过 `ViewCompat.setOnApplyWindowInsetsListener` 叠加 `displayCutout` 的左、上安全边距），只识别 QR，成功立即返回；取消静默，拒绝权限显示「没有相机权限」与「打开系统设置」（点按打开系统设置不清掉错误，仅在再次扫码成功或取消、或离开配对页时清除）。Manifest 声明 CAMERA 与 required=false 的 camera feature，按使用时申请。拍照继续由 `PhoneComposer` 文件输入和生成的 `RustWebChromeClient` 处理；App 的 `CameraPermissionClient` 在调用原处理器前完成 capture 授权，防止首次授权后仍用授权前的状态回退到选图页，拒绝时取消文件回调。Manifest 的 `queries` 声明 IMAGE_CAPTURE，供原处理器解析系统相机。生成文件保持原样。

`update.ts` 只认正式 `x.y.z`；GitHub 标签可带 `v`，必须有 `nocturne-<version>.apk` 资产且非预发布、非草稿。每次成功 initialize 比较电脑的 `nocturneVersion`：若电脑版本比 APP_VERSION 新且比已知 GitHub 版本新，则请求 `releases/tags/v<version>` 确认对应 Release 存在 APK（请求进行中暂不计入比较；确认存在则本次运行不再请求，确认不存在则不计入比较且 1 小时内不再请求，网络错误、403/5xx 或响应格式错误等无法确认时仍计入比较以保证 GitHub 不通时可用，且下次连接会重试）。两个来源取比 APP_VERSION 新的较大值。启动与原生回前台检查 GitHub，成功结果与时间存手机本地，24 小时内不重复；失败静默且不记时间。手动检查绕过节流并重新确认电脑版本，等两个请求都结束才离开检查中状态，设置 › 关于显示检查中、已是最新、下载或重试。首页提示按关闭版本记住，更高版本再显示；关于与不兼容状态的下载不受关闭影响。

电脑协议较新时显示「App 版本过旧」，有已知正式新版本时提供下载。连接进入 `connecting` 时 `appPlatform` 会先 `update.computer(undefined)` 清空上一台电脑的版本；而真实 RPC 客户端在 `result.protocolVersion !== RPC_PROTOCOL_VERSION` 时直接抛 `protocol_version_mismatch`，不会把 `InitializeResult` 返回给 `PhoneConnection`，因此真实 RPC 走不兼容分支时电脑版本已被清空且拿不到当次握手版本，下载按钮只能来自 GitHub 检查结果（无 GitHub 结果则不显示下载按钮）。下载地址固定为 `https://github.com/kanzaki-chiya/Nocturne/releases/download/v<version>/nocturne-<version>.apk`，原生验证后交系统 `DownloadManager` 写入公共 `Download/nocturne-<version>.apk`（API 29 以下使用下载管理器默认位置；同一 URL 已有 `PENDING`/`RUNNING`/`PAUSED` 任务时不重复入队；下载管理器不可用或入队失败时回退 `ACTION_VIEW`），由用户点系统下载完成通知安装；不放宽 WebView 导航，不申请 REQUEST_INSTALL_PACKAGES。

共享扩展点新增 `scanPairing`、`openAppSettings`、`initialized`、`versionMessage` 及更新 UI 挂载点；App 通过 `updateLifecycle` 管理启动、前台检查与退订，网页版入口不注入这些字段。

## 4. 后台保持连接

**前台服务**（`KeepAliveService`）只负责让进程不被回收；连接、加密与订阅仍在 WebView 里，服务本身不联网、不持有密钥。

- 启动条件：已配对至少一台电脑且「后台保持连接」打开（设置页，默认开）。关闭或移除最后一台电脑则停止，行为回到网页版。用户划掉 App 时（Activity 结束）服务随之停止，避免通知谎称「已连接」。
- 常驻通知文案：标题保持 `Nocturne 远程：已连接 <电脑名>`，未连上为 `Nocturne 远程：正在连接…`，渲染进程丢失且 App 在后台时为 `Nocturne 远程：连接已中断，点按重新打开`；命中具体会话时正文设为会话名（与本地通知 `sessionTitle` 一致）并采用 `BigTextStyle`。通知渠道「后台保持连接」为低优先级，有目标会话时点按直接打开该会话（复用 `notificationTarget`），否则回到 App 首页；同一内容去抖不重复 `notify`。
- **Android 16 Live Updates（小米超级岛）**：清单声明 `POST_PROMOTED_NOTIFICATIONS`，SDK ≥ 36 时按状态在 `Notification.Builder` 上调用 `setRequestPromotedOngoing(true/false)` 与 `setShortCriticalText`（依据：ChatGPT 安卓版 1.2026.307 的 `CodexRemoteSessionForegroundService` 在 HyperOS 3.0 上仅靠 `POST_PROMOTED_NOTIFICATIONS`、`IMPORTANCE_LOW` 常驻通知与这两个标准 API 即能上超级岛，无私有字段、未用 `CallStyle`）。按优先级取当前连接电脑上最高的一项：

| 情况 | `shortCriticalText` | 请求上岛 |
|---|---|---|
| 有会话等待确认（权限或提问） | 待确认 | 是 |
| 有会话出错停止且用户还没看 | 出错 | 是 |
| 有会话完成且用户还没看 | 已完成 | 是 |
| 有会话正在运行 | 运行中 | 是 |
| 连接状态 `connecting` | 正在连接 | 是 |
| 连接状态 `offline` | 电脑离线 | 是 |
| 已连接且以上都没有 | 不设置 | 否（`setRequestPromotedOngoing(false)`） |

  「出错 / 已完成」的未看语义与桌面侧栏 `rowTag` 一致：没在看该会话时实时结束才记，打开会话或新一轮实时开始时清除。
- `START_NOT_STICKY`：进程被回收后不自动拉起，WebView 不在，服务会谎称已连接。
- 首页 Android 返回将任务退到后台（不 finish），内页按页面历史返回；从最近任务划掉时服务 `onTaskRemoved` 停止。原生主题改为 AppCompat DayNight，不再依赖 Material3 Gradle 包。
- Android 13+ 需要 `POST_NOTIFICATIONS` 才会显示通知，启动服务时请求一次；授权后立即重新发布被丢弃的常驻通知。前台服务本身不依赖这个权限。

**前台服务类型：`specialUse`**（Android 14+ 必须声明，Manifest 里带 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 说明用途）。选型：

- `dataSync`：Android 15 起每 24 小时最多运行 6 小时，到点系统回调 `onTimeout`，不适合常驻连接。
- `remoteMessaging`：文档示例是「在设备间转发文字消息」，语义最近，但声明的用途与我们的实际行为（保持到用户自己电脑的加密通道）并不完全一致；以后上架时审核风险更高。
- `connectedDevice`：需要蓝牙/USB 等运行时权限，与用途无关。
- `specialUse`：无超时，无需额外运行时权限，用途如实写在子类型里。第一版只发 APK、不上架，没有商店审核问题；将来上架需要按商店要求提交说明。

**WebView 的暂停**：wry 的 `WryActivity` 在 `onPause` 调 `mWebView.onPause()`，在 `onResume` 调 `onResume()`；两者都不调 `pauseTimers()`，但前台服务本身挡不住 WebView 被冻结。模拟器实测（`WebView 133`，Android 16）：Activity 进入后台约 1 分钟起页面计时器被节流到每分钟一次，**约 5 分钟时整个页面被冻结**，WebSocket 的收发停止，中继在约 9 分钟时因收不到应答关闭连接（close 1006），回前台才重连。只做 `WebView.onResume()` + `resumeTimers()` 同样无效（实测同样在 5 分钟冻结）。有效的做法是让渲染端一直认为窗口可见：`MainActivity` 在 `onPause` / `onStop` 且前台服务运行时，对 WebView 调 `dispatchWindowVisibilityChanged(View.VISIBLE)`，此后每 5 秒补发一次，回到前台即停止；同时 `setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)` 让渲染进程在后台保持重要优先级。这是已有的 Cordova 后台插件的做法，不是公开保证的行为，WebView 版本变化可能失效，所以探针保留，页面计时器延迟与事件间隔可以一眼看出是否退化。副作用：页面始终认为自己可见，`document.visibilityState` 在后台也是 `visible`，探针的「前台 / 后台」页面标签因此不准，后台时段以原生记录的 `activity_pause` / `activity_resume` 为准。

上述标签不准是第 1 轮探针的限制；第 2 轮已改用原生 Activity 状态，见第 6 节。

**渲染进程被回收**：wry 的 `RustWebViewClient` 是 final 且没有 `onRenderProcessGone`，不处理会让整个 App 进程崩溃。`MainActivity.onWebViewCreate` 在主线程队列里用 `GuardedWebViewClient` 包住它（wry 在 `setWebView` 之后才 `setWebViewClient`），回调转发，并接管 `onRenderProcessGone`：

- 前台：记录后立即重启 App（拉起启动 Activity 后结束进程），身份密钥在 IndexedDB 里，页面按现有逻辑重连并重新订阅。已打开的会话视图在内存里，重启后重新读取，不是按 `afterSeq` 增量续接。
- 后台：Android 不允许无界面拉起 Activity，WebView 又属于 Activity，所以不能在后台重建；先把常驻通知改为「连接已中断，点按重新打开」，回到前台（`onResume`）时再重启。

**系统设置引导**：设置页的「电池优化设置」打开系统的电池优化列表（`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`，不需要额外权限），「自启动设置」优先打开小米安全中心的自启动管理页，其他系统退回应用详情页。小米还需要把省电策略设为「无限制」、在最近任务里锁定 App，这两项没有可靠的跳转，只能由用户手动设置：设置 › 应用 › 应用管理 › Nocturne › 省电策略 › 无限制；在「最近任务」里长按 Nocturne 卡片选择锁定。

## 5. 会话列表保持最新

后台保持连接让手机一直在线，列表不能再靠「回前台重连时顺带重拉」更新。分两层：

- **通知**：连接期间页面监听电脑后台的 `runtime.sessionsChanged`（电脑上创建或分叉会话、首条消息与标题出现时 300 ms 内合并推送，不带内容，[rpc.md §3.8](../protocols/rpc.md)），收到就重拉列表并订阅新出现的本后台打开会话（`openHere`，旧后台缺省时退回持锁）；空闲引用释放与重连筛选复用[手机网页规则](desktop.md#8-手机网页)，常驻连接不例外，因此新会话的标题、运行与待确认状态在 2 秒内出现。旧电脑没有这条通知，页面只依赖下面的兜底。
- **回前台兜底**：别的进程（如 CLI）新建的会话不经过电脑后台，没有通知。`MainActivity.onResume` 在页面的 `window` 上派发 `nocturne-android-resume` 事件（`src/host.ts` 的 `RESUME_EVENT`），`appPlatform` 的 `onForeground` 把它交给页面，页面刷新一次列表。不用 `visibilitychange`：「窗口保持可见」的变通让页面在后台也认为自己可见；也不轮询。

网页版不变：切到后台页面断线，回前台重连时重拉列表，连接期间同样监听通知。

## 6. 后台探针

设置页「连接诊断」子页底部的「后台探针」，数据只在手机本地（`localStorage` 与 App 私有目录里的原生日志），不上传、不含会话内容：

- 每条收到的会话事件：到达时间、`event.time` 发送时间（均含 epoch）、类型、会话 id、序号（流式增量没有序号，记 `-`），以及当时原生 Activity 在前台还是后台、是实时事件还是重连后的回放；
- 每次断线（原因）与连上（电脑名）、连接状态变化；
- 计时器延迟：每 30 秒汇总一次 1 秒计时器的最大延迟与次数，标前后台；
- 原生一侧（`NativeLog`）：前台服务启停、Activity 前后台、渲染进程回收与重启、通知权限结果；
- 页面启动。

摘要给出前后台事件数、最大事件间隔、间隔大于 5 秒的次数、「成批涌入」批次、后台计时器最大延迟，以及原生事件计数；实时后台事件按 `到达 epoch − event.time epoch` 统计中位数与最大值，重放不算。前后台标签来自 Activity 的原生 pause/resume 信号，绝不用 WebView 的 `document.visibilityState`（它因保活而一直 visible）。「复制探针记录」导出纯文本（JS 与原生逐行都附 epoch 毫秒），清除同时清掉两侧；JS 侧最多 20000 条。小米实测与长期风险见 [ADR-0059 修订](../decisions/ADR-0059-android-app.md#修订2026-10-16-小米真机与第-2-轮)。

到达延迟依赖电脑和手机时钟同步，负值保留用于发现时钟偏差，不能直接当成网络耗时；导出也带此提示。

## 7. 本地通知

设置页「通知」（文案与电脑端设置页相同：总开关「通知」，下面「需要确认（权限、提问）」「出错停止」「完成」与「提醒触发时长」，总开关关闭时子项禁用）只存在手机本地 `localStorage`，总开关、attention/error/done 与提醒触发时长缺省直接复用桌面 `NOTIFY_DEFAULTS`，档位复用 `DONE_THRESHOLD_CHOICES`；不改电脑设置。已订阅的持锁会话和主动打开的会话均由 `PhoneSessions` 接收事件，`runtime.sessionsChanged` 带来的新持锁会话订阅后同样覆盖；手机同一时间只连接一台电脑，其他已配对电脑的会话不提醒。`live` 判断沿用桌面 `conversations.ts`：订阅响应前 durable 事件按 `event.time >= subscribeStart` 区分回放窗口期新事件，ephemeral 天然实时；Turn 开始的 epoch 缓存在每会话 Map，完成用时由 `decideNotification` 判定。Activity 在前台且当前显示该会话才算在看（设置覆盖不算），启动时查询原生状态、之后用 pause/resume 更新，不默认前台；在看、回放、恢复补写与中断均不提醒。

Kotlin `SessionNotifications` 使用独立于保活服务的「会话提醒」渠道（`nocturne_sessions_v2`，`IMPORTANCE_HIGH`，因此以悬浮通知从屏幕顶部弹出；渠道级别创建后无法调高，所以换过一次 id，升级后首次发提醒创建新渠道时删除旧的 `nocturne_sessions`）；`NotificationManagerCompat` 用 hostId/sessionId 稳定 tag 与 `sessionId.hashCode()` 派生的 id 替换同一会话通知（tag 保证不同电脑或哈希碰撞的会话不互相覆盖），点击 Intent 的唯一 data URI 与 extras 携带两个 id，暖启动或进程死后冷启动从配对记录切到该电脑、等会话列表加载后打开会话并撤通知。`VISIBILITY_PRIVATE` 的 publicVersion 仅为固定 Nocturne + 类别，不出现会话标题、权限目标或内容；私有正文与桌面同款、只在本地生成。系统通知权限/渠道关闭时不抛错误，不自动为提醒索权；系统通知被关闭时，设置页「通知」一节出现「系统通知已关闭」一行与「打开系统应用设置」入口。网页版 service worker/Web Push 不变。进程被系统杀掉后无法生成新通知，已发出的通知仍可点开。
