# TUI（nctrn --tui / nctrn-tui）

状态：**提议 v0.1**（Phase 4 设计稿；验收后以已接受替换）

`apps/tui` 是 Nocturne 的终端界面客户端：与 CLI 驱动同一套 Runtime，只消费公开 API（`@nocturne/core`）与 `protocol`（含 `SessionView` reducer，见 [protocols/view.md](../protocols/view.md)）。TUI 不包含任何 Agent 逻辑，不复用 CLI 的渲染代码，不自行做事件投影。

## 1. 启动入口

| 方式 | 说明 |
|---|---|
| `nctrn --tui` | **主入口**。CLI 完成参数解析、配置收集、会话选择（新建/恢复/继续/选择器）后，把已打开的 `Session` 交给 `runTui()`。终端不是 TTY 时报错退出（§5）。 |
| `nctrn-tui` | `apps/tui` 自带的独立 bin，参数为 CLI 的子集（无 `-p`），内部走同一套 `openSession`/`collectSessionConfig` 公共入口，等价于 `nctrn --tui`。 |

取舍：选 `--tui` 作为推荐入口而非独立子命令/仅独立命令，理由是——

- 会话选择的语义（`--resume`/`--continue`/`--sessions`/`--force-unlock`、跨目录确认、恢复摘要）只有一份实现，CLI 与 TUI 不可能漂移；
- `nctrn --tui` 不引入新命令面；`nctrn-tui` 作为薄壳保留给打包分发场景；
- 代价是 `apps/cli` → `apps/tui` 一条**惰性**依赖边（`--tui` 时才 `import()`，普通 CLI 路径不加载、不付启动成本；depcheck 为这条边开唯一例外，其余 apps→apps 仍禁止）。

`--tui` 与 `-p/--print` 互斥（`-p` 是非交互批处理，无 TUI 可言），同时给出用法错误（退出码 2）。

## 2. 界面布局

自顶向下四个区；前两区是会话时间线，后两区是交互层：

```
┌ 会话回放区（scrollback）
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
│   流式中的助手文本；进行中工具的输入摘要 + liveOutput 尾部；
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

- **会话回放区**：一个 `SessionViewEntry` 渲染一次。`tool` 条目完结时连同 diff/结果摘要一起写入回放（事件溯源保证不再变化）。长输出按 modelContent 截断标记 + `spillPath` 提示，与 CLI 同口径。
- **活动区**：随 `view.revision` 重绘。同一时刻只有一段活动内容（串行管线）：流式文本、工具进行中块、重试、压缩中。
- **权限对话框**：`pendingPermission` 非空时独占交互焦点；输入行禁用并提示。
- **状态栏**：`preset | model | status(+retry 计数) | tokens（累计 input/output） | cwd | sessionId`。宽度不足时按 §5 收缩。

## 3. 键位与交互（对照 cli.md）

| 场景 | CLI（REPL） | TUI |
|---|---|---|
| 提交输入 | Enter 提交一行 | Enter 提交输入框内容 |
| 斜杠命令 | `/help /model /preset /context /compact /exit /quit` | 同一集合；`/model` 弹出选择列表（↑↓ + Enter），`/context` 弹出可滚动报告面板（Esc/Enter 关闭）。命令名与效果完全一致 |
| 权限确认 | `a`/`s`/`p`/`d`/`x`，`d <文本>` 带反馈 | 同五键；`d` 先进入反馈行，`d>文本 Enter` 发送，`Esc` 放弃反馈直接拒绝——与 `d`（空反馈）等价 |
| 中断 | Ctrl+C：Turn 中中断；权限提示中取消；空闲退出 | 同：pendingPermission 时先中断（结算为 cancelled）；busy 时中断 Turn；空闲时退出 |
| EOF/退出 | Ctrl+D、`/exit` | Ctrl+D（空闲）、`/exit`、`/quit` |
| 恢复 | `--resume <id>` / `--continue` | 同参数；另有 `--tui --sessions` 打开**会话选择器**（列表含 id、时间、cwd、模型、锁定标记；选中锁定会话时确认强制解锁） |
| 会话列表 | `--sessions` 打印后退出 | `--sessions` 单独使用仍打印退出；`--tui --sessions` 进入选择器，可选"新会话" |
| 跨目录恢复确认 | `y/N` 提问（默认拒绝） | 打开会话前的确认对话框，默认拒绝 |
| 恢复摘要/警告 | stderr 行 | 回放区顶部 notice 块 + notices 计数进状态栏 |
| 忙时输入 | "会话忙，稍后再试" | 输入框禁用，状态栏显示当前状态；Ctrl+C 中断 |
| 退出码 | 交互模式 0；用法/配置/恢复错误 2；中断 130 | 正常退出 0；启动错误同 CLI 映射（2）；非 TTY 报 2 并提示用 `-p` |

对话输入之外的全局键：`Esc` 关闭弹层（模型列表/上下文报告/反馈行）；`Tab` 在权限对话框选项间移动焦点（与直接按字母键等价，服务鼠标不可用的纯键盘流）。

## 4. 渲染模型

- 技术选型见 [ADR-0010](../decisions/0010-tui-rendering.md)：Ink + React。回放区用 `<Static>`（已完结条目 append-only，天然契合事件溯源）；活动区/对话框/状态栏是普通组件，随 `view.revision` 重绘。
- **diff 展示**：`tool.completed.output` 的结构化 diff（edit/write 工具已声明）直接渲染，红绿着色（NO_COLOR 时仅用 `+`/`-` 前缀）；大 diff 折叠为头尾若干行 + 省略计数，`spillPath` 存在时提示查看完整文件。
- **工具行**：`● name <输入摘要>` + 状态徽标（preparing → `…`，awaiting → `?`，running → 转轮，ok/error → `✓`/`✗`，denied/cancelled/interrupted → 对应词）。`liveOutput` 只显示尾部 N 行。
- **宽字符**：所有截断/对齐经 `wcwidth` 计算显示宽度（Ink 已内建），中文文本不掰断。

## 5. 降级行为

| 条件 | 行为 |
|---|---|
| stdin/stdout 非 TTY | 立即报错退出 2，提示 `nctrn -p` 用于非交互 |
| `NO_COLOR` 或 `TERM=dumb` | 禁用颜色与转轮动画；框线、徽标退回 ASCII（`-`/`+`/`*`/`->`）；其余布局不变 |
| Unicode 不可用终端（conhost 旧代码页） | 同 ASCII 回退；判定规则：`TERM` in `{dumb, cons25}` 或 `NO_COLOR` |
| 宽度 ≥80 | 完整布局（含 diff 并排上下文行号省略） |
| 40–79 | 紧凑：状态栏隐藏 cwd/sessionId，diff 上下文收窄，工具输入摘要硬截断 |
| <40 或 高度 <10 | 极简：只渲染活动区 + 输入行 + 单行状态（`status | tokens`）；权限对话框收缩为单行选项提示；回放仍在后台累积，恢复宽度后正常显示 |
| 运行时 resize | Ink 自动重排；回放区不受影响（已写 scrollback），活动区按新宽度重绘 |
| Windows Terminal / conhost | 两者均支持；conhost 旧版无真彩，用 16 色回退（Ink 的 ColorLevel 探测） |

## 6. 会话选择与恢复

`--tui --sessions` 的选择器是 TUI 相对 CLI 的唯一新增交互：列出 `listSessions()` 结果，↑↓ 选择，Enter 恢复（等价 `--resume <id>`），`n` 新建。锁定会话显示锁标记，Enter 后弹确认走 `forceUnlock`（与 `--force-unlock` 同义）。恢复完成后回放全部历史条目，顶部显示恢复摘要 notice（interrupted 调用数、修复的 Turn 数——`turn_end` notice 的 `recovered` 文案已覆盖"上次进程退出"语义）。

## 7. 工程约束

- `apps/tui` 只允许依赖 `@nocturne/core`、`@nocturne/core/protocol` 两个入口 + ADR-0010 批准的终端依赖（ink、react）。depcheck 新增规则：禁止 apps/tui → 其他 apps；cli→tui 仅 `--tui` 惰性边界一例。
- 目录：`src/index.ts`（`runTui` 导出）、`src/main.ts`（`nctrn-tui` bin）、`src/app.tsx`、`src/components/`（Transcript、ToolRow、PermissionDialog、StatusBar、Composer、SessionPicker）、`src/keys.ts`。
- 测试：reducer 不变量在 `packages/core` 测（view.md §8）；TUI 组件用 `ink-testing-library` 断言渲染帧（含 40 列窄终端帧）；交互路径用注入假 Session 的集成测试（offline）。
- 需要的 Core 公开 API 增补（唯一一组，见 §8）：会话配置收集与会话打开的组合入口。

## 8. 需要的 Core API 变更

| 新增 | 位置 | 理由 |
|---|---|---|
| `collectSessionConfig(platform, args, env)` | `@nocturne/core` | 现 `apps/cli/config.ts` 的分层收集逻辑上移；TUI 与 CLI 共用，消除"配置语义两份实现"漂移。不改行为 |
| `openSession(runtime, opts)` | `@nocturne/core` | 组合 create/resume/continue/列表选择 + 跨目录确认回调（`onForeignWorkspace: (root)=>Promise<boolean>`）。把"选择语义"放进公共入口，CLI 改为调用它 |
| `normalizeModelRef` | `@nocturne/core` | 现 CLI 私有的 `provider/model` 解析上移 |

**不新增**：不新增事件类型；不改 Agent Loop；权限判定仍只在权限层（TUI 的对话框只是 `respondPermission` 的 UI）。`runTui` 需要 `Session` 的 `subscribe`/`durableEvents`/`submit`/`interrupt`/`respondPermission`/`setModel`/`setPermissionPreset`/`compact`/`close`/`listSessions`/`state`/`warnings`/`recovery`——全部为现有公开 API。

## 9. 本阶段不做

- 鼠标交互、点击选中；
- 多行输入编辑器、粘贴检测、@文件补全；
- Markdown 语法高亮（文本按纯文本渲染，着色仅限角色/工具行）；
- alternate screen 全屏模式（回放交给终端原生 scrollback）；
- 会话内切换（`/sessions`）、多会话标签页；
- 工具输出详情查看器/分页器（长输出靠截断 + spillPath，与 CLI 一致）；
- 主题、配色、键位自定义；
- 中文输入法候选窗精确定位（Ink 已知限制，见 ADR-0010 风险条目）；
- RPC/Web 客户端（后续阶段，直接复用 SessionView reducer）。
