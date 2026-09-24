# TUI（`nctrn --tui`）

> 状态：提议 v0.1 ｜ 前置阅读：[apps/cli.md](cli.md)、[protocols/view.md](../protocols/view.md) ｜ 代码位置（计划）：`apps/tui/`

`apps/tui` 是 Nocturne 的终端界面客户端：与 CLI 驱动同一套 Runtime，只消费公开 API（`@nocturne/core`）与 `protocol`（含 `SessionView` reducer）。TUI 不包含任何 Agent 逻辑，不复用 CLI 的渲染代码，不自行做事件投影。

## 1. 启动入口

唯一入口是 **`nctrn --tui`**：CLI 完成参数解析、配置收集、会话选择（新建/恢复/继续/选择器）后，把已打开的 `Session` 与 `Runtime` 交给 `runTui(runtime, session, opts)`。终端不是 TTY 时报错退出（§5）。

取舍理由：

- 会话选择的语义（`--resume`/`--continue`/`--sessions`/`--force-unlock`、跨目录确认、恢复摘要）只有一份实现，在 CLI 启动路径内，不存在第二份可漂移的副本；
- 不引入新命令面；
- 代价是 `apps/cli` → `apps/tui` 一条**惰性**依赖边：`--tui` 时才 `import()`，普通 CLI 路径不加载 React/Ink，启动开销不变（注意：安装面会变——`apps/cli` 依赖 `apps/tui` 包后，`pnpm install` 会连带安装 Ink/React；惰性加载省的只是启动时的模块加载）。depcheck 为这条边开唯一例外，其余 apps→apps 仍禁止。

`--tui` 与 `-p/--print` 互斥（`-p` 是非交互批处理），同时给出用法错误（退出码 2）。

本阶段**不做**独立 `nctrn-tui` 命令（见 §9）：它要么复制启动逻辑，要么要求把会话选择语义上移 Core——后者会把 CLI 的参数结构与交互确认带进 Core，违反模块边界，见 §8。

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
├ 权限对话框（pendingPermission 出现时替换活动区）
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
- **状态栏**：`preset | model | status(+retry 计数) | tokens（累计 input/output） | cwd | sessionId`。宽度不足时按 §5 收缩。

## 3. 键位与交互（对照 cli.md）

| 场景 | CLI（REPL） | TUI |
|---|---|---|
| 提交输入 | Enter 提交一行 | Enter 提交输入框内容 |
| 斜杠命令 | `/help /model /preset /context /compact /exit /quit` | 同一集合；`/model` 弹出选择列表（↑↓ + Enter），`/context` 弹出可滚动报告面板（Esc/Enter 关闭）。命令名与效果完全一致 |
| 权限确认 | `a`/`s`/`p`/`d`/`x`，`d <文本>` 带反馈 | 同五键；`d` 先进入反馈行：`Enter` 发送拒绝（内容为空 = 不带反馈，等价裸 `d`），`Esc` 退出反馈行回到五选项 |
| 中断 | Ctrl+C：Turn 中中断；权限提示中取消；空闲退出 | 同：pendingPermission 时先中断（结算为 cancelled）；busy 时中断 Turn；空闲时退出 |
| EOF/退出 | Ctrl+D、`/exit` | Ctrl+D（空闲）、`/exit`、`/quit` |
| 恢复 | `--resume <id>` / `--continue` | 同参数；另有 `--tui --sessions` 在 TUI 启动前走**行式会话选择器**（编号列表：id、时间、cwd、模型、锁定标记；输入编号恢复，`n` 新建，锁定会话给提示） |
| 会话列表 | `--sessions` 打印后退出 | `--sessions` 单独使用仍打印退出；`--tui --sessions` 进入选择器（见 §6） |
| 跨目录恢复确认 | `y/N` 提问（默认拒绝） | 打开会话前的确认对话框，默认拒绝 |
| 恢复摘要/警告 | stderr 行 | 回放区顶部 notice 块 + notices 计数进状态栏 |
| 忙时输入 | "会话忙，稍后再试" | 输入框禁用，状态栏显示当前状态；Ctrl+C 中断 |
| 退出码 | 交互模式 0；用法/配置/恢复错误 2；中断 130 | 正常退出 0；启动错误同 CLI 映射（2）；非 TTY 报 2 并提示 `nctrn`（行式 REPL）或 `nctrn -p` |

对话输入之外的全局键：`Esc` 关闭弹层（模型列表/上下文报告/权限反馈行）；`Tab` 在权限对话框选项间移动焦点（与直接按字母键等价，服务纯键盘流）。

## 4. 渲染模型

- 技术选型见 [ADR-0010](../decisions/ADR-0010-tui-rendering.md)：Ink + React。回放区用 `<Static>`（已完结 `entries` append-only，契合事件溯源）；活动区/对话框/状态栏是普通组件，随 `view.revision` 重绘。
- **diff 展示**：`tool.completed.output` 的结构化 diff（edit/write 工具已声明）直接渲染，红绿着色（NO_COLOR 时仅用 `+`/`-` 前缀）；大 diff 折叠为头尾若干行 + 省略计数，`spillPath` 存在时提示查看完整文件。
- **工具行**：`● name <输入摘要>` + 状态徽标（awaiting → `?`，running → 转轮，ok/error → `✓`/`✗`，denied/cancelled/interrupted → 对应词）。`liveOutput` 只显示尾部 N 行。
- **宽字符**：所有截断/对齐经显示宽度计算（Ink 内建 string-width），中文文本不掰断。

## 5. 降级行为

| 条件 | 行为 |
|---|---|
| stdin/stdout 非 TTY | 立即报错退出 2，提示 `nctrn`（行式 REPL）或 `nctrn -p` |
| `NO_COLOR` 或 `TERM=dumb` | 禁用颜色与转轮动画；布局与符号不变 |
| `NOCTURNE_ASCII=1`（显式开关） | 框线、徽标退回 ASCII（`-`/`+`/`*`/`->`）。不做自动探测：Windows 上 `TERM` 通常未设置，靠它识别 conhost 不可靠；默认一律输出 Unicode |
| 宽度 ≥80 | 完整布局（含 diff 上下文行） |
| 40–79 | 紧凑：状态栏隐藏 cwd/sessionId，diff 上下文收窄，工具输入摘要硬截断 |
| <40 或 高度 <10 | 极简：回放条目照常输出（`<Static>` 只追加，不暂存）但摘要更短；活动区 + 输入行 + 单行状态（`status | tokens`）；权限对话框收缩为单行选项提示 |
| 运行时 resize | Ink 自动重排；回放区不受影响（已写 scrollback），活动区按新宽度重绘 |
| Windows Terminal / conhost | 两者均支持；conhost 旧版无真彩，用 16 色回退（Ink 的 ColorLevel 探测）；IME 候选窗定位依赖终端的 Synchronized Update 支持，conhost 上会退化（ADR-0010 风险条目） |

## 6. 会话选择与恢复

`--tui --sessions` 在 TUI 启动前由 CLI 侧完成选择：**行式选择器**（编号列表 + 输入编号 + `n` 新建），不做 Ink 组件——会话打开发生在 `runTui` 之前，会话选择语义必须留在 CLI 一处（§8）。锁定会话在选择器中标注，选中时报 `session_locked` 并提示 `--force-unlock`（不内嵌强制解锁确认，与 CLI 行为一致）。恢复完成后回放全部历史条目，顶部显示恢复摘要 notice（interrupted 调用数、修复的 Turn 数——`turn_end` notice 的 `recovered` 文案已覆盖"上次进程退出"语义）。

## 7. 工程约束

- `apps/tui` 只允许依赖 `@nocturne/core`、`@nocturne/core/protocol` 两个入口 + ADR-0010 批准的终端依赖（ink、react；`ink-testing-library` 为 devDependency）。depcheck 新增规则：禁止 apps/tui → 其他 apps；cli→tui 仅 `--tui` 惰性边界一例。
- 目录：`src/index.ts`（`runTui` 导出）、`src/app.tsx`（Ink 根组件）、`src/components/`（Transcript、ToolRow、PermissionDialog、StatusBar、Composer）、`src/keys.ts`。
- 测试：reducer 不变量在 `packages/core` 测（view.md §8）；TUI 组件用 `ink-testing-library` 断言渲染帧（含 40 列窄终端帧）；交互路径用注入假 Session 的集成测试（offline）。
- `runTui` 只消费现有公开 API：`subscribe`/`durableEvents`/`submit`/`interrupt`/`respondPermission`/`setModel`/`setPermissionPreset`/`compact`/`close`/`state`/`warnings`/`recovery`，加上 `runtime.listModels`（`/model` 选择列表用）。

## 8. 需要的 Core API 变更

唯一新增：`normalizeModelRef` 上移到 `@nocturne/core`（`provider/model` 归一化语义属于 Provider 层，TUI 的 `/model` 复用）。

**不上移**：配置收集（`collectSessionConfig`）与会话打开组合（`openSession`）留在 CLI——它们携带 CLI 参数结构与"跨目录确认"这类客户端交互，进 Core 会违反"Core 不依赖客户端"的边界。入口唯一（`nctrn --tui`）保证启动语义只有一份实现，TUI 从 CLI 手里接过已打开的 `Session`，不存在漂移面。

不新增事件类型；不改 Agent Loop；权限判定仍只在权限层（对话框只是 `respondPermission` 的 UI）。

## 9. 本阶段不做

- 独立 `nctrn-tui` 命令（需要共享启动语义时再评估，可能以独立命令复制薄壳或重新讨论 Core 入口上移的方式引入）；
- 鼠标交互、点击选中；
- 多行输入编辑器、粘贴检测、@文件补全；
- Markdown 语法高亮（文本按纯文本渲染，着色仅限角色/工具行）；
- alternate screen 全屏模式（回放交给终端原生 scrollback）；
- 会话内切换（`/sessions`）、多会话标签页；
- 工具输出详情查看器/分页器（长输出靠截断 + spillPath，与 CLI 一致）；
- 主题、配色、键位自定义；
- 中文输入法候选窗精确定位（Ink 已知限制，conhost 上无 Synchronized Update 会退化，见 ADR-0010）；
- RPC/Web 客户端（后续阶段，直接复用 SessionView reducer）。
