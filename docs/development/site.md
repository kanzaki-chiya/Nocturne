# 项目主页

主页地址是 <https://nocturne.koxia.cn/>，中文默认，英文位于 `/en/`。深色优先，经 `prefers-color-scheme` 跟随系统切换浅色；主题变量、字体声明与共用页头页脚放在 `base.css`，主页（含滚动驱动时间轴与各章节）和更新日志页另加 `site.css`，有深浅两版的截图用 `<picture>` 的浅色 `source` 切换。全站为静态 HTML + CSS，不含统计、第三方脚本或 cookie；**仅主页允许一段内联、无 `src` 的 `<script>`**，用于在客户端按操作系统切换下载主按钮文案与链接（禁用 JavaScript 时页面保持完整可用，默认提供 Windows 安装包，其余平台入口仍通过次级链接可达）；用户文档页与更新日志页禁止任何脚本。

官网配色取桌面端「工作台」主题的 token，并在 `base.css` 补充主页夜间时间轴所需的深浅双套变量（对应关系以 `base.css` 为准）。

## 主页结构与脚本规则

中英双语主页结构完全一致，按 23:00–07:00 夜间时间轴组织：

1. **23:00 首屏**：大标题、副标题、按系统切换的主下载按钮（默认 Windows 安装包）与次级平台下拉菜单（macOS、终端 `nctrn`、安卓 APK）、GitHub 链接。
2. **23:10 / 23:40 / 23:41 滚动演示区（`.story`）**：使用 CSS 滚动驱动动画（`view-timeline`、`animation-timeline`）在同一模拟桌面窗口内依次展示写代码与权限审批、华彩预览、回退与分叉。不支持滚动驱动动画的浏览器以及 `prefers-reduced-motion: reduce` 环境下退化为静态可读版面。
3. **00:30–06:30 实机截图与能力章节**：依次展示桌面端会话与变更（00:30）、权限审查与确认（01:15）、组曲 / 合奏多成员协作（02:30）、终端 `nctrn` 与手机远程控制（04:00）、定时任务与执行方式（05:30）、用量热力图与扩展生态（06:30）。
4. **07:00 下载收尾与多栏页脚**：全平台下载入口、版本号（`{{version}}`）、GPL-3.0 开源信息，以及按 `site-docs/nav.json` 真实 slug 组织的文档导航和语言互链。

脚本限制由 `scripts/test/build-site.test.mjs` 自动守护：主页只能包含恰好一段内联、无 `src` 的脚本；更新日志页与 `/docs/` 页面不得出现 `<script>` 标签。

## 目录与构建

- `site/index.html`、`site/en/index.html`：结构相同的双语页面。功能事实以根 README 为准。
- `site/assets/`：共用 CSS、favicon、自托管字体和中英文分别拍摄的 WebP 截图。
- `site/CNAME`：`nocturne.koxia.cn`。
- `site/changelog/index.html`：更新日志页模板，中文。构建时由根目录 `CHANGELOG.md` 生成版本目录和正文，发版不需要额外操作。
- `site-docs/`：中文用户文档 Markdown 正文、导航配置与页面模板。
- `scripts/build-site.mjs`：使用 Node 内置模块与根工作区的 `marked` 依赖，将 `site/` 复制到忽略的 `dist-site/`，把 HTML 与文档中全部 `{{version}}` 替换成根 `package.json` 的版本，并生成更新日志页和 `/docs/` 用户文档页面。
- `scripts/test/build-site.test.mjs`：版本、占位符、语言互链、本地资源与锚点、CNAME、字体标题清单、用户文档构建检查。根 `pnpm test` 的 scripts 测试组会运行它。

主页不是 pnpm workspace 成员，不参与 `pnpm build` 和 workspace 包测试。单独构建与验证：

```bash
node scripts/build-site.mjs
pnpm exec vitest run --root scripts test/build-site.test.mjs
```

可用任意静态服务预览 `dist-site/`；需把目录请求解析到 `index.html`。服务仅监听 `127.0.0.1`，启动时记下 PID，结束时只关闭该 PID 及其子进程。

## 用户文档

用户文档位于 `site-docs/`，构建后输出到 `dist-site/docs/`：

- `site-docs/nav.json`：定义分组（`group`）与页面顺序（`pages` 数组，每项含 `slug` 和 `title`；首页 `slug` 为 `""`，对应 `site-docs/index.md` 和 `/docs/index.html`，其余 `<slug>` 对应 `site-docs/<slug>.md` 和 `/docs/<slug>/index.html`）。
- `site-docs/*.md`：各页面 Markdown 正文，第一行必须是 `# <标题>` 且与 `nav.json` 中的 `title` 一致。不允许内联原始 HTML。站内互链直接写 `other.md` 或 `other.md#章节`，构建时会自动转换为相对路径。
- `site-docs/template.html` 与 `site/assets/docs.css`：文档页面 HTML 模板与三栏响应式样式（仅引用 `base.css` 变量，无运行时 JavaScript）。

新增或修改文档页面时：

1. 在 `site-docs/` 下新建或编辑 `<slug>.md`，并在 `site-docs/nav.json` 中登记对应条目（目录中的 `.md` 文件集合必须与 `nav.json` 完全一致，否则构建失败）。
2. 运行 `node scripts/build-site.mjs` 生成静态页面，再运行 `pnpm exec vitest run --root scripts test/build-site.test.mjs` 验证导航、锚点和本地链接。

## 发布与域名

`.github/workflows/pages.yml` 使用官方 `upload-pages-artifact`、`deploy-pages`，以固定提交 SHA 锁定。在构建前安装根工作区依赖（`pnpm install --frozen-lockfile --filter .`），再运行 Node 静态构建。触发条件：main 上的 `site/**`、`site-docs/**`、`CHANGELOG.md`、`package.json`、`pnpm-lock.yaml`、构建脚本或工作流修改，Release 的 `published`，以及手动运行。Release 触发时检出发布标签，因此版本与该标签中的根 package.json 一致；其他触发检出对应提交。

第一次上线由维护者完成：DNS 添加 `nocturne` CNAME 指向 `kanzaki-chiya.github.io`；仓库 Pages 来源设为 GitHub Actions；推送后在 Pages 设置确认域名并启用强制 HTTPS。提交代码本身不会开启 Pages。

## 字体子集

h1、h2 和字标使用 Noto Serif SC 2.003 的 SC Black，SIL OFL 1.1，`@font-face` 在 `base.css`；英文用同一字体的拉丁字形。原始字体来自 `notofonts/noto-cjk` 的 `Serif2.003` 固定提交，完整 URL 写在脚本中，原文件只在 OS 临时目录保存并清理。许可见 [字体许可](../../site/assets/fonts/OFL.txt) 与 [第三方声明](../../THIRD-PARTY-NOTICES.md)。正文和代码使用系统字体，字体不可用时标题回退宋体/衬线字体。

标题变更后手动执行（需要 Node.js 24.16+ 与根依赖）：

```bash
pnpm install --frozen-lockfile
node scripts/subset-site-font.mjs
node scripts/build-site.mjs
pnpm exec vitest run --root scripts test/build-site.test.mjs
```

脚本支持 `HTTPS_PROXY` / `HTTP_PROXY` 等 Node 环境代理，只在这条命令上设置；扫描双语主页和更新日志页的 h1、h2、字标，并加入数字 0–9。提交生成的 `noto-serif-sc-headings.woff2` 和 `characters.txt`，不提交 OTF。不要从境外字体服务加载字体。

## 截图重拍

所有截图必须来自隔离假模型会话，不能使用维护者的真实配置、会话或密钥；画面里不能出现真实路径、用户名或密钥。中英文各跑一轮；UI 标签为中文，英文图保留真实 UI 标签，仅会话内容改成英文。

| 文件（`site/assets/images/`） | 内容 | 主题 | 语言 | 尺寸 |
|---|---|---|---|---|
| `desktop-<语言>-<主题>.webp` | 桌面端整窗，会话与右侧变更面板 | 深、浅 | 中、英 | 2880×1800 |
| `perm-<语言>-<主题>.webp` | 桌面端权限审批卡片与改动预览 | 深、浅 | 中、英 | 2880×1800 |
| `ensemble-<语言>-<主题>.webp` | 桌面端组曲 / 合奏多成员面板 | 深、浅 | 中、英 | 2880×1800 |
| `terminal-<语言>-<主题>.webp` | 终端 `nctrn --resume` | 深、浅 | 中、英 | 960×600 |
| `sched-<语言>-<主题>.webp` | 桌面端定时任务列表与运行详情 | 深、浅 | 中、英 | 2880×1800 |
| `usage-<语言>-<主题>.webp` | 桌面端「设置 › 用量」统计行和热力图（裁切） | 深、浅 | 中、英 | 1824×809 |
| `social-<语言>.webp` | 社交预览（深色首屏） | 深 | 中、英 | 1200×630 |

每张 WebP 不超过 300 KB；HTML 写真实 `width`、`height`、`alt`，深色图放 `<img>`，浅色图放 `<source media="(prefers-color-scheme: light)">`。不再使用的图片删除。

### 1. 准备隔离 home 与假模型

每种语言使用独立根目录（含隔离 `home`、演示仓库 `echoes`、`wv` 缓存目录）。只在启动脚本里设置 `NOCTURNE_HOME`、`WEBVIEW2_USER_DATA_FOLDER` 与演示用 `SITE_DEMO_KEY`，不要指向真实 `~/.nocturne`。先在当前工作树执行 `pnpm build`。

隔离 `providers.json` 仅注册本地回环地址的假 OpenAI 兼容服务商（如 `http://127.0.0.1:<空闲端口>/v1`），关闭 `modelsDev` 及用户/项目级外部技能发现，确保不会加载用户真实凭据或技能。演示仓库使用独立目录名（如 `echoes`），内容与命名可保留乐队/专辑/曲名彩蛋，但**不得出现任何歌词**。

英文版截图按与中文版完全一致的场景重拍一套独立隔离环境：保留桌面端真实中文 UI 标签（软件本身无英文界面），将用户提问、模型回复、代码改动、组曲成员任务与定时任务名称及描述全部改为英文，同样使用本地假模型与隔离数据种子生成。

用量热力图需要多天数据：通过种子脚本在隔离 `home` 下写入跨度约一年的历史会话/子会话日志，每条含 `turn.started`、带 `usage` 的 `message.assistant`（需含 `toolCalls: []`、`finishReason`）和 `turn.completed`。写完用 Core 的 `decodeDurableEvent` 逐行校验，任何一行不合契约整条日志会被统计跳过。定时任务与组曲场景同样通过对应种子或假模型响应写入隔离 `home`。

### 2. 启动与进程

用 Node 的 `spawn(..., { detached: true, windowsHide: true, stdio: ["ignore", outFd, errFd] })`（或 `Start-Process -PassThru`）启动本地假模型、独立端口的 Vite（或静态构建后的调试版桌面 exe，不要占用已有开发实例端口 31420）、以及调试版桌面 exe（`NOCTURNE_DESKTOP_BACKEND` 指向工作树 `apps/cli/dist/main.js`，WebView 开启 `--remote-debugging-port=<空闲端口>`）。PID 写入文件，结束时只停这些 PID 及其子进程，不按进程名结束；不碰正在运行的安装版或开发版。启动脚本的子进程会占住输出管道，单独启动，不要和截图命令串在一起。每次操作前核对 CDP 端口对应的 exe 路径。

### 3. 桌面五场景（desktop / perm / ensemble / sched / usage）

在调试页的 `localStorage['nocturne.desktop.prefs.v1']` 中设置 `theme`（深浅模式；保持默认「工作台」与「标准」宽度）、`autoUpdate:false`、演示项目路径，刷新后分别切到对应场景。隐藏标题栏或页面中可能暴露的本机盘符路径。每张图同时设置 `data-theme` 和 `Emulation.setEmulatedMedia`，截图前读一次 `body` 背景色确认主题生效；整窗场景均以 1440×900、`deviceScaleFactor: 2` 拍摄（输出 2880×1800）：

```text
Emulation.setDeviceMetricsOverride {"width":1440,"height":900,"deviceScaleFactor":2,"mobile":false}
Emulation.setEmulatedMedia {"features":[{"name":"prefers-color-scheme","value":"dark"}]}
Page.captureScreenshot {"format":"png","captureBeyondViewport":false}
```

- **desktop**：打开演示会话并展开右侧「变更」面板展示 Diff。
- **perm**：在需要人工确认的命令审批态下截取，保留完整审批卡片与上下文。
- **ensemble**：切换到侧边栏「组曲」面板，展示多成员并行执行进度与输出摘要。
- **sched**：切换到侧边栏「定时任务」页面，展示任务列表与单条任务配置/运行记录。
- **usage**：进「设置 › 用量」，范围选「全部」；以 1440×900、`deviceScaleFactor: 2` 渲染后，对 `.usage-body` 统计行与热力图区域按无裁断边界裁切（输出 1824×809），确保统计数字与图例完整显示且不切入下一节标题。

### 4. 终端

复制隔离 home 到终端专用副本，按深浅分别写 `settings.json` 的 `theme`；只在副本里把日志中的工作区路径替换为 `N:\echo`，首行 `workspaceRoot` 保留实际路径。先确认 N: 未占用，再 `subst N: <示例根目录>`（映射演示仓库上一级，使 `N:\echo` 存在）。英文完成说明要短到终端一行放得下（`nctrn` 按列折行，长英文句会在单词中间断开）。

在桌面 WebView 中注入一个临时 IIFE（Vite lib 构建，入口导入正式 `createTauriHost` 与 `mountTerminal`，不打进主页），清空 body 后挂载终端，设置 `data-theme` 后再挂载以取对应配色。`mountTerminal` 已加载 Unicode 11 宽度表，注入包不用另外注册；挂载前先用 `document.fonts.load` 加载 `--mono` 的常规与粗体字形，否则字宽按回退字体量，框线会错位。shell 用 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`，cwd `N:/echo`，cols/rows 取 `mountTerminal().size()`，输入 `node <启动器> --resume <会话ID>`（启动器先 `chdir('N:/echo')` 再导入工作树 CLI），等到 `idle` 后截 960×600。拍完用 host API 关闭 PTY，`subst N: /d`。若终端章节与既有 `terminal-en-*.webp` 一致，英文终端图可直接复用。

### 5. 社交预览与导出验收

```powershell
ffmpeg -i desktop-zh-dark.png -c:v libwebp -quality 86 desktop-zh-dark.webp
ffmpeg -i perm-zh-dark.png -c:v libwebp -quality 86 perm-zh-dark.webp
ffmpeg -i ensemble-zh-dark.png -c:v libwebp -quality 86 ensemble-zh-dark.webp
ffmpeg -i sched-zh-dark.png -c:v libwebp -quality 86 sched-zh-dark.webp
ffmpeg -i terminal-zh-dark.png -c:v libwebp -quality 88 terminal-zh-dark.webp
ffmpeg -i usage-zh-dark.png -c:v libwebp -quality 90 usage-zh-dark.webp
```

`social-zh.webp` 与 `social-en.webp` 在静态站点构建后，使用 headless Edge 以 `1200×630` 深色模式访问本地静态预览的 `/` 和 `/en/` 首屏截取并转为 WebP（`-quality 88`），确保与当前首屏视觉一致。

逐张打开检查：没有真实路径/密钥，无歌词，主题正确，终端无错位，整图无外部窗口，单张文件不超过 300 KB。

构建后用只监听 `127.0.0.1` 的静态服务和独立 headless Edge（CDP）逐章验收：中文、英文各在 1440×900 深色、1440×900 浅色、390×844 深色下截取首屏与每一章，另在禁用 JavaScript 和 `prefers-reduced-motion: reduce` 下检查首屏及演示区退化，同时抽检更新日志页与 `/docs/`。headless 窗口有最小宽度，必须用 `Emulation.setDeviceMetricsOverride` 设视口，主题与减弱动效用 `Emulation.setEmulatedMedia`。等待 `document.fonts.ready` 和所有图片加载完成，确认 `scrollWidth <= innerWidth`、所有图片 `naturalWidth > 0`。headless Edge 建议加 `--disable-extensions --disable-background-timer-throttling --disable-renderer-backgrounding --disable-gpu`；截图和 Lighthouse 顺序执行，避免它们导航同一目标。

```powershell
pnpm dlx lighthouse@13.0.1 http://127.0.0.1:18643/ --port=19445 '--only-categories=accessibility,seo' --output=json --output-path=site-audit.json
```

Lighthouse 只按默认配色审计，深色对比度另按 `base.css` 的变量核算。保留截图和审计报告。结束服务、Edge、调试桌面时只按启动记录的 PID 结束其进程树。
