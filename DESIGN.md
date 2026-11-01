# Nocturne 设计规范

适用于桌面端（`apps/desktop`）与随附手机网页（`apps/desktop/src/web`）。TUI 与官网单独维护，配色方向保持一致。

所有设计 token 定义在 [`design/tokens.json`](design/tokens.json) 中，由 `scripts/gen-tokens.mjs` 生成 [`apps/desktop/src/tokens.css`](apps/desktop/src/tokens.css)，不在本文档重复抄写具体数值。

---

## 0. 设计原则

1. **界面不写描述性文字**：不写模式标签、送达或状态说明、占位里的快捷键提示、解释行为的 `title`；图标按钮的 `title` / `aria-label` 只写动作名。标签讲不清就改标签或控件，不加说明。
2. **一种东西只有一种样子**：同一角色（主操作、分组标题、开关、来源标记、空状态）在所有页面用同一套样式与位置，差异只能来自状态，不能来自页面。
3. **层级靠空白和字重，不靠颜色**：分组间距明显大于行间距，标题比正文重一档；彩色只留给可交互项与状态。
4. **只在有新信息时显示状态**：默认状态不标；偏离默认、需要注意或可撤销时才显示标记。
5. **等宽字体表示机器读的值**：路径、命令、模型 ID、环境变量名、数字统计用等宽；人读的值、选项名、状态一律无衬线。
6. **不适用就别显示**：条件不满足的操作隐藏；必须让用户知道它存在时，整块只读并加只读标记，不写说明句。
7. **只用 token，例外要登记**：颜色、字号、圆角、阴影、控件尺寸都从 `design/tokens.json` 取；确需字面量的位置加 `stylelint-disable-next-line` 并在本文第 9 节登记。

---

## 1. 颜色

- **定义位置**：`design/tokens.json` 的 `color` 分组，浅色在 `:root`、深色在 `[data-theme="dark"]` 下由 `apps/desktop/src/tokens.css` 导出。
- **表面与文字**：
  - 表面层次：`--a-bg`（主画布）、`--a-side`（侧栏与设置导航）、`--a-panel`（卡片、浮层、输入外框）、`--a-raised`（次级块、悬停底、代码块表头）、`--a-input`（表单输入底）、`--a-code-bg`（代码块底）、`--a-overlay`（浮层遮罩）、`--a-qr-bg` / `--a-qr-fg`（二维码底与前景）。
  - 文字层次：`--a-text`（正文与标题）、`--a-secondary`（次要正文、按钮文字）、`--a-muted`（辅助标签、次要说明）、`--a-faint`（占位符、装饰分隔、禁用灰字）。深浅色都不使用纯黑或纯白作大面积底或字。
- **强调与状态**：
  - 强调色：`--a-accent`、`--a-accent-hover`、`--a-accentAlt`、`--a-on-accent`、`--a-accent-subtle`、`--a-accent-border`、`--a-focus-ring`；选中态：`--a-sel`、`--a-sel-strong`。
  - 边框与控件：`--a-border`、`--a-border-strong`、`--a-switch-off`、`--a-switch-knob`、`--a-scroll`、`--a-scrollThumbHover`。
  - 语义色：`--a-success` / `--a-success-bg`、`--a-warning` / `--a-warning-bg` / `--a-warning-border`、`--a-error` / `--a-error-bg` / `--a-error-border`。
  - 分类、热力图与代码高亮：`--a-cat1`..`--a-cat5`、`--a-heat-0`..`--a-heat-4`、`--a-termYellow` / `--a-termYellowBright`、`--a-syn-*`、`--cm-*`。
- **底色与描边规则**：
  - 状态色作文字或图标时，搭配对应的浅底（`--a-warning-bg`、`--a-error-bg`、`--a-success-bg`、`--a-accent-subtle`）或弱混色底，不用高饱和实心色块铺满整行（主按钮与聚焦态除外）。
  - 对话内提示条、权限确认卡、文件变更增删行统一用浅色底或整圈弱描边表达级别，不用左侧粗色条。

---

## 2. 字体与字号

- **字体栈**（定义于 `design/tokens.json` 的 `font` 分组）：
  - `--sans`：界面正文与控件（含中文回退栈 `"Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif`）。
  - `--mono`：代码、路径、命令、模型 ID、快捷键与技术标识（尾段回退包含中文字体，避免代码注释中的汉字落到点阵宋体）。
- **字号梯度**（5 档，具体数值见 `design/tokens.json`）：

| 变量 | 桌面端用途 | 手机端用途 |
|---|---|---|
| `--fs-1` | 次要信息、徽章、时间戳、表头、分组标题、折叠箭头、工具行与思考过程 | 角标、快捷键、次要标签 |
| `--fs-2` | 导航项、按钮、表单标签、设置行、列表项、表格正文 | 辅助说明、状态栏、胶囊按钮、代码输出 |
| `--fs-3` | 对话正文、输入框、卡片标题、Markdown `h4`–`h6` | 正文、设置行、抽屉项、选项标题 |
| `--fs-4` | 页面与弹窗标题、Markdown `h3` | 顶栏标题、对话框标题、发送按钮 |
| `--fs-5` | 欢迎标题、用量大数字、Markdown `h1`/`h2` | 空状态标题 |

- **手机网页**：根字号 16px，正文与输入框沿用根字号（输入框小于 16px 会触发 iOS 聚焦时整页放大）；触控目标不小于 44px。
- 行内代码与键盘提示在对话和面板内用 `max(var(--fs-1), 0.92em)`（或 `0.85em`），随外层正文缩放且不小于 `--fs-1`。
- **字重**：`--fw-regular`（正文）、`--fw-medium`（导航选中、按钮、表单标签、小标题）、`--fw-semibold`（页面标题、分组标题、大数字），不使用 `700`。
- **行高**：`--lh-tight`（标题、单行控件）、`--lh-base`（界面正文、表单说明）、`--lh-code`（代码块、日志、终端）、`--lh-prose`（对话 Markdown 正文）。
- **数字对齐**：百分比、token 数、金额、时间、计数器统一加 `font-variant-numeric: tabular-nums`，避免跳动与错位。

---

## 3. 间距

- **间距梯度**（9 档，定义于 `design/tokens.json` 的 `space` 分组）：`--space-0-5`、`--space-1`、`--space-2`、`--space-3`、`--space-4`、`--space-5`、`--space-6`、`--space-8`、`--space-12`。
- **页面内边距**：`--page-px`（水平内边距）、`--page-py`（垂直内边距），随窗口宽度容器查询自动收窄。
- **层级关系**：分组间距（`--space-8`）明显大于组内标题与卡片间距（`--space-2`）以及卡片内边距（`--space-4`），靠留白区分归属。

---

## 4. 圆角与阴影

- **圆角梯度**（定义于 `design/tokens.json` 的 `radius` 分组）：

| 变量 | 用途 |
|---|---|
| `--radius-0-5` | 极小色块（如上下文构成图例色点） |
| `--radius-1` | 行内代码、键盘提示、小徽章、复选框、分段按钮内项、滚动条滑块 |
| `--radius-2` | 按钮、输入框、下拉框、菜单项、小卡片、代码块、待发行 |
| `--radius-3` | 对话框、弹层、设置分组卡片、输入外框、提示卡、手机卡片与抽屉 |
| `--radius-pill` | 胶囊标签、开关轨道、状态圆点、圆形图标按钮 |
| `--radius-device` | 手机外框容器 |

- **阴影**（定义于 `design/tokens.json` 的 `shadow` 分组）：
  - `--shadow-popover`：菜单、下拉、状态栏浮层；
  - `--shadow-dialog`：模态对话框、抽屉；
  - `--shadow-edge`：覆盖式侧面板左缘阴影；
  - `--shadow-device`：设备预览框阴影；
  - `--shadow-focus`：键盘 `:focus-visible` 与输入框 `:focus` 聚焦环。权限确认卡与提问卡被程序聚焦（`tabIndex={-1}`）时去掉浏览器默认 outline，`:focus-within` 用 `--a-accent` 边框加 `--shadow-focus` 外圈。

---

## 5. 基础控件

共享基础控件样式集中在 [`apps/desktop/src/ui.css`](apps/desktop/src/ui.css)，尺寸 token 定义在 `design/tokens.json` 的 `control` 分组。

- **按钮（`.btn`）**：默认高度 `--ctl-h-md`、圆角 `--radius-2`、字号 `--fs-2`、字重 `--fw-medium`。
  - 默认 `.btn`：描边次按钮（`--a-border-strong` 描边、透明底）；
  - `.btn-primary`：实心强调色主按钮（同一区域最多一个）；
  - `.btn-ghost`：无边框弱按钮；
  - `.btn-danger`：常规态与次按钮相同，悬停变红；
  - `.btn-danger-solid`：破坏性确认弹窗内的实心红按钮；
  - 尺寸变体：`.btn-sm`（`--ctl-h-sm`）、`.btn-lg`（`--ctl-h-lg`），触控端按钮高度用 `--ctl-h-touch`。
- **`src/ui/` 组件**：各页面一律用这组组件（`Button`、`IconButton`、`Switch`、`Checkbox`、`SegmentedControl`、`Badge`），不单独写局部按钮、开关、复选框、分段控件或徽标样式。`IconButton` 必填 `aria-label`；`Button` 的 `danger-solid` 只用于最后一步确认，另有 `ghost-danger` 变体。
- **图标按钮（`.ib`）**：宽高 `--ctl-h-md`（`.ib.sm` 为 `--ctl-h-sm`），圆角 `--radius-2`，激活态加 `.on` 或 `aria-pressed="true"`。图标按钮的 `title` 与 `aria-label` 只写动作名，不写状态或行为解释。
- **折叠箭头（`.fold-arrow`）**：统一使用 `▶` 配合 CSS `transform: rotate(...)` 过渡，不混用 `▾`/`▸` 字符。折叠时朝右（`0deg`）；展开时指向展开出的内容——按钮在内容上方时朝下（`.fold-arrow.down`，`90deg`），按钮在内容下方时朝上（`.fold-arrow.up`，`-90deg`）。下拉触发器的 `▾` 表示弹出菜单，不算折叠箭头。
- **待发队列（`.pending-inputs`）**：压在输入框上沿，每条待发输入单行（`.pi-row`）：弱化色箭头、单行省略的正文，右侧图标按钮依次为立即发送（只有运行中的排队条目才有）、编辑、取消；子代理结果条目只有取消。不写模式标签。
- **开关（`.switch`）**：`button[role="switch"][aria-checked]`，尺寸 `--switch-w` × `--switch-h`，圆钮 `--switch-knob`。立即生效的布尔设置用开关；进表单点「保存」才生效的布尔字段用复选框 `.check`。
- **分段控件（`.seg`）**：2–4 个互斥短选项，选中项 `[aria-pressed="true"]` / `[aria-selected="true"]` / `[aria-checked="true"]` 用 `--a-sel-strong` 底。
- **下拉与输入框（`.dd`、`.input`、`.textarea`）**：默认高度 `--ctl-h-md`（`.lg` 为 `--ctl-h-lg`），机器值加 `.mono`，宽度档位 `.sm-w`（`--w-field-sm`）、`.md-w`（`--w-field-md`）。
- **徽标（`.badge`）与来源标记（`.marker`）**：`.badge` 用于状态标签（`.accent`、`.warn`、`.err`、`.ok`）；`.marker` 用等宽 `--fs-1` 标示非默认配置来源（如 `项目`、`只读 · magpie.json`），被更高层覆盖时加 `.warn`。

---

## 6. 页面模板与容器宽度

页面只有三种模板，布局宽度由 `design/tokens.json` 的 `layout` 分组控制：

1. **单栏设置页**（常规、模型、远程、外观）：
   - 外层 `.spage` 滚动，内套 `.readable`（`max-width: var(--w-readable)`，水平居中）；
   - 顶栏 `.phead`（高 `--h-page-head`，标题 `--fs-4`），正文 `.sbody`（分组间距 `--space-8`）；
   - 每组 `.group` 含 `.ghead`（标题 `--fs-2` + `--fw-semibold`）和 `.card`（圆角 `--radius-3`），行 `.srow`（最小高 `--row-h`，左 `.lab` 右 `.ctl`）。
2. **主从设置页**（服务商、授权、MCP、技能、子代理、定时任务）：
   - 外层 `.spage.flush` 不滚动，顶栏 `.phead` 下接 `.md`（左栏 `.md-list` 宽 `--w-list` 独立滚动，右栏 `.md-detail` 独立滚动，内部 `.inner` 宽 `--w-readable` 居中）；
   - 新增按钮固定在左栏顶部，主操作与删除在右栏详情顶栏 `.dhead .actions`。
3. **数据页**（用量、后台日志）：
   - 不套 `--w-readable` 窄栏限制，铺满可用宽度，表格仅用横线分隔行（`.tbl`）。
4. **对话区与侧面板**：
   - 对话消息流与输入框最大宽度 `--w-thread`；侧面板默认宽度 `--w-panel`；左侧栏宽度 `--w-sidebar`（设置导航 `--w-settings-nav`）。

---

## 7. 响应式断点

桌面端通过 CSS 容器查询（`@container`）按可用宽度自适应：

- **`#root`（`settings-layout` 容器）**：
  - `width <= 1240px`：`--w-sidebar` 收窄为 `232px`，`--page-px` 收窄为 `24px`；
  - `width <= 1060px`：主从布局 `.md` 改为上下单列堆叠，左栏 `.md-list` 置顶（`max-height: 220px`）；
  - `width <= 900px`：`--w-settings-nav` 收窄为 `168px`。
- **`.settings-over`（`settings-content` 容器）**：
  - `width < 900px`：授权页 `.grants-page .cols3` 左栏收窄为 `200px`；
  - `width < 700px`：后台日志页 `.page3 .logpage` 左右内边距收窄为 `16px`。
- **`.grants-page .pane`（`provider-detail` 容器）**：
  - `width < 520px`：服务商模型表隐藏「最大输出」列（`.model-output`）；
  - `width < 400px`：隐藏「上下文」列（`.model-context`），横幅允许换行。
- **`.usage-page`（容器查询）**：
  - `max-width: 1080px` 表格隐藏单价列；`920px` 隐藏近期速度列；`900px` 概览改 3 列；`560px` 概览与构成改 2 列；`320px` 概览改单列。
- **状态栏窄窗口让位顺序**：主区变窄时按「速度 → tokens → 上下文进度条」顺序隐藏，运行状态、上下文百分比和缓存命中始终保留，详见 [docs/apps/desktop.md](docs/apps/desktop.md#54-状态栏与上下文)。

---

## 8. 文案与显示规范

- **界面不写描述性文字**：
  - 不写模式标签（如待发队列不标排队/插话模式标签）、不写送达或状态说明、不在输入框占位符里塞快捷键提示、不写解释行为的 `title`；输入框占位只写「输入消息」；
  - 图标按钮的 `title` 与 `aria-label` 只写动作名（如「立即发送」「编辑」「取消」「关闭面板」）。
- **工具行用中文名称**：对话流与子代理面板的工具行显示 `Conversation.tsx` 的 `TOOL_META`（读取、搜索、查找文件、编辑、写入、命令、读取网页等），不显示底层工具标识或单字母图标。
- **默认状态不标**：设置项处于默认值时不加「默认」「本机」等标记；仅在被项目层或接入层覆盖、只读锁定或模型已停用时显示来源或警告标记。
- **条件不满足的操作隐藏**：当前状态下不成立的按钮直接隐藏；必须保留入口让用户知晓功能存在时，整块设为只读并加只读标记，不写说明句。
- **中英文、分隔与代码混排**：
  - 路径、命令、模型 ID、环境变量名、键名用 `<code>` 或 `.mono`；人读的标签、状态、选项名用 `--sans`；
  - 标签与状态值分成两个元素，值放进 `.muted-value`，不用「 · 」串联不同性质的信息；模型引用统一写 `provider · model`（经 `src/model-ref.ts` 格式化），子代理标题行保留「档位 · 任务摘要」；
  - 并列短语用中文逗号或顿号（「识别到 3 台，可导入 2 台」）；数值附注用括号（「第 3 轮（已撤销）」）或放进 `.muted-value`；
  - `title`、`aria-label` 是纯文本语境，可以保留中点；
  - 键盘提示用 `KeyHint`（`<kbd>` 框靠间距分隔，聊天输入框不常驻快捷键提示）；
  - 统一用词：对话回合叫「轮」，`task` 与设置统一叫「子代理」，effort 叫「思考档位」，数值后写「tokens」、说明写「token」，MCP 传输写「本地命令」「远程地址（HTTP）」；手机网页不出现 CLI 命令；
  - 按钮用 2–4 字中文动词短语（添加服务商、重新探测、立即运行、撤回修改）；
  - 异步进行中统一用 `…`（U+2026），不用三个点 `...`。

---

## 9. 例外登记

以下代码位置因系统惯例、主题预览固定色、深色图片遮罩或半透明混色无完全等值 token，使用 `/* stylelint-disable-next-line <规则> -- <理由> */` 豁免，与源码一一对应：

| 文件 | 选择器 | 规则 | 原值 | 理由 |
|---|---|---|---|---|
| `composer.css` | `.composer textarea::selection` | `function-disallowed-list` | `color-mix(in srgb, var(--a-sel-strong) 55%, transparent)` | 输入框选区用 55% `--a-sel-strong` 半透明底以透出语法高亮层 |
| `conversation.css` | `.conversation .think-end button` | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-accent) 35%, var(--a-border))` | 思考收起按钮用 35% `--a-accent` 混入 `--a-border` 的弱强调描边 |
| `conversation.css` | `.conversation .think-end button:hover` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 10%, transparent)` | 思考收起按钮悬停用 10% `--a-accent` 半透明底 |
| `conversation.css` | `.conversation-notice-error` | `function-disallowed-list` | `color-mix(in srgb, var(--a-error) 8%, transparent)` | 对话内错误提示条用 8% `--a-error` 半透明底 |
| `conversation.css` | `.conversation .ask` | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-warning) 55%, var(--a-border))` | 权限确认卡用 55% `--a-warning` 混入 `--a-border` 的警告描边 |
| `conversation.css` | `.qcard .opt[aria-checked="true"]` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 45%, transparent)` | 提问卡选中项用 45% `--a-accent` 半透明描边 |
| `pages.css` | `.page3 .wait.warnb` | `function-disallowed-list` | `color-mix(in srgb, var(--a-warning) 40%, var(--a-border))` | 登录等待警告态用 40% `--a-warning` 混入 `--a-border` 的描边 |
| `pages.css` | `.page3 .pbanner` | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-warning) 45%, var(--a-border))` | 服务商提示横幅用 45% `--a-warning` 混入 `--a-border` 的描边 |
| `pages.css` | `.page3 .keybox` | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-warning) 45%, var(--a-border))` | 密钥提示框用 45% `--a-warning` 混入 `--a-border` 的描边 |
| `pages.css` | `.page3 .scrim` | `color-no-hex, function-disallowed-list` | `color-mix(in srgb, #000 32%, transparent)` | 设置页对话框遮罩固定 32% 黑，深浅色共用 |
| `pages.css` | `.page3 .effs button.on` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 50%, transparent)` | 推理档位选中态用 50% `--a-accent` 半透明描边 |
| `pages.css` | `.tcard.on` | `function-disallowed-list` | `0 0 0 2px color-mix(in srgb, var(--a-accent) 30%, transparent)` | 主题卡片选中外圈用 30% `--a-accent` 2px 半透明环 |
| `pages.css` | `.tcard .pv i:first-child` | `color-no-hex` | `#f0f0f4` | 浅色主题预览卡侧栏固定色，不随当前主题变化 |
| `pages.css` | `.tcard .pv i:last-child` | `color-no-hex` | `#fafafb` | 浅色主题预览卡画布固定色，不随当前主题变化 |
| `pages.css` | `.tcard.dk .pv i:first-child` | `color-no-hex` | `#0d0f13` | 深色主题预览卡侧栏固定色，不随当前主题变化 |
| `pages.css` | `.tcard.dk .pv i:last-child` | `color-no-hex` | `#121419` | 深色主题预览卡画布固定色，不随当前主题变化 |
| `pages.css` | `.tcard.sys .pv i:first-child` | `color-no-hex` | `linear-gradient(90deg, #f0f0f4 34%, #fafafb 34%)` | 跟随系统预览卡浅色半边固定色，不随当前主题变化 |
| `pages.css` | `.tcard.sys .pv i:last-child` | `color-no-hex` | `linear-gradient(90deg, #0d0f13 34%, #121419 34%)` | 跟随系统预览卡深色半边固定色，不随当前主题变化 |
| `remote.css` | `.scrim:has(> .agent-pair-dlg)` | `color-no-hex, function-disallowed-list` | `color-mix(in srgb, #000 36%, transparent)` | 外部代理配对对话框遮罩固定 36% 黑，深浅色共用 |
| `skills.css` | `.skill-banner.warn` | `function-disallowed-list` | `color-mix(in srgb, var(--a-warning) 35%, var(--a-border))` | 技能警告横幅用 35% `--a-warning` 混入 `--a-border` 的描边 |
| `skills.css` | `.skill-banner.info`（`border-color`） | `function-disallowed-list` | `color-mix(in srgb, var(--a-accentAlt) 35%, var(--a-border))` | 技能信息横幅用 35% `--a-accentAlt` 混入 `--a-border` 的描边 |
| `skills.css` | `.skill-banner.info`（`background`） | `function-disallowed-list` | `color-mix(in srgb, var(--a-accentAlt) 6%, transparent)` | 技能信息横幅用 6% `--a-accentAlt` 半透明底 |
| `skills.css` | `.skill-cut` | `function-disallowed-list` | `1px dashed color-mix(in srgb, var(--a-warning) 60%, transparent)` | 技能截断标记用 60% `--a-warning` 半透明虚线框 |
| `styles.css` | `.nav .item .tag.need` | `function-disallowed-list` | `color-mix(in srgb, var(--a-warning) 14%, transparent)` | 会话行待确认标签用 14% `--a-warning` 半透明底 |
| `styles.css` | `.nav .item .tag.err` | `function-disallowed-list` | `color-mix(in srgb, var(--a-error) 14%, transparent)` | 会话行出错标签用 14% `--a-error` 半透明底 |
| `styles.css` | `.nav .item .tag.done` | `function-disallowed-list` | `color-mix(in srgb, var(--a-success) 14%, transparent)` | 会话行已完成标签用 14% `--a-success` 半透明底 |
| `styles.css` | `.dot.run` | `function-disallowed-list` | `0 0 0 3px color-mix(in srgb, var(--a-accent) 25%, transparent)` | 运行中圆点外圈用 25% `--a-accent` 半透明光晕 |
| `styles.css` | `.crash`（`border`） | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-error) 45%, var(--a-border))` | 崩溃横幅用 45% `--a-error` 混入 `--a-border` 的描边 |
| `styles.css` | `.crash`（`background`） | `function-disallowed-list` | `color-mix(in srgb, var(--a-error) 7%, transparent)` | 崩溃横幅用 7% `--a-error` 半透明底 |
| `styles.css` | `.pane-error`（`border`） | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-error) 45%, var(--a-border))` | 面板错误卡用 45% `--a-error` 混入 `--a-border` 的描边 |
| `styles.css` | `.pane-error`（`background`） | `function-disallowed-list` | `color-mix(in srgb, var(--a-error) 6%, transparent)` | 面板错误卡用 6% `--a-error` 半透明底 |
| `styles.css` | `.dialog-backdrop` | `function-disallowed-list` | `color-mix(in srgb, var(--a-bg) 60%, transparent)` | 桌面更新对话框背景用 60% `--a-bg` 半透明遮罩 |
| `usage.css` | `.usage-level-0` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 8%, var(--a-panel))` | 热力图 0 级用 8% `--a-accent` 混入 `--a-panel` |
| `usage.css` | `.usage-level-1` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 25%, var(--a-panel))` | 热力图 1 级用 25% `--a-accent` 混入 `--a-panel` |
| `usage.css` | `.usage-level-2` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 45%, var(--a-panel))` | 热力图 2 级用 45% `--a-accent` 混入 `--a-panel` |
| `usage.css` | `.usage-level-3` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 70%, var(--a-panel))` | 热力图 3 级用 70% `--a-accent` 混入 `--a-panel` |
| `usage.css` | `.usage-kind-input` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 60%, var(--a-panel))` | 用量构成条「输入」段用 60% `--a-accent` 混入 `--a-panel` |
| `usage.css` | `.usage-kind-output` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accentAlt) 55%, var(--a-panel))` | 用量构成条「输出」段用 55% `--a-accentAlt` 混入 `--a-panel` |
| `web/phone.css` | `.phone .phone-attachment button`（`background`） | `function-disallowed-list` | `rgb(0 0 0 / 0.6)` | 缩略图移除按钮深色半透明遮罩，与 `--a-overlay` 不同 |
| `web/phone.css` | `.phone .phone-attachment button`（`color`） | `color-no-hex` | `#fff` | 深色图片遮罩上的固定白字 |
| `web/phone.css` | `.phone .phone-attachment button`（`font-size`） | `declaration-property-value-allowed-list` | `15px` | 附件移除 `✕` 字符在 24px 圆钮内光学居中 |
| `web/phone.css` | `.phone-attachment small`（`background`） | `function-disallowed-list` | `rgb(0 0 0 / 0.5)` | 缩略图底部角标深色半透明遮罩，与 `--a-overlay` 不同 |
| `web/phone.css` | `.phone-attachment small`（`color`） | `color-no-hex` | `#fff` | 深色图片遮罩上的固定白字 |
| `web/phone.css` | `.phone-popover` | `color-no-hex, declaration-property-value-allowed-list` | `0 12px 40px #0004` | 手机浮层加深阴影，与桌面 `--shadow-popover` 不同 |
| `web/phone.css` | `.phone-option-check` | `declaration-property-value-allowed-list` | `18px` | 手机选项勾选 `✓` 字符光学居中与触控辨识度 |
| `web/phone.css` | `.phone-rename-backdrop` | `color-no-hex` | `#0008` | 手机重命名弹窗 53% 黑遮罩，与 `--a-overlay` 不同 |
| `web/phone.css` | `.phone-sheet` | `color-no-hex, declaration-property-value-allowed-list` | `0 -12px 40px #0003` | 手机底部抽屉向上投影，无对应向上阴影 token |

---

## 10. 自动化检查

`pnpm lint` 串联三项样式与 token 检查：

1. **`pnpm lint:css`（stylelint，配置于 [`.stylelintrc.json`](.stylelintrc.json)）**：检查 `apps/desktop/src/**/*.css`（排除生成文件 `tokens.css`）：
   - **报错级（error）**：
     - `color-no-hex`：禁止十六进制颜色字面量；
     - `color-named: "never"`：禁止 `white`、`black` 等颜色名；
     - `function-disallowed-list`：禁止 `rgb`、`rgba`、`hsl`、`hsla`、`color-mix`；
     - `declaration-property-value-allowed-list`：`font-size`、`border-radius` 及其分角属性、`box-shadow` 只允许 `var(--*)`（含 `max(var(--fs-1), 0.92em)` 这类写法）、`0`、`none`、`inherit`、`50%`；
     - `reportDescriptionlessDisables` 与 `reportNeedlessDisables`：禁止无理由或已失效的 `stylelint-disable` 注释。
   - **警告级（warning）**：
     - `declaration-property-value-disallowed-list`：`padding*`、`margin*`、`gap`、`row-gap`、`column-gap` 只允许 `var(--*)`、`0`、`auto`；
     - 通过 `--max-warnings 681` 锁定存量警告上限，警告数只能减不能增；`lint:css` 只输出警告总数，看明细直接跑 `pnpm exec stylelint "apps/desktop/src/**/*.css"`。
2. **`node scripts/gen-tokens.mjs --check`**：校验 `apps/desktop/src/tokens.css` 与 `design/tokens.json` 完全同步，手工编辑 `tokens.css` 会直接失败。
3. **`node scripts/check-css-vars.mjs`**：扫描 `apps/desktop/src/**/*.{css,ts,tsx}` 中所有 `var(--*)` 引用，若无回退值且未在任何 CSS 文件中定义则报错退出。
