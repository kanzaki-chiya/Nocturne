# ADR-0078：桌面端设置里独立的「浏览器」页

- 状态：已接受
- 日期：2026-11-03
- 修订：[desktop.md](../apps/desktop.md)、[desktop-browser.md](../protocols/desktop-browser.md)、[ADR-0060 修订（六）](ADR-0060-desktop-side-panel.md#2026-10-22六agent-操作面板浏览器)

## 背景

面板里的内置浏览器（[ADR-0060](ADR-0060-desktop-side-panel.md) 第 5 节）和 agent 操作它的能力（修订（六））上线后，和浏览器有关的设置只有「设置 › 常规 › 执行」里的一个「面板浏览器」开关。这个名字名不副实：不开开关，用户照样能在面板里打开网页；开关真正管的是“模型能不能操作网页”。同时还缺几件用户常问的事：回复里的链接能不能在面板里打开、下载存到哪、面板里登录过的网站怎么清掉。

开关改动后要重启应用才生效（[desktop-browser.md](../protocols/desktop-browser.md) 第 1 节），外壳早已返回 `restartRequired`，界面却没有用上。

## 决定

### 1. 独立页面与位置

- 设置区新增「浏览器」页（`apps/desktop/src/BrowserSettingsPage.tsx`），导航在「子代理」与「远程」之间。只有桌面端有这一页，手机网页没有。
- 页面初版四个分组依次是「Agent 浏览器」「打开方式」「浏览数据」「下载」（「下载」后移至「设置 › 常规」，见文末 2026-11-11 修订）。除分组名、行名、选项、按钮和下文列出的确认文字外不写说明；错误写在 `SettingsRow` 的 `error` 里。确认都是卡片里的一行（文字在左，按钮在右，`--a-raised` 底色）。

### 2. Agent 浏览器

- 开关从「常规 › 执行」移来，改名「模型操作网页」。原因：用户不开开关也能在面板里打开网页，「面板浏览器」名不副实。存储字段 `agentBrowserEnabled`、`agentBrowserRiskAccepted` 不改名，旧配置照常生效。首次启用的风险确认文字与按钮不变，`alertdialog` 名为「启用模型操作网页」。
- 正在运行的后台和开关不一致时，开关左边出现「重启应用」。点击和关窗口走同一条路：有待发输入时弹「还有 N 条没发出」（按钮「留在这里」「仍然重启」），取消就留下，确认后或没有待发输入时调外壳 `app_restart`（置 `shutting_down`，与 `begin_shutdown` 共用同一清理路径关终端、关浏览器与 agent 标签、调 `close_backends` 关后台，全部结束后调 `app.restart()`）。是否一致由外壳判断：外壳记下最近一次 spawn 后台时交出去的服务器代（每次 `start_server` 生成新端口和凭证，代加一），`restartRequired` = 当前要给的凭证（开着时为当前代，关着时为无）≠ 交出去的那份。所以启动时关着、开了再关，按钮消失；启动时开着、关了再开，旧后台拿着上一代凭证接不上新服务，按钮仍在。进入页面时经 `agent_browser_status` 还原开关与「重启应用」，开关显示以外壳为准并同步不一致的 prefs。
- 「重启应用」在 `WEBVIEW2_USER_DATA_FOLDER` 隔离环境下沿用同一数据目录：外壳启动时把这个变量从进程环境删掉（desktop.md 第 6 节），重启退出码时把它写回，避免新进程落到默认的应用数据目录。

### 3. 打开方式

- 「网页链接」「本地网址」两行，各选「系统浏览器」或「Nocturne 面板」，缺省系统浏览器，存本机 prefs（`webLinkOpener`、`localLinkOpener`，只存 `"panel"`）。
- 本地网址：协议 http/https、主机是 `localhost`、`127.0.0.1`、`[::1]`；其余 http(s) 是网页链接（`external-url.ts` 的 `linkKind` / `replyLinkOpener`，纯函数）。
- 只管模型回复里的链接。登录授权、帮助文档、更新、工具栏「在系统浏览器打开」等其他外链仍用系统浏览器；手机端不变。
- 选面板时走地址栏同一个入口（`PanelHost` 的 `openBrowser`，经面板控制器 `openUrl`），在当前会话面板新开浏览器标签；没有内置浏览器、没有会话面板或打开失败时退回系统浏览器，不提示。

### 4. 下载

- 「每次询问保存位置」（缺省开）、「保存位置」（缺省系统「下载」文件夹，「更改…」用系统选目录对话框），存 prefs（`downloadAsk` 只存 `false`，`downloadDir`）。前端启动时和改动时经 `browser_downloads_set` 同步给外壳；第一个下载早于同步时按询问处理。
- 询问开：弹「另存为」，初始目录是保存位置。询问关：直接存到保存位置，同名加序号（`a.zip`、`a (1).zip`、`a (2).zip`）；保存位置不存在、不可写或序号用完时退回「另存为」。判断在 `browser_policy::plan_download` / `unique_file_name`（纯函数）。开始、完成、失败提示照旧。
- agent 标签的下载仍一律取消，不读这些设置（desktop-browser.md 第 5 节）。

### 5. 浏览数据

- 「我的浏览」「Agent 浏览」两行，各显示占用大小和「清除…」。大小由外壳在后台线程遍历对应目录（`browsing_data::dir_size`，不跟随链接，目录不存在算 0），进入页面时刷新。目录只经 `browser_data_dir` / `agent_data_dir` 取得，隔离环境一样，不碰主界面的数据目录。
- 「清除…」在行下展开确认：「面板里登录过的网站都要重新登录。」/「Agent 登录过的网站都要重新登录。」，按钮「取消」「清除」。
- 清除方案：目录被运行中的 WebView2 占着，`Cookies`、`lockfile` 都打不开，不能直接删。外壳用和标签相同的方式（同一数据目录、默认环境选项）临时建一个隐藏 webview，接入同一个 WebView2 环境与 Profile，调 `ICoreWebView2Profile2::ClearBrowsingDataAll`，等完成回调后关掉它（`close_later`），再重新计算并返回实际大小。有没有活动标签都走这一条路。范围覆盖 cookie、本地存储、IndexedDB、缓存等；只作用于这一个 Profile。已打开的标签不刷新，刷新后就是退出登录的状态。清除只清掉那一刻已有的数据：清除时还在加载的页面，响应到达后照常写入。
- WebView2 自己下载的组件（`WidevineCdm`、`component_crx_cache`、`Subresource Filter` 等）不属于浏览数据，清除后大小不会归零。

## 之后

- 网站权限：按网站选允许、询问、拒绝，另有「其他网站」的缺省。判定必须放在权限层（[permissions.md](../architecture/permissions.md)），不能在外壳或界面里自行决定；第一步不做，界面上不留任何入口。

## 不做

密码管理、联系信息、扩展、历史记录管理。

## 后果

- 「面板浏览器」只指面板里的内置浏览器本身；设置开关一律叫「模型操作网页」。
- 清除要临时建一个 webview，环境选项必须和标签保持一致；以后给标签加环境选项时要同步。
- 回复链接的打开方式只在桌面端生效；其他外链的入口不受影响。

## 备选方案

- 留在「常规 › 执行」只改名：放不下打开方式、下载、浏览数据，也不利于以后加网站权限。
- 清除时直接删目录：运行中删不掉；关掉全部 webview 再等浏览器进程退出才删，要打断用户和 agent 的标签，且等待时长不可控。
- 用 wry 的 `clear_all_browsing_data`：不等完成就返回，清除后立刻算出的大小不可信。

## 修订（2026-11-11）：「下载」移至「设置 › 常规」并覆盖主界面下载

主窗口原本未注册 `on_download`，图片查看器的「下载」与对话内文件附件卡片的下载走 WebView2 默认行为直接落到系统「下载」文件夹，不询问位置。现给主窗口注册 `on_download`，与面板浏览器用户标签共用 `browser::resolve_download_destination`、`download_prefs`、`pending_saves` 与 `browser_policy::plan_download`（主窗口不发面板浏览器的 `BrowserMessage::Download` 通知；`download_prefs` 尚未同步时同样按询问处理）。

既然这两项管应用内所有下载而不再只属于面板浏览器，「下载」分组（标题与两行控件、文字、存储字段 `downloadAsk` / `downloadDir`、`browser_downloads_set` 命令及同步时机原样保留）从「设置 › 浏览器」移至「设置 › 常规」，位于「普通对话」之后、「更新」之前；没有 `downloads` 外壳能力时仍不显示，「浏览器」页保留「Agent 浏览器」「打开方式」「浏览数据」三组。
