# 项目主页

主页地址是 <https://nocturne.koxia.cn/>，中文默认，英文位于 `/en/`。深色优先，经 `prefers-color-scheme` 跟随系统切换浅色；主题变量、页头页脚只在 `base.css`，主页和更新日志页另加 `site.css`，有深浅两版的截图用 `<picture>` 的浅色 `source` 切换。纯静态 HTML + CSS，无运行时 JavaScript、统计、第三方脚本或 cookie。

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
| `desktop-<语言>-<主题>.webp` | 桌面端整窗，变更面板打开 | 深、浅 | 中、英 | 1440×900 |
| `terminal-<语言>-<主题>.webp` | 终端 `nctrn --resume` | 深、浅 | 中、英 | 960×600 |
| `phone-<语言>-<主题>.webp` | 手机会话 | 深、浅 | 中、英 | 390×844 |
| `context-<主题>.webp` | 上下文用量浮层（裁切） | 深、浅 | 中 | 720×340 |
| `usage-<主题>.webp` | 用量统计行和热力图（裁切） | 深、浅 | 中 | 885×418 |
| `social-<语言>.webp` | 社交预览 | 深 | 中、英 | 1200×630 |

每张 WebP 不超过 300 KB；HTML 写真实 `width`、`height`、`alt`，深色图放 `<img>`，浅色图放 `<source media="(prefers-color-scheme: light)">`。不再使用的图片删除。

### 1. 准备隔离 home 与假模型

每种语言一个独立根目录，内含 `home`、`echo`、`relay-data`。只在启动脚本里设置 `NOCTURNE_HOME`、`WEBVIEW2_USER_DATA_FOLDER`、`SITE_DEMO_KEY=demo-placeholder`，不要指向真实 `~/.nocturne`。先在当前工作树 `pnpm build`。

隔离 `providers.json` 只有一个 `demo` 服务商（`baseURL: http://127.0.0.1:18652/v1`、`apiKeyEnv: SITE_DEMO_KEY`），模型 `local` 声明 `contextWindow: 128000`、`toolCalls`、`editTool: "edit"`，并填一组 `pricing` 让用量页能估算费用。`config.json` 关闭 `modelsDev`，`skills.sources.agents/claude` 设为 false，权限预设 `auto-edit`，只为 `node --test *` 加允许规则；`settings.json` 使用 `model: "demo/local"`。这样不会加载用户技能或凭据。

假 OpenAI SSE 模型只监听回环地址，依次返回 `read src/login.mjs` → `todo_write`（四项，两项完成、一项进行中）→ `edit` → `shell node --test test/login.test.mjs` → 带结果表的完成说明，不请求外网模型。echo 中放登录函数（原为 `return await request()`）和三项回归测试并 `git init`。中文请求「修一个登录超时：超时后允许重试，保留其他错误。改完跑测试。」，英文请求 “Fix the login timeout: allow retries on timeout and preserve other errors. Run the tests.”。英文完成说明要短到终端一行放得下：nctrn 按列折行，长英文句会在单词中间断开。用 Core 的 `createRuntime({config,cwd,interactive:false})`、`createSession({model:'demo/local'})`、`session.submit({text})` 跑完并关闭；侧栏只保留这一个 echo 项目和这一条会话。

用量热力图需要多天数据：另写约一年的子会话日志（`session.created.payload.parent` 指向演示会话），每条含 `turn.started`、带 `usage` 的 `message.assistant`（需 `toolCalls: []`、`finishReason`）和 `turn.completed`。用量统计扫描全部日志，子会话不进侧栏。写完用 Core 的 `decodeDurableEvent` 逐行校验，任何一行不合契约整条日志会被统计跳过。

手机经本地中继打开同一会话：种子同时生成主机与手机两份 P-256 身份，主机私钥用 DPAPI 写进隔离 `credentials.json`，`remote.json` 与中继 `relay-data.json` 登记这对设备。这些是一次性演示身份，不是真实凭据。

### 2. 启动与进程

用 `Start-Process -PassThru` 依次启动：当前工作树 `apps/desktop` 的 Vite（`--port 31420 --strictPort`）、`apps/relay/dist/main.mjs serve --listen 127.0.0.1:18787 --web-root apps/desktop/dist-web`、调试版桌面 exe（`NOCTURNE_DESKTOP_BACKEND` 指向工作树 `apps/cli/dist/main.js`，WebView 加 `--remote-debugging-port=19334`）、独立 user-data-dir 的 headless Edge（`--remote-debugging-port=19444`）。PID 写入文件，结束时只停这些 PID 及其子进程，不按进程名结束；先确认端口空闲，不碰正在运行的安装版或开发版。启动脚本的子进程会占住输出管道，单独启动，不要和截图命令串在一起。每次操作前核对 CDP 端口对应的 exe 路径。

### 3. 桌面、上下文与用量

在调试页的 `localStorage['nocturne.desktop.prefs.v1']` 中设置 `theme`、`autoUpdate:false`、`projects:[<echo 绝对路径>]`（与会话日志里的路径完全一致，否则侧栏会出现两个 echo），刷新后打开演示会话，点「右侧面板」再点「变更」。隐藏所有以盘符开头的叶子节点文字（标题栏的本地路径）。每张图同时设置 `data-theme` 和 `Emulation.setEmulatedMedia`，截图前读一次 `body` 背景色确认主题生效：

```text
Emulation.setDeviceMetricsOverride {"width":1440,"height":900,"deviceScaleFactor":1,"mobile":false}
Emulation.setEmulatedMedia {"features":[{"name":"prefers-color-scheme","value":"dark"}]}
Page.captureScreenshot {"format":"png","captureBeyondViewport":false}
```

上下文用量：点状态栏 `aria-label="上下文用量"` 的按钮，按浮层位置用 `clip` 裁 720×340（下沿贴窗口底，含状态栏）。用量：进「设置 › 用量」，范围选「全部」；视口 1188×900 时统计行仍是一行五列，把 `.usage-body` 整宽连同上方统计行、下方图例用 `clip` 的 `scale` 缩到 885×418，下沿不要切到下一节标题，数字不能被裁断。

### 4. 终端

复制隔离 home 到终端专用副本，按深浅分别写 `settings.json` 的 `theme`；只在副本里把日志中的工作区路径替换为 `N:\echo`，首行 `workspaceRoot` 保留实际路径。先确认 N: 未占用，再 `subst N: <示例根目录>`（映射 echo 的上一级，使 `N:\echo` 存在）。

在桌面 WebView 中注入一个临时 IIFE（Vite lib 构建，入口导入正式 `createTauriHost` 与 `mountTerminal`，不打进主页），清空 body 后挂载终端，设置 `data-theme` 后再挂载以取对应配色。桌面内嵌 xterm 只带 Unicode 6 宽度表，nctrn 任务清单的 emoji 会让框线错位；注入包里用 `term.unicode.register` 注册 Unicode 11 宽度（与 Windows Terminal 一致）后再 `open`。shell 用 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`，cwd `N:/echo`，cols/rows 取 `mountTerminal().size()`，输入 `node <启动器> --resume <会话ID>`（启动器先 `chdir('N:/echo')` 再导入工作树 CLI），等到 `idle` 后截 960×600。拍完用 host API 关闭 PTY，`subst N: /d`。

### 5. 手机

headless Edge 设置 390×844、`mobile:true`，打开中继页面，把种子里的手机身份和主机记录写入 IndexedDB `nocturne-remote`。手机网页启动时按 `localStorage['nocturne.phone.theme']` 应用主题，缺省 `system` 会删掉 `data-theme` 并跟随浏览器（headless 默认浅色），所以每种主题都先写这个键、再设 `prefers-color-scheme`、再刷新，进入 echo 和演示会话，等完成文本、输入框和字体就绪后截图，并用背景色确认主题。

### 6. 导出与验收

```powershell
ffmpeg -i desktop-zh-dark.png -c:v libwebp -quality 86 desktop-zh-dark.webp
ffmpeg -i terminal-zh-dark.png -c:v libwebp -quality 88 terminal-zh-dark.webp
ffmpeg -i phone-zh-dark.png -c:v libwebp -quality 88 phone-zh-dark.webp
ffmpeg -i context-dark.png -c:v libwebp -quality 90 context-dark.webp
ffmpeg -i usage-dark.png -c:v libwebp -quality 90 usage-dark.webp
ffmpeg -i desktop-zh-dark.png -vf 'scale=1008:630,pad=1200:630:96:0:color=0x121419' -c:v libwebp -quality 86 social-zh.webp
```

逐张打开检查：没有真实路径/密钥，主题正确，终端无错位，整图无外部窗口，大小达标。

构建后用独立 headless Edge 和 CDP 拍整页：宽 1440、1024、800、400，中英文和更新日志页，深浅色。headless 窗口有最小宽度，必须用 `Emulation.setDeviceMetricsOverride`（或 iframe）设视口，否则窄屏结果不可信；主题用 `Emulation.setEmulatedMedia`。等待 `document.fonts.ready` 和所有图片 decode，确认 `scrollWidth <= innerWidth`、所有图片 `naturalWidth > 0`，用 `Page.getLayoutMetrics` 的内容高度作为截图 clip。headless Edge 建议加 `--disable-extensions --disable-background-timer-throttling --disable-renderer-backgrounding --disable-gpu`；截图和 Lighthouse 顺序执行，避免它们导航同一目标。

```powershell
pnpm dlx lighthouse@13.0.1 http://127.0.0.1:18643/ --port=19445 '--only-categories=accessibility,seo' --output=json --output-path=site-audit.json
```

Lighthouse 只按默认配色审计，深色对比度另按 `base.css` 的变量核算。保留截图和审计报告。结束服务、Edge、调试桌面时只按启动记录的 PID 结束其进程树。
