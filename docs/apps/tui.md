# TUI（`nctrn`，交互终端默认界面）

> 状态：v0.3 已发布；v0.4 按 [ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 实施中｜前置阅读：[apps/cli.md](cli.md)、[protocols/view.md](../protocols/view.md)｜代码位置：`apps/tui/`

`apps/tui` 是 Nocturne 的终端界面客户端：与 CLI 驱动同一套 Runtime，只消费公开 API（`@nocturne/core`）与 `protocol`（含 `SessionView` reducer）。TUI 不包含任何 Agent 逻辑，不复用 CLI 的渲染代码，不自行做事件投影。

## 1. 启动入口

v0.3 起，**stdin 与 stdout 都是 TTY 时 `nctrn` 默认启动 TUI**（含 `-c`/`--resume`）：CLI 完成参数解析、配置收集、会话选择后，把已打开的 `Session` 与 `Runtime` 交给 `runTui(session, runtime, opts)`。v0.4 起默认形态是**全屏模式**；`--inline` 选普通屏幕模式（§2 末节）；`--cli` 进入逐行 REPL；`--tui` 保留为兼容参数。界面参数与 `--cli`/`-p`/`--print`/`--sessions` 互斥，冲突为用法错误退出码 2。任一端非 TTY 时自动走逐行模式，不因"默认选择 TUI"报错；显式 `--tui` 在非 TTY 下保持原语义退出码 2（§5）。

取舍理由不变：会话选择语义只有一份实现，在 CLI 启动路径内；CLI→TUI 的依赖边界见 [modules.md](../architecture/modules.md) 第 1 节，逐行路径不加载 React/Ink。

首次配置流程（provider-setup.md 第 1 节）：`nctrn setup` 在 TTY 下直接打开服务商页（第 1 步），`Esc` 完成后无默认模型时自动进模型选择页（第 2 步）；没有已配置服务商时运行 `nctrn` 走同一流程，选完模型才创建会话。此时 `runTui` 以**无会话形态**启动，注入 `openSession` 回调完成延迟装配（§10）。

本阶段**不做**独立 `nctrn-tui` 命令（见 §11）：它要么复制启动逻辑，要么要求把会话选择语义上移 Core——后者会把 CLI 的参数结构与交互确认带进 Core，违反模块边界，见 §10。

## 2. 界面布局

v0.4 起主对话运行在**全屏模式**（[ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 第 1 条）：启动即进入备用屏幕，Ink 渲染固定高度的帧，帧高始终为终端行数减 1。顶部是对话视口——只布局与渲染可见行；底部固定为浮层/权限框、斜杠候选、输入框和状态栏。模型选择页、服务商页（含向导）是同一全屏内的页面替换，不再进出备用屏幕。

```
┌ 对话视口（只渲染可见行；欢迎区是第一项）
│   欢迎区：弯月标记旁显示版本、模型、目录、快捷键提示
│   › 用户消息
│   助手文本 / 工具行 / 通知（流式输出与进行中工具也在此滚动）
├ 权限确认框 / 浮层（出现时占用视口下沿）
├ ─────────────────────────────────────────────
│ › 输入
│ /model  切换模型                       ← 以 / 开头时，最多 8 行，在输入框与状态栏之间
│ idle • deepseek/deepseek-v4.1-flash • 思考:off • default • ~/repo • 0.1% / 1M
```

- **欢迎区**：四行内容依次为版本、模型与思考档位、当前目录、快捷键提示；空间够时左侧绘制弯月标记，窄屏时只显示这四行文字。ASCII 模式退回 `#`。不显示会话 id 或最近会话列表；MCP 连接失败通过对话通知提示。
- **对话视口**：欢迎、启动通知、已完结条目与流式内容排成同一条内容流；视口只渲染当前可见的行窗口。默认跟随底部（新内容自动滚动到可见）；向上翻阅后停在该位置，新内容到达时状态栏提示"有新内容"，回到底部恢复跟随。宽度变化时整段对话按新宽度重排；已完成条目的渲染结果按「条目 key + 宽度」缓存，流式的那条每次重新渲染。全屏模式下 `/new` 把视口换成新会话、欢迎区重新出现、翻阅状态与选区清空；`/resume` 同此（无分隔行）。
- **思考折叠**：流式思考显示灰色的 `∴ 思考中 12s（Ctrl+O 展开）` 与按当前宽度折行后的最新最多 4 行，光标跟在最后一行；满 4 行后内容在固定高度内更新。正文、工具或 Turn 结束后收为 `∴ 思考了 12s（Ctrl+O 展开）`。恢复历史没有计时，显示 `∴ 思考（Ctrl+O 展开）`；同轮多段分别折叠。计时由 TUI 按消息增量记录，每秒刷新，不进入 Core。窄屏标题截断，ASCII 模式用 `*` 代替 `∴`。折叠行及流式行仍可拖动选中，复制所得是屏幕文字。
- **翻阅**：`PageUp`/`PageDown` 翻一屏、`Ctrl+Home`/`Ctrl+End` 跳顶部/底部、滚轮每格 3 行（`?1006` SGR 上报）。离开底部时状态栏显示"已向上翻阅"，有新内容追加时改显"有新内容"。
- **拖动选中与复制**：视口内左键按下开始、拖动扩展、反色高亮；拖到视口第一行或拖出视口下沿，按住期间持续向上或向下滚动并扩展。列按显示宽度换算，落在中文右半格选中整个字符。选区以「内容行 + 列」记录，滚动与流式追加不错位；宽度重排时清除。松开时非空即复制——折行续行拼回原行、真换行保留、行尾空白去掉；同时写系统剪贴板（Windows `powershell Set-Clipboard`、macOS `pbcopy`、Linux `wl-copy`/`xclip`，文本经 stdin 传入）与 OSC 52，任一成功即在状态栏显示"已复制 N 个字符"约 2 秒，都失败提示失败。单击只清除选区；视口外的按键忽略。
- **助手 Markdown**：用 `marked` 词法分析后按显示宽度排成终端行。标题、强调、行内与围栏代码、嵌套列表、引用、分隔线、表格和链接可读显示；链接显示文字及地址，代码不高亮。窄表格退化为逐行“列名：值”。
- **权限对话框与浮层**：`/resume`、`/context`、`/help`、权限确认、向导确认画在对话区高度内，不另占帧高，也不清除输入框文字。模型选择页与服务商页替换整帧（同一全屏内），关闭后输入框文字仍在。
- **输入行与硬件光标**：`›` 提示符。空间够时上方一条横线。输入内容可展开至 5 行，超过后在输入区内滚动。各输入框按显示宽度登记光标列（中文占 2 列）；登记行是相对帧末的行差，多行输入按当前可见行计算。全屏输出层把登记点换算成绝对行列，并与帧同笔写出；`--inline` 仍在 Ink 写前用 DECRC 恢复、写后用 DECSC 保存，再以上移 `ESC[nA` 和列定位 `ESC[mG` 补位。页面内输入框采用同一坐标约定。粘贴走括号粘贴（Ink `usePaste`），换行统一为 `\n`；多行或超长粘贴显示为单个 `[Paste #n, …]` 占位，提交前展开。
- **斜杠补全**：输入以 `/` 开头时，在输入框下方、状态栏上方显示候选，最多 8 行，格式如 `/model  切换模型`。排序先前缀匹配，再包含匹配。列表打开时 ↑/↓ 移动候选，Tab 补全，Enter 执行，Esc 关闭列表但保留已输入文字。完整命令名加一个空格后进入参数补全：`/effort` 为当前模型档位和 `off`，`/provider` 为子命令与已配置服务商，`/preset` 为四个预设，`/shell` 为 `auto` 与五种 shell 种类（补全只列名字，可用性以选择页为准）。候选与 `/help` 共用同一张命令表。终端太矮时先减少候选行数，再压缩对话区。
- **输入编辑与历史**：Home/End、Ctrl+A/E 到当前行首尾；Ctrl+←/→ 按词跳转，Ctrl+U/K 删至当前行首尾，Ctrl+W 删前词。Ctrl+J 换行；当前行末尾的 `\` 后按 Enter 会去掉 `\` 并换行，其余 Enter 提交。多行时 ↑/↓ 在行间移动；首行 ↑、末行 ↓ 回填当前工作区跨次保存的历史，下翻到末尾恢复草稿。粘贴占位在移动或删除时作为整体处理；存盘前展开原文，历史回填时重新收起。明文文件位置和保留规则见 [config.md](../architecture/config.md)。
- **状态栏**：彩色分段，`•` 分隔——`状态 • 模型 • 思考:档位 • 权限预设 • 目录 • 上下文`。上下文为「百分比 / 上下文长度」，单位大写，例如 `0.1% / 1M`；长度未知时只显示已用量。模型段（欢迎区同）只显示模型 ID，放不下用模型简称，再不行截断；服务商名可能带空格，放进来既长又易误读，服务商在 `/model` 页查看。`思考:` 段只在当前模型有可用档位时显示；Turn 进行中切档显示 `思考:<生效档>→<新档>`。翻阅提示（"已向上翻阅"/"有新内容"）与复制结果提示（"已复制 N 个字符"/"! 复制失败"）短暂占用状态栏左侧提示位。Shift+Tab、Alt+M 只短暂高亮对应段，不往对话区插条目。宽度不足时按 §5 收缩。

### 全屏输出层

全屏视口写满后，跟随新内容会让每一行都换位置；Ink 按行号比较会反复重写整个视口，Windows Terminal 中表现为闪烁。全屏仍由 Ink 生成固定 `rows - 1` 行的完整帧并保持原有约 30 帧/秒节流；`cursor.ts` 截取 Ink 标准 `log-update` 写出的整帧，`output-layer.ts` 与上一帧比较后再写终端。

视口有 1–4 行小幅整体上移或下移，且至少半个视口的行发生位置变化时，输出层以 DECSTBM 把滚动区域限制在对话视口，发 `CSI k S` 或 `CSI k T` 平移，再复位滚动区域，只覆盖新露出的行与其他变化行。较大的翻阅、尺寸变化、页面切换以及无法确认平移的帧逐行覆盖变化行；尺寸或页面变动时覆盖整帧，不发 `ESC[2J`。每帧先隐藏光标，把平移、逐行覆盖、绝对坐标光标补位和显示光标合为一次 `?2026h`…`?2026l` 同步写出。备用屏进入后开鼠标上报、退出前关闭；OSC 52 走帧外写出通道。`--inline` 仍用 Ink 的逐行增量输出和相对光标补位，不经过此输出层。

### 普通屏幕模式（`--inline`）

`nctrn --inline` 走 v0.3 的普通屏幕实现：不进入备用屏幕，已完结内容经 Ink `<Static>` 追加进终端回滚区（终端原生滚轮、选中、复制、搜索可用），底部活动区按 `rows - 1` 预算重画；模型/服务商页打开时临时进出备用屏幕；不开启鼠标上报、不提供程序内翻阅键与拖动选中。输入法光标仍由 `cursor.ts` 登记补位，使用相对移动。退出时无需恢复主屏，`<Static>` 内容留在回滚区。

### Ctrl+O 思考展开

全屏模式在对话区原位切换全部思考段：折叠时为计时行与流式最新 4 行，展开时为不带快捷键提示的计时行及灰色、缩进两格的全文（含流式内容）。工具行和正文顺序不变。切换时清除选区；跟随态仍在底部，翻阅态按顶部条目与条目内偏移保持锚点。展开状态仅在本次运行有效，切换会话后保留；状态栏持续显示「思考已展开（Ctrl+O 收起）」，短暂提示结束后恢复。展开思考的复制结果去掉显示缩进并拼回折行。没有思考时仅提示，不切换。

`--inline` 的已写回滚区无法重画；Ctrl+O 临时进入备用屏幕中的「完整记录」页，按展开形态重排全部对话。可用 PgUp/PgDn、方向键与 Ctrl+Home/End 翻阅；不开鼠标上报。Esc 或 Ctrl+O 返回，草稿保留，并沿用 ADR-0017 的 Windows stdin 保护。权限确认框打开时 Ctrl+O 不响应。

## 3. 键位与交互（对照 cli.md）

| 场景 | CLI（REPL） | TUI |
|---|---|---|
| 提交输入 | Enter 提交一行 | Enter 提交输入框内容 |
| 斜杠命令 | `/help /model /preset /effort /context /compact /resume /new /clear /mcp /provider /shell /exit /quit`（`/provider` 子命令见 [provider-setup.md](../architecture/provider-setup.md) 第 1 节） | 同一集合；`/model` 打开全屏模型选择页（§7），`/provider` 打开全屏服务商页（§8），`/resume` 弹出列表选择器（↑↓ + Enter，Esc 取消），`/context` 弹出可滚动报告面板（请求携带图片附件时含 `images <count> 张 ~<tok> tok` 行，context.md 第 5 节），`/mcp` 弹出服务器状态面板（复用 Panel 组件，Esc/Enter 关闭），`/shell` 弹出 shell 选择器（`auto` 加五种探测结果，未安装灰显不可选、光标自动跳过，当前值高亮；被 `NOCTURNE_SHELL`/`config.json` 覆盖时页面顶部说明「写入 settings.json 但不生效」，ADR-0022 第 4 节）；`/shell <种类>` 直接切换，未安装的种类在写盘前被拒绝并列出可选项（`invalid_command`）。命令名与效果完全一致 |
| 权限确认 | `a`/`s`/`p`/`d`/`x`，`d <文本>` 带反馈 | 同五键；`d` 先进入反馈行：`Enter` 发送拒绝（内容为空 = 不带反馈，等价裸 `d`），`Esc` 退出反馈行回到五选项 |
| 中断 | Ctrl+C：Turn 中中断；权限提示中取消；空闲退出 | 同：pendingPermission 时先中断（结算为 cancelled）；busy 时中断 Turn；空闲时退出。**例外**：存在选区时 Ctrl+C 复制并清除选区，不中断、不退出 |
| EOF/退出 | Ctrl+D、`/exit` | Ctrl+D（空闲）、`/exit`、`/quit` |
| 展开思考 | 无 | Ctrl+O 全屏原位展开/收起；`--inline` 打开/返回完整记录页；权限确认框打开时不响应 |
| 恢复 | `--resume <id>` / `--continue` | 同参数 |
| 会话列表 | `--sessions` 打印后退出 | 同（`--tui` 不改变 `--sessions` 的只读退出行为） |
| 会话内切换 | `/resume`（REPL：编号列表，`/resume <id>` 直达） | `/resume` 弹出列表选择器（复用 PickList 组件，Esc 取消）；`/resume <id>` 直达。切换语义见 §6 |
| 跨目录恢复确认 | `y/N` 提问（默认拒绝） | 确认对话框，默认拒绝（启动恢复与 `/resume` 一致） |
| 恢复摘要/警告 | stderr 行 | 提示区 `!` 行（挂载与 `/resume` 切换时写入 clientLines） |
| 忙时输入 | "会话忙，稍后再试" | 输入框禁用，状态栏显示当前状态；Ctrl+C 中断 |
| 退出码 | 交互模式 0；用法/配置/恢复错误 2；中断 130 | 正常退出 0；启动错误同 CLI 映射（2）；显式 `--tui` 在非 TTY 报 2 并提示 `nctrn --cli` 或 `nctrn -p` |

对话输入之外的全局键：`Esc` 次序最前是清除选区，然后依次关闭补全列表、弹层或权限反馈行；没有这些焦点时忙碌中中断 Turn，空闲时不退出、不清空输入。选区存在时其他按键（翻阅键除外）清除高亮。拆成 Esc + 字母的 Alt 组合在 80ms 内不会误中断。`Tab` 在权限对话框选项间移动焦点；补全列表打开时 `Tab` 补全当前候选。`Shift+Tab`（`\x1B[Z`）在输入框状态下循环思考档位 `[off, …当前模型可用档位]`，只高亮状态栏，不插入对话条目；Turn 进行中同样可切，新档位从下一个 Turn 生效（状态栏显示 `思考:<生效档>→<新档>`，ADR-0018）。权限确认框内 `Shift+Tab` 仍是反向移动焦点。当前模型没有可用档位时 `Shift+Tab` 不响应、不插入提示。

`Alt+M` 在 `read-only → default → auto-edit → full-access` 间循环，走与 `/preset` 相同的 `setPermissionPreset`（`session.config_changed`），Turn 进行中同样拒绝；只高亮状态栏，不插入对话条目。Windows Terminal 发送 `\x1bm`，必须能识别；若把 Alt 拆成 Esc 加字母，吞掉该字母，不写入输入框，也不触发其他操作。

不带参数的 `/preset` 与 `/effort` 打开活动区内的选择列表，高亮当前值，↑/↓ 选择、Enter 生效、Esc 取消；`/effort` 仅列出当前模型的可用档位与 `off`，不支持思考的模型只显示说明。带参数的调用和逐行 CLI 的可选值输出不变（[ADR-0021](../decisions/ADR-0021-tui-daily-usability.md) 第 8 条）。

翻阅对话用 `PageUp`/`PageDown`（一屏）、`Ctrl+Home`/`Ctrl+End`（顶部/底部）和滚轮（每格 3 行）。`--inline` 模式下翻阅仍是终端原生行为，这些键不接管。

## 4. 渲染模型

- Ink + React 沿用 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)。主界面使用 `incrementalRendering: true` + 备用屏幕，帧高 `rows - 1`；对话区只布局可见行窗口（`viewport.ts`），已完成条目的行布局按「条目 key + 宽度」缓存（`lines.ts`），宽度变化整段重排并清除选区。
- **鼠标**：进入全屏后开启 `?1000h ?1002h ?1006h`；SGR 鼠标序列（`ESC [ < b ; x ; y M/m`）在 stdin 进入 Ink 之前摘除并解析成事件（`mouse.ts`），序列跨数据块截断时缓存拼接，绝不漏给 Ink 当成按键。退出、未捕获异常、任何恢复主屏幕的路径先按 `?1006l ?1002l ?1000l` 反向关闭。
- **选区与复制**：`selection.ts` 以「绝对内容行 + 列」记录选区，`clipboard.ts` 负责复制——系统剪贴板按平台 spawn 剪贴板命令（文本经 stdin），OSC 52（`ESC ] 52 ; c ; base64 BEL`）经 `cursor.ts` 的 stdout 代理在 Ink 帧之外写出。剪贴板不经 Core，不新增运行时依赖。
- **退出**：提交已接受但尚未写入 `turn.started` 时也视为忙：先中断并等待 Turn 收束，再关闭鼠标上报 → 恢复主屏幕 → 把本次会话对话按当前宽度渲染成纯文本行打印到主屏（不含输入框和状态栏；思考按退出时显示形态导出：折叠时只留折叠行，展开时保留灰字全文的纯文本；欢迎区只保留文字，不导出弯月像素）→ 打印「会话 \<id\> 已保存，nctrn -c 继续」。异常路径至少保证鼠标关闭与主屏恢复。
- **diff 展示**：`tool.completed.output` 的结构化 diff（edit/write 工具已声明）直接渲染，红绿着色（NO_COLOR 时仅用 `+`/`-` 前缀）；大 diff 折叠为头尾若干行 + 省略计数，`spillPath` 存在时提示查看完整文件。新建文件（`output.created`）没有 diff，全屏模式按输入的 `content` 铺成 `+` 行，同样折叠。全屏模式在摘要行（已修改/已创建 …）下方接 diff，不显示 `@@` 头；出错的调用只显示错误。
- **工具行**：`● name <输入摘要>` + 状态徽标（awaiting → `?`，running → 转轮，ok/error → `✓`/`✗`，denied/cancelled/interrupted → 对应词）。`liveOutput` 只显示尾部 N 行。`task`（子代理，Phase 6）的进行中行同样靠 `liveOutput` 展示一行式进度摘要（`tool.progress` `stream:"info"`），无新增视图通道（[subagent.md](../architecture/subagent.md) 第 12 节）。
- **MCP 状态（Phase 5）**：`mcp.server` 是临时事件、不进 `SessionView`（reducer 忽略未知类型）；`failed`/`crashed` 经 `runtime.warning` 进入提示区，`/mcp` 面板按 `session.mcpServers()` 展示每台服务器的状态、工具数与失败原因。Hook 的可见效果走既有事件（`permission.resolved source:"hook"`、`tool.completed`、`runtime.warning(code:"hook_failed")`），不新增 UI 通道。
- **宽字符**：所有截断/对齐经显示宽度计算（Ink 内建 string-width），中文文本不掰断。

## 5. 降级行为

| 条件 | 行为 |
|---|---|
| stdin/stdout 非 TTY | v0.3 起自动使用逐行 REPL（`--cli` 同形态），不再因默认选择 TUI 报错；显式 `--tui` 仍报错退出 2 并提示 `nctrn --cli` 或 `nctrn -p`。`runTui` 直接调用非 TTY 时同样退出 2 |
| `--inline` | 普通屏幕模式（§2 末节）：`<Static>` 回滚区、终端原生滚轮与选中，不进入备用屏幕、不开启鼠标上报；与 `--cli`/`-p`/`--sessions` 互斥 |
| `NO_COLOR` 或 `TERM=dumb` | 禁用颜色与转轮动画；布局与符号不变 |
| `NOCTURNE_ASCII=1`（显式开关） | 框线、徽标退回 ASCII（`-`/`+`/`*`/`->`）；默认输出 Unicode |
| 宽度 ≥80 | 欢迎区弯月与文字并排，状态栏显示完整分段与目录；diff 显示较多上下文 |
| 40–79 | 欢迎区空间足够时仍并排，否则保留四行文字；状态栏隐藏目录段；diff 上下文收窄，工具输入摘要截断 |
| <40 | 欢迎区保留四行文字；回滚内容照常写入 `<Static>`，摘要按宽度截断；状态栏优先保留状态与上下文，权限对话框收紧布局 |
| 运行时 resize | 全屏：按新行数重算帧高（`rows - 1`），整段对话按新宽度重排并清除选区。`--inline`：活动区按新预算重排，已写入回滚区的内容不重排 |
| Windows Terminal | v0.4 的终端验收目标；全屏接管滚轮与拖动选中后，终端原生搜索在全屏页内不可用、右键粘贴改用 `Ctrl+V`、`Shift+拖动` 走终端原生选中；输入法光标由 `runTui` 补位（见 §2 输入行） |

## 6. 会话切换与恢复

会话内切换走 **`/resume` 斜杠命令**（REPL 与 TUI 同一套语义，cli.md 第 4 节为唯一主文档）：

- `/resume`：列出 `runtime.listSessions()`，TUI 弹出 PickList 列表选择器（↑↓ + Enter，Esc 取消）；每行以首条用户消息首行和相对修改时间开头，后列 id、模型、路径及锁定标记，首句在可用宽度内截断；`/resume <id>` 直达。首句为空时显示占位。
- `/new`（`/clear`）：CLI 注入新建会话回调，沿用当前模型、思考档位和权限预设；成功后切到空会话。全屏模式下视口整体换成新会话——欢迎区重新出现、翻阅状态与选区清空，旧会话仍可 `/resume`；`--inline` 模式下旧内容与分隔行保留在回滚区。忙时拒绝，不清屏。
- **打开逻辑只在 CLI 有一份**：`runTui(session, runtime, { switchSession })`，`switchSession(id, { allowForeign? }) => Promise<SessionSwitchResult>`，结果为 `{ kind: "ok"; session } | { kind: "busy" } | { kind: "foreign"; workspaceRoot } | { kind: "error"; message }`。TUI 不直接打开会话，Core 不新增入口。跨目录确认在客户端完成：回调先返回 `kind: "foreign"`，TUI 弹确认对话框（默认拒绝）同意后带 `allowForeign` 重调。
- **切换顺序**：提交已接受但尚未写入 `turn.started` 时也拒绝 `/new`、`/resume`，提示会话忙；模型页、服务商页也只在提交收束后打开。切换回调等待期间拒绝新提交，输入框提示稍候；先打开新会话——锁冲突/日志损坏/跨目录被拒时报错并**留在原会话**；打开成功后才 `close()` 旧会话、释放锁。
- **切换后**：新建 `SessionView`，重放新会话的持久事件。全屏模式视口直接换成新会话；`--inline` 模式下已写入终端滚动区的旧内容无法收回，向回放区插一条"已切换到会话 \<id\>"分隔提示，再附恢复摘要（若有修复）。
- 离线测试覆盖：切换成功、取消、锁冲突后留在原会话、Turn 进行中拒绝、切换后视图重放。

## 7. 模型选择页

`/model` 打开全屏的模型选择页。v0.3 起 `/provider` 不再打开此页——服务商管理在 §8 的服务商页；本页左栏仍保留 `○` 未配置预设，Enter 后在页内嵌入添加向导（便于选模型时发现缺服务商），完成后回到本页并选中新服务商。只在会话空闲时可打开，前置条件与 `setModel` 一致；会话忙时提示"会话忙"。

**页面切换**：全屏模式下页面直接替换同一帧的内容区，不进出备用屏幕；`--inline` 模式才临时切入备用屏幕、关闭后恢复普通屏幕原位（[ADR-0017](../decisions/ADR-0017-model-picker-alternate-screen.md)）。两种模式下输入框草稿和对话内容都保留。服务商页同此。

**布局**：

```text
┌ 范围 ────────┬─ 搜索: [________________] ────────────────┐
│ ▸ 最近使用   │  deepseek/deepseek-chat   R I  128k  $0.27/1.10
│   全部模型   │  openrouter/gpt-5.2-codex R    400k  $1.75/14
│ ──────────── │ ────── 最近使用 ─────────────────────────
│ ● deepseek 2 │  anthropic/claude-opus-4.6    200k  $15/75
│ ● openrouter │  …
│   412        │
│ ──────────── │
│ ○ anthropic  │
├──────────────┴─ deepseek/deepseek-chat ─────────────────┤
│ 上下文 128k • 最大输出 8k • $0.27/1.00 每 M • 推理 • 图片 │
│ 输入 • 当前会话 • 默认模型                                │
│ ←→切换栏 ↑↓移动 /搜索 Enter选择 PgUp/PgDn翻页 Esc关闭     │
└──────────────────────────────────────────────────────────┘
```

`R` = 推理标记、`I` = 图片输入标记（ASCII 降级下同样可用；`●`/`○` 在 `NOCTURNE_ASCII` 时退回 `*`/`o`）。

- 左栏从上到下：范围两项（「最近使用」「全部模型」）；分隔线；已配置的服务商（`●` + 名称 + 模型数）；分隔线；尚未配置的预设服务商（`○` + 名称）。
- 右栏：顶部搜索框；其下模型列表——焦点在「最近使用」时只列最近项，焦点在「全部模型」或某服务商时列对应集合且最近使用的模型置顶、以分隔线与其余模型隔开；底部详情行显示当前选中模型的全部已知信息，并标出它是否为「当前会话」「默认模型」。
- 最底部一行按键提示。

**按键**：

- `←`/`→` 在左右栏间切换焦点；`↑`/`↓` 在栏内移动；`PageUp`/`PageDown`、`Home`/`End` 翻页/跳首尾（OpenRouter 有数百个模型）。
- 打字自动聚焦右栏搜索框并做模糊过滤；`Backspace` 删除字符；`Esc` 先清空搜索内容，搜索框已空时再按 `Esc` 关闭页面。
- 左栏 `Enter`：选中已配置服务商 → 右栏过滤为该服务商的模型；选中 `○` 预设 → 进入该预设的 `/provider add` 弹层流程，完成后回到本页并选中刚添加的服务商；选中「最近使用」/「全部模型」→ 切换右栏范围。
- 右栏 `Enter`：弹出内联选项条 `[仅本会话] [设为默认]`，`←`/`→` 选择、`Enter` 确认、`Esc` 返回。不用字母键做快捷操作——字母键进入搜索框。确认后关闭页面并调用 `session.setModel`（`仅本会话`）或 `Runtime.setDefaultModel` + `setModel`（`设为默认`）。
- 页面打开期间 `Ctrl+C` 正常退出并恢复主屏幕，不把终端留在备用屏幕里。

**列表列**：`服务商/模型 id`、推理标记、图片输入标记、上下文长度（`1m`、`262k` 式缩写）、价格（`$输入/输出`，每百万 token）。**只显示上游或配置明确声明的值，未声明的留空或 `?`，不编造数据**。不做智能分、不做角色分配。首字延迟、吞吐两列本轮不做（下一步做本机实测），但布局预留列位。

**数据来源**：模型集合 = 各已配置服务商 `providers.json`/`config.json` 条目中的 `models`（向导与 `/provider refresh` 写入的上游列表），字段映射见 [provider-setup.md](../architecture/provider-setup.md) 第 7 节；「最近使用」= `runtime.listRecentModels()`（recent-models.json，provider-setup.md 第 2 节）；「当前会话」= `session.getModel()`；「默认模型」= `runtime.defaultModel()`。

**窄终端**：宽度 < 80 列时隐藏左栏只显示右栏，左栏范围改用 `←`/`→` 循环切换（最近使用 → 全部模型 → 各服务商）；< 40 列沿用第 5 节的降级规则。列宽与截断按 string-width 计算（中文占 2 列）。

**不做**：鼠标操作、角色（Roles）分配、智能评分、本机实测性能数据。

**CLI 对照**：行式 REPL 画不出双栏，`/model` 改为同列信息的编号表格并支持 `/model <关键词>` 过滤（cli.md 第 4 节）；`/model <完整 id>` 的直选行为不变。

## 8. 服务商页

`/provider`（无参）打开服务商管理页（ADR-0019）。全屏模式下替换同一帧的内容区；`--inline` 模式临时进入备用屏幕，关闭后返回普通屏幕。只在会话空闲时可打开；首次配置流程中由启动路径直接打开，不要求已有会话。

**布局**：页面高度锁定为终端行数——页头（Logo/标题/副标题/步骤标记）与底部按键提示始终完整可见，内容超出时只在列表或表单区域内滚动。像素 Logo 只在终端行数 ≥30 且宽度 ≥64 列时绘制；不满足时页头降级为单行文字标题，不画像素 Logo。

```text
┌ <像素 Logo>  Nocturne · 服务商
│ 选择服务商进行配置；可配置多个，完成后按 Esc            ← 副标题
│ 第 1 步，共 2 步                                      ← 仅首次配置流程显示
├ 过滤: [________]
│ ▸ ● deepseek        已配置 • 凭据文件 • 12 个模型
│   ● openrouter      已配置 • 环境变量 OPENROUTER_API_KEY • 412 个模型
│   ○ anthropic       未配置
│   ○ 其他 OpenAI 兼容服务
│   ○ 其他 Anthropic 兼容服务
│   ● commandcode     已配置 • 凭据文件 • 5 个模型        ← providers.json 自定义条目
├ 已保存 command，12 个模型                              ← 结果行（操作完成后出现）
└ ↑/↓ 选择 • Enter 确认 • Esc 返回/完成 • Ctrl+C 退出
```

**列表** = 5 个预设行 + 未被预设覆盖的已配置条目（`providers.json` 自定义条目、`config.json`/项目层手写条目按追加行展示）：

- 预设行按固定顺序：DeepSeek、OpenRouter、Anthropic、其他 OpenAI 兼容、其他 Anthropic 兼容。与已配置条目 id 匹配的预设显示 `● 已配置`（绿色）+ 密钥来源（`凭据文件` / `环境变量 <NAME>` / `缺失`）+ 模型数；未匹配显示 `○ 未配置`。
- 手写配置层的条目（`origin` ≠ `setup`）标注来源层并**只读**：Enter 后提示去哪个文件修改（`config.json` 层 → `<NOCTURNE_HOME>/config.json`；项目层 → `<工作区>/.nocturne/config.json`；env/cli 层 → 对应环境变量或命令行参数）。
- 当前会话正在使用的服务商加注「当前」标记，删除它被拒绝（提示先 `/model` 切换）。
- 直接打字进入过滤（对 id/标签/主机名做子串匹配），`Backspace` 删字符；`Esc` 先清过滤，过滤已空时再按关闭页面（首次配置流程中为"完成"语义）；`↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` 移动；列表超出可视高度时右侧出滚动条。

**未配置预设 `Enter` → 就地展开步骤**（正文区替换为向导视图，页头页脚保持；步骤编排在 Core `runProviderSetupWizard`，v0.3 起不再含选模型步骤）。向导视图是 omp 风格的就地表单：已完成步骤折叠为一行摘要（`名称 x • 地址 y • 密钥已保存`），只展开当前步骤——当前提问用强调色、下方用灰色小字给说明（密钥来源、回车改用环境变量等），不堆叠逐行问答历史：

1. 仅自定义预设问「名称」（必填）与「服务地址」（openai 兼容必填；anthropic 兼容可留空用官方端点）——三个内置预设直接跳过名称与地址；
2. 「API Key」掩码输入（`*` 回显）：输入后回车 → 交系统凭据后端；直接回车 → 环境变量路径（问「凭据环境变量名」，默认取预设 `defaultKeyEnv`）；后端不可用时直接进环境变量路径；
3. `GET /models` 拉模型列表与限额（不发模型请求，provider-setup.md 第 7 节）：进行中显示「正在获取模型列表…」，完成后被结果行替换——成功为 `✓ 已获取 N 个模型`；失败显示原因并继续后续步骤（401/403 → 密钥可能无效；404/网络错误等 → 模型将手动填写），保存后可用「刷新模型列表」重试；
4. 上游列表未声明思考能力 → **单步档位勾选**（ADR-0019 第 2 条；ADR-0018 规则不变，仅交互形式调整）：选项列表首项为「不支持思考强度」，与其余六档互斥；`↑`/`↓` 移动、`空格` 勾选、`Enter` 确认；什么都不勾直接回车同样等于不支持；
5. 保存 → 回列表，底部结果显示如 `已保存 command，12 个模型`（未取到模型时为 `已保存 <id>`）。

**已配置条目 `Enter` → 操作菜单**（内联选项条，`←`/`→` 移动、`Enter` 执行、`Esc` 返回）：

| 操作 | 效果 | 等价子命令 |
|---|---|---|
| 换密钥 | 掩码输入新密钥 → 系统凭据后端 | `/provider key <名>` |
| 刷新模型列表 | 重新 `GET /models` 写回限额与能力标记；不覆盖 `thinking.levels` 用户声明 | `/provider refresh <名>` |
| 调整思考档位 | 重走单步档位勾选（首项「不支持思考强度」互斥） | `/provider thinking <名>` |
| 编辑模型 | 进入模型列表子视图（见下）；`/provider model <名> [<模型>]` 直达 | `/provider model <名> [<模型>]` |
| 删除 | 选项式确认框（默认焦点在「取消」；`←`/`→`/`↑`/`↓` 移动、`Enter` 执行、`Esc` 取消）确认后删除条目与凭据；当前会话使用的拒绝；只读条目不可达 | `/provider remove <名>` |

**模型编辑子视图**（ADR-0024 第 5 节）：「编辑模型」把内容区换成**模型列表**——页头面包屑 `服务商 <名> › 模型（N）`，下一行与服务商页一致的 `过滤: <query>`；行显示模型 id、`上下文/最大输出` 缩写与 `R`（推理）/`I`（图片输入）能力标记，按模型 id 排序、按显示宽度对齐。`Enter` 进**模型编辑页**，`Esc` 返回列表再返回服务商列表。底部按键提示 `↑/↓ 选择 • Enter 编辑 • Esc 返回 • Ctrl+C 退出`（子视图打开时服务商页自身不再追加提示行，全页只有这一行）。只读服务商（手写层条目）`Enter` 不进操作菜单，直接进模型列表的**只读查看**——面包屑下方显示 `readonlyHint`（该条目定义在哪个文件/环境），底部提示改为 `只读 • Esc 返回 • Ctrl+C 退出`，编辑页所有字段灰显不可聚焦。

**模型编辑页**：面包屑 `服务商 <名> › <模型>`；每行 `字段名  当前值  来源`，列按显示宽度对齐：字段名列固定 10 列，**值列宽为 `min(本页值文本最大显示宽度, 32)`**，来源列紧跟其后占剩余宽度、放不下时从左侧截断（保留文件名）。来源文案为 上游 / 用户编辑 / 由 <文件> 决定（config.json 层为文件路径、项目配置为项目配置路径、env 为环境变量、cli 为命令行）/ 内置 / 默认 / 服务商思考档位 / 按推理能力推导 / 「推理为 none，不可切换」。当前值规则：可编辑且无用户编辑的字段显示 `跟随（<生效值>）`（生效值未声明显示 `未声明`）；草稿改回跟随/清空后显示回落到的下层值；来源为手写层的只读字段直接显示生效值、不出现「跟随」；`reasoningEffort` 被显式 none 锁定时该行显示 `—` 且不可聚焦。焦点行以 `›` 前缀标示。六个字段：

- 显示名、上下文长度、最大输出：直接键入编辑（输入框预填用户编辑值；留空 = 跟随；数字按原始整数显示）；
- 图片输入：`←`/`→` 在「跟随 / 是 / 否」间切换；推理：「跟随 / none / hidden / visible」；
- 思考档位：`Enter` 打开多选弹层（与思考档位向导同一勾选交互）：首项「跟随」与「不支持思考强度」（= 空数组）各自独占互斥，其余六档；弹层打开时编辑页提示行隐去，弹层底部 `空格勾选 • Enter 确认 • Esc 取消 • Ctrl+C 退出`；
- `↑`/`↓` 移动时跳过不可编辑行（只读灰显）；来源为 `config.json` 等手写层的字段不可聚焦。

底部 `[保存]` `[取消]` 与按键提示 `↑/↓ 移动 • ←/→ 切换 • Enter 编辑/确认 • Esc 取消 • Ctrl+C 退出` 各占一行。保存经 `saveModelSettings` 写入 providers.json 的 `userModels`，成功后 reload 配置 + `updateProviders` 并回列表、结果显示行；校验失败在编辑页内显示原因不退出。`Esc` 取消不保存。`/provider model <名> [<模型>]` 打开服务商页直达模型列表（带模型 id 时直达该模型的编辑页）。

**全页无打字是非题**（ADR-0019 第 2 条）：所有是非与多选交互都用 `↑`/`↓`/`←`/`→` + `空格`/`Enter` 完成——包括删除确认与思考档位勾选，页面上不出现需要键入 `y`/`N` 回答的提问。

**向导对外只发 `GET /models`**（provider-setup.md 第 1、6 节）：不做连接测试、不发模型请求；测试用 fake fetch 断言只出现 `GET /models`。

**不做**：页内选模型（去 `/model`）、密钥明文回显、鼠标操作。

## 9. 工程约束

- `apps/tui` 只允许依赖 `@nocturne/core`、`@nocturne/core/protocol` 两个入口及批准的终端依赖（ink、react、string-width、marked；`ink-testing-library` 为 devDependency）。CLI 仅可惰性加载 `@nocturne/tui`，或静态引用 `@nocturne/tui/slash-catalog`；后者不得 import 任何模块，以免逐行模式加载 Ink。依赖方向见 [modules.md](../architecture/modules.md) 第 1 节。
- 目录：`src/index.ts`（`runTui`：全屏/普通屏幕装配、鼠标上报开闭、退出导出）、`src/app.tsx`（界面状态与布局）、`src/lines.ts`（`SessionView` → 内容行块，按条目 key + 宽度缓存布局）、`src/viewport.ts`（可见窗口选择）、`src/scroll.ts`（翻阅状态）、`src/mouse.ts`（SGR 鼠标序列解析与 stdin 包装）、`src/selection.ts`（选区坐标与高亮/复制文本）、`src/clipboard.ts`（系统剪贴板 + OSC 52，只用 Node 内置模块）、`src/cursor.ts`（硬件光标补位与帧外写出通道）、`src/output-layer.ts`（全屏帧差异写出与滚动区域平移）、`src/frame.ts`（活动区高度预算）、`src/alt-screen.ts`（`--inline` 与首配流程的临时备用屏）、`src/markdown.ts`（助手文本排版）、`src/slash-catalog.ts`（`/help` 与补全共用的命令表，CLI 经子路径引用，不加载 Ink）、`src/commands.ts`、`src/session-view.ts`、`src/env.ts`、`src/theme.ts`、`src/format.ts`、`src/components/`（StatusBar、Composer、ProviderPage、ModelPicker、WizardView 等）。
- 测试：reducer 不变量在 `packages/core` 测（view.md §8）；TUI 组件用 `ink-testing-library` 断言渲染帧（含 40 列窄终端帧与欢迎区/状态栏降级）；交互路径用注入假 Session 的集成测试（offline）；服务商页覆盖列表/过滤/就地步骤/操作菜单/模型编辑子视图/Esc/Ctrl+C。
- **显示宽度**：按 `string-width` 预算中文和动态文本，框内动态文本经 `format.ts` 的 `boxSafe()` 处理；窄屏时截断摘要和列表字段，边框保留安全余量。
- `runTui` 只消费 Core 公开 API：`subscribe`/`durableEvents`/`submit`/`interrupt`/`respondPermission`/`setModel`/`setPermissionPreset`/`compact`/`close`/`state`/`warnings`/`recovery`/`reasoningEffortInfo`/`describeContext`、`readInputHistory`/`recordInputHistory`、`mcpServers()`（`/mcp` 面板），以及 `runtime.listModels`/`runtime.listSessions`/`runtime.listRecentModels`/`runtime.defaultModel`/`runtime.updateProviders`；会话切换通过 CLI 注入的 `switchSession` 回调（§6），不直接调 `resumeSession`。

## 10. 需要的 Core API 变更

`normalizeModelRef` 上移到 `@nocturne/core`（`provider/model` 归一化语义属于 Provider 层，TUI 的 `/model` 复用）。Phase 5 增补：`session.mcpServers()`（`/mcp` 面板的数据源，`McpServerStatus[]` 只读查询）。

v0.2 增补（provider-setup.md 第 6 节）：模型选择页与 `/provider` 弹层消费 `runtime.defaultModel()`、`runtime.listRecentModels()`、`runtime.updateProviders`，以及配置模块的 `describeProviders`/`saveSetupProvider`/`removeSetupProvider`/`refreshUpstreamLimits`/`setDefaultModel`/`setCredential`；向导各步（预设列表、模型获取）经 `listProviderPresets`/`fetchModels`——向导不发送模型请求。交互外壳留在 TUI，逻辑只在 Core 一份。

v0.3 增补（ADR-0019）：

- `runProviderSetupWizard` 不再包含选模型与"设为默认"两步；`WizardResult` 移除 `model`/`setDefault`、新增 `modelCount`（服务商页底部结果行的数据源）；
- `SessionSummary.firstText?`：`/resume` 列表首句摘要的数据源（列表实现读日志，提取首条 `message.user` 文本）；
- `runTui` 可无会话启动（首次配置流程）：注入 `openSession` 回调，服务商页 → 模型页走完后由 CLI 完成延迟装配；打开会话的逻辑仍在 CLI 一份。

**不上移**：配置收集（`collectSessionConfig`）与会话打开组合（`openSession`）留在 CLI——它们携带 CLI 参数结构与"跨目录确认"这类客户端交互，进 Core 会违反"Core 不依赖客户端"的边界。CLI 单入口保证启动语义只有一份实现，TUI 从 CLI 手里接过已打开的 `Session`（或 setup 完成后的打开回调），不存在漂移面。

不新增事件类型；不改 Agent Loop；权限判定仍只在权限层（对话框只是 `respondPermission` 的 UI）。

## 11. 本阶段不做

- 独立 `nctrn-tui` 命令（需要共享启动语义时再评估，可能以独立命令复制薄壳或重新讨论 Core 入口上移的方式引入）；
- 双击/三击选词选段、页内可点击控件（鼠标只用于滚轮翻阅与拖动选中）；
- @文件补全；
- 代码块语法高亮（助手 Markdown 已做结构化排版）；
- 多会话标签页；
- 工具输出详情查看器/分页器（长输出靠截断 + spillPath，与 CLI 一致）；
- 主题、配色、键位的用户自定义（v0.3 只把颜色集中到主题常量，不开放配置）；
- RPC/Web 客户端（后续阶段，直接复用 SessionView reducer）。
