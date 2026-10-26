# 项目主页

主页地址是 <https://nocturne.koxia.cn/>，中文默认，英文位于 `/en/`。采用「月光纸页」浅色视觉；纯静态 HTML + CSS，无运行时 JavaScript、统计、第三方脚本或 cookie。

## 目录与构建

- `site/index.html`、`site/en/index.html`：结构相同的双语页面。功能事实以根 README 为准。
- `site/assets/`：共用 CSS、favicon、自托管字体和中英文分别拍摄的 WebP 截图。
- `site/CNAME`：`nocturne.koxia.cn`。
- `scripts/build-site.mjs`：仅使用 Node 内置模块，将 `site/` 复制到忽略的 `dist-site/`，并将 HTML 中全部 `{{version}}` 替换成根 `package.json` 的版本。
- `scripts/test/build-site.test.mjs`：版本、占位符、语言互链、本地资源与锚点、CNAME、字体标题清单检查。根 `pnpm test` 的 scripts 测试组会运行它。

主页不是 pnpm workspace 成员，不参与 `pnpm build` 和 workspace 包测试。单独构建与验证：

```bash
node scripts/build-site.mjs
pnpm exec vitest run --root scripts test/build-site.test.mjs
```

可用任意静态服务预览 `dist-site/`；需把目录请求解析到 `index.html`。服务仅监听 `127.0.0.1`，启动时记下 PID，结束时只关闭该 PID 及其子进程。

## 发布与域名

`.github/workflows/pages.yml` 使用官方 `upload-pages-artifact`、`deploy-pages`，以固定提交 SHA 锁定。仅运行 Node 静态构建，不安装项目依赖。触发条件：main 上的 `site/**`、构建脚本或工作流修改，Release 的 `published`，以及手动运行。Release 触发时检出发布标签，因此版本与该标签中的根 package.json 一致；其他触发检出对应提交。

第一次上线由维护者完成：DNS 添加 `nocturne` CNAME 指向 `kanzaki-chiya.github.io`；仓库 Pages 来源设为 GitHub Actions；推送后在 Pages 设置确认域名并启用强制 HTTPS。提交代码本身不会开启 Pages。

## 字体子集

标题、字标、章节编号使用 Noto Serif SC 2.003 的 SC Black，SIL OFL 1.1；英文用同一字体的拉丁字形。原始字体来自 `notofonts/noto-cjk` 的 `Serif2.003` 固定提交，完整 URL 写在脚本中，原文件只在 OS 临时目录保存并清理。许可见 [字体许可](../../site/assets/fonts/OFL.txt) 与 [第三方声明](../../THIRD-PARTY-NOTICES.md)。正文和代码使用系统字体，字体不可用时标题回退宋体/衬线字体。

标题变更后手动执行（需要 Node.js 24.14+ 与根依赖）：

```bash
pnpm install --frozen-lockfile
node scripts/subset-site-font.mjs
node scripts/build-site.mjs
pnpm exec vitest run --root scripts test/build-site.test.mjs
```

脚本支持 `HTTPS_PROXY` / `HTTP_PROXY` 等 Node 环境代理；扫描双语页面的 h1、h2、字标，并加入章节数字。提交生成的 `noto-serif-sc-headings.woff2` 和 `characters.txt`，不提交 OTF。不要从境外字体服务加载字体。

## 截图重拍

所有截图必须来自隔离假模型会话，不能使用维护者的真实配置、会话或密钥。中英文各跑一轮；UI 当前标签为中文，英文图保留真实 UI 标签，仅会话内容改成英文。桌面整图 1440×900，终端 960×600，手机 390×780，均为浅色。

### 1. 准备隔离项目与假模型

选择独立临时根目录，例如 `C:\Temp\nocturne-site`，分别建立 `home-zh`、`home-en`、`zh\echo`、`en\echo`。不要指向真实 `~/.nocturne`。只在当前启动脚本设置环境：

```powershell
$siteTemp = 'C:\Temp\nocturne-site'
$env:NOCTURNE_HOME = "$siteTemp\home-zh"
$env:WEBVIEW2_USER_DATA_FOLDER = "$siteTemp\webview-zh"
New-Item -ItemType Directory -Force $env:WEBVIEW2_USER_DATA_FOLDER | Out-Null
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=19333'
$env:SITE_DEMO_KEY = 'demo-placeholder'
```

先 `pnpm build`，按桌面开发流程构建调试 exe。复用本地假 OpenAI SSE 模型夹具（本轮留在报告旁 `tmp/r1030/mock-model.mjs`、`seed.mjs`；修改其临时根目录和仓库 import 路径后运行）。假模型仅监听回环地址，返回 `read src/login.mjs` → `edit` → `shell node --test test/login.test.mjs` → 完成说明；不要请求外网模型。

隔离 `providers.json` 示例：

```json
{
  "version": 1,
  "providers": [{
    "id": "demo",
    "type": "openai-compatible",
    "baseURL": "http://127.0.0.1:18642/v1",
    "apiKeyEnv": "SITE_DEMO_KEY",
    "models": {"local": {"displayName": "Demo · local", "contextWindow": 128000, "maxOutputTokens": 8192, "capabilities": {"toolCalls": true, "editTool": "edit"}}}
  }]
}
```

隔离 `config.json` 关闭 `modelsDev`，设 `credentials.backend: "none"`、`skills.sources.agents: false`、`skills.sources.claude: false`、`permissions.preset: "auto-edit"`，只为 `node --test *` 加允许规则。`settings.json` 使用 `model: "demo/local"`、`theme: "light"`、`permissionPreset: "auto-edit"`。这样不会加载用户技能或凭据。

在 echo 中放一个登录函数和三项回归测试，原函数为 `return await request()`；任务要求超时后返回 `{ retry: true }`、保留其他错误，修改后跑测试。中文请求「修一个登录超时：超时后允许重试，保留其他错误。改完跑测试。」英文请求 “Fix the login timeout: allow retries on timeout and preserve other errors. Run the tests.”。用 Core 的 `createRuntime({config,cwd,interactive:false})`、`createSession({model:'demo/local'})`、`session.submit({text})` 跑完，关闭会话；再建两条非空示例会话供侧栏展示。

### 2. 桌面整窗与细节

用 `Start-Process -PassThru` 启动自己的调试 exe 并记录 PID。每次点击或输入前用 `Get-Process -Id <记录的PID>` 核对 exe 路径，CDP 只连该进程启动的 19333 端口、`http://tauri.localhost/` 目标。

在调试页的 `localStorage['nocturne.desktop.prefs.v1']` 中设置 `theme:'light'`、`autoUpdate:false`、`projects:[<echo绝对路径>]`，并用对应会话的 `panelSessions` 打开 `changes` 标签。刷新后打开登录修复会话。通过 CDP 设置视口和截取页面（下列是发送给 CDP 的方法和 JSON 参数）：

```text
Emulation.setDeviceMetricsOverride {"width":1440,"height":900,"deviceScaleFactor":1,"mobile":false}
Page.captureScreenshot {"format":"png","captureBeyondViewport":false}
```

将返回的 `data` base64 写成 PNG。只捕获自己的 WebView 页面，不截整个桌面。桌面小图从大图右上裁 720×450：

```powershell
ffmpeg -i desktop-zh.png -vf 'crop=720:450:720:0' -c:v libwebp -quality 88 detail-zh.webp
```

### 3. 终端与手机

终端使用正式桌面 `mountTerminal` + Tauri `host.terminals` 的 PTY，加载正式 xterm 样式。复制隔离 home 到独立 terminal-home，避免与桌面抢锁；只对该副本将显示路径转为临时空闲盘符中的 `N:\echo`，`workspaceRoot` 保留实际隔离路径以便恢复验证。先确认 N: 未占用，再 `subst N: <当前语言示例目录>`。PTY 实际 cwd 与示例项目对应，运行 `node <仓库>/apps/cli/dist/main.js --resume <演示会话ID>`；等待 `idle` 后截 960×600 的 WebView。PTY 的 cols/rows 必须取 `mountTerminal().size()`，不要硬编码。拍完用 host API 关闭该 PTY，移除本轮建立的盘符映射。

手机用 Vite 的临时独立入口导入正式 `Conversation`、`PhoneComposer`、`web/icons`、`styles.css`、`web/phone.css`，通过 `replaySessionView` 重放同一语言的假模型事件；传入会话的真实隔离 cwd，让工具路径正确相对化。标题栏使用正式 phone-header 结构；不需要连接中继。该夹具仅在临时目录，不能打进主页。

用独立 headless Edge 打开夹具，设置 390×780、`mobile:true`、`data-theme="light"`，等待完成文本和字体加载，使用 `Page.captureScreenshot`。所有 `Start-Process` 都用 `-PassThru` 保存 PID；只关闭记录过的 PID，不按进程名结束。

### 4. 导出与验收

```powershell
ffmpeg -i desktop-zh.png -c:v libwebp -quality 86 desktop-zh.webp
ffmpeg -i terminal-zh.png -c:v libwebp -quality 88 terminal-zh.webp
ffmpeg -i phone-zh.png -c:v libwebp -quality 88 phone-zh.webp
ffmpeg -i desktop-zh.png -vf 'scale=1008:630,pad=1200:630:96:0:color=0xf3f4f7' -c:v libwebp -quality 86 social-zh.webp
```

英文使用独立英文会话重复以上操作。逐张打开检查：没有真实路径/密钥，浅色，终端无错位，整图无外部窗口，每张 WebP ≤300 KB；HTML 填写真实 `width`、`height`、`alt`。

构建后在 1440 和 375 宽各拍中英文整页图。等待 `document.fonts.ready` 和所有图片 decode，确认 `scrollWidth <= innerWidth`，使用 `Page.getLayoutMetrics` 的内容高度作为截图 clip。headless Edge 建议加 `--disable-extensions --disable-background-timer-throttling --disable-renderer-backgrounding --disable-gpu`，使用独立 user-data-dir；截图和 Lighthouse 顺序执行，避免它们导航同一目标。

```powershell
pnpm dlx lighthouse@13.0.1 http://127.0.0.1:18643/ --port=19445 '--only-categories=accessibility,seo' --output=json --output-path=site-audit.json
```

核对颜色对比度、页面重量、字体标题覆盖与所有本地资源，保留截图和审计报告。结束服务、Edge、调试桌面时只按启动记录的 PID 结束其进程树。
