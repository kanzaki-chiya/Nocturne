# Nocturne 设计规范

适用于桌面端（`apps/desktop`）与随附手机网页（`apps/desktop/src/web`）。TUI 与官网单独维护，配色方向保持一致。

所有设计 token 定义在 [`design/tokens.json`](design/tokens.json) 中，由 `scripts/gen-tokens.mjs` 生成 [`apps/desktop/src/tokens.css`](apps/desktop/src/tokens.css)，不在本文档重复抄写具体数值。

---

## 0. 设计原则

1. **界面不写描述性文字**：不写模式标签、送达或状态说明、占位里的快捷键提示、解释行为的 `title`；图标按钮的 `title` / `aria-label` 只写动作名。标签讲不清就改标签或控件，不加说明。
2. **一种东西只有一种样子**：同一角色（主操作、分组标题、开关、只读徽标、空状态）在所有页面用同一套样式与位置，差异只能来自状态，不能来自页面。
3. **层级靠空白和字重，不靠颜色**：分组间距明显大于行间距，标题比正文重一档；彩色只留给可交互项与状态。
4. **只在有新信息时显示状态**：默认状态不标；偏离默认、需要注意或可撤销时才显示标记。
5. **等宽字体表示机器读的值**：路径、命令、模型 ID、环境变量名、数字统计用等宽；人读的值、选项名、状态一律无衬线。
6. **不适用就别显示**：条件不满足的操作隐藏；必须让用户知道它存在时，整块只读并加只读标记，不写说明句。
7. **只用 token，例外要登记**：颜色、字号、圆角、阴影、控件尺寸都从 `design/tokens.json` 取；确需字面量的位置加 `stylelint-disable-next-line` 并在本文第 9 节登记。

---

## 1. 颜色

- **定义位置**：`design/tokens.json` 的 `color` 分组，由 `apps/desktop/src/tokens.css` 导出深浅模式。
- **主题预设与自定义主题**：工作台、夜曲、纸面、青瓷、松烟的种子色、效果图出处、推算规则、对比度下限与手机同步见 [ADR-0093](docs/decisions/ADR-0093-appearance-theme-presets.md)；自定义主题的单面三色 OKLCH 双面推算、亮暗双面卡片、编辑/导入/导出浮窗与首帧缓存见 [ADR-0094](docs/decisions/ADR-0094-custom-themes.md)。预设与自定义主题在运行时覆盖颜色 token，工作台恢复原 token；迷你卡片左半亮面、右半暗面使用相同推算结果，无须固定预览色豁免。
- **工作台单层平铺与中性灰选中态**（[ADR-0092](docs/decisions/ADR-0092-desktop-redesign-workbench.md)）：保持强调色、语义色、分类色与代码高亮不变；中性色表面与选中态（`--a-sel`、`--a-sel-strong`）转为纯粹中性灰。主区（`--a-bg`）与标题栏/侧栏（`--a-side`）处于同一平面，只靠 `1px` `--a-border` 细线分隔，不再使用浮起卡片包裹主区。
- **表面与文字**：
  - 表面层次：`--a-bg`（主画布）、`--a-side`（标题栏、侧栏与设置导航）、`--a-panel`（浮层、菜单、对话框、输入框）、`--a-raised`（悬停底、次级块、代码块表头）、`--a-input`（表单输入底）、`--a-code-bg`（代码块底）、`--a-overlay`（浮层遮罩）、`--a-qr-bg`（二维码底）。
  - 文字层次：`--a-text`（正文与标题）、`--a-secondary`（次要正文、未选中导航、按钮文字）、`--a-muted`（分组标题、辅助标签）、`--a-faint`（占位符、装饰分隔、禁用灰字）。工作台使用既定中性色；其他预设按 ADR-0093 的种子色取值。
- **强调与状态**：
  - 强调色：`--a-accent`、`--a-accent-hover`、`--a-accentAlt`、`--a-on-accent`、`--a-accent-subtle`、`--a-accent-border`、`--a-focus-ring`；选中态：`--a-sel`、`--a-sel-strong`、`--a-multi-sel`、`--a-multi-sel-strong`。
  - 实心主按钮（发送）：`--a-btn`（指向 `--a-text`）与 `--a-on-btn`（指向 `--a-bg`），组件不直接引用 `--a-text`。
  - 边框与控件：`--a-border`、`--a-border-strong`、`--a-switch-off`、`--a-switch-knob`、`--a-scroll`、`--a-scrollThumbHover`。
  - 语义色：`--a-success` / `--a-success-bg`、`--a-warning` / `--a-warning-bg`、`--a-error` / `--a-error-bg` / `--a-error-border`。
  - 分类、热力图与代码高亮：`--a-cat1`..`--a-cat5`、`--a-termYellow` / `--a-termYellowBright`、`--cm-*`（CodeMirror 与 `.syntax-*` 代码高亮共用）；热力图五档由 `--a-accent` 与 `--a-panel` 按比例混色。
- **底色与描边规则**：
  - 状态色作文字或图标时，搭配对应的浅底（`--a-warning-bg`、`--a-error-bg`、`--a-success-bg`、`--a-accent-subtle`）或弱混色底，不用高饱和实心色块铺满整行（主按钮与聚焦态除外）。
  - 对话内提示条、文件变更增删行统一用浅色底或整圈弱描边表达级别，不用左侧粗色条；权限确认卡使用 `--a-panel` 面板底与 `--a-border-strong` 描边，仅通过警示色图标与审查结论圆点表达级别。

---

## 2. 字体与字号

- **随包字体与字体栈**（定义于 `design/tokens.json` 的 `font` 分组）：桌面端与手机网页入口各自引入 `@fontsource-variable/inter` 与 `@fontsource-variable/jetbrains-mono`（均仅引入 `latin` 子集，OFL-1.1 登记见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)），中文字符由系统字体回退：
  - `--sans`：`"Inter Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif`（界面正文、标签、分组标题与数字统计）。
  - `--mono`：`"JetBrains Mono Variable", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace`（仅用于机器读的值：路径、命令、分支、diff、模型 ID、快捷键与技术标识；尾段保留中文字体避免代码注释汉字落到点阵宋体）。
- **字号梯度**（5 档，`--fs-5` 调为 `20px`，具体数值见 `design/tokens.json`）：

| 变量 | 桌面端用途 | 手机端用途 |
|---|---|---|
| `--fs-1` | 次要信息、徽章、表头、侧栏与设置分组标题、思考过程（12px） | 角标、快捷键、次要标签 |
| `--fs-2` | 导航项、菜单项、按钮、表单标签、设置行、对话标题、工具行全部文字（默认 13px） | 辅助说明、输入框底栏、胶囊按钮、代码输出 |
| `--fs-3` | 对话正文、输入框、卡片标题、Markdown `h4`–`h6`（14px） | 正文、设置行、抽屉项、选项标题 |
| `--fs-4` | 弹窗标题、Markdown `h3`（16px） | 顶栏标题、对话框标题、发送按钮 |
| `--fs-5` | 新会话标题、设置页标题、用量大数字、Markdown `h1`/`h2`（20px） | 空状态标题 |

- **桌面端工作台字号与字重用法**：

| 位置 | 字号 | 字重与样式 |
|---|---|---|
| 导航行、菜单项、设置行、输入框底栏、工具行 | `--fs-2` | `--fw-regular`（400；选中导航用 `--fw-medium` 500；工具行动词/计数/状态用 `--sans`，路径/命令/参数用 `--mono`） |
| 对话正文、输入框 | `--fs-3` | `--fw-regular`（400） |
| diff 正文 | `--fs-diff` | `--fw-regular`（400，`12.5px`，`--mono`） |
| 侧栏分组标题、设置分组标题 | `--fs-1` | `--fw-medium`（500），`--a-muted`，字距 `0.02em` |
| 对话标题 | `--fs-2` | `--fw-medium`（500） |
| 新会话标题「有什么可以帮你？」、设置页标题 | `--fs-5` | `--fw-semibold`（600），字距 `-0.01em` |

文件卡片 28px 方块内的类型标记用 `--fs-file-badge`，方块尺寸固定，所以这档不参与字号缩放。

- **桌面端字体与字号缩放**（`apps/desktop/src/appearance.ts`）：「设置 › 外观」选择的界面字体与代码字体插到 `--sans` / `--mono` 原字体栈最前面（原栈整体留作回退）；字号（12–20，默认 14）在 `<html>` 行内样式上按 `Math.round(原值 × 字号 / 14)` 等比缩放 `--fs-1` 到 `--fs-5`，面板终端一并读取计算后的 `--fs-2` 与 `--mono`。只作用于桌面端，手机端不读取也不应用。
- **混排基线对齐**：同一行内同时出现无衬线（`--sans`）与等宽（`--mono`）文字时（对话工具行 `.tool-line`、改动卡片文件行 `.diff-h`、会话概览项目行与变更行、用量排行行），行容器用 `align-items: baseline` 让两种字体按文字基线对齐；行内的纯图标或进度条用 `align-self: center` 单独居中。
- **手机网页**：根字号 16px，正文与输入框沿用根字号（输入框小于 16px 会触发 iOS 聚焦时整页放大）；触控目标不小于 44px；触屏上用系统叠加式滚动条，不占布局宽度。
- **桌面端与手机网页共用的样式表**：手机网页同样加载 `styles.css`、`conversation.css`、`grants.css`、`code-colors.css`（经 `Conversation.tsx`）和 `side-panel.css`。在这些文件里新增只给桌面端的规则时，选择器要排除 `.phone` 内部；手机专属规则写在 `web/phone.css`。
- 行内代码与键盘提示在对话和面板内用 `max(var(--fs-1), 0.92em)`（或 `0.85em`），随外层正文缩放且不小于 `--fs-1`。
- **字重**：`--fw-regular`（正文）、`--fw-medium`（导航选中、按钮、表单标签、小标题）、`--fw-semibold`（页面标题、分组标题、大数字），不使用 `700`。
- **行高**：`--lh-tight`（标题、单行控件）、`--lh-base`（界面正文、表单说明）、`--lh-code`（代码块、日志、终端）、`--lh-prose`（对话 Markdown 正文）。
- **数字对齐**：百分比、token 数、金额、时间、计数器统一加 `font-variant-numeric: tabular-nums`，避免跳动与错位。
- **输入框底栏与对话标题行**：桌面端去掉底部状态栏，改由输入框底栏与对话标题行承担状态与控制。输入框底栏（高 `--ctl-h-md` 28px）使用 `--fs-2`、`--sans`、常规字重 `--fw-regular`、数字 tabular-nums（chip 默认文字 `--a-secondary`，悬停与展开 `--a-text`）：左侧「＋」（`240px` 上弹菜单含六种执行方式，与 `220px`「技能」「MCP」右展子菜单；MCP 失败或崩溃时右上角亮 `6px` 红点）、回形针「添加文件」、权限预设 chip；右侧依次为 `18px` SVG 上下文圆环（仅会话页，点击在输入框外框上方 `8px`、右缘对齐圆环处弹出面板，窄窗不超出左侧，底部附累计 tokens 与缓存占比）、模型（名字前带 `14px` 品牌图标、间距 `6px`，匹配不上用 `box_3`）与思考档位 chip、实心圆角发送/中断按钮（圆角 `--radius-send`、`--a-btn`/`--a-on-btn`）。选中执行方式后，输入区与底栏之间展示单行标签（含关闭图标、无解释文案）。新会话页输入卡片下方贴附左右各缩进 `12px` 的 `.tray` 托盘（`--a-raised` 底色、`margin-top: -1px` 压在输入框下边后面、无上边框、下圆角 `--radius-composer`），从左到右放工作区（名称最宽 `320px` 省略）与 Git 分支 chip（等宽字、名称最宽 `240px` 省略；普通对话或非仓库隐藏分支 chip），两菜单向下弹出，悬停底改用 `--a-sel`；会话页无托盘，分支菜单与电脑操控中的「停止」置于对话标题行（[docs/apps/desktop.md](docs/apps/desktop.md#54-上下文用量标题栏控制与状态迁移)）。

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
| `--radius-0-5` | 极小色块（如上下文构成图例色点，`2px`） |
| `--radius-1` | 行内代码、键盘提示、小徽章、复选框、分段按钮内项、滚动条滑块（`4px`） |
| `--radius-2` | 按钮、输入框、下拉框、菜单项、导航行、chip、小卡片、代码块、待发行（`6px`） |
| `--radius-send` | 桌面端输入框实心发送/中断按钮专用圆角（`7px`） |
| `--radius-3` | 对话框、弹层、菜单面板、用户气泡、提示卡、diff 卡片、手机卡片与抽屉（`8px`） |
| `--radius-composer` | 输入框外框与权限确认卡圆角（`10px`） |
| `--radius-pill` | 胶囊标签、开关轨道、状态圆点、圆形图标按钮 |

- **阴影**（定义于 `design/tokens.json` 的 `shadow` 分组）：
  - `--shadow-popover`：菜单、下拉、上下文面板；
  - `--shadow-dialog`：模态对话框、抽屉；
  - `--shadow-edge`：覆盖式侧面板左缘阴影；
  - `--shadow-focus`：键盘 `:focus-visible` 与输入框 `:focus` 聚焦环。提问卡被程序聚焦（`tabIndex={-1}`）时去掉浏览器默认 outline，`:focus-within` 用 `--a-accent` 边框加 `--shadow-focus` 外圈；权限确认卡 `:focus-within` 仅将边框切为 `--a-accent-border`，不加 `--shadow-focus` 外圈（卡片内按钮保留 `:focus-visible` 焦点环）。

---

## 5. 基础控件

共享基础控件样式集中在 [`apps/desktop/src/ui.css`](apps/desktop/src/ui.css)，尺寸 token 定义在 `design/tokens.json` 的 `control` 分组。

- **按钮（`.btn`）**：默认高度 `--ctl-h-md`、圆角 `--radius-2`、字号 `--fs-2`、字重 `--fw-medium`。
  - 默认 `.btn`：描边次按钮（`--a-border-strong` 描边、透明底）；
  - `.btn-primary`：实心强调色主按钮（同一区域最多一个）；
  - `.btn-ghost`：无边框弱按钮；
  - `.btn-danger`：常规态与次按钮相同，悬停变红；
  - `.btn-danger-text`：无边框、常态错误色文字，悬停 `--a-error-bg` 底（用于权限确认卡「拒绝并停止」等需要明确警示但不与主操作争重的破坏性选项）；
  - `.btn-danger-solid`：破坏性确认弹窗内的实心红按钮；
  - 尺寸变体：`.btn-sm`（`--ctl-h-sm`）、`.btn-lg`（`--ctl-h-lg`），触控端按钮高度用 `--ctl-h-touch`。
- **`src/ui/` 组件**：各页面一律用这组组件（`Button`、`IconButton`、`Icon`、`Switch`、`Checkbox`、`SegmentedControl`、`Badge`），不单独写局部按钮、开关、复选框、分段控件或徽标样式。`IconButton` 必填 `aria-label`；`Button` 的 `danger-solid` 只用于最后一步确认，另有 `ghost-danger` 与 `danger-text` 变体。
- **图标（`<Icon>`）**：界面图标统一使用 MingCute 线性图标（`mingcute_icon` 2.9.72，`_line.svg` 填充路径），由公共组件 `apps/desktop/src/ui/Icon.tsx`（`<Icon name="..." size={...} />`）渲染，继承 `currentColor`，默认 `aria-hidden`。桌面端三档尺寸定义在 `design/tokens.json` 的 `control` 分组：侧栏导航、设置页导航、工具栏和图标按钮用 `--icon-md`（`ICON_MD`，16px），部分较大场景保留 `--icon-lg`（`ICON_LG`，18px），小字旁边（工具行、标签、下拉箭头、折叠箭头）用 `--icon-sm`（`ICON_SM`，14px）；手机网页沿用现有显示尺寸。窗口控制按钮、品牌标记、数据图形及终端和代码查看器内部内容除外。
- **图标按钮（`.ib`）**：宽高 `--ctl-h-md`（`.ib.sm` 为 `--ctl-h-sm`），圆角 `--radius-2`，激活态加 `.on` 或 `aria-pressed="true"`。图标按钮的 `title` 与 `aria-label` 只写动作名，不写状态或行为解释。
- **折叠箭头（`.fold-arrow`）**：统一使用 `<Icon name="right_small" size={ICON_SM} className="fold-arrow" />` 配合 CSS `transform: rotate(...)` 过渡（对话流内用户触发的 `<details>` 为 `--dur-fold`），不混用文本三角字符或 `summary::before` 伪元素。折叠时朝右（`0deg`）；展开时指向展开出的内容——按钮在内容上方时朝下（`.fold-arrow.down` 或 `details[open] > summary > .fold-arrow`，`90deg`），按钮在内容下方时朝上（`.fold-arrow.up`，`-90deg`）。下拉触发器统一使用 `<Icon name="down_small" size={ICON_SM} />`，不算折叠箭头。
- **待发队列（`.pending-inputs`）**：压在输入框上沿，每条待发输入单行（`.pi-row`）：弱化色箭头、单行省略的正文，右侧图标按钮依次为立即发送（只有运行中的排队条目才有）、编辑、取消；子代理结果条目只有取消。不写模式标签。
- **开关（`.switch`）**：`button[role="switch"][aria-checked]`，尺寸 `--switch-w` × `--switch-h`（`32px × 18px`），打开时轨道用强调色 `--a-accent`，圆钮 `--switch-knob`。立即生效的布尔设置用开关；进表单点「保存」才生效的布尔字段用复选框 `.check`。
- **分段控件（`.seg`）**：2–4 个互斥短选项，选中项 `[aria-pressed="true"]` / `[aria-selected="true"]` / `[aria-checked="true"]` 用 `--a-sel-strong` 底。
- **下拉与输入框（`.dd`、`.input`、`.textarea`）**：默认高度 `--ctl-h-md`（`28px`；`.lg` 为 `--ctl-h-lg`），下拉触发器 `.dd` 采用透明底与 `1px solid var(--a-border)` 描边；机器值加 `.mono`，宽度档位 `.sm-w`（`--w-field-sm`）、`.md-w`（`--w-field-md`）。
- **菜单、对话框与浮层（`Menu`、`.ddm`、`.dlg`、`.ovpop`、`.qopen`、`.search-dialog`）**：统一使用 `--radius-3` 圆角、`1px solid var(--a-border)` 描边与 `--a-panel` 底色；菜单项与下拉项高 `--item-h`（`30px`），焦点与选中底色 `--a-sel`；`MenuItem` 仅在传入 `checked` 时渲染 `.menu-ck` 勾选列（无 `icon` 时在最前，带 `icon` 时移至行尾并保留固定宽度）：默认是单选项（`menuitemradio`，菜单打开时焦点落在选中项上）；再加 `toggle` 是独立开关（`menuitemcheckbox`，如「文件」菜单的「自动换行」），不抢初始焦点，普通菜单图标贴左对齐；模型菜单每项名字前显示 `16px` 品牌或通用图标（`box_3`，手机网页模型菜单内为 `14px`），思考档位与权限菜单不显示图标。
- **徽标（`.badge`）与覆盖警告**：`.badge` 用于状态标签（`.accent`、`.warn`、`.err`、`.ok`）和「只读」。除覆盖警告和只读徽标外不显示配置来源；被更高层覆盖的设置值用 `--a-warning` 色，现有覆盖警告只放在值的 `title`，不加徽标或可见说明。Shell 行既有的「由…指定」保留。

---

## 6. 页面模板与容器宽度

页面模板如下，布局宽度由 `design/tokens.json` 的 `layout` 分组控制：

1. **设置导航与单栏设置页**（常规、模型、远程、外观、浏览器、电脑操控、已归档的会话）：
   - 设置导航（`.snav`）与侧栏共用一套样式：行高 `--item-h`（`30px`）、图标加名称、选中底 `--a-sel`，顶部为「← 返回」与 `Esc` 键帽提示，底部不放说明文字；
   - 外层 `.spage` 滚动，内套 `.readable`（`max-width: var(--w-readable)` `880px`，水平居中，顶部留白 `32px` `--space-8`）；
   - 顶栏 `.phead`（高 `--h-page-head`，标题 `--fs-5`、`--fw-semibold`、`letter-spacing: -0.01em`），正文 `.sbody`（分组间距 `--space-8`）；
   - 每组 `.group` 去掉外层卡片框，分组上方（含首组）以 `1px solid var(--a-border)` 分隔，`.ghead` 标题用 `--fs-1`、`--fw-medium`、`letter-spacing: 0.02em`、`--a-muted`；`.card` 仅作内容容器，内部设置行 `.srow` 最小高 `--row-h`（`48px`）、左 `.lab` 右 `.ctl`，行间以 `1px solid var(--a-border)` 分隔。
2. **主从设置页**（服务商）：
   - 服务商页保留居中双栏卡片（`.spage` > `.readable` 宽 `880px` > `.phead` > `.md-frame` > `.md.framed`）：卡片带 `1px solid var(--a-border)` 描边、`--radius-3` 圆角与 `--a-panel` 底色，撑满页头以下剩余高度（底部留 `--space-8`）；左栏 `.md-list` 宽 `220px`（内边距 `--space-2`）、右栏 `.md-detail`（内边距 `--space-5` `--space-6` `--space-6`，`.inner` 铺满右栏不限 `680px`），左右各自独立滚动，按卡片宽度（`< 640px`）上下堆叠。定时任务页（`SchedulePage`）仍沿用旧的 `.spage.flush` 铺满式布局（左栏 `--w-list` `280px`，`.inner` 限 `--w-readable`）。详情分组去掉外层卡片框，行高 `48px`，表格统一表头与行线；名字单行省略，完整名字放 `title`。服务商左栏行与详情标题前显示 `16px` 品牌或通用图标（`cloud`，行内状态点移至最右），添加选择页 `30px` 方块内居中显示 `18px` 图标（自定义类保留「+」）。
   - 新增按钮在页头右侧，主操作在右栏详情顶栏；删除收入「更多」菜单，禁用条件与来源 `title` 保留。
3. **列表页**（子代理、技能、MCP、桌面授权）：
   - 使用 `.spage` > `.readable`（`880px` 居中）> `PageHeader` 与自上而下的 `SettingsGroup`，无双栏卡片。`SettingsListRow` 最小高 `56px`、上下内边距 `8px`、底边 `1px solid var(--a-border)`；悬停底 `--a-raised` 左右各外扩 `10px`、圆角 `6px`。组标题与行线沿用设置页。
   - 左侧名称 `13px`、`--a-text`，可用等宽字并带徽标；第二行 `12px`、`--a-muted`、单行省略，等宽时 `11.5px`。停用名称用 `--a-faint`。右侧依次为状态或文字、开关、`14px` `right_small` 箭头（`--a-faint`）。左侧文字由按钮包裹，开关是兄弟元素；点击空白也打开详情，点击开关只启停。
   - 点击条目、新建、编辑进入独立子页面。`PageHeader.crumb` 显示「父页面 › 当前名称」，父页面按钮用 `--a-muted`、悬停 `--a-text`，分隔符 `--a-faint`，字号沿用页标题，徽标和路径放 `extra`；点击父页面返回列表，不增加 Esc 返回。
   - 详情右侧放启用、已有的测试连接与 `IconButton`「更多」菜单（横排三点）；菜单沿用原操作名称，删除项危险色且前有分隔线。只读条目不提供编辑与删除菜单。
   - 子页面表单左标签、右控件，文本输入、多行输入与键值编辑器宽 `400px` 靠右，下拉、开关、分段控件保持自身宽度靠右；行最小高 `48px`、设置行线，底部按钮靠右依次为取消、原有的测试连接、保存。描述框从单行随内容增高。
   - 已有子代理档位即改即存：选择项与开关变更即保存，描述失焦且有变化才保存（清空则恢复），超时失焦或回车保存（清空不设）；失败恢复已保存值，成功沿用 toast。新建档位仍有取消与保存；默认档位仅模型可改。
   - 全部滚动区共用无箭头的细滚动条，隐藏滚动条的区域保留 `scrollbar-width: none`。手机授权沿用原页面结构。
4. **数据页**（用量、后台日志）：
   - 同样套用 `.spage` > `.readable`（`max-width: var(--w-readable)` `880px` 居中，顶部留白与常规页一致），表格统一表头与 `1px solid var(--a-border)` 行线（`.tbl`）；后台日志页的日志框撑满下方剩余高度，长行在框内换行。
5. **对话区与侧面板**：
   - 对话消息流与输入框最大宽度 `--w-thread`（`720px`），消息条目间距 `--space-3`（`12px`）；侧面板默认宽度 `520px`（`PANEL_DEFAULT_WIDTH`，可拖拽调宽）；左侧栏宽度 `--w-sidebar`（设置导航 `--w-settings-nav`）；
   - 用户消息气泡（`.u-bubble`）使用 `--a-raised` 底色与 `--radius-3` 圆角；
   - 工具行（`.tool-line`）按语义拆分字体：动作动词、计数、状态等中文/阅读文本用 `--sans`，路径、文件名、命令、参数名值用 `--mono`，通过基线对齐；连续工具行之间、同一调用的多文件行之间都是 6px，工具行与正文、思考块之间 12px；
   - diff 卡片（`.tool-diff`）与本轮文件改动卡片（`.turn-changes-card`）采用 `--radius-3` 圆角、`1px solid var(--a-border)` 描边，表头 `.diff-h` 底色 `--a-code-bg`、路径用 `--mono`、`+N` 用 `--a-success`、`−N` 用 `--a-error`，diff 正文用 `--fs-diff`（`12.5px`）；
   - 权限确认卡（`.ask`）、提问卡（`.qcard`）、提示条（`.conversation-notice-*`）、子代理行（`.subagent-view`）、计划/任务清单与目标详卡片（`.todo-panel`、`.goal-detail`）统一使用 `--radius-2` / `--radius-3` 圆角与 `1px solid var(--a-border)` 描边，中文标签与人读内容一律使用 `--sans`。
   - 回答里的 Markdown 表格（`.conversation-markdown .tbl`，桌面、子代理面板与手机共用）：单元格不继承消息的 `overflow-wrap: anywhere`；源文本不超过 10 个半角宽（全角算 2）的短格整格不换行，其余格子至少 5em 宽，长说明在剩余宽度内换行，格内路径、URL 与行内代码仍可任意断开；装不下时只在 `.tbl-wrap` 内横向滚动（`overscroll-behavior-x: contain`），页面不横向滚动，不加滚动提示或遮罩。宽度足够时列宽分配与普通表格相同。

**手机顶栏与侧边栏**（[ADR-0084](docs/decisions/ADR-0084-phone-side-panel.md)）：顶栏右侧只有「…」会话菜单与侧边栏按钮两个图标；侧边栏是右侧抽屉，宽 88%，从顶栏下沿开始、不盖顶栏，顶栏以下的其余界面压暗；点遮罩、再点侧边栏按钮或安卓返回关闭，子视图返回先回总览。总览自上而下为上下文百分比、累计 tokens 与构成，运行中的子代理（同步与后台同列，不加标记、无行内取消），后台命令（运行中与刚结束的，无行内停止），底部「变更」「文件」「终端」；没有条目的分组不显示。子视图只读：子代理过程用对话同款渲染，变更为按轮 diff，文件为文件索引加只读、自动换行的代码查看器；取消后台子代理与停止后台命令只在详情出现。终端是虚线边框、淡色的 `aria-disabled` 静态行，不动作、不写说明。

**图片查看器**（`ImageViewer.tsx`、`image-viewer.css`，桌面、手机网页、安卓共用）：经 portal 挂在 `document.body` 盖住整个窗口，不被对话区、子代理面板、右侧面板或手机抽屉裁剪。遮罩不用 `--a-overlay`，桌面深浅主题统一为固定深色 `rgb(10 10 14 / 0.88)`，窄于 `600px` 的手机为全屏纯黑 `#000`。右上角图标栏依次为「复制」「下载」「关闭」三个 `IconButton`（平台不支持的操作直接隐藏），同组多张时左右两侧显示圆形「上一张」「下一张」按钮（`<= 600px` 隐藏，顶栏按钮触控区升为 `--ctl-h-touch` 44px）并在底部居中显示等宽数字计数 `2 / 4`，单张时不渲染箭头与计数；控件底色统一为 `rgb(20 20 26 / 0.72)` 深色半透明底配 `#f2f2f6` 浅色图标与文字。初始按适应窗口显示且不放大超过原始像素，缩放范围为适应窗口至 8 倍：桌面支持以光标为中心的滚轮缩放、双击在适应窗口与原始大小间切换、放大后在边界内拖动平移、方向键或箭头循环切换；手机支持双指缩放、双触切换适应与放大、放大后单指拖动、未放大时左右滑动切换，安卓返回键先关闭查看器。打开时焦点移入查看器并困在内部，Esc、点图片外空白或点关闭按钮均直接消失（仅在 `prefers-reduced-motion: no-preference` 下入场淡入 `--dur-dialog`）并将焦点归还原缩略图。查看器内除计数外不显示任何文字、文件名、尺寸、百分比或成功提示，复制失败仅将错误原文写入复制按钮 `title`。

---

## 7. 响应式断点

桌面端通过 CSS 容器查询（`@container`）按可用宽度自适应：

- **`#root`（`settings-layout` 容器）**：
  - `width <= 1240px`：`--w-sidebar` 收窄为 `232px`，`--page-px` 收窄为 `24px`；
  - `width <= 1060px`：非带框主从布局 `.md:not(.framed)`（定时任务）改为上下单列堆叠，左栏 `.md-list` 置顶（`max-height: 220px`）；
  - `width <= 900px`：`--w-settings-nav` 收窄为 `168px`。
- **`.md-frame`（`md-frame` 容器，仅服务商带框主从卡片）**：
  - `width < 640px`：`.md.framed` 改为上下单列堆叠，列表置顶（`max-height: 220px`，底部边线）。
- **`.md.framed > .md-detail`（`md-detail` 容器）**：
  - `width < 480px`：服务商添加选择页 `.addgrid` 改为单列。
- **列表页与子页面**：子代理、技能、MCP、桌面授权始终使用单列 `.readable`；表单控件宽度不超过可用空间，窄内容区允许标签与控件换行，菜单与页头操作不撑宽页面。
- **`.usage-page`（容器查询）**：
  - `max-width: 760px` 概览改 3 列、展开区 `.usage-detail` 改上下排列（图区固定 220px 高）；`560px` 概览与构成改 2 列；`320px` 概览改单列。
- **侧栏运行状态与输入框收敛**：侧栏运行中且无「待确认」或留痕标签的会话行末显示 `12px` 环形转圈（悬停/聚焦显示「…」时隐藏）；输入框底栏在窄屏内保持单行不换行，新会话页工作区与分支收入下方 `.tray` 托盘并按各自宽度上限省略；不再保留底部状态栏与相关让位规则，详见 [docs/apps/desktop.md](docs/apps/desktop.md#54-上下文用量标题栏控制与状态迁移)。

---

## 8. 文案与显示规范

- **界面不写描述性文字**：
  - 不写模式标签（如待发队列不标排队/插话模式标签）、不写送达或状态说明、不在输入框占位符里塞快捷键提示、不写解释行为的 `title`；输入框占位只写「输入消息」；
  - 图标按钮的 `title` 与 `aria-label` 只写动作名（如「立即发送」「编辑」「取消」「关闭面板」）。
- **沿用原有叫法**：同一概念在界面上已有叫法时照用，不另造新词，如「API Key」不写成「API 密钥」；手机网页沿用桌面端设置页的原词。
- **工具行用中文名称**：对话流与子代理面板的工具行显示 `tool-meta.ts` 的 `TOOL_META`（读取、搜索、查找文件、编辑、写入、命令、读取网页等），不显示底层工具标识或单字母图标。
- **默认状态不标**：设置项处于默认值时不加「默认」「本机」等标记；覆盖值只以警告色和 `title` 提醒，只读锁定用「只读」徽标，模型停用保留状态标记，不显示配置来源。
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
| `conversation.css` | `.qcard .opt[aria-checked="true"]` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 45%, transparent)` | 提问卡选中项用 45% `--a-accent` 半透明描边 |
| `image-viewer.css` | `.image-viewer`（`background`） | `function-disallowed-list` | `rgb(10 10 14 / 0.88)` | 图片查看器遮罩固定深色，深浅主题共用，不用 `--a-overlay` |
| `image-viewer.css` | `.image-viewer`（`color`） | `color-no-hex` | `#f2f2f6` | 图片查看器深色遮罩上的浅色图标与计数文字 |
| `image-viewer.css` | `.image-viewer .iv-stage img` | `color-no-hex` | `#fff` | 图片查看器大图固定白底以垫托透明 PNG，深浅主题共用 |
| `image-viewer.css` | `.image-viewer .iv-btn:hover:not(:disabled)` | `function-disallowed-list` | `rgb(242 242 246 / 0.14)` | 图片查看器深色控件上的浅色半透明悬停底 |
| `image-viewer.css` | `.image-viewer :is(.iv-top, .iv-nav, .iv-count)` | `function-disallowed-list` | `rgb(20 20 26 / 0.72)` | 图片查看器按钮栏、切换箭头与计数的深色半透明底 |
| `image-viewer.css` | `@media (max-width: 600px) .image-viewer` | `color-no-hex` | `#000` | 手机图片查看器全屏纯黑底 |
| `inline-page.css` | `.inline-page-tools, .inline-page-fullscreen-tools` | `function-disallowed-list` | `color-mix(in srgb, var(--a-panel) 84%, transparent)` | 回复内嵌页面悬浮工具栏用 84% `--a-panel` 毛玻璃半透明底 |
| `inline-page.css` | `.inline-page-more` | `function-disallowed-list` | `color-mix(in srgb, var(--a-panel) 84%, transparent)` | 回复内嵌页面底部展开/收起按钮用 84% `--a-panel` 毛玻璃半透明底 |
| `pages.css` | `.page3 .wait.warnb` | `function-disallowed-list` | `color-mix(in srgb, var(--a-warning) 40%, var(--a-border))` | 登录等待警告态用 40% `--a-warning` 混入 `--a-border` 的描边 |
| `pages.css` | `.page3 .pbanner` | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-warning) 45%, var(--a-border))` | 服务商提示横幅用 45% `--a-warning` 混入 `--a-border` 的描边 |
| `pages.css` | `.page3 .keybox` | `function-disallowed-list` | `1px solid color-mix(in srgb, var(--a-warning) 45%, var(--a-border))` | 密钥提示框用 45% `--a-warning` 混入 `--a-border` 的描边 |
| `pages.css` | `.scrim` | `color-no-hex, function-disallowed-list` | `color-mix(in srgb, #000 32%, transparent)` | 对话框遮罩固定 32% 黑，深浅色共用 |
| `pages.css` | `.page3 .effs button.on` | `function-disallowed-list` | `color-mix(in srgb, var(--a-accent) 50%, transparent)` | 推理档位选中态用 50% `--a-accent` 半透明描边 |
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
| `web/phone.css` | `.phone .phone-attachment .phone-attachment-remove`（`background`） | `function-disallowed-list` | `rgb(0 0 0 / 0.6)` | 缩略图移除按钮深色半透明遮罩，与 `--a-overlay` 不同 |
| `web/phone.css` | `.phone .phone-attachment .phone-attachment-remove`（`color`） | `color-no-hex` | `#fff` | 深色图片遮罩上的固定白字 |
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
     - 通过 `--max-warnings 598` 锁定存量警告上限，警告数只能减不能增，实际数低于上限时同样失败，需把上限改成实际数；`lint:css` 只输出警告总数，看明细直接跑 `pnpm exec stylelint "apps/desktop/src/**/*.css"`。
2. **`node scripts/gen-tokens.mjs --check`**：校验 `apps/desktop/src/tokens.css` 与 `design/tokens.json` 完全同步，手工编辑 `tokens.css` 会直接失败。
3. **`node scripts/check-css-vars.mjs`**：扫描 `apps/desktop/src/**/*.{css,ts,tsx}` 中所有 `var(--*)` 引用，若无回退值且未在任何 CSS 文件中定义则报错退出。

## 11. 动效

| 位置 | 时长 token | 时长 | 曲线 |
|---|---|---|---|
| 菜单打开 | `--dur-menu` | 100ms | `--ease-out`：`cubic-bezier(.2, .8, .3, 1)` |
| 对话框打开 | `--dur-dialog` | 120ms | `--ease-out` |
| 折叠区展开和收起 | `--dur-fold` | 180ms | `--ease-both`：`cubic-bezier(.4, 0, .2, 1)` |
| 面板开合 | `--dur-panel` | 200ms | `--ease-both` |
| 悬停进入 | `--dur-hover-in` | 140ms | `ease-out` |
| 悬停离开 | `--dur-hover-out` | 210ms | `ease-out` |
| 按下缩放 | `--dur-press` | 90ms | `--ease-out` |
| 预设卡片箭头右移 | `--dur-nudge` | 160ms | `--ease-out` |
| 开关旋钮 / 底色 | `--dur-switch` / `--dur-switch-bg` | 300ms / 180ms | `--ease-spring`：`cubic-bezier(.34, 1.56, .64, 1)` / `--ease-out` |
| 换主题交叉淡化 | `--dur-theme` | 240ms | `--ease-both` |
| 运行中流光 | `--shimmer-cycle` | 2.6s | `linear`（参数延后 15% 周期） |

- 所有动效只在 `prefers-reduced-motion: no-preference` 且外观里未开启「减少动态效果」（根元素无 `data-reduce-motion`）时启用；不支持所需 CSS 能力或关闭动效时直接切换状态（运行中工具行退回静止的 `.tool-spin`）。
- 菜单淡入并沿弹出方向移动 4px；对话框淡入、移动 6px 并从 `scale(.985)` 恢复，遮罩只淡入。菜单与对话框关闭直接消失，不延迟卸载。
- 按钮、图标按钮、服务商预设卡片与主题卡片按下时缩到 `scale(.97)`（禁用态、开关与列表行不缩放）；预设卡片悬停时边框用 `--a-border-strong`、右箭头右移 2px。菜单项、下拉选项、`Ctrl+K` 列表、输入补全列表等支持键盘移动高亮的列表，以及输入框、拖动调宽手柄和终端/代码查看器内部保持瞬时高亮，不加悬停过渡。
- 输入刷新不重播浮层入场；设置切页和会话切换不触发动效。
- 折叠区高度和透明度同时变化，箭头同步旋转，展开后指向内容。程序查找与跳转直接展开并准确定位。
- 面板内容在开合时保持最终宽度，由外层裁切；拖动调宽没有过渡，启动恢复不播放动效。原生网页开合期间先换截图，结束后按最终位置恢复；终端与代码查看器只在结束后测量尺寸。
- 不给等待确认闪烁、新消息、流式输出、切页、提示气泡、Toast 或侧栏折叠添加动效。
