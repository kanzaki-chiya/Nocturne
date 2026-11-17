# ADR-0093：外观主题预设

- 状态：已接受
- 日期：2026-11-16

## 背景

桌面端和手机网页目前只有深浅模式，需要增加五套配色与桌面内容宽度，同时保留现有组件、字体设置和工作台原色。第一期只提供预设，不提供自定义、编辑、导入导出或占位入口。

## 决定

### 配色数据与推算

共享纯 TypeScript 模块定义 `ThemeSeed = { bg, side, text, accent }`，每套预设包含 id、名称与 light/dark 两组种子。id 顺序为 `workbench`、`nocturne`、`paper`、`celadon`、`ink`，名称依次为工作台、夜曲、纸面、青瓷、松烟。

配色依据是本轮[效果图](https://claude.ai/artifact/XMSG2TVPRhKjYHH9VkaFZA)（本地源 `Z:\nocturne-mockups\appearance\mockup.html`）的 `PRESETS`、`derive()`、`WORKBENCH`、`FIXED`，种子值与混合比例照抄（后续修订见末节）。`deriveTheme(seed, mode)` 在 sRGB 字节值上混合并取整，返回 CSS 自定义变量表；`themeVars(id, mode)` 对工作台或未知 id 返回空表。工作台就是现有 `tokens.css` 原值，不经过推算，不覆盖任何颜色变量；卡片预览使用原 token 的对应模式值。

次要文字 `--a-secondary` 与背景的对比度至少 7，弱化文字 `--a-muted` 与背景至少 4.5，`--a-on-accent` 与强调色至少 4.5。文字混色未达标时按效果图的 0.01 步长朝正文色回退；强调色上的文字先沿用效果图选择，未达标再朝正文色回退。界面不显示任何提示。装饰色 `--a-faint` 沿用效果图，不作为弱化正文文字。

不随预设变化的颜色按 light/dark 固定：`--a-success/warning/error` 及其 `-bg`、`-border`、`--a-accentAlt`、`--a-cat2..5`、`--a-overlay`、`--a-qr-bg`。固定值沿用效果图 `FIXED`；不把状态背景重新混合成主题背景。`--cm-*` 保持对语义 token 的引用：注释 `--cm-comment` 跟随 `--a-faint`，当前行 `--cm-active-line` 由 `--a-raised` 混合；引用固定状态色的代码色自然保持固定，不单独冻结代码色。其他未由效果图推算的变量也继续由 token 提供。

### 应用与本地偏好

`applyThemePreset(root, id, resolvedMode)` 先移除上次写入的颜色变量，再把新变量表写入 `<html>` 行内样式。切回工作台清除全部预设覆盖，回到样式表原值。模式切换及跟随系统时系统模式变化，都重新应用当前预设；终端和代码高亮继续读取 CSS 变量。

桌面模式、字体与字号仍保存在 localStorage 的 `nocturne.desktop.prefs.v1`。该偏好同时缓存已知预设 id，用于 `applyStoredAppearance` 首次渲染前同步应用；连接后台后以全局设置为准，缓存不向后台反写。桌面内容宽度同样保存在 Prefs：标准 720px、宽 960px、铺满取消最大宽度，保留现有左右内边距。只作用于桌面主窗口的对话与输入框，不改变 880px 设置页，不由手机读取。

### 电脑到手机同步

选择推荐方案：全局 `settings.json` 新增 `appearance.themePreset` 字符串，通过 `runtime.describeSettings` / `runtime.updateSettings` 读写。Core 只校验字符串、保存和返回，不枚举预设、不依赖 UI、不参与项目配置合并；缺省由客户端解释为工作台，未知字符串也由客户端回退到工作台，`null` 删除保存值。桌面立即应用选择并经现有设置通道写入。

RPC 新增易失的 `runtime.settingsChanged` 通知，参数为 `{}`，设置成功写入后、响应之前广播给全部已握手连接（包括远程），不写会话日志、不包含设置内容。客户端订阅后初次读取设置，通知后重读；失败写入不发送通知。重载配置成功后也发送该通知，以便同步外部改动。远程连接可读取预设，不允许通过 `runtime.updateSettings` 修改 `appearance.themePreset`；保留既有其他远程设置能力。

手机在现有本机 localStorage 中以 `nocturne.phone.themePresets` 按 hostId 缓存预设，用 `nocturne.phone.themeHost` 保存上次打开的电脑；网页与安卓在打开数据库和首次渲染前同步应用缓存，连接或切换电脑时先应用目标电脑缓存，无缓存才用工作台。连上后从当前 Runtime 读取并覆盖、写回对应缓存，忽略旧连接迟到结果；通知触发实时刷新并更新缓存。手机只同步配色 id，模式仍从手机本机读取并独立解析系统偏好，设置页布局不变。安卓继续共享真实手机网页，通过 `PhonePlatform.observer.theme(resolvedMode, background)` 把当前计算后的 `--a-bg` 传到原生系统栏桥；原生按背景色设置状态栏/导航栏，按模式选择图标深浅。本轮不具备安卓真机验收条件。

### 第一、二期边界

种子结构与 `deriveTheme` 是可复用的纯函数接口。第一期不写任何自定义数据存储、编辑对话框、导入导出代码或空入口。第二期自定义主题的数据结构、单面三色到亮暗双面的 OKLCH 推算、双面卡片、编辑与导入导出浮窗及桌面/手机缓存见 [ADR-0094](ADR-0094-custom-themes.md)。

## 后果

不改变 token 源头与既有工作台配色；预设只在客户端解释。桌面缓存解决首屏配色闪烁，后台设置保证当前电脑是同步来源。增加一个向后兼容的空载荷通知；旧客户端可忽略，新手机连接旧后台时缺省工作台。

## 备选方案

- 只保存 localStorage：手机拿不到当前电脑配色，不能满足实时同步。
- 将全部颜色写入 Core 或协议：增加 UI 与 Core 耦合，且会复制推算规则。
- 复用 `runtime.providersChanged`：外观变更并非服务商变更，会触发无关目录刷新，因此采用单独设置通知。

## 修订

### 2026-11-18

- **浅色预设对比度与表面层次对齐工作台**：由于浅色下夜曲、纸面、青瓷的正文与边框色差小于工作台（字发虚、边框和气泡偏弱、侧栏带色较多），用户反馈阅读费力，调整浅色种子与 `deriveTheme` 浅色分支比例（深色与工作台、自定义主题 `withSide` 比例保持不变）：
  - 夜曲浅色：`text` `#1c1d2c` → `#0a0a12`，`side` `#efeef7` → `#f1f0f6`；
  - 纸面浅色：`text` `#1f1d1a` → `#100f0c`，`side` `#f3f1ea` → `#f5f4f0`；
  - 青瓷浅色：`text` `#102224` → `#0a1415`，`side` `#f0f6f6` → `#f5f7f7`；
  - `deriveTheme` 浅色混合比例：`--a-raised` `0.045` → `0.048`，`--a-border` `0.075` → `0.08`，`--a-border-strong` `0.14` → `0.15`。
- **松烟强调色改为墨蓝**：此前松烟浅色与深色的 `accent` 与 `text` 同色，导致链接和可交互控件与正文难以区分，现改为墨蓝：浅色 `accent` `#111111` → `#34506e`，深色 `accent` `#f2f2f2` → `#a3b6cc`；`--a-on-accent` 仍由现有推算规则得出。
