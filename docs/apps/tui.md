# TUI（`nctrn`，交互终端默认界面）

> 状态：已接受 v1.0（2026-09-24 验收）；v0.3 修订（[ADR-0019](../decisions/ADR-0019-tui-visual-provider-page.md)、[ADR-0020](../decisions/ADR-0020-tui-fullscreen-rendering.md)，均提议，待验收）｜ 前置阅读：[apps/cli.md](cli.md)、[protocols/view.md](../protocols/view.md) ｜ 代码位置：`apps/tui/`

`apps/tui` 是 Nocturne 的终端界面客户端：与 CLI 驱动同一套 Runtime，只消费公开 API（`@nocturne/core`）与 `protocol`（含 `SessionView` reducer）。TUI 不包含任何 Agent 逻辑，不复用 CLI 的渲染代码，不自行做事件投影。

## 1. 启动入口

v0.3 起，**stdin 与 stdout 都是 TTY 时 `nctrn` 默认启动 TUI**（含 `-c`/`--resume`）：CLI 完成参数解析、配置收集、会话选择后，把已打开的 `Session` 与 `Runtime` 交给 `runTui(session, runtime, opts)`。`--cli` 进入逐行 REPL；`--tui` 保留为兼容参数（与 `--cli` 互斥、与 `-p`/`--print` 互斥，冲突为用法错误退出码 2）。任一端非 TTY 时自动走逐行模式，不因"默认选择 TUI"报错；显式 `--tui` 在非 TTY 下保持原语义退出码 2（§5）。

取舍理由不变：会话选择语义只有一份实现，在 CLI 启动路径内；CLI→TUI 的依赖边界见 [modules.md](../architecture/modules.md) 第 1 节，逐行路径不加载 React/Ink。

首次配置流程（provider-setup.md 第 1 节）：`nctrn setup` 在 TTY 下直接打开服务商页（第 1 步），`Esc` 完成后无默认模型时自动进模型选择页（第 2 步）；没有已配置服务商时运行 `nctrn` 走同一流程，选完模型才创建会话。此时 `runTui` 以**无会话形态**启动，注入 `openSession` 回调完成延迟装配（§10）。

本阶段**不做**独立 `nctrn-tui` 命令（见 §11）：它要么复制启动逻辑，要么要求把会话选择语义上移 Core——后者会把 CLI 的参数结构与交互确认带进 Core，违反模块边界，见 §10。

## 2. 界面布局

启动即进入备用屏幕（[ADR-0020](../decisions/ADR-0020-tui-fullscreen-rendering.md)）。帧高等于终端行数减 1。自顶向下：可滚动对话区，底部固定输入框、可选的斜杠候选、状态栏。

```
┌ 对话区（只布局、只渲染可见行）
│   欢迎区是第一项，随滚动离开：左侧 4 行小像素标记，
│   右侧「Nocturne 版本」「模型 • 思考档位」、当前目录、一行提示
│   › 用户消息
│   助手文本 / 工具行 / 通知
│   已向上翻阅，Ctrl+End 回到最新        ← 离开底部、尚无新输出时占最后一行
├ ─────────────────────────────────────────────
│ › 输入
│ /model  切换模型                       ← 以 / 开头时，最多 8 行，在输入框与状态栏之间
│ idle • commandcode/deepseek-v4 • 思考:off • default • ~/repo • 0.1% / 1M
```

- **欢迎区**：紧凑布局。不画大号像素字，不显示会话 id、最近会话列表和 MCP 分栏。MCP 只在连接失败时在对话里给一条通知。宽度不够并排时改为纵向文字行。
- **对话区**：欢迎、启动通知、时间线条目、流式输出都在同一可滚动窗口里。停在底部时跟随新输出；向上翻阅后停止跟随，未有新输出时显示「已向上翻阅，Ctrl+End 回到最新」，新输出到达后改为「有新内容，Ctrl+End 回到最新」，回到底部则消失。PgUp/PgDn 翻页，Ctrl+Home 到顶，Ctrl+End 到底。不开启鼠标上报，滚轮暂不处理。
- **权限对话框与浮层**：`/resume`、`/context`、`/help`、权限确认、向导确认画在对话区高度内，不另占帧高，也不清除输入框文字。模型选择页与服务商页替换整帧，关闭后输入框文字仍在。
- **输入行**：`›` 提示符。空间够时上方一条横线。主输入、模型搜索、服务商过滤与向导文本框共用按显示宽度定位的硬件光标（中文 2 列），供输入法预编辑定位。补全及历史回填后编辑光标与硬件光标同步到文字末尾。
- **斜杠补全**：输入以 `/` 开头时，在输入框下方、状态栏上方显示候选，最多 8 行，格式如 `/model  切换模型`。排序先前缀匹配，再包含匹配。列表打开时 ↑/↓ 移动候选，Tab 补全，Enter 执行，Esc 关闭列表但保留已输入文字。完整命令名加一个空格后进入参数补全：`/effort` 为当前模型档位和 `off`，`/provider` 为子命令与已配置服务商，`/preset` 为四个预设。候选与 `/help` 共用同一张命令表。终端太矮时先减少候选行数，再压缩对话区。
- **输入历史**：候选未打开时 ↑/↓ 回填本次运行提交过的输入；下翻到末尾恢复翻阅前草稿。回填后光标在末尾。
- **状态栏**：彩色分段，`•` 分隔——`状态 • 模型 • 思考:档位 • 权限预设 • 目录 • 上下文`。上下文为「百分比 / 上下文长度」，单位大写，例如 `0.1% / 1M`；长度未知时只显示已用量。模型段为「服务商/模型 ID」或模型简称，与 `/model` 一致。`思考:` 段只在当前模型有可用档位时显示；Turn 进行中切档显示 `思考:<生效档>→<新档>`。Shift+Tab、Alt+M 只短暂高亮对应段，不往对话区插条目。宽度不足时按 §5 收缩。

## 3. 键位与交互（对照 cli.md）

| 场景 | CLI（REPL） | TUI |
|---|---|---|
| 提交输入 | Enter 提交一行 | Enter 提交输入框内容 |
| 斜杠命令 | `/help /model /preset /context /compact /resume /mcp /provider /exit /quit`（`/provider` 子命令见 [provider-setup.md](../architecture/provider-setup.md) 第 1 节） | 同一集合；`/model` 打开全屏模型选择页（§7），`/provider` 打开全屏服务商页（§8），`/resume` 弹出列表选择器（↑↓ + Enter，Esc 取消），`/context` 弹出可滚动报告面板，`/mcp` 弹出服务器状态面板（复用 Panel 组件，Esc/Enter 关闭）。命令名与效果完全一致 |
| 权限确认 | `a`/`s`/`p`/`d`/`x`，`d <文本>` 带反馈 | 同五键；`d` 先进入反馈行：`Enter` 发送拒绝（内容为空 = 不带反馈，等价裸 `d`），`Esc` 退出反馈行回到五选项 |
| 中断 | Ctrl+C：Turn 中中断；权限提示中取消；空闲退出 | 同：pendingPermission 时先中断（结算为 cancelled）；busy 时中断 Turn；空闲时退出 |
| EOF/退出 | Ctrl+D、`/exit` | Ctrl+D（空闲）、`/exit`、`/quit` |
| 恢复 | `--resume <id>` / `--continue` | 同参数 |
| 会话列表 | `--sessions` 打印后退出 | 同（`--tui` 不改变 `--sessions` 的只读退出行为） |
| 会话内切换 | `/resume`（REPL：编号列表，`/resume <id>` 直达） | `/resume` 弹出列表选择器（复用 PickList 组件，Esc 取消）；`/resume <id>` 直达。切换语义见 §6 |
| 跨目录恢复确认 | `y/N` 提问（默认拒绝） | 确认对话框，默认拒绝（启动恢复与 `/resume` 一致） |
| 恢复摘要/警告 | stderr 行 | 提示区 `!` 行（挂载与 `/resume` 切换时写入 clientLines） |
| 忙时输入 | "会话忙，稍后再试" | 输入框禁用，状态栏显示当前状态；Ctrl+C 中断 |
| 退出码 | 交互模式 0；用法/配置/恢复错误 2；中断 130 | 正常退出 0；启动错误同 CLI 映射（2）；显式 `--tui` 在非 TTY 报 2 并提示 `nctrn --cli` 或 `nctrn -p` |

对话输入之外的全局键：`Esc` 关闭弹层（模型列表/上下文报告/权限反馈行）；补全列表打开时 `Esc` 只关列表、保留输入。`Tab` 在权限对话框选项间移动焦点；补全列表打开时 `Tab` 补全当前候选。`Shift+Tab`（`\x1B[Z`）在输入框状态下循环思考档位 `[off, …当前模型可用档位]`，只高亮状态栏，不插入对话条目；Turn 进行中同样可切，新档位从下一个 Turn 生效（状态栏显示 `思考:<生效档>→<新档>`，ADR-0018）。权限确认框内 `Shift+Tab` 仍是反向移动焦点。当前模型没有可用档位时 `Shift+Tab` 不响应、不插入提示。

`Alt+M` 在 `read-only → default → auto-edit → full-access` 间循环，走与 `/preset` 相同的 `setPermissionPreset`（`session.config_changed`），Turn 进行中同样拒绝；只高亮状态栏，不插入对话条目。Windows Terminal 发送 `\x1bm`，必须能识别。conhost 不要求识别；若把 Alt 拆成 Esc 加字母，吞掉该字母，不写入输入框，也不触发其他操作。

翻页：`PgUp`/`PgDn` 按对话区高度翻页；`Ctrl+Home` 到顶；`Ctrl+End` 到底并恢复跟随。

## 4. 渲染模型

- 技术选型见 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)：Ink + React。全屏滚动模型见 [ADR-0020](../decisions/ADR-0020-tui-fullscreen-rendering.md)：`incrementalRendering` 与 Ink 自带 `alternateScreen`，帧高 `rows - 1`，对话区只布局可见行。不再用 `<Static>` 写主屏 scrollback。
- 可见窗口从末尾向前布局；跟随底部时不布局视口碰不到的历史。块按 key、内容版本和宽度缓存。
- **diff 展示**：`tool.completed.output` 的结构化 diff（edit/write 工具已声明）直接渲染，红绿着色（NO_COLOR 时仅用 `+`/`-` 前缀）；大 diff 折叠为头尾若干行 + 省略计数，`spillPath` 存在时提示查看完整文件。
- **工具行**：`● name <输入摘要>` + 状态徽标（awaiting → `?`，running → 转轮，ok/error → `✓`/`✗`，denied/cancelled/interrupted → 对应词）。`liveOutput` 只显示尾部 N 行。`task`（子代理，Phase 6）的进行中行同样靠 `liveOutput` 展示一行式进度摘要（`tool.progress` `stream:"info"`），无新增视图通道（[subagent.md](../architecture/subagent.md) 第 12 节）。
- **MCP 状态（Phase 5）**：`mcp.server` 是临时事件、不进 `SessionView`（reducer 忽略未知类型）；`failed`/`crashed` 经 `runtime.warning` 进入提示区，`/mcp` 面板按 `session.mcpServers()` 展示每台服务器的状态、工具数与失败原因。Hook 的可见效果走既有事件（`permission.resolved source:"hook"`、`tool.completed`、`runtime.warning(code:"hook_failed")`），不新增 UI 通道。
- **宽字符**：所有截断/对齐经显示宽度计算（Ink 内建 string-width），中文文本不掰断。

## 5. 降级行为

| 条件 | 行为 |
|---|---|
| stdin/stdout 非 TTY | v0.3 起自动使用逐行 REPL（`--cli` 同形态），不再因默认选择 TUI 报错；显式 `--tui` 仍报错退出 2 并提示 `nctrn --cli` 或 `nctrn -p`。`runTui` 直接调用非 TTY 时同样退出 2 |
| `NO_COLOR` 或 `TERM=dumb` | 禁用颜色与转轮动画；布局与符号不变 |
| `NOCTURNE_ASCII=1`（显式开关） | 框线、徽标退回 ASCII（`-`/`+`/`*`/`->`）。不做自动探测：Windows 上 `TERM` 通常未设置，靠它识别 conhost 不可靠；默认一律输出 Unicode |
| 宽度 ≥80 | 完整布局（欢迎框双栏、状态栏全段、diff 上下文行） |
| 40–79 | 紧凑：欢迎框降级为单栏；状态栏隐藏目录段；diff 上下文收窄，工具输入摘要硬截断 |
| <40 | 极简：不显示欢迎框；回放条目照常输出（`<Static>` 只追加，不暂存）但摘要更短；活动区 + 输入行 + 单行状态（`状态 • 上下文占用`）；权限对话框隐藏原因行、选项收缩为单行 |
| 运行时 resize | 监听 `resize`，按新的行数减 1 重算帧预算，对话区按新宽度重排可见行 |
| Windows Terminal / conhost | 两者均可运行；conhost 旧版无真彩，用 16 色回退。增量渲染 + 帧高 `rows - 1` 避免整屏清除（ADR-0020）。主输入框用 `useCursor` 定位输入法。图标只用两端实测可显示的字符 |

## 6. 会话切换与恢复

会话内切换走 **`/resume` 斜杠命令**（REPL 与 TUI 同一套语义，cli.md 第 4 节为唯一主文档）：

- `/resume`：列出 `runtime.listSessions()`（id、时间、cwd、模型、锁定标记），TUI 弹出 PickList 列表选择器（↑↓ + Enter，Esc 取消）；`/resume <id>` 直达。
- **打开逻辑只在 CLI 有一份**：`runTui(session, runtime, { switchSession })`，`switchSession(id, { allowForeign? }) => Promise<SessionSwitchResult>`，结果为 `{ kind: "ok"; session } | { kind: "busy" } | { kind: "foreign"; workspaceRoot } | { kind: "error"; message }`。TUI 不直接打开会话，Core 不新增入口。跨目录确认在客户端完成：回调先返回 `kind: "foreign"`，TUI 弹确认对话框（默认拒绝）同意后带 `allowForeign` 重调。
- **切换顺序**：Turn 进行中拒绝（提示先 Ctrl+C 中断）；先打开新会话——锁冲突/日志损坏/跨目录被拒时报错并**留在原会话**；打开成功后才 `close()` 旧会话、释放锁。
- **切换后**：新建 `SessionView`，重放新会话的持久事件；已写入终端滚动区的旧内容无法收回，向回放区插一条"已切换到会话 \<id\>"分隔提示，再附恢复摘要（若有修复）。
- 离线测试覆盖：切换成功、取消、锁冲突后留在原会话、Turn 进行中拒绝、切换后视图重放。

## 7. 模型选择页

`/model` 打开全屏的模型选择页。v0.3 起 `/provider` 不再打开此页——服务商管理在 §8 的服务商页；本页左栏仍保留 `○` 未配置预设，Enter 后在页内嵌入添加向导（便于选模型时发现缺服务商），完成后回到本页并选中新服务商。只在会话空闲时可打开，前置条件与 `setModel` 一致；会话忙时提示"会话忙"。

**全屏内的一页**：与主界面共用同一备用屏幕（ADR-0020），打开和关闭不切屏，也不清除输入框里已有的文字。服务商页同此。

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

`/provider`（无参）打开服务商管理页（v0.3，ADR-0019）。它与主界面在同一全屏里（ADR-0020），不再逐页进出备用屏幕。只在会话空闲时可打开；首次配置流程中由启动路径直接打开，不要求已有会话。

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
| 删除 | 选项式确认框（默认焦点在「取消」；`←`/`→`/`↑`/`↓` 移动、`Enter` 执行、`Esc` 取消）确认后删除条目与凭据；当前会话使用的拒绝；只读条目不可达 | `/provider remove <名>` |

**全页无打字是非题**（ADR-0019 第 2 条）：所有是非与多选交互都用 `↑`/`↓`/`←`/`→` + `空格`/`Enter` 完成——包括删除确认与思考档位勾选，页面上不出现需要键入 `y`/`N` 回答的提问。

**向导对外只发 `GET /models`**（provider-setup.md 第 1、6 节）：不做连接测试、不发模型请求；测试用 fake fetch 断言只出现 `GET /models`。

**不做**：页内选模型（去 `/model`）、密钥明文回显、鼠标操作。

## 9. 工程约束

- `apps/tui` 只允许依赖 `@nocturne/core`、`@nocturne/core/protocol` 两个入口 + ADR-0010 批准的终端依赖（ink、react；`ink-testing-library` 为 devDependency）。CLI 仅可惰性加载 `@nocturne/tui`，或静态引用 `@nocturne/tui/slash-catalog`；后者不得 import 任何模块，以免逐行模式加载 Ink。依赖方向见 [modules.md](../architecture/modules.md) 第 1 节。
- 目录：`src/index.ts`（`runTui`：增量渲染 + Ink 备用屏幕）、`src/app.tsx`（全屏壳）、`src/frame.ts`（帧高 `rows - 1` 与降级）、`src/viewport.ts`（可见行）、`src/slash-catalog.ts`（`/help` 与补全共用的命令表，CLI 经子路径引用，不加载 Ink）、`src/commands.ts`、`src/session-view.ts`、`src/env.ts`、`src/theme.ts`、`src/format.ts`、`src/components/`（StatusBar、Composer、ProviderPage、ModelPicker、WizardView 等）。不再有逐页切屏模块。
- 测试：reducer 不变量在 `packages/core` 测（view.md §8）；TUI 组件用 `ink-testing-library` 断言渲染帧（含 40 列窄终端帧与欢迎框/状态栏降级）；交互路径用注入假 Session 的集成测试（offline）；服务商页覆盖列表/过滤/就地步骤/四操作/Esc/Ctrl+C。
- **歧义宽度字符**（conhost 实测，GBK 代码页）：`· ● ○ ◆ ◇ ↑ ↓ ← → … — ｜` 等在控制台实宽 2 列，与 `string-width` 的 1 列不一致；`│ ─ ╭ █ ✓ ✗ ⚠ • › ⠋` 及全角 CJK 两边一致。凡会被补齐到整宽的行（带边框 Box 内部、左右栏拼接行），每个歧义字符都让实际行宽 +1，超边即折行——备用屏下表现为整屏滚动、页头被裁。规则：框内动态文本一律过 `format.ts` 的 `boxSafe()`，静态文案只用宽度确定字符（分隔符用 `•` 不用 `·`，方向提示用"上下/左右"不用箭头），边框盒距右缘保留 ≥4 列余量；无补齐的行（裸 Text）只需截断预算留 ≥4 列余量。
- `runTui` 只消费现有公开 API：`subscribe`/`durableEvents`/`submit`/`interrupt`/`respondPermission`/`setModel`/`setPermissionPreset`/`compact`/`close`/`state`/`warnings`/`recovery`/`reasoningEffortInfo`/`describeContext`（状态栏上下文占用与 `/context` 同源），加上 `runtime.listModels`/`runtime.listSessions`/`runtime.listRecentModels`/`runtime.defaultModel`/`runtime.updateProviders`，以及 `session.mcpServers()`（`/mcp` 面板与欢迎框 MCP 块）；会话切换通过 CLI 注入的 `switchSession` 回调（§6），不直接调 `resumeSession`。

## 10. 需要的 Core API 变更

`normalizeModelRef` 上移到 `@nocturne/core`（`provider/model` 归一化语义属于 Provider 层，TUI 的 `/model` 复用）。Phase 5 增补：`session.mcpServers()`（`/mcp` 面板的数据源，`McpServerStatus[]` 只读查询）。

v0.2 增补（provider-setup.md 第 6 节）：模型选择页与 `/provider` 弹层消费 `runtime.defaultModel()`、`runtime.listRecentModels()`、`runtime.updateProviders`，以及配置模块的 `describeProviders`/`saveSetupProvider`/`removeSetupProvider`/`refreshUpstreamLimits`/`setDefaultModel`/`setCredential`；向导各步（预设列表、模型获取）经 `listProviderPresets`/`fetchModels`——向导不发送模型请求。交互外壳留在 TUI，逻辑只在 Core 一份。

v0.3 增补（ADR-0019）：

- `runProviderSetupWizard` 不再包含选模型与"设为默认"两步；`WizardResult` 移除 `model`/`setDefault`、新增 `modelCount`（服务商页底部结果行的数据源）；
- `SessionSummary.firstText?`：欢迎框"最近会话·首句摘要"的数据源（列表实现本就读日志文件，提取首条 `message.user` 文本）；
- `runTui` 可无会话启动（首次配置流程）：注入 `openSession` 回调，服务商页 → 模型页走完后由 CLI 完成延迟装配；打开会话的逻辑仍在 CLI 一份。

**不上移**：配置收集（`collectSessionConfig`）与会话打开组合（`openSession`）留在 CLI——它们携带 CLI 参数结构与"跨目录确认"这类客户端交互，进 Core 会违反"Core 不依赖客户端"的边界。CLI 单入口保证启动语义只有一份实现，TUI 从 CLI 手里接过已打开的 `Session`（或 setup 完成后的打开回调），不存在漂移面。

不新增事件类型；不改 Agent Loop；权限判定仍只在权限层（对话框只是 `respondPermission` 的 UI）。

## 11. 本阶段不做

- 独立 `nctrn-tui` 命令（需要共享启动语义时再评估，可能以独立命令复制薄壳或重新讨论 Core 入口上移的方式引入）；
- 鼠标交互、点击选中；
- 多行输入编辑器、粘贴检测、@文件补全；
- Markdown 语法高亮（文本按纯文本渲染，着色仅限角色/工具行）；
- 逐页进出备用屏幕（主界面启动即在备用屏幕内，页面是同一帧里的层，见 ADR-0020）；
- 多会话标签页；
- 工具输出详情查看器/分页器（长输出靠截断 + spillPath，与 CLI 一致）；
- 主题、配色、键位的用户自定义（v0.3 只把颜色集中到主题常量，不开放配置）；
- RPC/Web 客户端（后续阶段，直接复用 SessionView reducer）。
