# ADR-0109：页面版本与右侧面板（`render_html` 多版本、面板页面与内嵌页面并存）

- 状态：已接受
- 日期：2026-11-21
- 修订：[ADR-0088](ADR-0088-inline-html.md) 第 1 节第 4 条与第 6 条（新增 `display: "panel"` 显示方式，面板页面在回复里显示为入口行，内嵌页面行为不变）
- 相关：[ADR-0088](ADR-0088-inline-html.md)（隔离空壳沙箱）、[ADR-0060](ADR-0060-desktop-side-panel.md)（桌面端右侧面板）、[ADR-0041](ADR-0041-checkpoints-rewind-fork.md)（回退与分叉）

## 背景

[ADR-0088](ADR-0088-inline-html.md) 提供了单次内嵌 HTML 页面渲染，但在反复修改页面或制作偏重交互的看板、小工具与文档时存在三处不足：

1. 模型每次修改都产生一份彼此孤立的新页面，用户无法按版本回看或对照；
2. 哪怕只改一行文字或样式，也必须重发整份 HTML（上限 256 KiB），增大上下文与日志体积；
3. 需要持续对照使用的页面挤在对话流里，会撑长消息记录且难以一边聊天一边操作。

同时，配合回复说明的小型图表、示意图与对比表仍适合直接嵌在消息里随文阅读。因此需要同时保留「内嵌页面」与「面板页面」，由模型在创建时按用途选择，并为两种页面统一引入版本管理。

## 决定

### 1. `render_html` 契约与显示方式

在原有 `{ title, html, images? }` 基础上，新增三个可选输入参数：

- `page?: string`：要更新的已有页面 id。
- `edits?: { old: string; new: string }[]`：对上一版 HTML 按顺序做精确字符串替换（仅更新时使用）。
- `display?: "inline" | "panel"`：显示方式，只在新建页面时有效，缺省 `"inline"`。

规则如下：

- **新建页面**（不传 `page`）：`title` 与 `html` 必填，校验与上限同 ADR-0088；`display` 缺省 `"inline"`。
- **更新页面**（传 `page`）：
  - `page` 必须是本会话有效历史里已存在的页面 id，否则返回 `invalid_input` 并列出当前有效页面 id 与标题；
  - `html` 与 `edits` 二选一，必须且只能提供一个：提供 `html` 表示整份重写；提供 `edits` 表示读取上一版已落盘 HTML 后按数组顺序依次精确替换，每条 `old` 必须非空且在当前文本中恰好出现一次，否则返回 `invalid_input` 并指明第几条出现 0 次或多次，整次调用不落盘不生效；
  - `title` 可选，不传时沿用上一版标题；
  - 新版本沿用该页面第一版的 `display`，更新时传入的 `display` 被忽略且不报错。
- **大小上限**：新建与更新（含 `edits` 替换后）结果均受 UTF-8 ≤ 256 KiB 限制；若同时提供 `images`，图片内联后总字节仍受 `8 MiB` 上限约束。
- **工具特性与权限不变**：`traits` 仍保持 `mutates: false`、`mainSessionOnly: true`，不传 `images` 时 `permissionSubjects` 为空，仍免确认且仅对主会话开放。
- **工具说明**：小改动优先用 `edits`，页面整体背景写在 `body` 上。新建默认 `inline`，展示、绘制和对比也用 `inline`。用户用 `/cadenza`、要求放到面板或侧边栏，或要求一个 artifact 时用 `panel`。

### 2. 页面 id、版本号与存盘

- **页面 id**：由 Core 分配，格式 `page-<n>`，`n` 按本会话有效历史中新建页面的最大编号从 1 递增；同一 step 并发新建多个页面时通过执行期计数避免撞号。
- **版本号**：每个页面从 `1` 递增（`version = 上一版版本号 + 1`）。
- **附件与元数据**：每个版本都落盘为一份完整 HTML 会话附件（`attachments/<sessionId>/file-<k>.html`），规则同 ADR-0088。附件的 `inline` 扩展为 `{ title, page?, version?, display? }`。
- **工具返回**：成功时的 `modelContent` 写明页面 id、版本号、显示方式及该版本 HTML 文件的绝对路径；模型需要核对当前全文时可用 `read` 直接读取该路径。

### 3. 读取放行

页面文件在本会话落盘目录内，由已有的本会话落盘目录 `read` 规则放行（[permissions.md](../architecture/permissions.md) 第 6 节），不另写规则。

### 4. 派生视图（`SessionView.pages`）与回退/分叉

- `packages/core/src/protocol/pages.ts` 与 `packages/core/src/protocol/view.ts` 在 `SessionView` 上派生 `pages: SessionPage[]`：
  - 每项包含 `{ page, title, display, versions }`。`title` 为最新一版标题，`display` 取有效版本第一版的显示方式。
  - `versions` 每项为 `{ version, file, title, seq }`，按事件顺序排列。
- 识别逻辑不按工具名硬编码，沿用「成功 `tool.completed` 中带有有效 `inline.title` 的附件」规则。
- 页面与版本完全由有效持久事件派生。回退（`session.rewound`）后，归约器按 `effectiveEvents` 重建 `pages`，撤去转面板的版本后，若剩余版本均为 `inline`，整页恢复内嵌。分叉（`forkSession`）按分叉点之前的有效版本派生。
- 0.62.0 日志中第一版标为 `inline` 的页面，后续版本即使记为 `panel`，仍随整页派生为内嵌。落盘事件无需迁移。

### 5. 桌面端：入口行、右侧面板「页面」标签与自动打开

- **面板页面入口行**（修订 ADR-0088 第 1 节第 4 条、第 6 条）：`SessionPage.display` 为 `panel` 时，页面的每个版本在回复中都显示为一行可点击、键盘可达的入口（页面图标 + 标题 + 弱化等宽 `v<n>` + `right_small` 箭头）。点击入口会打开该页面的右侧面板标签并定位到对应版本，面板正展示的版本入口显示选中样式。
- **内嵌页面**：`display: "inline"` 的每个版本仍按 ADR-0088 原地渲染在对应回复里（自适应高度、超过 420px 折叠、全屏）；右上角浮动工具栏只提供全屏。
- **运行中与失败**：工具行显示规则不变（运行中摘要按 `title || page` 取值）。
- **右侧面板「页面」标签**（`kind: "page"`）：
  - 每个会话每个页面至多一个标签，标签标题取页面最新标题，配页面图标；
  - 顶部工具栏左侧为 `‹ n / N ›` 版本切换（等宽数字，到达首/末版时对应箭头置灰），右侧为下载（保存当前显示版本为 `.html` 或 `.png`，复用全屏下载菜单与沙箱截图协议）。布局由 [ADR-0060](ADR-0060-desktop-side-panel.md) 的面板最大化统一控制；
  - 内容区由沙箱 iframe 填满、内部滚动。面板与全屏共用 `data-nct-fullscreen="true"`，此时空壳让 `body` 至少与视口等高，使页面设在 `body` 上的背景铺到底。根元素保留主题底色，供 `body` 背景透明时显示。内嵌模式按内容测高；沙箱协议、CSP、主题动态注入与 Tauri IPC 封锁复用 ADR-0088；
  - `panelSessions` 仅持久化标签打开标记（`kind: "page"`、`page`、`title`），不存 HTML 内容，内容始终从 `SessionView.pages` 读取，规则同合奏标签。
- **自动打开规则**：
  - 仅针对 `display: "panel"` 的页面：当前会话收到实时 `tool.completed` 新建或更新面板页面时，自动打开面板并切到该页面标签显示最新版；
  - 若该页面标签已打开且用户正停留在旧版本，不强行跳到最新版，`N` 随视图递增；
  - 历史回放、切换会话、重新打开旧会话时不自动打开。

### 6. 手机网页、安卓 App 与 TUI

- **手机网页与安卓 App**：面板页面的每个版本都显示为入口行。点击入口行进入全屏遮罩并定位到对应版本。内嵌页面仍在回复中原地显示，提供全屏操作。两种页面的全屏视图都铺满视口，提供 `‹ n / N ›` 版本切换并可下载当前查看的版本。手机端由用户点按打开全屏。
- **TUI**：原有 `▣ <标题>`（ASCII 模式 `[] <标题>`）在携带版本号时于末尾附加弱化 ` v<n>`；旧会话无 `version` 时不附加。其他行为不变。

## 兼容性

- **协议与旧版 Runtime**：`packages/core/src/protocol/schema.ts` 的 `toolResultFileAttachmentSchema` 中 `inline` 使用普通 `z.object(...)`（非 `.strict()`），新增 `page`、`version`、`display` 均为可选字段；旧版 Runtime 读取新日志时自动剥离未知字段而不报错，不提升 `formatVersion`。
- **旧会话**：历史日志中 `inline` 不含 `page` 的页面，在 `SessionView.pages` 中各自映射为一个单版本、`display: "inline"` 的页面，页面 id 采用 `legacy-<file>`（例如 `legacy-file-1.html`），与新建页面 `page-<n>` 永不冲突，渲染表现与原先完全一致。

## 不做的事

- 不做跨会话页面库、页面持久化数据存储、页面内调用模型或放宽 CDN / 网络白名单；这些属于后续轮次，本轮不触碰 ADR-0088 的断网与沙箱安全边界。

页面持久化和模型调用见 [ADR-0111](ADR-0111-page-storage-and-model.md)。

## 修订（2026-11-23）

原来的工具说明按内容种类建议内嵌图表和示意图，用户要求制作、需要反复查看和修改的架构图也因此挤在回复中。第 1 节改为按页面用途选择，第 4 至 6 节规定更新时转入面板、各版统一用入口行以及回退后的显示规则。其中按页面用途选择显示方式、更新转面板及内嵌页面的「在面板打开」入口，均已在第二次修订撤回。

短内容的页面在面板或全屏中曾露出主题底色，因为自动高度的根元素无法为 `body` 的百分比最小高度提供基准。第 5 节改用视口高度作为 `body` 的最小高度，让页面背景铺到底。

## 修订（2026-11-23 二）

用户需要页面在后续修改中保持原来的阅读位置。更新和回放按第一版确定显示方式，内嵌页面的浮动工具栏只保留全屏。新建默认内嵌，按显式要求使用面板，新增 [ADR-0076](ADR-0076-work-modes.md) 的 `/cadenza` 入口。桌面标签栏提供 [面板最大化](ADR-0060-desktop-side-panel.md)，让当前标签占用对话区域并保留现有工具栏。上次修订的页面背景铺满视口规则继续沿用。

跨会话项目页面库与跨会话接着改见 [ADR-0114](ADR-0114-project-page-library.md)。
