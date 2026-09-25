# TUI（`nctrn --tui`）

> 状态：已接受 v1.0（2026-09-24 验收）｜ 前置阅读：[apps/cli.md](cli.md)、[protocols/view.md](../protocols/view.md) ｜ 代码位置：`apps/tui/`

`apps/tui` 是 Nocturne 的终端界面客户端：与 CLI 驱动同一套 Runtime，只消费公开 API（`@nocturne/core`）与 `protocol`（含 `SessionView` reducer）。TUI 不包含任何 Agent 逻辑，不复用 CLI 的渲染代码，不自行做事件投影。

## 1. 启动入口

唯一入口是 **`nctrn --tui`**：CLI 完成参数解析、配置收集、会话选择（新建/`--resume`/`--continue`）后，把已打开的 `Session` 与 `Runtime` 交给 `runTui(session, runtime, opts)`。终端不是 TTY 时报错退出（§5）。

取舍理由：

- 会话选择的语义（`--resume`/`--continue`/`--sessions`/`--force-unlock`、跨目录确认、恢复摘要）只有一份实现，在 CLI 启动路径内，不存在第二份可漂移的副本；
- 不引入新命令面；
- 代价是 `apps/cli` → `apps/tui` 一条**惰性**依赖边：`--tui` 时才 `import()`，普通 CLI 路径不加载 React/Ink，启动开销不变（注意：安装面会变——`apps/cli` 依赖 `apps/tui` 包后，`pnpm install` 会连带安装 Ink/React；惰性加载省的只是启动时的模块加载）。depcheck 为这条边开唯一例外，其余 apps→apps 仍禁止。

`--tui` 与 `-p/--print` 互斥（`-p` 是非交互批处理），同时给出用法错误（退出码 2）。

本阶段**不做**独立 `nctrn-tui` 命令（见 §10）：它要么复制启动逻辑，要么要求把会话选择语义上移 Core——后者会把 CLI 的参数结构与交互确认带进 Core，违反模块边界，见 §9。

## 2. 界面布局

自顶向下四个区；前两区是会话时间线，后两区是交互层：

```
┌ 会话回放区（scrollback，Ink <Static>）
│   已完结的时间线条目只追加不重绘，交给终端原生滚动与复制
│   > 用户消息
│   助手文本（可多段、含 reasoning 折叠显示）
│   ● edit src/foo.ts ── ok 123ms
│     ─ src/foo.ts
│       + added line
│       - removed line
│   ◇ 权限：shell npm test → 用户允许一次
│   ◇ 上下文已压缩（摘要至 seq 42）
├ 活动区（动态重绘，至多屏高的一段）
│   流式中的助手文本（view.live.assistants）；
│   进行中工具（live.tools 参数流 / entries 的 awaiting/running 条目）+ liveOutput 尾部；
│   重试倒计时；压缩中提示
├ 权限对话框（pendingPermission 出现时叠加在活动区下方，独占交互焦点）
│   ? 需要确认
│     shell: npm install
│     原因：预设 default：shell 命令需要确认
│   [a] 允许一次  [s] 本会话  [p] 本项目  [d] 拒绝  [x] 拒绝并停止
│   d 之后出现反馈输入行：d> ____
├ 输入行 + 状态栏（常驻底部两行）
│   › 输入提示_________________________________________
│   default | gpt-4o | idle | ↑12.3k ↓1.2k | ~/repo | s_01J…
```

- **回放区**：一个 `entries` 条目渲染一次。`tool` 条目完结时连同 diff/结果摘要一起写入回放（事件溯源保证不再变化）。长输出按 modelContent 截断标记 + `spillPath` 提示，与 CLI 同口径。
- **活动区**：渲染 `view.live`（流式助手、参数准备中的工具）、`entries` 中未完结的工具条目、`retry`、`status`。随 `view.revision` 重绘。同一时刻活动内容有限（串行管线）。
- **权限对话框**：`pendingPermission` 非空时独占交互焦点；输入行禁用并提示。
- **状态栏**：`preset | model | 思考:档位 | status(+retry 计数) | tokens（累计 input/output） | cwd | sessionId`。`思考:` 段只在当前模型有可用思考档位时显示（ADR-0018）。宽度不足时按 §5 收缩。

## 3. 键位与交互（对照 cli.md）

| 场景 | CLI（REPL） | TUI |
|---|---|---|
| 提交输入 | Enter 提交一行 | Enter 提交输入框内容 |
| 斜杠命令 | `/help /model /preset /context /compact /resume /mcp /provider /exit /quit`（`/provider` 为 v0.2 提议，[provider-setup.md](../architecture/provider-setup.md) 第 1 节：弹层、单行输入框、`*` 回显的密钥输入框、确认对话框） | 同一集合；`/model` 打开全屏模型选择页（§7），`/resume` 弹出列表选择器（↑↓ + Enter，Esc 取消），`/context` 弹出可滚动报告面板，`/mcp` 弹出服务器状态面板（复用 Panel 组件，Esc/Enter 关闭）。命令名与效果完全一致 |
| 权限确认 | `a`/`s`/`p`/`d`/`x`，`d <文本>` 带反馈 | 同五键；`d` 先进入反馈行：`Enter` 发送拒绝（内容为空 = 不带反馈，等价裸 `d`），`Esc` 退出反馈行回到五选项 |
| 中断 | Ctrl+C：Turn 中中断；权限提示中取消；空闲退出 | 同：pendingPermission 时先中断（结算为 cancelled）；busy 时中断 Turn；空闲时退出 |
| EOF/退出 | Ctrl+D、`/exit` | Ctrl+D（空闲）、`/exit`、`/quit` |
| 恢复 | `--resume <id>` / `--continue` | 同参数 |
| 会话列表 | `--sessions` 打印后退出 | 同（`--tui` 不改变 `--sessions` 的只读退出行为） |
| 会话内切换 | `/resume`（REPL：编号列表，`/resume <id>` 直达） | `/resume` 弹出列表选择器（复用 PickList 组件，Esc 取消）；`/resume <id>` 直达。切换语义见 §6 |
| 跨目录恢复确认 | `y/N` 提问（默认拒绝） | 确认对话框，默认拒绝（启动恢复与 `/resume` 一致） |
| 恢复摘要/警告 | stderr 行 | 提示区 `!` 行（挂载与 `/resume` 切换时写入 clientLines） |
| 忙时输入 | "会话忙，稍后再试" | 输入框禁用，状态栏显示当前状态；Ctrl+C 中断 |
| 退出码 | 交互模式 0；用法/配置/恢复错误 2；中断 130 | 正常退出 0；启动错误同 CLI 映射（2）；非 TTY 报 2 并提示 `nctrn`（行式 REPL）或 `nctrn -p` |

对话输入之外的全局键：`Esc` 关闭弹层（模型列表/上下文报告/权限反馈行）；`Tab` 在权限对话框选项间移动焦点（与直接按字母键等价，服务纯键盘流）；`Shift+Tab`（`\x1B[Z`，Ink 解析为 `key.tab + key.shift`）在输入框状态下循环切换思考档位 `[off, …当前模型可用档位]`，Turn 进行中同样生效（下一次模型请求起，ADR-0018）；权限确认框内 `Shift+Tab` 保持"反向移动焦点"，不切换档位；弹层/选择页/向导激活时由其自身处理。当前模型没有可用档位时 `Shift+Tab` 不响应。

## 4. 渲染模型

- 技术选型见 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)：Ink + React。回放区用 `<Static>`；活动区/对话框/状态栏是普通组件，随 `view.revision` 重绘。
- **回放区只写 `entries` 的完结前缀**：从头到第一个未完结条目（`awaiting_permission`/`running` 的工具）为止；其后的条目（包括已完结的 notice）留在活动区渲染，待前缀推进后按序补进回放——`<Static>` 写出的内容不可改，未完结条目绝不能先进滚动区。测试覆盖：运行中工具之后已有权限提示条目时，该提示不得先进入回放区（ink-testing-library 断言帧内容）。
- **diff 展示**：`tool.completed.output` 的结构化 diff（edit/write 工具已声明）直接渲染，红绿着色（NO_COLOR 时仅用 `+`/`-` 前缀）；大 diff 折叠为头尾若干行 + 省略计数，`spillPath` 存在时提示查看完整文件。
- **工具行**：`● name <输入摘要>` + 状态徽标（awaiting → `?`，running → 转轮，ok/error → `✓`/`✗`，denied/cancelled/interrupted → 对应词）。`liveOutput` 只显示尾部 N 行。`task`（子代理，Phase 6）的进行中行同样靠 `liveOutput` 展示一行式进度摘要（`tool.progress` `stream:"info"`），无新增视图通道（[subagent.md](../architecture/subagent.md) 第 12 节）。
- **MCP 状态（Phase 5）**：`mcp.server` 是临时事件、不进 `SessionView`（reducer 忽略未知类型）；`failed`/`crashed` 经 `runtime.warning` 进入提示区，`/mcp` 面板按 `session.mcpServers()` 展示每台服务器的状态、工具数与失败原因。Hook 的可见效果走既有事件（`permission.resolved source:"hook"`、`tool.completed`、`runtime.warning(code:"hook_failed")`），不新增 UI 通道。
- **宽字符**：所有截断/对齐经显示宽度计算（Ink 内建 string-width），中文文本不掰断。

## 5. 降级行为

| 条件 | 行为 |
|---|---|
| stdin/stdout 非 TTY | 立即报错退出 2，提示 `nctrn`（行式 REPL）或 `nctrn -p` |
| `NO_COLOR` 或 `TERM=dumb` | 禁用颜色与转轮动画；布局与符号不变 |
| `NOCTURNE_ASCII=1`（显式开关） | 框线、徽标退回 ASCII（`-`/`+`/`*`/`->`）。不做自动探测：Windows 上 `TERM` 通常未设置，靠它识别 conhost 不可靠；默认一律输出 Unicode |
| 宽度 ≥80 | 完整布局（含 diff 上下文行） |
| 40–79 | 紧凑：状态栏隐藏 cwd/sessionId，diff 上下文收窄，工具输入摘要硬截断 |
| <40 | 极简：回放条目照常输出（`<Static>` 只追加，不暂存）但摘要更短；活动区 + 输入行 + 单行状态（`status | tokens`）；权限对话框隐藏原因行、选项收缩为单行 |
| 运行时 resize | Ink 自动重排；回放区不受影响（已写 scrollback），活动区按新宽度重绘 |
| Windows Terminal / conhost | 两者均可运行；conhost 旧版无真彩，用 16 色回退（Ink 的 ColorLevel 探测）。conhost 的活动区重绘可能留下残影，IME 候选窗定位也可能偏移；建议使用 Windows Terminal。Ink 当前默认已关闭增量渲染，但活动区帧通常不会触发整屏清除；按 `TERM` 无法可靠区分 conhost，强行整屏清除又会破坏 `<Static>` 回放与滚动区，因此本轮保留为已知限制（ADR-0010） |

## 6. 会话切换与恢复

会话内切换走 **`/resume` 斜杠命令**（REPL 与 TUI 同一套语义，cli.md 第 4 节为唯一主文档）：

- `/resume`：列出 `runtime.listSessions()`（id、时间、cwd、模型、锁定标记），TUI 弹出 PickList 列表选择器（↑↓ + Enter，Esc 取消）；`/resume <id>` 直达。
- **打开逻辑只在 CLI 有一份**：`runTui(session, runtime, { switchSession })`，`switchSession(id, { allowForeign? }) => Promise<SessionSwitchResult>`，结果为 `{ kind: "ok"; session } | { kind: "busy" } | { kind: "foreign"; workspaceRoot } | { kind: "error"; message }`。TUI 不直接打开会话，Core 不新增入口。跨目录确认在客户端完成：回调先返回 `kind: "foreign"`，TUI 弹确认对话框（默认拒绝）同意后带 `allowForeign` 重调。
- **切换顺序**：Turn 进行中拒绝（提示先 Ctrl+C 中断）；先打开新会话——锁冲突/日志损坏/跨目录被拒时报错并**留在原会话**；打开成功后才 `close()` 旧会话、释放锁。
- **切换后**：新建 `SessionView`，重放新会话的持久事件；已写入终端滚动区的旧内容无法收回，向回放区插一条"已切换到会话 \<id\>"分隔提示，再附恢复摘要（若有修复）。
- 离线测试覆盖：切换成功、取消、锁冲突后留在原会话、Turn 进行中拒绝、切换后视图重放。

## 7. 模型选择页

`/model` 打开全屏的模型选择页（替换 §3 中 `/model` 的列表选择器）；不带参数的 `/provider` 也打开此页（打开时焦点在左栏的服务商列表）。只在会话空闲时可打开，前置条件与 `setModel` 一致；会话忙时提示"会话忙"。

**全屏**：打开时进入终端备用屏幕（alternate screen），关闭后回到原界面，对话内容完整保留。只有这一个页面使用备用屏幕，其余界面维持第 2 节的布局。这是对 ADR-0010"不用 alternate screen"决定的局部修订，理由与备选方案见 ADR-0017。

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
│ 上下文 128k · 最大输出 8k · $0.27/1.00 每 M · 推理 · 图片 │
│ 输入 · 当前会话 · 默认模型                                │
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

## 8. 工程约束

- `apps/tui` 只允许依赖 `@nocturne/core`、`@nocturne/core/protocol` 两个入口 + ADR-0010 批准的终端依赖（ink、react；`ink-testing-library` 为 devDependency）。depcheck 新增规则：禁止 apps/tui → 其他 apps；cli→tui 仅 `--tui` 惰性边界一例。
- 目录：`src/index.ts`（`runTui` 导出）、`src/app.tsx`（Ink 根组件）、`src/commands.ts`（斜杠命令分发）、`src/session-view.ts`（`useSessionView`：持久日志回放 + 订阅进同一 reducer）、`src/env.ts`（NOCTURNE_ASCII / NO_COLOR / TERM 降级探测）、`src/format.ts`（宽度安全格式化）、`src/types.ts`（`SwitchSessionFn` 等注入类型）、`src/components/`（Transcript、Activity、ToolRow、DiffView、PermissionDialog、StatusBar、Composer、PickList、Panel、ConfirmBox）。
- 测试：reducer 不变量在 `packages/core` 测（view.md §8）；TUI 组件用 `ink-testing-library` 断言渲染帧（含 40 列窄终端帧）；交互路径用注入假 Session 的集成测试（offline）。
- `runTui` 只消费现有公开 API：`subscribe`/`durableEvents`/`submit`/`interrupt`/`respondPermission`/`setModel`/`setPermissionPreset`/`compact`/`close`/`state`/`warnings`/`recovery`，加上 `runtime.listModels`（`/model` 选择列表）与 `runtime.listSessions`（`/resume` 列表），以及 `session.mcpServers()`（Phase 5，`/mcp` 面板）；会话切换通过 CLI 注入的 `switchSession` 回调（§6），不直接调 `resumeSession`。

## 9. 需要的 Core API 变更

`normalizeModelRef` 上移到 `@nocturne/core`（`provider/model` 归一化语义属于 Provider 层，TUI 的 `/model` 复用）。Phase 5 增补：`session.mcpServers()`（`/mcp` 面板的数据源，`McpServerStatus[]` 只读查询）。

v0.2 增补（provider-setup.md 第 6 节）：模型选择页与 `/provider` 弹层消费 `runtime.defaultModel()`、`runtime.listRecentModels()`、`runtime.updateProviders`，以及配置模块的 `describeProviders`/`saveSetupProvider`/`removeSetupProvider`/`refreshUpstreamLimits`/`setDefaultModel`/`setCredential`；向导各步（预设列表、模型获取）经 `listProviderPresets`/`fetchModels`——向导不发送模型请求。交互外壳留在 TUI，逻辑只在 Core 一份。

**不上移**：配置收集（`collectSessionConfig`）与会话打开组合（`openSession`）留在 CLI——它们携带 CLI 参数结构与"跨目录确认"这类客户端交互，进 Core 会违反"Core 不依赖客户端"的边界。入口唯一（`nctrn --tui`）保证启动语义只有一份实现，TUI 从 CLI 手里接过已打开的 `Session`，不存在漂移面。

不新增事件类型；不改 Agent Loop；权限判定仍只在权限层（对话框只是 `respondPermission` 的 UI）。

## 10. 本阶段不做

- 独立 `nctrn-tui` 命令（需要共享启动语义时再评估，可能以独立命令复制薄壳或重新讨论 Core 入口上移的方式引入）；
- 鼠标交互、点击选中；
- 多行输入编辑器、粘贴检测、@文件补全；
- Markdown 语法高亮（文本按纯文本渲染，着色仅限角色/工具行）；
- 主界面的 alternate screen 全屏模式（回放交给终端原生 scrollback；模型选择页是唯一例外，见 §7 与 ADR-0017）；
- 多会话标签页；
- 工具输出详情查看器/分页器（长输出靠截断 + spillPath，与 CLI 一致）；
- 主题、配色、键位自定义；
- 中文输入法候选窗精确定位（Ink 已知限制，conhost 上无 Synchronized Update 会退化，见 ADR-0010）；
- RPC/Web 客户端（后续阶段，直接复用 SessionView reducer）。
