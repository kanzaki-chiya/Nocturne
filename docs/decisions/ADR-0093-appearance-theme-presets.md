# ADR-0093：外观主题预设

- 状态：已接受
- 日期：2026-11-16

## 背景

桌面端和手机网页目前只有深浅模式，需要增加五套配色与桌面内容宽度，同时保留现有组件、字体设置和工作台原色。第一期只提供预设，不提供自定义、编辑、导入导出或占位入口。

## 决定

### 配色数据与推算

共享纯 TypeScript 模块定义 `ThemeSeed = { bg, side, text, accent }`，每套预设包含 id、名称与 light/dark 两组种子。id 顺序为 `workbench`、`nocturne`、`paper`、`celadon`、`ink`，名称依次为工作台、夜曲、纸面、青瓷、松烟。

配色依据是本轮[效果图](https://claude.ai/artifact/XMSG2TVPRhKjYHH9VkaFZA)（本地源 `Z:\nocturne-mockups\appearance\mockup.html`）的 `PRESETS`、`derive()`、`WORKBENCH`、`FIXED`，种子值与混合比例照抄。`deriveTheme(seed, mode)` 在 sRGB 字节值上混合并取整，返回 CSS 自定义变量表；`themeVars(id, mode)` 对工作台或未知 id 返回空表。工作台就是现有 `tokens.css` 原值，不经过推算，不覆盖任何颜色变量；卡片预览使用原 token 的对应模式值。

次要文字 `--a-secondary` 与背景的对比度至少 7，弱化文字 `--a-muted` 与背景至少 4.5，`--a-on-accent` 与强调色至少 4.5。文字混色未达标时按效果图的 0.01 步长朝正文色回退；强调色上的文字先沿用效果图选择，未达标再朝正文色回退。界面不显示任何提示。装饰色 `--a-faint` 沿用效果图，不作为弱化正文文字。

不随预设变化的颜色按 light/dark 固定：`--a-success/warning/error` 及其 `-bg`、`-border`、`--a-accentAlt`、`--a-cat2..5`、`--a-overlay`、`--a-qr-bg`，以及 `--cm-*` 中不引用 `--a-accent` 的颜色。固定值沿用效果图 `FIXED` 和现有 token；不把状态背景重新混合成主题背景。其他未由效果图推算的变量也继续由 token 提供。

### 应用与本地偏好

`applyThemePreset(root, id, resolvedMode)` 先移除上次写入的颜色变量，再把新变量表写入 `<html>` 行内样式。切回工作台清除全部预设覆盖，回到样式表原值。模式切换及跟随系统时系统模式变化，都重新应用当前预设；终端和代码高亮继续读取 CSS 变量。

桌面模式、字体与字号仍保存在 localStorage 的 `nocturne.desktop.prefs.v1`。该偏好同时缓存已知预设 id，用于 `applyStoredAppearance` 首次渲染前同步应用；连接后台后以全局设置为准，缓存不向后台反写。桌面内容宽度同样保存在 Prefs：标准 720px、宽 960px、铺满取消最大宽度，保留现有左右内边距。只作用于桌面主窗口的对话与输入框，不改变 880px 设置页，不由手机读取。

### 电脑到手机同步

选择推荐方案：全局 `settings.json` 新增 `appearance.themePreset` 字符串，通过 `runtime.describeSettings` / `runtime.updateSettings` 读写。Core 只校验字符串、保存和返回，不枚举预设、不依赖 UI、不参与项目配置合并；缺省由客户端解释为工作台，未知字符串也由客户端回退到工作台，`null` 删除保存值。桌面立即应用选择并经现有设置通道写入。

RPC 新增易失的 `runtime.settingsChanged` 通知，参数为 `{}`，设置成功写入后、响应之前广播给全部已握手连接（包括远程），不写会话日志、不包含设置内容。客户端订阅后初次读取设置，通知后重读；失败写入不发送通知。重载配置成功后也发送该通知，以便同步外部改动。远程连接可读取预设，不允许通过 `runtime.updateSettings` 修改 `appearance.themePreset`；保留既有其他远程设置能力。

手机连接或切换电脑时清除上一台的预设，从当前连接的 Runtime 读取，忽略旧连接迟到结果；通知触发实时刷新。手机只同步配色 id，模式仍从手机本机读取并独立解析系统偏好，设置页布局不变。安卓继续共享真实手机网页，通过 `PhonePlatform.observer.theme(resolvedMode, background)` 把当前计算后的 `--a-bg` 传到原生系统栏桥；原生按背景色设置状态栏/导航栏，按模式选择图标深浅。本轮不具备安卓真机验收条件。

### 第一、二期边界

种子结构与 `deriveTheme` 是可复用的纯函数接口。第一期不写任何自定义数据存储、编辑对话框、导入导出代码或空入口。

## 后果

不改变 token 源头与既有工作台配色；预设只在客户端解释。桌面缓存解决首屏配色闪烁，后台设置保证当前电脑是同步来源。增加一个向后兼容的空载荷通知；旧客户端可忽略，新手机连接旧后台时缺省工作台。

## 备选方案

- 只保存 localStorage：手机拿不到当前电脑配色，不能满足实时同步。
- 将全部颜色写入 Core 或协议：增加 UI 与 Core 耦合，且会复制推算规则。
- 复用 `runtime.providersChanged`：外观变更并非服务商变更，会触发无关目录刷新，因此采用单独设置通知。
