# 项目主页

主页地址是 <https://nocturne.koxia.cn/>，中文默认，英文位于 `/en/`。深色优先，经 `prefers-color-scheme` 跟随系统切换浅色；主题变量、字体声明与共用页头页脚放在 `base.css`，主页（含滚动驱动时间轴与各章节）和更新日志页另加 `site.css`，有深浅两版的截图用 `<picture>` 的浅色 `source` 切换。全站为静态 HTML + CSS，不含统计、第三方脚本或 cookie；**仅主页允许一段内联、无 `src` 的 `<script>`**，用于在客户端按操作系统切换下载主按钮文案与链接（禁用 JavaScript 时页面保持完整可用，默认提供 Windows 安装包，其余平台入口仍通过次级链接可达）；用户文档页与更新日志页禁止任何脚本。

官网配色取桌面端「工作台」主题的 token，并在 `base.css` 补充主页夜间时间轴所需的深浅双套变量（对应关系以 `base.css` 为准）。

## 主页结构与脚本规则

中英双语主页结构完全一致，按 23:00–07:00 夜间时间轴组织：

1. **23:00 首屏**：大标题、副标题、按系统切换的主下载按钮（默认 Windows 安装包）与次级平台下拉菜单（macOS、终端 `nctrn`、安卓 APK）、GitHub 链接。
2. **23:10 / 23:40 / 23:41 滚动演示区（`.story`）**：使用 CSS 滚动驱动动画（`view-timeline`、`animation-timeline`）依次演示三段流程——23:10 写代码（工具调用与权限审批）、23:40 让它画出来（选中回复文字引用追问、通过华彩在右侧面板生成页面并直接在图上评论）、23:41 离开电脑接着聊（手机远程打开同一会话，继续发消息与审批工具调用）。不支持滚动驱动动画的浏览器以及 `prefers-reduced-motion: reduce` 环境下退化为静态可读版面。
3. **00:30–06:30 实机截图与能力章节**：依次展示桌面端会话与右侧「变更」面板（00:30）、权限预设与智能审查确认（01:15）、合奏（`/ensemble`）多成员协作（02:30）、终端 `nctrn` 全屏界面与 `--resume` 恢复（04:00）、定时任务与运行历史（05:30）、服务商预设、用量热力图与能力索引（06:30）。
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
| `perm-<语言>-<主题>.webp` | 桌面端会话与命令权限审批卡片 | 深、浅 | 中、英 | 2880×1800 |
| `ensemble-<语言>-<主题>.webp` | 桌面端会话与右侧合奏面板（留言板 / 成员） | 深、浅 | 中、英 | 2880×1800 |
| `terminal-<语言>-<主题>.webp` | 终端 `nctrn --resume` | 深、浅 | 中、英 | 960×600 |
| `sched-<语言>-<主题>.webp` | 桌面端定时任务列表与运行历史 | 深、浅 | 中、英 | 2880×1800 |
| `usage-<语言>-<主题>.webp` | 桌面端「设置 › 用量」统计行和热力图（裁切） | 深、浅 | 中、英 | 1824×809 |
| `social-<语言>.webp` | 社交预览（深色首屏） | 深 | 中、英 | 1200×630 |

每张 WebP 不超过 300 KB；HTML 写真实 `width`、`height`、`alt`，深色图放 `<img>`，浅色图放 `<source media="(prefers-color-scheme: light)">`。不再使用的图片删除。

### 1. 准备隔离 home 与假模型

每种语言使用独立根目录（含隔离 `home`、演示仓库 `root/echoes`、`wv` 缓存目录）。只在启动脚本里设置 `NOCTURNE_HOME`、`WEBVIEW2_USER_DATA_FOLDER`、`SITE_DEMO_KEY=demo-placeholder`（桌面截图时另设 `NOCTURNE_DESKTOP_BACKEND`、`NOCTURNE_OFFSCREEN=1` 与 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`），不要指向真实 `~/.nocturne`。先在当前工作树执行 `pnpm build`。

演示仓库 `root/echoes` 放 `package.json`（`version: "1.3.0"`、`type: "module"`、`scripts.test: "node --test"`）、`src/login.mjs`（原为 `return await request()`）、三项回归测试 `test/login.test.mjs`（`timeout can be retried`、`login succeeds`、`network errors remain visible`）与 `CHANGELOG.md`（初始含 `1.3.0` 记录），再 `git init -b main` 提交初始 commit。内容与分支/任务命名可保留乐队/专辑/曲名彩蛋，但**不得出现任何歌词**。

桌面五场景的隔离 `home/config.json` 配置如下，确保不加载用户凭据或外部技能：

- `model: "demo/local"`，`modelsDev: false`，`skills.sources.agents` 与 `skills.sources.claude` 均设为 `false`。
- `providers` 仅注册一条 `id: "demo"`、`type: "openai-compatible"` 的本地回环服务商（`baseURL: "http://127.0.0.1:<空闲端口>/v1"`、`apiKeyEnv: "SITE_DEMO_KEY"`）；模型 `local` 声明 `contextWindow: 128000`、`maxOutputTokens: 8192`、`capabilities: { toolCalls: true, editTool: "edit" }` 与 `pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 }`（供用量页估算费用）。
- `permissions: { preset: "smart" }`，并把 `permission.reviewer` 设为 `{ backend: "model", model: { provider: "demo", model: "local" } }`，让智能权限审查走本地假模型。

本地假 OpenAI 兼容 SSE 服务只监听 `127.0.0.1`（支持 `GET /models`、`stream: false` 与 SSE），按 system 提示词和消息路由到五类固定剧本，不请求外网模型：

- **标题生成**（匹配 `你只负责给对话起标题`）：按关键词返回对应会话标题。
- **权限审查器**（匹配 `你是权限安全审查器`）：返回审查 JSON；命令不含 `--force` 时返回 `requested: true, destroys: false` 自动放行，含 `--force` 时返回 `requested: false, destroys: true` 交由用户确认。
- **桌面改代码剧本**：依次返回 `read src/login.mjs` → `todo_write`（四项：两项完成、一项进行中、一项待办）→ `edit src/login.mjs`（区分 `TimeoutError` 返回 `{ retry: true }`，其他错误继续抛出）→ `read CHANGELOG.md` → `edit CHANGELOG.md`（补未发布条目）→ `shell node --test test/login.test.mjs` → `todo_write`（四项全部完成）→ 含三行结果对照表与 `3 passed, 0 failed` 的完成说明。
- **权限审批剧本**：依次返回 `shell node --test` → `read CHANGELOG.md` → `edit CHANGELOG.md`（未发布改为 `1.4.0`）→ `shell git commit -am "release: 1.4.0"` → `shell git tag v1.4.0` → `shell git push --force origin rock-and-roll-all-nite`（触发审查器拦截并停在确认卡片）。
- **合奏剧本**：收到 `/ensemble` 请求后进入指挥剧本，先 `ensemble_init`（中文标题「迁移设置页表单」，英文 `Migrate settings forms`），再依次 `ensemble_add_member` 注册 `violin-1`、`violin-2`、`cello-1` 三位成员（各带 `owns` / `handsOff` / `doneWhen` 职责），随后用 `ensemble_post` 分派页面迁移、回应 `violin-2` 关于失焦校验的提问、指派 `cello-1` 运行全量测试并在收到回报后总结收尾；成员子会话按 ``You are persistent ensemble member `@...` `` 路由并用 `ensemble_post` 在留言板汇报。

英文版截图按与中文版完全一致的场景在独立隔离环境重拍：保留桌面端真实中文 UI 标签（软件本身无英文界面），将用户提问、模型回复、代码改动说明、合奏成员职责与留言板消息、定时任务名称及指令全部改为英文，同样由本地假模型和隔离种子生成。

### 2. 启动与进程

用 Node 的 `spawn(..., { detached: true, windowsHide: true, stdio: ["ignore", outFd, errFd] })`（或 `Start-Process -PassThru`）启动本地假模型、独立端口的 Vite（或静态构建后的调试版桌面 exe，不要占用已有开发实例端口 31420）以及调试版桌面 exe（WebView 开启 `--remote-debugging-port=<空闲端口>`）。若需让截图时间戳对齐章节时刻，可把 `NOCTURNE_DESKTOP_BACKEND` 指向一个薄包装脚本（监视 `clock.txt` 覆盖后端 `Date` 后再导入工作树 `apps/cli/dist/main.js`），前端同时通过 CDP `Page.addScriptToEvaluateOnNewDocument` 注入同等偏移的 `Date`（合奏剧本在关键 `ensemble_init` / `ensemble_post` 时顺次推进 `clock.txt`）；不需要对齐时刻时直接指向工作树 `apps/cli/dist/main.js`。PID 写入文件，结束时只停这些 PID 及其子进程，不按进程名结束；不碰正在运行的安装版或开发版。启动脚本的子进程会占住输出管道，单独启动，不要和截图命令串在一起。每次操作前核对 CDP 端口对应的 exe 路径。

### 3. 桌面五场景（desktop / perm / ensemble / sched / usage）

在调试页的 `localStorage['nocturne.desktop.prefs.v1']` 中设置 `theme`（深浅模式；保持默认「工作台」与「标准」宽度）、`autoUpdate: false`、`projects: [<echoes 绝对路径>]`，刷新后分别执行各场景。截图前隐藏页面中所有以盘符开头的叶子节点文字（标题栏本地路径），每种主题同时设置 `Emulation.setEmulatedMedia` 和 `document.documentElement.dataset.theme`，并读取 `body` 背景色确认主题生效。除 `usage` 裁切外，其余四场景均以 1440×900、`deviceScaleFactor: 2` 拍摄整窗（输出 2880×1800）：

```text
Emulation.setDeviceMetricsOverride {"width":1440,"height":900,"deviceScaleFactor":2,"mobile":false}
Emulation.setEmulatedMedia {"features":[{"name":"prefers-color-scheme","value":"dark"}]}
Page.captureScreenshot {"format":"png","captureBeyondViewport":false}
```

- **desktop**：在 `echoes` 新建会话，发送登录超时修复请求（中文「修一个登录超时：超时后允许重试，保留其他错误。改完跑测试。」，英文 `"Fix a login timeout: allow retries on timeout and preserve other errors. Run the tests."`）；等完成回复出现后，点击改动卡片里的「查看变更」（或「右侧面板」→「变更」）加载 `src/login.mjs` 与 `CHANGELOG.md` 的 Diff，若底部 `✓4/4` 任务条已展开则折叠，滚动对话到底部后截深浅双图。
- **perm**：先在 `echoes` 仓库执行 `git checkout -b rock-and-roll-all-nite`，新建会话发送发布请求（中文「跑完测试，打 tag 推上去」，英文 `"Run the tests, tag 1.4.0, and push"`）；待审查器拦截 `git push --force origin rock-and-roll-all-nite` 并弹出审批卡片后截深浅双图，拍完点击「拒绝并停止」结束回合。
- **ensemble**：在 `echoes` 新建会话发送合奏请求（中文「/ensemble 把设置页迁移到新的表单组件并补齐测试」，英文 `"/ensemble Migrate the settings pages to the new form components and add tests"`）；待指挥与 `violin-1`、`violin-2`、`cello-1` 完成协作并输出最终总结后，点击对话中生成的合奏卡片按钮（含合奏标题与「合奏」字样）打开右侧合奏面板（留言板 / 成员），截深浅双图。
- **sched**：先停止桌面端，用种子脚本向隔离 `home` 写入 `schedules.json`（三条任务：`before-dawn` 每天 05:30 启用、`time` 每天 07:00 启用、`weekly-deps` 每周一 09:00 停用；中文名「黎明前巡检」/ `Time` /「依赖周报」，英文名 `Pre-dawn check` / `Time` / `Weekly deps`）与 `schedules/history/before-dawn.jsonl`（七条运行历史，覆盖 `done`、`skipped`/`missed`、`denied: 1`、`error`/`provider_error`）。重启桌面端后点侧边栏「定时任务」→ 选中第一条任务 → 点「历史」标签，截深浅双图。
- **usage**：同样在桌面端停止时，用种子脚本以演示会话为 `parent` 在隔离 `home/sessions/` 写入近一年多天的子会话 `.jsonl`（每条含 `session.created`、`turn.started`、带 `usage` 与 `toolCalls: []` / `finishReason: "stop"` 的 `message.assistant` 和 `turn.completed`，最长一次额外含 `message.user`；并在热力图第 41 列附近排布月牙与星点），写完用 Core 的 `decodeDurableEvent` 逐行校验，任何一行不合契约整条日志会被统计跳过。重启桌面端后进「设置 › 用量」，范围选「全部」；视口设为 `1188×900`、`deviceScaleFactor: 2`，量取 `.usage-body` 到 `.usage-heat-footer` 的边界并加边距（`x - 16, y - 8, w + 32, bottom - y + 28`），用 `Page.captureScreenshot` 的 `clip`（`scale: 1`）裁切出深浅双图（输出 1824×809），确保统计数字与图例完整显示且不切入下一节标题。

### 4. 终端

终端截图仍使用独立隔离会话，若章节内容未变可直接复用现有 `terminal-{zh,en}-{dark,light}.webp`。重拍该演示会话时：在独立隔离 `home` 的 `providers.json` 注册本地回环的 `demo` 服务商（`baseURL: "http://127.0.0.1:<空闲端口>/v1"`、`apiKeyEnv: "SITE_DEMO_KEY"`，模型 `local` 声明 `contextWindow: 128000`、`toolCalls`、`editTool: "edit"` 与 `pricing`），`config.json` 设 `modelsDev: false`、`skills.sources.agents/claude: false`、权限预设 `auto-edit` 并仅允许 `node --test *`，`settings.json` 设 `model: "demo/local"`；演示仓库 `echo` 放相同的 `src/login.mjs` 与三项 `test/login.test.mjs` 并 `git init`。假 OpenAI SSE 模型依次返回 `read src/login.mjs` → `todo_write`（四项：两项完成、一项进行中、一项待办）→ `edit` → `shell node --test test/login.test.mjs` → 带结果表的完成说明；中文请求「修一个登录超时：超时后允许重试，保留其他错误。改完跑测试。」，英文请求 `"Fix the login timeout: allow retries on timeout and preserve other errors. Run the tests."`（英文完成说明要短到终端一行放得下，`nctrn` 按列折行，长英文句会在单词中间断开）。用 Core 的 `createRuntime({ config, cwd, interactive: false })`、`createSession({ model: "demo/local" })`、`session.submit({ text })` 跑完并关闭。

复制该隔离 home 到终端专用副本，按深浅分别写 `settings.json` 的 `theme`；只在副本里把日志中的工作区路径替换为 `N:\echo`，首行 `workspaceRoot` 保留实际路径。先确认 N: 未占用，再 `subst N: <示例根目录>`（映射 `echo` 上一级，使 `N:\echo` 存在）。

在桌面 WebView 中注入一个临时 IIFE（Vite lib 构建，入口导入正式 `createTauriHost` 与 `mountTerminal`，不打进主页），清空 body 后挂载终端，设置 `data-theme` 后再挂载以取对应配色。`mountTerminal` 已加载 Unicode 11 宽度表，注入包不用另外注册；挂载前先用 `document.fonts.load` 加载 `--mono` 的常规与粗体字形，否则字宽按回退字体量，框线会错位。shell 用 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`，cwd `N:/echo`，cols/rows 取 `mountTerminal().size()`，输入 `node <启动器> --resume <会话ID>`（启动器先 `chdir('N:/echo')` 再导入工作树 CLI），等到 `idle` 后截 960×600。拍完用 host API 关闭 PTY，`subst N: /d`。

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
