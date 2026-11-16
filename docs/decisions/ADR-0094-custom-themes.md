# ADR-0094：自定义主题

- 状态：已接受
- 日期：2026-11-16

## 背景

[ADR-0093](ADR-0093-appearance-theme-presets.md) 落地了五套内置主题预设、桌面内容宽度与电脑到手机的配色同步。第二期在此基础上支持用户自定义主题：用户只需指定一套背景、文字、强调三色，另一面（亮面或暗面）由纯函数自动推算；支持新建、编辑、删除、导入与导出（复制 JSON），并将电脑端选中的自定义主题实时同步并缓存到手机端。

## 决定

### 数据结构和校验

全局 `settings.json` 新增 `appearance.customThemes`，值为 `CustomTheme[]` 数组，条数不设上限。每项严格为 `{ id, name, bg, text, accent }`，拒绝任何多余字段或缺失字段：

- `id`：匹配 `/^custom-[a-z0-9]+$/`，且在数组内唯一；
- `name`：去掉首尾空白后非空，最多 24 个字符（按 Unicode 码点计），保存去掉首尾空白后的值；
- `bg`、`text`、`accent`：严格小写十六进制颜色 `/^#[0-9a-f]{6}$/`。

`runtime.updateSettings` 接受 `"appearance.customThemes": CustomTheme[] | null`，传 `null` 删除该字段（`appearance` 段为空时一并移除，未知兄弟字段保留）。写入时整组原子校验，任一项不合法即以 `TypeError` 拒绝并说明原因。读取 `settings.json` 时同样整组校验，不合法则忽略整个 `appearance.customThemes` 字段并记录告警，不影响 `appearance.themePreset` 及其他设置。

`runtime.describeSettings` 新增 `appearance.customThemes` 项，`effective` 与 `saved` 为数组的 `JSON.stringify` 字符串（未保存时均为 `undefined`，`source` 为 `"default"` 或 `"settings"`，`overridden: false`），不参与用户或项目 `config.json` 分层合并。`appearance.themePreset` 保持不透明非空字符串，选中自定义主题时存入其 `id`。Core 只存储与校验数据，不包含配色推算逻辑。

### 推算规则与常数

推算规则与常数照抄本轮[效果图](https://claude.ai/artifact/X9mXi4ApJjm3GQhkvSSE8q)（本地源 `Z:\nocturne-mockups\appearance\custom-theme.html`）的 `toOk`、`okRaw`、`fromOk`、`atContrast`、`flip`、`withSide`、`expand`，在 `apps/desktop/src/theme-presets.ts` 中实现纯函数 `expandCustomTheme(seed: CustomThemeSeed): { light: ThemeSeed; dark: ThemeSeed }`：

1. **OKLCH 转换与色域回退**：sRGB 与线性光互转阈值为 `0.04045` / `0.0031308`（线性斜率 `12.92`，伽马指数 `2.4`，系数 `1.055` / `0.055`），经标准 OKLab 矩阵得到 `(L, C, H)`。`fromOk(L, C, H)` 最多迭代 `40` 次：当线性 RGB 三通道均落在 `[-1e-4, 1 + 1e-4]` 内时四舍五入输出 `#rrggbb`；否则每次令彩度 `c *= 0.92`；40 次后仍越界则退回无彩 `C = 0`。
2. **二分对比度求解（`atContrast`）**：固定彩度 `C` 与色相 `H`，在求更亮色时以 `[L_bg, 1]`、求更暗色时以 `[0, L_bg]` 为区间迭代 `30` 次二分查找满足目标 WCAG 对比度的亮度边界。
3. **亮暗面判定**：计算输入 `bg` 的 OKLab 亮度 `L_b`。当 `L_b > 0.5` 时，输入三色作为亮面并推算暗面；当 `L_b <= 0.5` 时，输入三色作为暗面并推算亮面。
4. **另一面背景色**：保留色相 `H_b`。由亮推暗时，亮度 `L' = clamp(0.15 + (1 - L_b) * 2, 0.13, 0.24)`，彩度 `C' = min(C_b * 2.5, 0.025)`；由暗推亮时，亮度 `L' = clamp(1 - (L_b - 0.15) / 2, 0.94, 1)`，彩度 `C' = C_b * 0.4`。
5. **另一面文字色**：保留原文字色相 `H_t` 与彩度 `C_t`。记原文字与原背景对比度为 `tc`，由亮推暗时目标对比度为 `clamp(tc, 14, 16.5)`（比新背景更亮），由暗推亮时目标对比度为 `clamp(tc, 15, 17.5)`（比新背景更暗）。
6. **另一面强调色**：当 `|L_a - L_t| < 0.03` 且 `C_a < 0.03`（无彩且与文字亮度相近的单色主题）时，另一面强调色直接取另一面文字色；否则保留色相 `H_a`，记原强调与原背景对比度为 `ac`，由亮推暗时彩度取 `C_a * 0.85`、目标对比度 `clamp(ac + 3, 7.5, 10)`，由暗推亮时彩度取 `C_a / 0.85`、目标对比度 `clamp(ac - 3, 4.5, 6.5)`。
7. **侧栏色（`side`）**：亮、暗两面的 `side` 均由各自 `bg` 朝 `text` 在 sRGB 空间线性混合，亮面比例 `4%`（`0.04`），暗面比例 `3%`（`0.03`）。
8. **语义变量派生与 ID 解析**：展开后的 `{ light, dark }` 照常交给 `deriveTheme(seed, mode)`，其余变量、固定状态色及对比度回退完全沿用 ADR-0093；用户所选三色本身对比度过低时不做调整、也不显示提示。主题 ID 解析优先匹配五个内置预设，其次在 `customThemes` 中查找，未命中（含已删除的自定义主题 ID）一律回退到 `workbench`。

### 卡片亮暗各半与横向主题条

桌面设置页「外观 › 主题」的主题条改为单行横向排列：先列五个内置预设，后按创建顺序排列自定义主题；超出容器宽度时启用横向滚动与 `scroll-snap`，隐藏原生滚动条。仅当内容溢出且左/右侧仍有未显示内容时，对应侧才显示渐隐遮罩与「向左」/「向右」圆形箭头按钮，点击箭头滚动约 `80%` 可视宽度；打开设置页、保存或导入主题后自动把当前选中卡片滚入可见区。

所有卡片（包含五个内置预设）的缩略图统一左半显示亮面、右半显示暗面，中间以 `1px` 分割线隔开，不随当前深浅模式变化；工作台卡片两半使用 `tokens.css` 的亮暗原值。自定义卡片在鼠标悬停或内部获得键盘焦点时于右上角显示「编辑」铅笔按钮，点击铅笔打开编辑浮窗而不切换选中主题，点击卡片其他区域选中该主题。

### 浮窗流程

「主题」分组标题右侧放置「导入」「新建」两个带图标文字按钮。新建与编辑共用同一模态浮窗（标题分别为「新建主题」「编辑主题」，右上角为「关闭」按钮）：

- 左栏为名称输入框与背景、文字、强调三行（每行含原生取色器色块与 hex 输入框；hex 输入非法时边框描红，失焦恢复上一个合法值）。新建时名称默认为「我的主题」，初始三色取当前选中主题在当前解析模式下的 `bg`、`text`、`accent`。
- 右栏并排展示亮面与暗面两个 `inert` 迷你应用预览，任一输入变化实时重算刷新。
- 底部右侧为「取消」「保存」；编辑已有主题时底部左侧额外显示「删除」「导出」。删除需点击两次：首次点击变为「确认删除」，点击浮窗内其他位置恢复为「删除」，第二次点击才执行删除。
- 仅点击「保存」写入设置；取消、关闭按钮、Esc 或点击遮罩均丢弃未保存草稿。保存后自动选中该主题，并用一次 `updateSettings` 同时写入 `appearance.customThemes` 和 `appearance.themePreset`。删除当前选中的自定义主题时，同一次请求把 `appearance.themePreset` 写为 `null`（回退工作台）。

### 导入导出格式

点击编辑浮窗的「导出」打开「导出主题」浮窗，内含只读文本框与唯一的「复制」按钮（复制成功后文案变为「已复制」，不设另存为文件入口），展示两空格缩进 JSON：

```json
{
  "nocturneTheme": 1,
  "name": "雾蓝",
  "bg": "#f6f8fa",
  "text": "#16202a",
  "accent": "#2f6db5"
}
```

关闭「导出主题」浮窗后返回原「编辑主题」浮窗并保留草稿。

点击分组标题的「导入」打开「导入主题」浮窗，提供可编辑文本框、「选择文件」（读取本地 `.json` 文件填入文本框）、「取消」与「导入」。校验要求 `nocturneTheme === 1`、`name` 去首尾空白后非空且不超过 24 个码点、`bg` / `text` / `accent` 均为 `#rrggbb`（大小写均接受，统一转为小写保存），其余字段忽略。校验失败时文本框边框变红并在下方显示「不是有效的主题文件」；成功则生成新的 `custom-` ID，追加到自定义列表末尾并立即选中。

### 手机同步与缓存

桌面端本机 `Prefs`（`nocturne.desktop.prefs.v1`）在当前选中自定义主题时，除保存 `themePreset` 外同步缓存 `customTheme`（`{ id, name, bg, text, accent }`），使 `applyStoredAppearance` 在首帧渲染前即可离线推算应用；旧版无此字段的 `Prefs` 照常工作。

手机网页与安卓从 `describeSettings` 同时读取 `appearance.themePreset` 与 `appearance.customThemes`，复用同一套 `expandCustomTheme` 与 `deriveTheme` 应用主题，手机端设置页保持原布局、不提供主题编辑能力。手机按电脑缓存 `nocturne.phone.themePresets` 在选中自定义主题时保存完整 `{ id, name, bg, text, accent }` 对象，选中内置预设仍存字符串 ID，且继续兼容读取旧版字符串缓存，保证启动与切换电脑时首帧不闪烁。安卓状态栏与导航栏继续经 `observer.theme` 取计算后的 `--a-bg`。

### 远程只读

远程连接可通过白名单内的 `runtime.describeSettings` 读取 `appearance.customThemes` 与 `appearance.themePreset`；`runtime.updateSettings` 不在 `REMOTE_METHODS` 白名单中，远程连接尝试修改或删除 `appearance.customThemes` 一律与 `appearance.themePreset` 相同以 `remote_not_allowed`（`-32004`）拒绝。本机写入成功后照常向全部已握手连接（含远程）广播 `runtime.settingsChanged`。

## 后果

客户端单面三色输入降低了配出协调深浅双面主题的门槛，同时保持 Core 与配色算法完全解耦。桌面与手机缓存三色种子消除了自定义主题启动和切机时的首帧白闪/黑闪，旧缓存与旧配置文件无需迁移即可平滑兼容。

## 备选方案

- 让用户分别手填亮、暗两套共八个颜色：配置负担翻倍且极易出现深浅对比失衡，因此采用单面三色加 OKLCH 推算。
- 在 Core 内执行颜色推算或导入校验：违反 Core 不依赖 UI 配色语义的边界，因此 Core 仅校验存储结构，导入格式转换与配色推算留在客户端。
