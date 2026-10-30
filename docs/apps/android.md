# 安卓 App

> 状态：外壳、后台保持连接、会话列表更新与第 2 轮本地通知已实现｜决策：[ADR-0059](../decisions/ADR-0059-android-app.md)｜实现：`apps/android`

`apps/android` 是 Tauri 2 的安卓工程，把[手机网页](desktop.md#8-手机网页)随 APK 安装：WebView 只加载打包进 APK 的页面，页面代码不再由中继下发。界面、加密通道、RPC 客户端与会话视图全部复用 `apps/desktop/src/web`，App 只补平台差异。本轮含会话本地通知；仍不含扫码、拍照、正式签名与自动更新（第 3 轮）。

文件附件与自由回答附件复用网页实现（[ADR-0072](../decisions/ADR-0072-file-attachments.md)）：选择任意文件、粘贴／拖入文件、32 KiB 大段粘贴转卡片；发送前检查远程合计原始字节上限，超限保留草稿。对话文件卡片经 `readAttachment` 下载；WebView 下载受宿主沙箱限制时仍可查看名称与大小。

## 1. 工程结构

| 路径 | 内容 |
|---|---|
| `index.html`、`vite.config.ts` | App 专属的网页入口，构建到 `dist/`。不带网页版的 service worker、manifest 与 `public-web` |
| `src/main.tsx` | 入口：把 `PhoneApp` 与 `appPlatform(tauriHost)` 接起来，启动探针 |
| `src/host.ts` | `AppHost`：与网页的 `WebHost` 并列的宿主接口，及经 Tauri 调 Kotlin 插件的实现 |
| `src/platform.tsx` | `PhonePlatform` 实现：中继地址取自配对链接、信任说明、「后台保持连接」设置区块、「后台探针」页 |
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

Git Bash 同理，用 `export JAVA_HOME=...`。产物在 `apps/android/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`；本轮只做 debug 签名。

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
| 外链 | 新标签打开 | 不打开：`on_navigation` 只允许 `http://tauri.localhost`（调试构建另允许开发服务器） |
| 能力边界 | 白名单 | 不变，App 不改 RPC 白名单 |

共享层的扩展点是 `PhonePlatform`（`apps/desktop/src/web/platform.ts`）：`relay`（`page` / `link`）、`keepConnected`、`observer`（已配对电脑、连接状态、断线、会话事件）、`onForeground`（回到前台）、`trustText`（只在设置页「关于」完整显示，配对页只留一句指路）、`pairHint`、`background` / `diagnostics`（设置页区块）与 `pages`（App 自己的页面）。网页入口不传即为 `{ relay: "page" }`，行为不变。

## 4. 后台保持连接

**前台服务**（`KeepAliveService`）只负责让进程不被回收；连接、加密与订阅仍在 WebView 里，服务本身不联网、不持有密钥。

- 启动条件：已配对至少一台电脑且「后台保持连接」打开（设置页，默认开）。关闭或移除最后一台电脑则停止，行为回到网页版。用户划掉 App 时（Activity 结束）服务随之停止，避免通知谎称「已连接」。
- 常驻通知文案：`Nocturne 远程：已连接 <电脑名>`，未连上为 `Nocturne 远程：正在连接…`，渲染进程丢失且 App 在后台时为 `Nocturne 远程：连接已中断，点按重新打开`。通知渠道「后台保持连接」为低优先级，点按回到 App。
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

设置页「连接诊断」里的「后台探针」，数据只在手机本地（`localStorage` 与 App 私有目录里的原生日志），不上传、不含会话内容：

- 每条收到的会话事件：到达时间、`event.time` 发送时间（均含 epoch）、类型、会话 id、序号（流式增量没有序号，记 `-`），以及当时原生 Activity 在前台还是后台、是实时事件还是重连后的回放；
- 每次断线（原因）与连上（电脑名）、连接状态变化；
- 计时器延迟：每 30 秒汇总一次 1 秒计时器的最大延迟与次数，标前后台；
- 原生一侧（`NativeLog`）：前台服务启停、Activity 前后台、渲染进程回收与重启、通知权限结果；
- 页面启动。

摘要给出前后台事件数、最大事件间隔、间隔大于 5 秒的次数、「成批涌入」批次、后台计时器最大延迟，以及原生事件计数；实时后台事件按 `到达 epoch − event.time epoch` 统计中位数与最大值，重放不算。前后台标签来自 Activity 的原生 pause/resume 信号，绝不用 WebView 的 `document.visibilityState`（它因保活而一直 visible）。「复制探针记录」导出纯文本（JS 与原生逐行都附 epoch 毫秒），清除同时清掉两侧；JS 侧最多 20000 条。小米实测与长期风险见 [ADR-0059 修订](../decisions/ADR-0059-android-app.md#修订2026-10-16-小米真机与第-2-轮)。

到达延迟依赖电脑和手机时钟同步，负值保留用于发现时钟偏差，不能直接当成网络耗时；导出也带此提示。

## 7. 本地会话提醒

设置页「会话提醒」只存在手机本地 `localStorage`，总开关、attention/error/done 与完成阈值缺省直接复用桌面 `NOTIFY_DEFAULTS`，档位复用 `DONE_THRESHOLD_CHOICES`；不改电脑设置。已订阅的持锁会话和主动打开的会话均由 `PhoneSessions` 接收事件，`runtime.sessionsChanged` 带来的新持锁会话订阅后同样覆盖；手机同一时间只连接一台电脑，其他已配对电脑的会话不提醒。`live` 判断沿用桌面 `conversations.ts`：订阅响应前 durable 事件按 `event.time >= subscribeStart` 区分回放窗口期新事件，ephemeral 天然实时；Turn 开始的 epoch 缓存在每会话 Map，完成用时由 `decideNotification` 判定。Activity 在前台且当前显示该会话才算在看（设置覆盖不算），启动时查询原生状态、之后用 pause/resume 更新，不默认前台；在看、回放、恢复补写与中断均不提醒。

Kotlin `SessionNotifications` 使用独立于保活服务的「会话提醒」渠道（`nocturne_sessions_v2`，`IMPORTANCE_HIGH`，因此以悬浮通知从屏幕顶部弹出；渠道级别创建后无法调高，所以换过一次 id，升级后首次发提醒创建新渠道时删除旧的 `nocturne_sessions`）；`NotificationManagerCompat` 用 hostId/sessionId 稳定 tag 与 `sessionId.hashCode()` 派生的 id 替换同一会话通知（tag 保证不同电脑或哈希碰撞的会话不互相覆盖），点击 Intent 的唯一 data URI 与 extras 携带两个 id，暖启动或进程死后冷启动从配对记录切到该电脑、等会话列表加载后打开会话并撤通知。`VISIBILITY_PRIVATE` 的 publicVersion 仅为固定 Nocturne + 类别，不出现会话标题、权限目标或内容；私有正文与桌面同款、只在本地生成。系统通知权限/渠道关闭时不抛错误，不自动为提醒索权；设置页提供系统应用设置入口。网页版 service worker/Web Push 不变。进程被系统杀掉后无法生成新通知，已发出的通知仍可点开。
