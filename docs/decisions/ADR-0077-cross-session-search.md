# ADR-0077：桌面端跨会话搜索

- 状态：已接受
- 日期：2026-11-03
- 修订：[sessions.md](../architecture/sessions.md)、[view.md](../protocols/view.md)、[rpc.md](../protocols/rpc.md)、[desktop.md](../apps/desktop.md)、[tui.md](../apps/tui.md)、[roadmap.md](../roadmap/roadmap.md)

## 背景

会话、项目与定时任务增多后，单靠左栏树按项目翻找旧对话或任务成本较高。[路线图](../roadmap/roadmap.md)列了跨会话搜索：在桌面端用侧栏「搜索」入口或全局 `Ctrl+K`（macOS `Cmd+K`）打开统一搜索弹窗，同时检索会话、项目、设计与定时任务，并在选中后直接跳到对应位置。

实现前需要明确六个问题：

1. 会话搜索的范围与匹配字段，尤其是工具输出怎样避免搜到内部 JSON 键名；
2. 现有 `SessionStore.list()` 只读每个日志前 64 KiB，全文搜索怎样读取长日志而不占满内存与文件句柄；
3. 被 `session.rewound` 回退撤回的对话事件仍在只追加日志里，怎样避免命中已不存在的界面条目；
4. 结果条数上限与连续输入时的旧查询取消方式；
5. 打开会话命中结果时，怎样定位并展开默认折叠的工具输出；
6. 是否向远程手机端开放该 RPC 方法。

## 决定

### 1. 范围与桌面端分栏

- 本轮实现 Core 会话全文搜索（`Runtime.searchSessions`）、RPC 方法 `runtime.searchSessions` 与桌面端搜索弹窗（`apps/desktop/src/SearchDialog.tsx`）；TUI 入口留待后续。
- 桌面端左栏在「＋ 新会话」与「定时任务」之间新增「搜索」行，全局快捷键 `Ctrl+K`（macOS `Cmd+K`）开关弹窗；焦点在面板终端（`.xterm`）内时，`Ctrl+K` 留给终端处理。设置页打开期间同样可呼出弹窗，选中结果后退出设置页。
- 弹窗固定五栏：`全部`、`会话`、`项目`、`设计`、`定时任务`。
  - 未输入查询词时：不调用 `runtime.searchSessions`，直接用桌面端已有数据展示 `最近使用`（`全部` 栏按会话更新时间、项目下最新会话时间、定时任务上次运行时间混合取最近 8 条，单类型栏列出该类型全部条目）。
  - 输入查询词后：`项目` 立即在本地匹配项目名称与路径，`定时任务` 立即匹配 `name` 与 `prompt`，不防抖；输入法组字期间冻结过滤，组字结束再更新。只有 `会话` 在 150 ms 防抖后调 `runtime.searchSessions`。`全部` 栏按 `会话`、`项目`、`设计`、`定时任务` 顺序分组，组标题仅在该组非空时出现；单类型栏不显示组标题。
  - 新查询第一批到达前只保留上一次会话列表；第一批替换，后续批次追加，结束以完整响应校准。每行用所属查询高亮：保留的会话行仍使用旧查询，本地行使用当前查询。扫描中会话/全部栏暂时为空时留白，结束且该栏确实无条目才显示 `没有结果`；项目、设计、定时任务栏立即判断空状态。不新增进度文案或控件。
  - 选中项按条目 key 跟踪，用户用方向键或鼠标选过的行，在追加会话导致本地组下移时仍选中同一条（没选过时高亮始终在第一行），Enter 打开同一条；追加不触发滚动，仅键盘导航滚入选中行。输入变化或切栏回到第一行。
  - 产品尚无设计工作区，`设计` 栏数据源通过 `designResults()` 空数组接缝接入，无结果时显示 `没有结果`，不放示例数据或占位宣传语。
  - 已从侧栏移除的项目（`hiddenProjects`）及其下属会话不进入任何结果。

### 2. 匹配规则与工具输出取值

- 子串匹配，不区分大小写（`toLowerCase().includes(...)`）。
- 子会话（`session.created.parent !== undefined`）默认排除，与 `listSessions()` 一致。
- 会话匹配范围限于四类文本：
  1. 会话标题（`SessionSummary.firstText`，含自定义标题旁路缓存与自动生成标题）；
  2. 用户消息正文（`message.user`，经 `userEntryText(payload)` 剥离末尾附加给模型的 `@` 文件、技能、委派、文件附件与执行方式快照块）；
  3. 助手回复正文（`message.assistant.content` 中的 `text` 块拼接，**不搜 `reasoning` 思考内容**）；
  4. 工具输出（`tool.completed.modelContent`，即对话界面展开工具行时展示的同一份文字，**不序列化或搜索 `output` 结构化 JSON 的键名与括号**）。
- 每个会话最多返回一条结果：优先返回日志中第一条命中的有效正文事件（附带去空白后的单行 `snippet`、命中区间 `ranges` 与该事件的 `seq`）；仅标题命中而正文未命中时，返回无 `snippet`、无 `seq` 的条目。
- 片段截取保证首个命中词可见：命中词前最多保留 14 个字符，发生截断时前置 `…`；尾部超出时后置 `…`。

### 3. 不建索引、流式扫描与结果上限

- 不建立独立全文索引。`Platform.fs.readLines(path, signal)` 用流式按行读取完整 `<sessionId>.jsonl`，不复用 `list()` 的 64 KiB 头部切片，因此超过 64 KiB 的长日志尾部照常命中。
- 先取 `store.list()` 得到的顶层会话摘要并按 `mtimeMs` 倒序排列，再以固定并发上限（4 个文件 worker）扫描日志；单行 JSON 损坏或包含未知未来事件时跳过该行，不中断整次搜索。每个文件只在内存里留最早的一条命中事件，不把事件攒成列表：回退只裁掉尾部，最早的命中被裁掉时当时已有的命中都一起没了。
- 每次搜索最多返回 200 条结果，够数后不再打开更旧的日志；超出部分不返回，界面不显示计数或截断提示。
- 可选 `onProgress(batch)` 交出已完成扫描的有序前缀：前面的文件未扫完，后面的完成结果先缓冲；同一轮 microtask 内确定的结果合批交出，批次拼接等于完整响应，已交出的行相对顺序不再变化。取消后不再回调；不引入索引或缓存。

### 4. 回退事件的过滤与跳转定位

- 读到 `session.rewound` 时，把当前保留的命中事件和它一起交给 `effectiveEvents`（`packages/core/src/protocol/rewind.ts`）判断是否被裁掉，复用现有的对话回退裁剪逻辑（`session.rewound` 且 `mode !== "files"` 时丢弃 `targetSeq <= seq < rewound.seq` 的对话事件）。已被回退丢弃的消息与工具结果不会命中，保证搜索结果的跳转目标在 `SessionView.entries` 中真实存在。
- `SessionView` 的 `ToolEntry.seq` 记录的是首个支撑持久事件（通常为 `tool.started`）的 `seq`，而工具输出命中来自 `tool.completed` 的 `seq`。为此在 `ToolEntry` 增加可选字段 `completedSeq?: number`，在归约 `tool.completed` 时记下其 `event.seq`。
- 打开会话搜索结果时：
  - 若带有 `seq`，打开会话后按 `entry.seq === seq` 或 `entry.completedSeq === seq` 找到对应条目，滚入视口中央并对整条消息/工具行做短暂高亮（`Conversation.tsx` 的助手消息由 Markdown 渲染为多节点 DOM，不做跨节点逐字高亮）；
  - 若命中的是工具行（默认收起），自动展开该 `ToolRow` 使工具输出可见；
  - 若仅命中标题（无 `seq`），按正常位置打开会话。

### 5. RPC 取消与远程边界

- RPC 协议没有通用的请求取消帧。服务端在每条连接上维护当前进行中的 `sessionSearch: AbortController`：同一连接收到新的 `runtime.searchSessions` 请求或连接断开时，立即 `abort()` 上一次未完成的扫描（`readLines` 销毁底层读流），被取代的旧请求以空结果 `[]` 结束。桌面端在输入变化及关闭后丢弃旧通知和响应。
- 客户端为每次查询生成 `searchId`，请求可带 `{ query, searchId? }`。带标识时服务端经 `runtime.sessionSearchProgress { searchId, results }` 发送增量，以首次待发批次起 100 ms 固定窗口合并，结束时冲刷尾批，最终返回完整数组；旧客户端省略标识时不发通知。通知仿照 `login.completed` 通过该连接的 `send` 发送，只到发起连接，不广播，远程连接收不到。新请求、断线或完成都会清除待发计时器；被取代的查询不再发送。
- `runtime.searchSessions` **不加入 `REMOTE_METHODS`**：跨会话搜索需要扫描电脑本机全部会话日志，且配套的跨项目、定时任务管理跳转属于桌面端工作台能力，本轮不向手机端开放，手机端（`apps/desktop/src/web/`）不设搜索入口。

## 后果

- 无需维护额外索引文件或处理崩溃后的索引同步，代码与存储结构简单；500 MB 量级日志在有限并发流式读取下保持可控内存占用。
- 未来会话规模增长到全量流式扫描明显变慢时，可在不改 RPC 与界面契约的前提下，在 `SessionStore` 内部引入可从日志重建的 SQLite FTS 索引。
- `ToolEntry.completedSeq` 是纯派生的内存视图字段，不改持久事件格式，也不影响 `formatVersion`。

## 备选方案

- **在 `SessionStore` 维护 SQLite FTS 索引**：查询更快，但需要处理增量写入、回退删除、分叉复制与索引损坏重建；当前规模下直接流式扫描已满足交互要求，按路线图约定先不建索引。
- **搜索 `tool.completed.output` 的 JSON 序列化文本**：会把内部字段名（如 `exitCode`、`spillPath`、`structuredPatch`）搜出来，产生界面上看不到的幽灵命中，故只搜界面实际展示的 `modelContent`。

## 修订

- **2026-11-11（TUI 搜索入口）**：TUI 新增斜杠命令 `/search`（及预填词 `/search <词>`）打开对话区会话搜索浮层，REPL（`--cli`）不设此命令。与桌面端弹窗相比，TUI 只检索会话，不设项目、设计、定时任务分栏与全局快捷键，直接调用本地 `runtime.searchSessions`；浮层交互、行格式、跨会话切换与 `seq` 定位规则以 [tui.md §6](../apps/tui.md#6-会话切换与恢复) 为准。
