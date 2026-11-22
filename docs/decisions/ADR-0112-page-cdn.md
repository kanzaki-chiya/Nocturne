# ADR-0112：页面从 CDN 加载库（`render_html` 页面三期）

- 状态：已接受
- 日期：2026-11-23
- 修订：[ADR-0088](ADR-0088-inline-html.md) 第 1 节第 2 条「完全断网」、第 2 节空壳页 CSP、第二版第 2 节 TUI 外壳 CSP
- 相关：[ADR-0111](ADR-0111-page-storage-and-model.md)（页面存数据与调模型）、[ADR-0101](ADR-0101-mcp-apps-host.md)（插件页面 CSP，本 ADR 不改）

## 背景

ADR-0088 让页面完全断网，所有资源只能内联。模型要用 React、Chart.js、D3、ECharts、Mermaid 这类库时，只能手写或把整个库的源码塞进 `html`，而 `html` 上限 256 KiB，大一点的库（如 ECharts 完整版约 1 MB）根本放不下。用户在一期讨论时选了「CDN 白名单」。

放开网络有三个代价：

1. **第三方代码**：CDN 上的脚本不是模型写的。jsDelivr 与 unpkg 直接镜像 npm（jsDelivr 还镜像任意 GitHub 仓库，路径 `/gh/<用户>/<仓库>`），任何人都能发布；cdnjs 只收经审核加进其仓库的库。
2. **外传数据**：ADR-0111 之后页面能读自己存的数据、能拿到模型回复。CSP 只放行某个主机后，页面仍能把数据编进请求地址发给这个主机。jsDelivr 公开了按文件统计的接口（`data.jsdelivr.com/v1/stats/packages/npm/{package}@{version}/files`，约 48 小时延迟），发布者能看到自己包里每个文件被请求的次数，可以被当成一条低速的外传通道。
3. **手机网络与离线**：电脑端用户能从 GitHub 下载安装，网络默认可用。手机经国内中继打开页面时库由手机网络加载；jsDelivr 于 2021-12-20 失去中国 ICP 许可证（[issue #18348](https://github.com/jsdelivr/jsdelivr/issues/18348)），2022 年起有用户报告 DNS 污染与连接重置（[issue #18407](https://github.com/jsdelivr/jsdelivr/issues/18407)），cdnjs、unpkg 在国内直连下没有实测数据。用 CDN 的页面离线缺库，下载的 `.html` 在断网电脑上也缺库。

## 决定

### 1. 放开哪些指令

只放行 `https://cdnjs.cloudflare.com`，应用于 `render_html` 的空壳页（`/sandbox.html`）与 TUI 外壳。插件页面（`/app.html`）继续使用原有策略。空壳页 CSP 如下：

```text
default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; img-src data: blob: https://cdnjs.cloudflare.com; font-src data: https://cdnjs.cloudflare.com; media-src data: blob:; connect-src 'none'; frame-ancestors <宿主源>; sandbox allow-scripts
```

- `connect-src 'none'` 拦截 `fetch`、`XMLHttpRequest`、`WebSocket`，包括目标为 cdnjs 的连接。依赖这类连接取数据的库功能无法使用。
- CDN 白名单按主机匹配。CSP 在跨源重定向后忽略路径部分，因此不加 `/ajax/libs/` 这样的路径限制。
- 四处同步改：桌面 `apps/desktop/src-tauri/src/sandbox.rs` 与安卓 `apps/android/src-tauri/src/sandbox.rs` 的 `sandbox_csp()`、中继 `apps/relay/src/csp.ts` 的 `SANDBOX_CSP`、TUI `apps/tui/src/inline-page-open.ts` 的 `INLINE_PAGE_SHELL_CSP`。TUI 保留 `form-action 'none'` 和 `base-uri 'none'`，由 iframe 的 `sandbox="allow-scripts"` 提供沙箱约束。

### 2. 三种做法对比

| | 只放 cdnjs（采用） | cdnjs + jsDelivr + unpkg | 内置常用库，不联网 |
| --- | --- | --- | --- |
| 能用的库 | cdnjs 收录的库（React、Chart.js、D3、ECharts、Three.js、Mermaid 等主流库都有） | npm 上几乎所有包 | 只有随应用打包的那几个，版本固定 |
| 第三方代码 | 经 cdnjs 审核收录 | 任何人都能发布 | 随版本发布，构建时固定 |
| 外传数据 | 资源请求只放行 cdnjs。cdnjs 是否公开按文件统计待核实 | jsDelivr 按文件统计可被利用 | 无，仍完全断网 |
| 手机不开代理 | 待实测 | jsDelivr 已知不稳，其余待实测 | 不受影响 |
| 离线 / 下载的 `.html` | 缺库 | 缺库 | 应用内可用，下载的 `.html` 需改为内联或缺库 |
| 应用体积 | 不变 | 不变 | 增加几 MB（安装包、中继包、APK 都要带） |

内置做法可把库文件放进空壳页同一来源（如 `nct-sandbox://localhost/lib/react@18.3.1/react.production.min.js`，中继同路径），在 CSP 中指明来源和路径，并在工具说明里列出可用的库和版本。

### 3. 工具说明

- 列出允许的主机，要求固定到精确版本（如 `react/18.3.1/umd/react.production.min.js`），不用 `latest` 或范围版本。
- 使用 UMD、全局变量构建，或用 `<script type="module">` 从同一主机导入。
- 先内联写好页面内容，让用户在库加载失败时仍能看懂，并由页面显示一条简短提示。

### 4. 与 ADR-0111 叠加后的风险

- 第三方脚本与页面自己的脚本同在一个文档里，同样能用 `window.nocturne` 读写这个页面的数据、发起调模型请求。调用模型仍需要用户先确认，确认条显示页面标题。见 [ADR-0111](ADR-0111-page-storage-and-model.md) 第 4 节。
- CDN 主机可以收到放行的资源请求。若同时放行 jsDelivr，其按文件统计接口会增加公开的外传途径。
- 页面截图可能受跨源样式和图片影响，例如读取样式表 `cssRules` 被拒绝、跨源图片污染 `<canvas>`。导出失败时沿用现有「导出失败」处理。见 [ADR-0088](ADR-0088-inline-html.md) 第三版。

### 5. 设置开关

放行的主机写死在四处 CSP 里，随版本发布。改主机列表需要修订本 ADR。

## 不做的事

- 不放开 `connect-src`，页面仍不能 `fetch` 任何地址。
- 不提供控制 CDN 放行的开关，不允许用户自己添加主机。
- 不改插件页面（`/app.html`）与宿主页面的 CSP。
- 不强制 Subresource Integrity，以免模型生成错误的 `integrity` 值导致资源加载失败。

## 实现前要实测

在桌面 WebView2、本机中继的手机网页和可用的安卓环境中，用假模型输出同一个页面，加载 React 18.3.1 与 Chart.js 4.4.1 的 UMD 构建并渲染图表。验证未放行主机的脚本、指向任意地址的 `fetch`、Tauri IPC 与 `localStorage` 均无法使用，记录加载耗时、`window.nocturne` 可用性与 PNG 导出结果。若实测不符，停止交付并记录现象。

本机开启 Windows 系统代理。使用同一个假模型页面，关闭浏览器 HTTP 缓存后，从插入 `<script>` 到收到 `load` 事件计时。

| 环境 | React 18.3.1 | Chart.js 4.4.1 | 图表及 PNG 导出 |
| --- | ---: | ---: | --- |
| 桌面 WebView2，亮色 | 373 ms | 372 ms | 七根柱，PNG 1578×1016 |
| 桌面 WebView2，暗色 | 344 ms | 373 ms | 七根柱，PNG 1578×1016 |
| 手机网页，本机中继、Edge 移动视口 390×844 | 360 ms | 369 ms | 七根柱，PNG 780×982 |

三个场景均记录到 CSP 拦截 jsDelivr 脚本和两次 `fetch`（cdnjs、example.com）。`localStorage` 抛出 `SecurityError`。桌面 Tauri IPC 被拒绝，手机网页没有 Tauri IPC。三个场景都通过 `window.nocturne.storage` 写入并读回测试值，且提供 `window.nocturne.ask`。

安卓通过四项 Rust 沙箱测试，完成 x86_64 调试 APK 构建、安装并发出启动指令。模拟器随后离线，未完成安卓 WebView 的 CDN 和 PNG 导出检查。

国内移动网络验证由用户在合入后用未开启代理的手机完成，并记录每个库的加载耗时。手机从自己的网络加载库，延迟与可用性由手机的网络条件决定。
