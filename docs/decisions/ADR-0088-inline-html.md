# ADR-0088：回复内嵌页面（`render_html` 与隔离空壳沙箱）

- 状态：已接受
- 日期：2026-11-11

## 背景

模型在展示对比表、统计图、结构示意图、界面草图或轻量交互演示时，自包含的单文件 HTML 明显比纯文本或静态代码块更直观。Nocturne 同时运行在桌面端（Tauri + WebView2 / WKWebView / WebKitGTK）、手机网页（经密文中继提供静态资源）、安卓 App（Tauri + Android WebView）与终端 TUI 四种客户端上，需要一套统一的数据契约与三端一致的图形渲染沙箱。

三端图形宿主的 `Content-Security-Policy` 均为 `script-src 'self'`（桌面端 `apps/desktop/src-tauri/tauri.conf.json`、安卓端 `apps/android/src-tauri/tauri.conf.json`、中继 `apps/relay/src/csp.ts` 的 `staticCsp`）。按 CSP3 规范（见 `w3c/webappsec-csp#700`），`srcdoc`、`blob:`、`data:` 的 `<iframe>` 会继承嵌入方文档的策略容器，页面内的内联 `<script>` 与内联 `<style>` 会被宿主策略拦截；而为宿主放宽 `'unsafe-inline'` 会削弱主界面自身的跨站脚本防线。

此外，在 Tauri 2（`wry`）上，Windows WebView2 的 `AddScriptToExecuteOnDocumentCreated` 与 Android WebView 的 `addDocumentStartJavaScript(..., setOf("*"))` / `@JavascriptInterface` 会把初始化脚本与底层 `window.ipc` 注入到主窗口内的所有子框架，且 Tauri 把 `register_uri_scheme_protocol` 注册的自定义协议视为本地源（`Origin::Local`）。若不在 IPC 密钥层隔离主框架与子框架，沙箱内的脚本将能调通主窗口的外壳命令。

## 决定

### 1. 七项边界决定

1. **允许沙箱脚本**：页面内允许运行内联脚本与内联样式，但关在无同源权限的沙箱中，碰不到 Nocturne 界面 DOM、会话数据、本地存储与 Tauri 外壳命令。
2. **完全断网**：页面内禁止任何网络请求；远程脚本、样式表、图片、字体、`fetch`、`XMLHttpRequest`、`WebSocket` 一律拦截，资源只能内联（允许 `data:` 图片/字体/媒体与页内生成的 `blob:` 图片/媒体）。第一版不做按本地工作区路径引用图片。
3. **禁用外跳与副作用**：页面内的链接跳转、表单提交、`window.open` 弹窗、`<a download>` 下载、原生模态框（`alert`/`confirm`/`prompt`）与顶层页面导航一律无效。
4. **自适应高度、折叠与全屏**：页面框无标题栏、无说明文字；高度随内容自适应并夹紧在 `48px`–`4096px` 之间；内容高于 `420px` 时默认折叠至 `420px`，底部渐隐并居中放置展开/收起箭头按钮；桌面悬停或聚焦（手机窄于 `600px` 常显，`44px` 触控区）在右上角显示全屏按钮；全屏遮罩挂在窗口根部，仅提供下载（保存为 `.html`）与关闭两个图标按钮。
5. **仅主会话可用、免确认**：内置工具 `render_html` 只对主会话开放；因其 `permissionSubjects` 为空且 `traits.mutates` 为 `false`，在 `read-only` 权限预设与计划模式（`/plan`）下均直接可用且不产生权限确认；通过工具特性 `traits.mainSessionOnly: true` 从子代理工具池中排除（显式传入 `tools: ["render_html"]` 亦被过滤）。
6. **完成后再显示**：参数流式到达期间（`tool.input.delta`）及工具执行中仅显示动词为 `页面` 的普通工具行，不在流式阶段渲染半成品 HTML；工具成功完成后隐藏该次调用的工具行，直接原地渲染内嵌页面（运行失败时保留工具行报错）。
7. **显示时动态注入主题**：落盘保存的 HTML 原文不写入当前主题色值；客户端在显示时读取宿主计算样式，向空壳页动态注入一组稳定的主题 CSS 变量与 `color-scheme`。切换深浅色或外观字体字号时通过 `postMessage` 热更新空壳页样式，不重新加载页面、不丢失页面内脚本与交互状态。不涉及被编辑项目自身的设计系统。

### 2. 独立空壳页、CSP 与 Tauri 子框架 IPC 封锁

三端共用唯一静态空壳源文件 `apps/desktop/public-web/sandbox.html`，通过独立来源响应头赋予空壳页专属 CSP，宿主再经 `postMessage` 将 HTML 文本与主题变量交给空壳页：

- **桌面端与安卓端**：通过 `Builder::register_uri_scheme_protocol("nct-sandbox", ...)` 提供空壳页（Windows 与 Android 映射为 `http://nct-sandbox.localhost/sandbox.html`，macOS 与 Linux 为 `nct-sandbox://localhost/sandbox.html`）。协议处理器只接受无查询串的 `GET`/`HEAD` `/sandbox.html`，其余路径或方法一律返回 `404`。桌面内置浏览器的内部地址黑名单同步登记 `nct-sandbox` / `nct-sandbox.localhost`；安卓 `on_navigation` 仅额外放行精确的 `http://nct-sandbox.localhost/sandbox.html`。
- **手机网页与中继**：`sandbox.html` 随 `dist-web` 打包进 `apps/relay/public/sandbox.html`；中继仅对该路径返回空壳页专属 CSP，不接触端到端加密的 HTML 正文。
- **空壳页响应头 `Content-Security-Policy`**：
  ```text
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors <宿主源>; sandbox allow-scripts
  ```
  其中 `<宿主源>` 在中继为 `'self'`，在桌面端为 `http://tauri.localhost tauri://localhost`（调试构建附加 `http://localhost:31420`），在安卓端为 `http://tauri.localhost`（调试构建附加 `http://localhost:31421`）。
- **嵌入方 `<iframe>` 属性**：固定为 `sandbox="allow-scripts"`，不含 `allow-same-origin`、`allow-top-navigation`、`allow-popups`、`allow-forms`、`allow-downloads`、`allow-modals`，使子框架处于不透明源（`window.origin === "null"`）。
- **宿主页面 CSP 改动**：仅在桌面端、安卓端 `tauri.conf.json` 的 `csp`/`devCsp` 增加 `frame-src nct-sandbox: http://nct-sandbox.localhost`，在中继 `staticCsp` 增加 `frame-src 'self'`；`script-src` 与 `style-src` 不做任何放宽。
- **Tauri 子框架 IPC 封锁**：桌面端与安卓端通过 `Builder::invoke_system` 将 `__INVOKE_KEY__` 仅绑定在 `window === window.top` 的顶层主框架闭包内；任何 `window !== window.top` 的子框架（含沙箱页及页内动态创建的嵌套 `<iframe>`）均拿不到调用密钥，`window.__TAURI_INTERNALS__.invoke(...)` 立即返回拒绝，绕过封装直接调用 `window.ipc.postMessage` 伪造报文亦在 Rust `Webview::on_message` 入口因密钥不匹配被直接丢弃。
- **消息校验**：空壳页仅接受 `event.source === window.parent` 的消息且只执行一次 `render` 装载，后续仅接受 `theme` 变量更新；父页面仅接受 `event.source === iframe.contentWindow` 且实例 `id` 匹配的有限数值高度与 `Escape` 关闭通知。

### 3. `render_html` 参数、上下文修剪与大小上限

- **输入契约**：`title`（必填，去首尾空白后非空、单行不含换行、至多 `80` 个字符）与 `html`（必填，去首尾空白后非空、UTF-8 编码至多 `256 KiB` 即 `262,144` 字节）。
- **事件落点与体积分析**：调用参数在流式阶段经临时事件 `tool.input.delta` 传输，完成后写入持久事件 `message.assistant.toolCalls[i].input` 与 `tool.started.input`（日志中出现两次）；工具执行将 HTML 经 `AttachmentStore.saveFile` 落盘为 `attachments/<sessionId>/file-<n>.html`（`label` 为清洗非法文件名字符后的 `<title>.html`，`mimeType: "text/html"`），`tool.completed` 仅携带 `files: [FileAttachment]` 与简短 `modelContent` 确认，不重复存放 HTML 原文。
- **上下文修剪与 `256 KiB` 上限依据**：
  - 在触发 ADR-0066 L1 修剪时，`pruneArgument` 会将历史 `message.assistant.toolCalls` 中超过 `200` 字符的字符串参数截短为 `<前200字符>…[已省略 N 字符]`；但在同源带推理签名的模型轮次中（`preserveArguments = true`），进入 L2 摘要前需保留原始 `toolCalls` 参数以维持签名有效。
  - 主流模型单次最大输出在 `16k`–`64k` tokens（约 `64 KiB`–`256 KiB` 文本）；若采用暂定的 `512 KiB`（约 `130k` tokens），单次调用即可耗尽 `128k` 窗口模型的全部可用输入预算。定为 `256 KiB` 既足以容纳带内联 SVG/Canvas、样式、脚本及小型 `data:` 资源的完整单页视图，又与 `64k` 输出上限对齐，且单条事件体积远低于远程加密通道 `15.9375 MiB`（`REMOTE_MESSAGE_LIMIT`）报文上限，会话恢复逐行解析无阻塞。
- **工具行详情展示**：当运行中或失败的工具行被用户展开「详情」时，对多行或超长字符串参数沿用折叠文本展示（`FoldedPlainText`），不将整份 HTML 原文一次性铺入 DOM。

### 4. 内嵌标记与旧版本兼容性

- **`FileAttachment` 扩展**：在 `FileAttachment`（[ADR-0072](ADR-0072-file-attachments.md)）上新增可选字段 `inline?: { title: string }`；`source` 沿用现有枚举值 `"upload"`。
- **前后向兼容依据**：旧版本 `packages/core/src/protocol/schema.ts` 的 `fileAttachmentSchema` 将 `source` 校验为严格枚举 `z.enum(["paste", "upload", "answer"])`，若新增 `"tool"` 枚举值会导致旧版本 Runtime 恢复会话时校验失败；而 `z.object(...)` 默认剥离未知字段（`strip`），因此保留 `source: "upload"` 并新增可选 `inline` 字段无需提升 `formatVersion`（保持 `1`），旧版本 Runtime 可正常恢复日志，旧版本客户端忽略 `inline` 并将其回退显示为普通 `.html` 文件附件卡片。
- **信任边界**：`inline` 标记仅在 `tool.completed.files` 上生效；Core 在用户消息入口（`submit` / 排队输入）显式剥离用户传入 `FileAttachment` 上的 `inline` 字段，`message.user.files` 始终按普通文件卡片渲染。
- **共享派生视图与终端显示**：`packages/core/src/protocol/view.ts` 在归约 `SessionView` 时识别成功完成的带 `inline` 附件工具结果（不按工具名硬编码）；图形端渲染 `InlinePage` 组件并在附件读取失败或远程被拒时回退为普通文件附件卡片；TUI 在全屏与内联模式下均显示一行 `▣ <title>`（不含 `.html` 后缀）。
- **会话生命周期**：HTML 存于会话标准附件目录 `attachments/<sessionId>/`，会话分叉、回退、归档及清理行为与现有图片和文件附件完全一致。

### 5. 主题变量清单

客户端从宿主根元素读取计算样式并向空壳页注入以下 12 个稳定 CSS 变量及 `color-scheme`；空壳页内置零特异度 `:where(:root)` / `:where(body)` 默认规则，使未写任何样式的纯 HTML 底色、文字色、字体与对话区一致，同时不覆盖页面自定义样式：

| 页面 CSS 变量 | 含义 | 宿主 Token 来源 |
|---|---|---|
| `--bg` | 页面底色 | `--a-panel` |
| `--raised` | 凸起面 / 次级底色 | `--a-raised` |
| `--text` | 主文字色 | `--a-text` |
| `--secondary` | 次要文字色 | `--a-secondary` |
| `--muted` | 弱文字 / 辅助色 | `--a-muted` |
| `--border` | 边框与分割线色 | `--a-border` |
| `--accent` | 强调色 | `--a-accent` |
| `--ok` | 成功状态色 | `--a-success` |
| `--warn` | 警告状态色 | `--a-warning` |
| `--bad` | 危险 / 错误状态色 | `--a-error` |
| `--sans` | 正文字体栈 | `--sans` |
| `--mono` | 等宽字体栈 | `--mono` |

### 6. 可行性实测结论（三端实证）

在动界面实现前，已分别在**桌面端（Windows Tauri + WebView2）**、**手机网页 + 中继（Chromium 390×844）**与**安卓端（Android 16 模拟器 `p0_16k` + Tauri Android WebView）**对全部六项安全与运行指标进行了实测：

1. **内联脚本与内联样式运行**：三端均正常执行内联 `<script>`、计算内联 `<style>` 与注入的主题变量，并正常解码内联 `data:` 图片。
2. **网络请求全面阻断**：三端沙箱内的 `fetch`（HTTP/HTTPS）、`<img src="https://...">`、`<script src="...">`、`<link rel="stylesheet" href="...">` 与 `WebSocket` 均触发 CSP 违规并失败，本地回环探针服务器收到请求数均为 `0`。
3. **父窗口与存储隔离**：三端 `window.origin` 均为 `"null"`；读取 `parent.document`、赋值 `top.location`、访问 `localStorage` 与读写 `document.cookie` 均抛出 `SecurityError`，`window.open` 返回 `null`，宿主地址保持不变。
4. **桌面端与安卓端 Tauri 通道隔离**：`window.__TAURI__` 为 `undefined`；尽管底层 WebView 初始化机制在子框架创建了 `window.__TAURI_INTERNALS__`（及安卓 `window.ipc`），经 `invoke_system` 顶层守卫后，直接调用 `invoke(...)` 与嵌套 `about:blank` 子框架调用均立即被拒（`Tauri IPC is disabled in subframes`），`fetch("http://ipc.localhost/...")` 与 `fetch("ipc://localhost/...")` 被 CSP 阻断，直接调用底层 `postMessage` 伪造密钥报文在 Rust `Webview::on_message` 入口被丢弃（桌面端 `shell_log` 与安卓 `logcat` 均证实命令未执行）。
5. **下载与外链拦截**：桌面端在开启 `on_main_download` 免弹窗自动保存并经主窗口正向对照确认生效的前提下，沙箱内点击 `<a download>`（`data:` 与 `blob:`）及 `<a target="_blank">`（脚本点击与真实坐标物理点击）触发下载数为 `0`，安卓端 `Download is disallowed` 且前台 Activity 保持 `MainActivity`，三端均未打开外部浏览器或新窗口。
6. **死循环脚本表现（如实记录）**：三端沙箱内执行同步 `while (true) {}` 死循环时，网页层宿主界面在死循环期间均无法响应点击来卸载该 `<iframe>`。原因在于：中继 `/sandbox.html` 与父页面同源，桌面端 `http://nct-sandbox.localhost` 与 `http://tauri.localhost` 的可注册域同为 `localhost`（Chromium Site Isolation 将其归为同一站点进程），而 Android WebView 为单渲染进程模型，三者的 `sandbox="allow-scripts"` 子框架均与父文档共享同一渲染主线程。桌面端可通过系统窗口关闭结束应用，切走会话或刷新后因未自动重入交互可恢复，第一版接受此浏览器引擎同站点进程限制。

## 后果

- **正面**：模型可在不触碰工作区文件、不弹权限确认、不放宽宿主 CSP 的前提下直接交付可交互的单文件图表与原型页；三端共用同一份 `sandbox.html` 与同一套 React 组件，深浅色与字体无缝同步，旧版客户端与 Runtime 平滑兼容。
- **负面与约束**：`html` 作为工具参数会占用当轮及同源签名未摘要轮次的模型上下文（上限约束在 `256 KiB`）；同渲染线程下恶意或错误的同步死循环脚本会阻塞当前页面渲染线程；Tauri 升级时需由版本单测提醒复核 `main_frame_only_invoke_script`。

## 未纳入第一版的事项

- 按本地工作区路径引用图片或其他本地静态资源；
- 读取或注入被编辑项目自身的设计系统 token；
- TUI 内一键在外部浏览器打开该页面的快捷键或提示文案；
- 通过额外独立域名或独立原生子 WebView 隔离同步死循环脚本的 CPU 占用。
