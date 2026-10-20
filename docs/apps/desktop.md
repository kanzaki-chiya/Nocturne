# 桌面端（Tauri 外壳 + React 前端）

> 状态：v0.5 骨架与连接、对话、设置区（服务商、常规、模型、外观）已实现（[ADR-0046](../decisions/ADR-0046-desktop-tauri.md) 第 9 节第 1–3 步） | 前置阅读：[protocols/rpc.md](../protocols/rpc.md) | 代码位置：`apps/desktop/`

`apps/desktop` 是 Nocturne 的桌面端：一个 Tauri 进程内，React 前端经 `@nocturne/rpc/client` 与一个常驻 `nctrn rpc --stdio` 后台进程通信，Rust 外壳只负责进程管理与按行转发。所有会话语义（握手、方法调用、事件）都在前端处理，外壳不解析报文。

## 1. 进程结构与后台策略
子代理档位见 [subagent.md 第 19 节](../architecture/subagent.md#19-子代理档位)：设置导航「外部 agent」改名「子代理」，同页左列分内置档位和外部 agent。添加提供空白/quick/deep 模板（模型留空），编辑器包含名称（创建后锁定）、何时用、模型、超时、强度、工具上限、启用和删除。default 始终启用且不能删除，模型写 modelRoles.task；模型页的子代理模型行跳转到这里。预览复用 Core 的 subagentSelectionTable；对话工具行显示档位徽标、实际模型和强度，展开显示选择理由，旧调用无 profile 不显示徽标。外部编辑和探测保持原行为，说明标签改为何时用。


- **单后台（ADR-0051）**：整个窗口只有一个 `nctrn rpc --stdio` 后台，`backend_open` 以普通对话工作区（见第 3 节）为 cwd 启动 `node <脚本> rpc --stdio`，窗口打开期间常驻；所有项目和普通对话的会话都在这个后台里创建与恢复，不再按项目起停后台。后台的启动目录只是它的缺省工作区：每个会话的 `cwd`/`workspaceRoot` 在 `runtime.createSession` 时传入、并写入 `session.created` 元数据，恢复时以日志记录的目录为准（[sessions.md](../architecture/sessions.md)）。会话列表是全局的（`<NOCTURNE_HOME>/sessions`），前端用这个常驻后台 `runtime.listSessions()` 取全部会话。
- **后台生命周期**：Rust 外壳在 Tauri 页面开始加载钩子中同步推进后台代际，F5 或 Vite 整页重载后并行关闭旧页面全部后台（关 stdin → 等自行退出 → 5 秒强杀），不依赖前端异步 `beforeunload`；在途 `backend_open` 在启动前校验分发时捕获的代际，旧页面请求被取消，旧清理只使用旧代快照，不影响新页面后台。窗口关闭时对所有后台（含正在重载清理的后台）执行相同关闭流程，全部结束后退出应用；Windows 上后台在 spawn 后被放入全局 Job Object（`KILL_ON_JOB_CLOSE`），外壳被强杀时后台一起结束。Job 创建或加入失败不致命，往该后台的 stderr 缓冲记一行说明。纯 React Fast Refresh 不重新加载文档，由前端组件生命周期释放连接。
- **日志边界**：stdin/stdout 的内容在任何地方都不记录、不打印、不写盘（报文里可能含密钥明文）；stderr 按行截断（64 KiB/行）保留最近 500 行在内存中。缓冲只在两处离开外壳：后台退出时随 `closed` 消息交给前端（崩溃横幅显示末尾几行），以及前端经 `backend_stderr` 命令按需拉取（「后台日志」页，只在打开页面或点「刷新」时读，不轮询）。后台退出即从注册表移除，此后 `backend_stderr` 返回 `unknown_backend`——缓冲不随进程保留，退出后唯一的 stderr 副本在 `closed` 消息里。

## 2. 命令与消息格式

Rust 外壳提供二十七个 Tauri 命令（经 `tauri_build` 的 `AppManifest::commands` 声明为应用命令，在 `capabilities/main.json` 中逐个授予 `allow-backend-open` 等权限），错误统一返回可序列化的 `{ code, message }`（message 为中文）：`node_unavailable`、`backend_script_missing`、`invalid_workspace`、`spawn_failed`、`unknown_backend`、`workspace_unavailable`、`file_too_large`、`io`，终端另有 `invalid_shell`、`unknown_terminal`、`unsupported`，浏览器另有 `unknown_browser`、`browser_failed` 与导航被拦的 `browser_invalid` / `browser_external` / `browser_internal` / `browser_file` / `browser_unsupported`。

| 命令              | 参数 → 结果                                         | 说明                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend_open`    | `{ workspace, channel }` → `backendId`（u32，自增） | 校验工作区目录存在；取缓存的 Node 探测结果（无缓存先探测一次，不满足报 `node_unavailable`）；解析后台脚本；spawn 后 stdout 行经 channel 推给前端                                                                                                                                                                                                                                              |
| `backend_send`    | `{ backendId, line }` → `null`                      | 写 `line + \n` 到该后台 stdin 并 flush；每个后台的 stdin 有独立 Mutex                                                                                                                                                                                                                                                                                                                         |
| `backend_close`   | `{ backendId }` → `null`                            | 关 stdin、等自行退出、5 秒超时强杀，进程确实结束才返回；重复调用或对已退出的后台调用返回 `null`                                                                                                                                                                                                                                                                                               |
| `backend_stderr`  | `{ backendId }` → `string[]`                        | 返回该后台内存中的 stderr 缓冲（最近 500 行，每行 ≤ 64 KiB）；不写盘。后台不存在或已退出（缓冲随进程回收）报 `unknown_backend`                                                                                                                                                                                                                                                                |
| `node_probe`      | `{}` → `NodeProbe`                                  | 每次重新探测并刷新缓存（说明页的「重新检测」）                                                                                                                                                                                                                                                                                                                                                |
| `plain_workspace` | `{}` → 绝对路径字符串                               | 解析 `<NOCTURNE_HOME>/workspace`（`NOCTURNE_HOME` 规则与 Core `nocturneHome()` 一致），不存在时创建（POSIX 上新建目录 0700），返回绝对路径；失败报 `workspace_unavailable`                                                                                                                                                                                                                    |
| `pick_images`     | `{}` → 原始字节（`Response`）                       | 系统文件对话框多选图片（过滤 png/jpg/jpeg/gif/webp）；外壳读取所选文件字节返回，前端不传路径——读取范围仅限用户显式选中的文件。单个文件 > 64 MiB 报 `file_too_large`：与 stdout 单行上限同级的内存护栏（不是附件规则，格式与尺寸校验仍在 Core）。自定义二进制帧，重复记录 `[u32 LE 文件名 UTF-8 字节数][文件名][u32 LE 数据字节数][数据]`；取消选择返回空体。前端解码在 `src/picked-images.ts` |

| `open_skill_directory` | `{ path, create }` → `null` | 打开绝对目录；create 只允许创建 `<NOCTURNE_HOME>/skills`；失败报 `workspace_unavailable` |
| `app_note` | `{ line }` → `null` | 前端把一行诊断写进外壳日志（更新检查结果等静默降级场景）；按 stderr 同样规则截断（≤64 KiB/行，UTF-8 边界内）后进内存缓冲 |
| `shell_log` | `{}` → `string[]` | 外壳自身诊断日志的快照（最近 500 行，不写盘）；「后台日志」页的「外壳」条目读它 |
| `notify_show` | `{ sessionId, title, body, sound }` → `{ shown, reason?, detail? }` | Windows 系统通知（[ADR-0056](../decisions/ADR-0056-session-notifications.md)）：同一会话 tag/group 替换旧通知；`sound: false` 时 `<audio silent="true"/>`；系统关掉本应用通知时 `shown: false, reason: "disabled"`；非 Windows `shown: false, reason: "unsupported"`。AUMID：安装版（release）直接用 bundle identifier（与 NSIS 快捷方式一致）；只有开发构建才探测注册表，未登记退回 PowerShell 署名 |
| `notify_dismiss` | `{ sessionId }` → `null` | 撤掉该会话的通知：先 Hide 原 toast（屏幕上那条立刻消失）再按 tag/group 清通知中心历史，最后放掉对象（点击回调随之失效）；切到该会话、窗口获焦时调用 |
| `terminal_open` | `{ shell, cwd, cols, rows, channel }` → `terminalId`（u32，自增） | 面板终端（5.10）：portable-pty 起 shell，输出经这个终端自己的 channel 推送。`shell` 必须是存在的绝对路径且文件名是 `pwsh.exe` / `powershell.exe` / `bash.exe` / `cmd.exe` 之一（System32 下的 `bash.exe` 是 WSL 入口，不认），否则 `invalid_shell`；参数由外壳按种类决定（PowerShell `-NoLogo`，Git Bash `--login -i`，cmd 无），前端传不了参数；`cwd` 必须是存在的目录，否则 `invalid_workspace`。Windows 上进程放进外壳的 Job Object |
| `terminal_write` | `{ id, data }` → `null` | 写入终端输入；未知或已结束的终端报 `unknown_terminal` |
| `terminal_resize` | `{ id, cols, rows }` → `null` | 调整 pty 尺寸（行列夹在 2–1000） |
| `terminal_close` | `{ id }` → `null` | 结束进程（连同它启动的程序）；已结束的也返回 `null`。前端页面重新加载、应用退出时外壳结束全部终端 |
| `terminal_read_clipboard` | `{}` → `string` | 读系统剪贴板文本（CF_UNICODETEXT），终端右键粘贴用：网页里的 `navigator.clipboard.readText` 在 WebView2 会弹权限框。非 Windows 报 `unsupported` |
| `terminal_write_clipboard` | `{ text }` → `null` | 写系统剪贴板文本（CF_UNICODETEXT，UTF-16 加结尾 NUL），终端 Ctrl+Shift+C 与右键复制用：网页里的 `navigator.clipboard.writeText` 在 WebView2 会静默失败。剪贴板被别的程序占着时重试 10 次后报 `io`；非 Windows 报 `unsupported` |
| `browser_create` | `{ url, bounds, channel }` → `browserId`（u32，自增） | 面板浏览器（5.10）：`url` 先过导航白名单（`browser_policy::parse_user_url`），再用 `Window::add_child` 在主窗口下建子 webview（标签 `nct-browser-<n>`，数据目录 `<应用本地数据>/browser`，开 devtools），先开 `about:blank`、挂好事件再导航；`bounds` 为 `{ x, y, width, height }`（逻辑像素），为 `null` 时建好即隐藏。页面事件经这个浏览器自己的 channel 推送 |
| `browser_navigate` | `{ id, url }` → `null` | 地址栏导航：同样过白名单，`javascript:` 等报 `browser_unsupported`、自定义协议报 `browser_external`、应用地址报 `browser_internal`；未知的浏览器报 `unknown_browser` |
| `browser_layout` | `{ id, bounds }` → `null` | 放到 `bounds` 并显示；`null` 隐藏，隐藏前焦点在网页里的把焦点还给主界面。同步命令，在主线程按收到的顺序执行 |
| `browser_action` | `{ id, action }` → `null` | `back` / `forward` / `reload` / `stop` / `devtools` / `focus`；其余报 `browser_failed` |
| `browser_capture` | `{ id }` → PNG 字节（`Response`） | WebView2 `CapturePreview` 截当前页面（浮层占位用，5.10）；3 秒没结果报 `browser_failed` |
| `browser_destroy` | `{ id }` → `null` | 关掉 webview；已关的也返回 `null`。前端页面重新加载、应用退出时外壳关掉全部浏览器 |

浏览器 channel 消息（serde tag `kind`）：`url { url }`（含网页内 pushState）、`title { title }`、`loading { loading }`、`history { back, forward }`、`favicon { png: number[] | null }`、`newWindow { url }`（`target=_blank` 与 `window.open`，外壳一律拒绝原生弹窗、转成这条）、`blocked { url, reason, message }`、`download { state: "started" | "finished" | "failed", name }`、`shortcut { key: "b" | "t" | "p" | "backquote" }`。

终端 channel 消息：`{ kind: "output"; data: string } | { kind: "exit"; code: number | null }`，output 按 UTF-8 边界切分，全部在 exit 之前发出，exit 每个终端只发一次。

`plain_workspace` 单独成命令而不并入 `backend_open`：前端归类「对话」需要这个路径且目录必须由外壳创建，而 `backend_open` 仍只接受已存在的目录——前端不能借它创建任意目录。

Channel 消息（serde tag `kind`）：

```ts
type BackendMessage =
  { kind: "line"; line: string } | { kind: "closed"; code: number | null; stderr: string[] };
```

`code` 是退出码，被强杀或拿不到时为 `null`；`stderr` 是该后台内存缓冲的全部内容（≤500 行）。监督线程（`try_wait` 约 50ms 轮询）在进程退出后等待 stdout 读线程排空（最多 2 秒，防孙进程继承管道卡住），保证**所有 line 消息都在 closed 之前发出**；closed 每个后台只发一次。stdout 切行上限 64 MiB/行，超过则记一行 stderr 并强杀后台（宁可显式失败也不悄悄丢报文让请求挂死）。

前端 `TauriLineTransport`（`src/transport.ts`）把这套命令实现成 `LineTransport`：`send` 经 promise 链串行保证顺序（写失败吞掉，断开会经 closed 体现）；注册 `onLine` 前到达的行被缓冲并按序交付；`closed` 在已交付完缓冲行后触发 `onClose`（只一次）；`exited` 暴露退出结果；`backend_open` 失败包装成带 `code` 的 `DesktopError`。`BackendPool`（`src/backends.ts`）管理唯一后台的连接：`ensure()` 在后台已在跑时直接返回同一个 client；真正启动时通过注入的取值函数读取当前生效的普通对话工作区（`prefs.plainWorkspace ?? defaultWorkspace`）作为 cwd，与触发启动的会话所属项目无关。并发 `ensure` 共享同一个握手 Promise，后台退出即清空条目并通知 UI。切换普通对话工作区不重启正在运行的后台，下次启动才使用新目录；会话自己的工作区仍由创建参数和恢复日志决定。握手失败（含后台 spawn 后秒退）的 `ensure` 会等 `exited` 拿到退出码与 stderr 尾部，把它们带进抛出的错误——否则横幅只看到「连接已断开」，后台为什么没起来无从排查。

**崩溃与恢复**：后台退出后 UI 显示「后台已退出（退出码 N）」横幅，附 `closed` 消息里 stderr 的末尾几行（可展开全部），操作是「重启后台」与「查看日志」（进入「后台日志」页）。单后台下退出影响的是全部已打开会话：`src/conversations.ts` 把它们都标为 `dead` 并各自保留 `SessionView` 与 `lastSeq`（当前会话保持选中，空闲清理跳过 dead 会话，直接打开 dead 会话也自动走恢复流程）。「重启后台」在同一个新后台里对每个 dead 会话依次 `resumeSession`（跨项目的会话由日志里的工作区元数据承接，Core 按它加载项目层与指令），并以 `afterSeq: lastSeq` 重新订阅，拿到退出期间落盘但没收到的持久事件；恢复失败的会话单独记录错误并保持 dead，不阻塞其余会话的恢复，之后重新打开时重试；其中错误码为 `invalid_model`（会话记录的模型已不在配置里）的会话同时写进 `openErrors`，横幅写「用的模型已不可用，点开它选一个模型继续」，点开即是 5.1 的「换模型」卡片，选好模型后带 `model` 恢复并按 `lastSeq` 续接。这张卡片也用于会话模型被停用（[ADR-0054](../decisions/ADR-0054-provider-model-toggle.md)）：错误里带 `disabled` 与模型引用时标题改为「这个会话用的模型已停用」，次按钮变成「重新启用 <服务商或模型>」（`setProviderEnabled` / `setModelsEnabled`），重新启用后已打开的会话直接回到对话；已打开会话的提交被同一原因拒绝时也走这张卡片（下一次提交前结束，当前 Turn 不打断）。

## 3. Node 查找与说明页

查找顺序（`src-tauri/src/node.rs`）：

1. 环境变量 `NOCTURNE_NODE`（非空即视为指定；文件不存在直接失败，后续步骤记 `skipped`）；
2. 资源目录 `<resource_dir>/node/node.exe`（非 Windows 为 `node`；发布安装包随附，开发构建经 `pnpm desktop:dev`/`desktop:build` 先跑 `scripts/fetch-node.mjs` 补齐；缺文件时记 `not-bundled`）；
3. `PATH` 逐目录找 `node.exe` / 可执行的 `node`。

找到后运行 `<node> --version`（5 秒超时，Windows 加 `CREATE_NO_WINDOW`；`.cmd`/`.bat` 脚本由 Rust std 自动经 cmd.exe 执行），取 stdout 第一行。版本解析接受可选 `v` 前缀、忽略 `-`/`+` 后缀，要求 ≥ 24.14.0（ADR-0046 第 2 节；与根及 CLI 的 `engines` `>=24.14` 一致）。

`NodeProbe` 结构（camelCase；步骤恒为 env/bundled/path 三项，`status` 为 kebab-case）：

```ts
type NodeSource = "env" | "bundled" | "path";
interface NodeProbeStep {
  source: NodeSource;
  status: "unset" | "not-bundled" | "missing" | "found" | "skipped";
  path: string | null;
}
interface NodeProbe {
  required: string; // "24.14.0"
  steps: NodeProbeStep[];
  selected: {
    source: NodeSource;
    path: string;
    version: string | null;
    error: string | null;
  } | null;
  ok: boolean;
}
```

探测不通过时前端显示说明页（`src/NodeHelp.tsx`）：逐项展示查找结果、要求版本与「打开 nodejs.org」「重新检测」按钮；重新检测通过后不重启应用直接进正常流程。

**随附 Node（ADR-0050）**：`scripts/node-version.json` 固定 Node 版本（24.x LTS，不低于 24.14）与官方 `node-v<ver>-win-x64.zip` 的 SHA-256；`scripts/fetch-node.mjs` 下载、校验哈希后只解出 `node.exe` 与 `LICENSE` 放进 `apps/desktop/src-tauri/resources/node/`（.gitignore 排除，不入库），`tauri.conf.json` 的 `bundle.resources` 把它们装进安装目录。校验失败直接中止，没有跳过选项。`backend_open` 成功后往该后台的 stderr 缓冲写一行 `[nocturne-desktop] Node <bundled|env|path>：<路径>（<版本>）`，「后台日志」页能看出 Node 的实际来源。

## 4. 后台脚本路径与单文件打包

- 环境变量 `NOCTURNE_DESKTOP_BACKEND` 非空则优先使用；
- debug 构建用 `<仓库>/apps/cli/dist/main.js`（`pnpm build` 的产物）；
- release 构建用 `<resource_dir>/nctrn.mjs`（随应用打包）。

文件不存在报 `backend_script_missing`，message 带路径并提示先 `pnpm build`。

`nctrn.mjs` 由 `scripts/bundle-nctrn.mjs` 生成（`pnpm build` 后用 `tsdown` 把 `apps/cli/src/main.ts` 打成单个 ESM 文件，输出到 `apps/desktop/src-tauri/resources/nctrn.mjs`，`.gitignore` 排除）：运行时依赖（workspace 包与 npm 依赖，含 `@nocturne/tui` 的动态 import 及其 Ink/React/yoga 链路）全部内联、不拆 chunk，`react-devtools-core` 可选依赖别名成空模块（仅 `DEV=true` 时 Ink 才探测它），`bufferutil`/`utf-8-validate` 经 `WS_NO_*` 环境变量禁用。产物自包含，复制到没有 `node_modules` 的目录可直接 `node nctrn.mjs` 运行。

一个 Windows 细节：Tauri 的 `resource_dir()` 经 `canonicalize` 返回 `\\?\` 前缀的 verbatim 路径，Node 不能正确处理 `\\?\X:\…` 形式的入口参数（解析时退化成 `lstat 'X:'` 直接 EISDIR 退出）。`AppState` 构造时统一用 `node::strip_verbatim_prefix` 剥掉前缀（`\\?\UNC\` → `\\`，`\\?\X:\` → `X:\`，无法安全还原的保持原样），后台脚本与随附 Node 查找都消费还原后的路径。

## 5. 会话树与界面状态

主窗口保留系统窗口标题「Nocturne」（任务栏与 Alt+Tab），但 `decorations: false` 隐藏原生标题栏。`src/WindowFrame.tsx` 自绘右侧顶部 32px 标题栏，左栏延伸到窗口顶部；空白区使用 `data-tauri-drag-region`，由 Tauri 的原生拖动和双击最大化处理。右端提供最小化、最大化/还原、关闭按钮；关闭悬停红底白字，其余悬停使用主题浅底。最大化状态随 WebView resize、focus 及按钮操作查询更新，不保存或自行计算还原尺寸，贴靠、还原与边框缩放交给系统。Windows 11 最大化按钮悬停贴靠布局菜单暂不提供。

标题栏左边界与布局共享 `--sidebar-width`：会话左栏为 236px，设置导航为 295px，设置区容器 <1000px 时为 200px。标题栏处在设置覆盖层之上，会话主区和设置主内容都从顶部 32px 以下开始；左栏的「← 返回 Esc」不被标题栏背景覆盖。标题栏始终在会话的 `inert` / `aria-hidden` 区域之外，打开设置后仍可拖动窗口、最小化、最大化/还原和关闭。

左栏结构从上到下（`src/session-tree.ts` 为纯函数，`src/Sidebar.tsx` 渲染）：「＋ 新会话」→「置顶」→「对话」→「项目」，底部只有「设置」一个入口（进入设置区的「常规」，见 5.5）。

- **空会话过滤**：`firstText` 缺省或 trim 后为空且未锁定的会话不显示（置顶、对话、项目都过滤）；被锁定的空会话照常显示为「未命名会话」。
- **对话**：普通对话工作区（默认 `<NOCTURNE_HOME>/workspace`，可在 设置 › 常规 更改）以及 `prefs.plainWorkspaces` 里记住的历任工作区的会话平铺列出（cwd 经 `projectKey` 归并比较），按 `mtimeMs` 降序，默认前 5 条 +「展开显示（还有 N 个）」/「收起」；已置顶的不重复出现，置顶的对话会话项目标签为「对话」。手动项目里路径等于这些工作区的也不显示为项目。还没拿到工作区路径时所有会话按项目处理。
- **项目**：项目 = 其余会话 `cwd` 的归并键 ∪ 手动添加的项目 − 隐藏项目。`projectKey(path)` 去末尾分隔符（根目录除外）；像 Windows 路径（`盘符:` 或含 `\`）则统一 `\` 并小写。显示用第一次见到的原始路径，项目名取末段。排序存 `projectSort`，「…」菜单的「排序」有三项：
  - 「手动」（默认）：按 `prefs.projectOrder` 的顺序排列。不在其中的项目（新出现的）排在最上面，多个新项目之间无会话的在前（后添加的在前），其余按各自最早会话的 `createdAt` 降序；每次列表变化后 App 把这些新键按显示顺序插到 `projectOrder` 前面并保存（`buildSessionTree` 是纯函数，只在结果里返回 `newProjectKeys`），之后它们固定在原位，有了新会话也不移动。位置只由用户调整：拖动项目标题行（HTML5 拖放，插入位置画一条主色指示线，落点按项目组上下半区计算；浏览器自带拖动阈值，单击标题仍是折叠/展开），或右键项目标题「上移」「下移」（首项置灰「上移」、末项置灰「下移」，供键盘与触控板使用）。调整按可见列表的位置换算回完整的 `projectOrder`：落在某个可见项之前就插到它在完整数组里的位置之前，落在末尾就插到最后一个可见项之后，隐藏项目的相对位置不变。
  - 「名称」：全部项目按名称排序。
  - 「最近活动」：有会话的项目按最新 `mtimeMs` 降序，其后是无会话的手动项目按添加顺序。
  - 拖动与「上移」「下移」只在「手动」模式可用；另外两种模式下标题不可拖、菜单里不显示这两项，也不会自动切回手动。项目内规则同对话区。「项目」标题行右侧的「…」（弹出菜单：排序、已移除的项目…）与「＋」（打开项目）在悬停时显示；项目行悬停显示的「＋」在该项目新建会话。「…」菜单的「已移除的项目…」列出隐藏的项目（显示名称、悬停见完整路径），点一项即从隐藏集合移除并恢复显示；隐藏不删除它在 `projectOrder` 里的位置，恢复后回到原位。
- **置顶**：按置顶数组顺序列出仍存在的会话，每条标出所属项目名（对话为「对话」）；置顶不受项目隐藏影响。右键会话行置顶/取消置顶，右键项目标题「从列表移除」（把项目路径加入隐藏集合，不删会话、不动手动项目列表，可在「…」菜单恢复）。
- **行内「…」菜单**（F-02）：会话行包在 `.irow` 容器里，右侧有悬停或键盘聚焦时才显示的「…」按钮（按钮是行的兄弟元素，不挡住标题文字与时间列），点击打开与右键同一菜单并锚定在按钮旁；项目组标题旁同样有「…」按钮。按钮可键盘聚焦，操作与右键完全一致。
- 会话行优先显示已打开会话视图的标题，否则为 `firstText ?? "未命名会话"`；meta 为相对时间（<60s「现在」<1h「N 分钟」<24h「N 小时」<48h「昨天」<30d「N 天」否则 `YYYY-MM-DD`，锁定加「🔒 」前缀）。运行中的会话显示主色圆点；等待权限确认或提问回复的会话显示「待确认」，切走后仍保持这个状态。
- **通知留痕**（[ADR-0056](../decisions/ADR-0056-session-notifications.md)）：本次运行里「没看到」的出错 / 已完成（`sessionMarkFor`，与通知开关、完成阈值无关），侧栏行显示红 / 绿圆点 + 「出错」/「已完成」标签（`--a-error` / `--a-success` 半透明底）；打开该会话（或窗口重新获焦）即撤掉它的系统通知并清除留痕；新 Turn 开始（实时 `turn.started`）也清掉旧留痕，运行中（`running`/`pending`）不显示旧标签。只在内存里，不持久化。

界面状态存 localStorage 键 `nocturne.desktop.prefs.v1`：`{ pinned: string[]; projects: string[]; hidden: string[]; projectSort: "manual" | "name" | "activity"; projectOrder?: string[]; lastEffort?: string; theme?: "light" | "dark"; plainWorkspace?: string; plainWorkspaces: string[]; todosCollapsed?: boolean }`（会话 id、原始路径、项目路径；`projectSort` 缺省 `"manual"`；`projectOrder` 是手动排序的项目归并键顺序，覆盖所有已知项目（含从会话 `cwd` 推出的），`projects` 仍只是手动添加的项目；对应不到项目的旧键留着无害，不清理；字段存在但类型不对按 `[]`。旧数据迁移：读到的 prefs 没有 `projectOrder` 字段视为旧数据（以前每次都写入 `projectSort: "activity"`，分不清是否用户所选），App 拿到会话列表后做一次：`"activity"` 改为 `"manual"`、`"name"` 保留，`projectOrder` 用升级前「最近活动」规则下的显示顺序初始化（隐藏项目也排进去），升级后第一次打开位置不变；有了 `projectOrder` 之后用户选的「最近活动」保留，不再迁移（`migrateLegacyProjectOrder`）；`lastEffort` 是上次选用的思考档位，作为新会话草稿的默认档位，非字符串字段被忽略；`theme` 缺省即跟随系统；`plainWorkspace` 是自选的普通对话工作区，缺省用外壳的默认路径；`todosCollapsed` 缺省展开，仅折叠时存 `true`，全局一份；`plainWorkspaces` 缺省 `[]`，记住用过的工作区路径；各字段逐个校验，类型不对的回退默认，缺新字段的旧数据照常读取；旧数据里的 `lastProject` 字段忽略）。读写失败均不影响本次运行，写失败时 `persistent` 标为 false（`src/prefs.ts`）。

启动流程：`node_probe` → 不 ok 显示说明页；ok 后 `plain_workspace` 取默认普通对话工作区（`prefs.plainWorkspace` 优先）→ `ensure` 开常驻后台（握手）→ `listSessions()`。`plain_workspace` 或 `ensure` 失败显示真实错误与「重试」；后台退出则显示崩溃横幅，「重启后台」重开后台并恢复全部已打开会话（见第 2 节崩溃与恢复）。「打开项目…」（「项目」标题行的「＋」）走系统文件夹对话框 → 加入手动项目、取消隐藏、刷新列表，不启动后台；项目原先不在列表里或处于隐藏状态时把它的键移到 `projectOrder` 最前面（排在最上面），已经可见的不移动。列表在连上后、打开项目后、窗口重新获得焦点时（节流 ≥ 2 秒）刷新。

未选中会话时主区显示 hero 空状态（`src/App.tsx` `DraftPane`）：月亮标记 + 标题 + 同一个输入框（宽度上限 680）。普通对话标题为「有什么可以帮你？」；项目草稿为「要在 <项目名> 里做什么？」——项目名是可点按钮（虚线下划线），点击打开与输入框托盘目录 chip 同一个目录菜单。目录菜单内容：「普通对话」（副标题「不属于任何项目」）/ 分隔线 /「项目」组逐项目（名称 + 小字路径）/ 分隔线 /「打开其他文件夹…」。

### 5.1 会话打开、创建与关闭

`src/conversations.ts` 管理打开的会话与订阅。**切换立即生效（ADR-0051）**：点击会话先切换选中项，主区显示「正在打开…」占位（`openingId`），再在常驻后台 `resumeSession`、通过 `trackSessionView` 订阅并回放历史；连续快速点击时以 `openToken` 与串行打开队列保证只采用最后一次点击的结果——先发出的请求晚返回时，若该会话已不再选中则按空闲路径关闭、不覆盖界面。打开失败不解释退回上个会话：错误按会话存进 `openErrors`（消息、工作区、RPC 错误的 `data.code` 与本次携带的替代模型），主区在该会话的占位区按错误码显示，不匹配文案；打开失败的会话也不会被发送路径误当草稿新建。一般错误显示「打开会话失败」、原始信息与「重试」。遇到 `session_locked` 先显示「正在别处使用」，只有用户选择「强制打开」后才以 `force: true` 重试（带着替代模型时一并带上，锁的判定不变）。

**换模型**：错误码为 `invalid_model`（会话记录的模型所属服务商已删除或改名）时，占位区换成 `src/ModelRecoveryCard.tsx` 的卡片，不给「重试」：标题「这个会话用的模型已不可用」，一句说明原模型已不可用（或已停用）、选一个继续、之前的记录不变；Core 原始信息以次要样式列在下方。模型清单用 `listModels` / `listRecentModels` / `defaultModel`（`listModels` 与 `defaultModel` 带会话工作区 `workspaceRoot`），分组复用状态栏模型菜单的 `modelGroups` + `ChoiceMenu`（最近使用在前，其余按服务商分组，`unavailable` 的模型置灰并悬停说明原因）；默认选中上次尝试的替代模型，其次当前生效的默认模型，再次第一个可用模型。主按钮「用这个模型继续」经 `open(id, workspace, force, model)` 以 `resumeSession(id, { model })` 重新打开，Core 先写 `session.config_changed { model }` 再开放（[sessions.md](../architecture/sessions.md) 第 4 节），以后再打开不会再进这张卡片；次按钮「去配置服务商」进入 设置 › 服务商，配置变化后卡片重新拉清单。清单为空时只有「去配置服务商」。换模型后仍失败（替代模型同样不可用等）留在卡片上并显示新的错误。

「＋ 新会话」、项目行「＋」和空状态目录菜单只进入草稿；第一条普通消息发送时才 `createSession`，不创建空会话。草稿里显式选过的字段（模型、思考档位、权限预设）写进 `createSession({ cwd, workspaceRoot, model, reasoningEffort?, permissionPreset? })`——`cwd`/`workspaceRoot` 始终带上草稿所选目录（ADR-0051 会话级工作区），模型总会带上（默认取最近使用或 `defaultModel`），未触碰的档位/预设省略，由 Core 解析项目级默认。发送采用接受语义：`session.submit` 返回即视为已接受（持久用户事件随后才到），Turn 视图出现新条目或新 Turn 也算接受；`submit` 在接受前拒绝（如附件校验失败）则抛错，输入框保留草稿与全部附件。接受后才设置选中会话并清掉草稿工作区；被拒的刚创建会话走正常 `closeIfIdle` 路径关闭。切换时关闭空闲的旧会话及订阅；运行中、等待权限确认或提问回复的旧会话保留打开，结束后若不再选中则关闭。空闲会话只关闭会话本身（`session.close` 释放锁），常驻后台不随会话释放。主区始终只有当前会话的一条消息流和一组请求卡片；`Conversation` 与 `Composer` 使用带组件前缀的不同 React key，切换会话时分别重建，不能共用同一个会话 id 作为同级 key。

### 5.2 消息、输入与交互请求

`src/Conversation.tsx` 按共享 `SessionView` 渲染用户消息、助手 Markdown、可折叠思考、工具调用和文件 diff、警告与通知，不另写事件折叠。用户消息是右对齐气泡，悬停显示「复制」「编辑并重发」「重发」三个操作（U-01，见 ADR-0041 修订）：「复制」随时可用，复制消息原文；另两个只在空闲时可用，忙时置灰并提示「请先等待或按 Esc 中断」。「编辑并重发」把消息变成原位编辑框，框内列出将撤回的回复轮数与将还原的文件（取自 `rewindTargets()`），提供「对话和文件」（默认）与「仅对话」两个选项（无可还原文件时不显示）；「重发」直接用原文。两者都在发送时先 `rewind(targetSeq, mode)` 回到这条消息之前，再经 `Conversations.resubmit` 走已有的串行提交路径重发；编辑期间旧回复变暗，发送成功后才移除；回退失败时保留编辑内容并显示错误。重发只取消息文本，不复用附件、`@文件` 快照与技能/委派快照。分叉新会话暂不进桌面端；只还原文件仅通过本轮更改卡片的「撤销」提供，`/rewind`、`/fork` 在桌面端仍提示后续版本提供。`@路径` 渲染成等宽 chip（title 来自匹配的 fileRef 元数据：「已附带 N/M 行」「目录」「已附带文件 · 已截断」）；助手行无标签无边线；助手 Markdown 段落内的单个换行按聊天惯例显示为换行（marked 开启 `breaks`，CommonMark 软换行不再折叠成空格；文件引用收集与渲染共用同一组解析选项），代码块、表格、列表结构、空行分段与行尾两空格的硬换行不变；助手回答里的行内代码形如 `路径` 或 `路径:行[-行]` 时，按工作区解析存在性（U-09，`splitCodeRef` 剥行号 + `session.resolveFiles` 批量只读）：存在的文件渲染成「文件/目录图标 + 路径」的链接（不再用行内代码底色）。工作区内：左键按「打开文件用」直接打开——缺省「Nocturne 面板」，在右侧面板开只读文件标签并定位、高亮所引行（HTML 也按源码显示，见 [5.10](#510-右侧面板adr-0060)）；选 VS Code / Cursor 时编辑器带行号，选中的编辑器未检测到时退回系统默认；目录始终交给系统打开。右键开菜单：「打开」（同左键，说明里写「Nocturne 面板」或程序名与行号，面板不另占一项）、「资源管理器」、检测到的编辑器逐个一行（VS Code、Cursor，目录不列）、「复制绝对路径」「复制相对路径」（相对路径来自 `resolveFiles` 的 `relativePath`）。工作区外存在的文件：「打开文件用」是 Nocturne 面板时左键在面板开只读文件标签（标签显示所在目录名），菜单多一项「打开」；是 VS Code / Cursor 时左键交给编辑器；是系统默认时左右键都只开菜单（「资源管理器」「复制绝对路径」，以及检测到的编辑器），避免点到可执行文件。网络路径（`\\server\share`）不做链接化，Core 的 `resolveFiles` 也不去访问它，见 [rpc.md](../protocols/rpc.md)。不存在的保持普通行内代码。流式实时回复不做链接化（引用不完整），落盘历史消息才解析；「打开文件用」在设置 › 常规（Nocturne 面板（缺省）/系统默认/VS Code/Cursor，编辑器只列检测到已安装的，存本机 prefs；旧版本存下的选择做一次迁移，见 5.10）。「系统默认」经外壳命令 `open_with_default`：脚本与可执行类型（PATHEXT 加 `.ps1`、`.py`、`.lnk`、`.msi`、`.reg` 等固定清单，按原路径和真实路径各判一次）不打开，改为在资源管理器中显示。思考默认折叠为一行（「思考中 Ns」/「思考了 Ns」/「思考」，时长由 `src/reasoning.ts` 从流式事件累计），点开展开全文（规则见下文「长思考」）。所有工具行默认收起为一行、都带折叠箭头，点击行才展开；展开或收起由用户决定，不随运行状态变化或重新渲染重置（工具 key 和文件路径 key 保持稳定）。一般工具行显示「图标字母 + 动作 + 参数 + 范围 + 简短结果」，cwd 内路径相对化（Windows 风格忽略大小写）。MCP 名称保持 `server/tool`，优先取 mcp 主体 target，实时行从注册名解析；参数显示第一个非空字符串，不重复名字。运行中有 `liveOutput` 时，行中淡色截断显示最后一个非空输出行，行尾显示转圈与已运行秒数（前端首次渲染 running 时记本地起点，不改协议）；不再另起默认展开的实时输出框。点击展开后，展开内容缩进在图标列下方，行头本身不加框、不移动：带文件 diff 的工具显示带框的 diff 区域；有 command 字符串输入的工具以同一块展示完整命令（淡色 $ 前缀）、虚线与输出，实时输出粘底跟随；其他工具显示结果原文，工作区内路径相对化。主体下方一行淡色元信息只放已有的退出码、显式 cwd、替换数、安全审查（原因放 title）与实际路径变化或 detail；不重复权限主体框。行尾「▶ 详情」默认收起，展开后按顶层键列出参数与结果，嵌套值使用缩进 JSON，两组都为空则不显示按钮。图片说明与截断提示移到下方淡色小字，行尾结果与耗时不变。结果带文件 diff 的工具（只按结果形状判断，`fileDiffs` 非空）收起时就是普通工具行、没有边框：参数位是文件名加淡色目录，行尾 +N（绿）−M（红），计数来自 `diffCounts`，没有删除时只写 +N，没有 diff 的文件（如纯改名）行尾留空；多文件结果（`output.files[]`，如 apply_patch）每个文件各占一行、结构相同、各自展开；展开后行下方是带框的 diff 正文，其下是元信息与「▶ 详情」。颜色使用 `--a-success` / `--a-error`，适配深浅主题。被拒绝的工具仍是一行红色说明，权限确认保持警告样式；提问卡片的交互见下文。

**会话区提示**：`view.notices`（`runtime.warning` / `runtime.error`）渲染在消息流最后，按 level 分 `role="status"` / `role="alert"`，悬停显示 code。MCP 连接状态类警告不在消息流渲染：`mcp_server_failed`、`mcp_server_crashed`、`mcp_secret_missing`、`mcp_env_missing`（常量 `MCP_STATE_NOTICE_CODES`，`src/mcp-status.ts`）。原因是它们描述服务器当前的运行状态而不是对话内容，而 `notices` 只增不减，放进消息流会在整个会话里一直挂着；这类状态改由状态栏的「MCP 未连接」标记表达（5.4）。`mcp_tool_conflict`、`mcp_tools_changed`、`mcp_tools_refresh_failed` 等其他提示照常显示。TUI 与 CLI 仍按原样输出这些警告。

**工具行三个阶段同一结构**：接收参数、执行中、完成都由 `ToolRow` 渲染同一个行头 `ToolLine`（▶ 箭头 · 图标 · 名称 · 参数位 · 可选范围/实时输出预览 · 行尾状态），行高、字号、左边距、箭头与图标位置不变，只有行尾依次是「接收参数中」、转圈与秒数、结果文案（带文件 diff 的为 +N −M）。实时工具行（`view.live.tools`）把 `inputText` 整体 `JSON.parse` 成功的结果合成只含 name/input 的 `ToolEntry` 交给同一组件，参数位经 `toolArgument` 整理（路径为文件名 + 淡色目录）；解析失败时参数位是空占位，半截 JSON 不上屏也不进 title；箭头占位但禁用（淡色、不可点）。实时行与正式条目在消息流同一个子数组里、共用 key `t:<callId>` 与同一组件树：reducer 在同一次归约里移除实时行并追加条目，没有重叠帧（渲染时仍按条目 key 去重），React 只移动节点、不卸载重挂；第一行的 `details` key 固定，展开选择一路保留。

**任务清单**：成功的工具行用 `todoItemsFromCompletion` 取这次快照，显示「✓ 任务清单 N/M · 正在：第一项进行中正文」与细进度条；全部完成用成功色，空快照显示「清空任务清单」。展开列全部项，不显示参数 JSON、元信息或详情；失败仍按普通工具。`src/TodoList.tsx` 共用标记与进度条：完成 ✓（正文淡色删除线）、进行中 ◐（主色、正文加粗）、待办 ○（淡色），长文本续行对齐正文。会话 Composer 在输入卡片上方常驻展示 `SessionView.todos`，草稿不显示、空清单不渲染；全部完成后下一条持久用户消息按共享视图规则归档。面板左右缩进 14px、上圆角、底边接输入框，最多十行高度且不超过主区 40%，内部滚动。底部开关条始终紧邻输入框（键盘可达的 button，带 aria-expanded），清单向上展开，箭头转 −90°；默认展开，折叠状态存 prefs 的 `todosCollapsed`。

桌面端折叠箭头统一使用同一字符 `▶`，展开向下旋转 90°、向上旋转 −90°，保留 0.15 秒短过渡；原生 details 隐藏浏览器三角，改用同样字符与 CSS 旋转。下拉菜单触发按钮沿用原有的 ▾ 指示符，不属于折叠箭头。

思考时长不足 1 秒时，无论进行中还是已结束都只显示「思考」。

**长思考**（desktop-v4.html F/G 屏）：思考块的标题行是按钮（`aria-expanded`），展开后标题为「思考 · N 秒 ▶」（超过一分钟写「M 分 S 秒」，进行中写「思考中 · …」），并吸附在消息滚动区顶部（`position: sticky`），读到块中间也能一键收起；整块滚出视野后标题随之离开，不会盖住后面的消息。思考正文高于一屏（滚动区可视高度）时，正文末尾再给一个「▶ 收起思考」按钮，不到一屏只用标题行。收起由消息流决定怎么滚（`ThinkScrollContext`）：处于跟随最新时同步滚到底部，跟随保持开启（在滚动事件之前定好位置，块变矮引起的回滚不会被当成用户上翻）；未跟随时若标题行已在视野上方，把它滚回滚动区顶部，读者停在刚收起的位置。diff 正文剥离每行自带的第一个 `+`、`-` 或空格，仅在标记列显示符号，保留正文自己的符号与缩进，`@@` 不进入正文。压缩回执直接显示 notice 的 `message`（修剪为「已省略较早的工具输出」，摘要为「上下文已压缩为摘要」，文案只在 Core 维护），不展示压缩模式、seq 或 payload。

增删 diff 行与标题计数使用独立的样式类；增删正文均使用默认文字颜色和相同字号，行号、标记与正文对齐，仅背景和标记列区分增删。结束回执不展示英文原因标识，中断显示「已中断」。「回到最新消息」位于消息滚动区下方的独立操作行，不覆盖正文。

失败工具行尾直接显示错误摘要，不再另起错误框：`not_read`（「需先读取文件」）、`stale_file`（无 diff 时「文件已变化，需重新读取」，`modelContent` 含以 `@@ -` 开头的 hunk 行时「文件已变化，已附上变更」）属于可恢复的守卫错误（`Conversation.tsx` 的 `RECOVERABLE_TOOL_ERRORS`，按 `error.code` 判断），用中性淡色（`tool-res recoverable`，复用次要文字颜色），不用 `--a-error`、不显示「失败」字样，展开区照常显示完整原文；超时行尾按 `error.code` 与 `output.timeoutMs` 显示「超时（N 秒）」（不解析中文文案），展开区显示 `modelContent` 中实际输出的最后 40 行，不重复摘要句；其他错误（命令失败、权限拒绝等）仍以红色（`tool-res err`）显示，取 Core message 第一句（不把扩展名或小数中的句点当句末），工作区内路径相对化，不显示错误码。点击工具行后在展开区显示完整原文，避免重复展示 modelContent。

用户气泡里的图片附件经 `AttachmentImageSource`（`src/attachment-images.ts`）按 sha256 缓存为 blob URL；发送成功登记原始字节，缓存未命中时仅在气泡进入可视区后调用 `session.readAttachment`。缩略图保持比例，最大 160px，沿用输入框预览的圆角、边框与底色。加载中显示占位，读取或显示失败时退回文件名 chip，title 给出失败原因；工具结果中的图片仍只显示 chip，不加载缩略图。

`src/Composer.tsx` 是空状态与会话共用的输入框（`variant: "draft" | "session"`）：Enter 发送，Shift+Enter 换行；`isComposing`、composition 状态或旧输入法 `keyCode=229` 时不发送。输入历史经 `readInputHistory` / `recordInputHistory`；运行中发送键变成 ■ 与 Esc 一样调用 `interrupt`。两种布局：draft 是卡片 + 托盘（`.cbox`/`.tray`：附件缩略图行、textarea、工具行「＋ + 模型 chip + 档位 chip + 发送键」、托盘「目录 chip + 权限预设 chip + 输入提示」，托盘负 margin 塞在卡片底边之下、卡片压在上层）；session 使用同样的卡片外观，卡片内为两层，上层文字区、下层工具行，工具行左侧为「＋」、右侧为发送键（运行中为 ■ 中断键），无 tray、无模型或档位 chip，这些设置由会话状态栏负责。textarea 自动长高到 ~40vh/280px 后内部滚动；redirect/vision 提示显示在卡片上方气泡，错误在下方。菜单统一走 `src/Menu.tsx`（`role="menu"`，打开即聚焦第一项、有选中项时聚焦选中项，↑↓/Home/End/Enter/Esc，外部点击关闭，焦点回触发键）；展开方向：渲染后量高度，下方放得下就向下（`top = anchor.bottom + 6`），放不下向上，两侧都放不下取较大一侧并限高滚动；项标题不换行、detail 单行省略号（悬停见全文），菜单宽 250–420px，滚动条与消息流一致（细、无箭头）。

空状态与会话内的占位文字相同，为「输入消息，@ 引用文件」，不提示斜杠命令。

- 模型 chip（仅空状态）：「最近使用」（`listRecentModels` ∩ `listModels`，按 recents 顺序）+ 其余按服务商分组（U-06，会话内与空状态共用 `modelGroups`，见 5.4）；不可用的模型带原因置灰。会话内切换在状态栏 pill（同一 ChoiceControl 数据与 Menu）。
- 档位 chip（仅空状态）：当前模型可用档位（会话来自 `reasoningEffortInfo`，草稿来自 `ModelInfo.capabilities.reasoningEffort`）；current≠effective 时提示「本 Turn 使用 X；Y 将在下一 Turn 生效」。选择写入 `prefs.lastEffort`。
- 预设 chip（仅空状态托盘）：`PERMISSION_PRESET_NAMES`；草稿里未触碰不计入选项。
- 运行中模型控件锁定（title「当前 Turn 结束后可切换」），思考档位、权限预设、Shell 仍可切（菜单内注明何时生效，见 5.4）。
- 「＋」菜单：「添加图片…」（系统对话框 `pick_images`）与「引用文件…」（在光标处插入 `@` 并打开文件弹层）；`fileRefs` 为 null 时「引用文件…」置灰并给出原因。
- 图片附件三条路径：对话框、粘贴（剪贴板 image/* 文件）、拖入（`dragDropEnabled: false` 让 HTML5 drop 拿到 File 对象；非图片报「只能拖入图片」，不支持的类型报「不支持的图片类型（支持 PNG、JPEG、GIF、WebP）」）。缩略图 `<img>` + 文件名 + ✕（`aria-label`「移除 <名>」），object URL 随移除/卸载回收。附件存在且有 `getVisionHint` 时拉一次提示（如「当前模型不支持图片，将由 <模型> 描述后发送」）。发送载荷 `{ data: Uint8Array, mimeType, label }`，提交被拒时附件与草稿一并保留。
- `@` 引用：文件索引懒加载（`fileRefs.load()`，`key` 变化才重取；会话内 `key` 用 `view.turnCount`）。弹层按 `src/file-refs.ts` 的排序（文件名前缀 > 文件名包含 > 路径包含，同级短路径优先），Tab/Enter 选择插入 `@路径 `（含空格路径写成 `@"a b.txt" `；目录不带尾随空格、弹层继续展开列下一级）。光标紧跟在一个完整 `@路径` 引用后面时 Backspace 一次删掉整个引用（含至多一个尾随分隔空格），光标在引用前面时 Delete 同理（U-05，`fileRefDeleteRange` 与补全共用同一套词法：行首或空白起、以 `@` 开头，引号形式须有收尾引号，无引号形式须被空白终止；有选区或输入法组合输入中保持默认行为）。纯文本里输入的 `@` 引用经 textarea 底下的镜像层高亮（`parseFileRefs` 区间上色，发送的仍是纯文本）。草稿/普通对话没有项目文件索引：`fileRefs` 为 null，输入 `@` 不弹层，菜单项 title 给出原因（`fileRefsUnavailable`）；空状态下项目文件搜索等 runtime 级 `fileIndex` 能力，见文末限制说明。

权限请求显示在消息流底部；仅调用 `respondPermission` / `respondQuestion` 回传选择，权限判定仍在 Core。权限卡片按钮严格按 Core 给出的 `options` 顺序渲染（`allow_once 允许一次`、`allow_session 本会话允许`、`allow_project 本项目允许`、`deny 拒绝`、`deny_stop 拒绝并停止`），不自行增删选项；标题是「需要确认 · <操作>」（操作来自首个 subject kind：shell 执行命令 / edit 修改文件 / read 读取文件 / network 访问网络 / mcp 调用 MCP 工具 / subagent 启动子任务），右侧短理由来自审查结论（「审查器交给你确认」「审查器建议拒绝」「审查器认为可以执行」，无审查为「按权限规则需要确认」），原始 reason 放 title。subject 逐行等宽显示（shell 前缀「<shell kind> ›」，路径按 `displayPath` 相对化）。键盘：卡片挂载即获得焦点，数字键 1–N 直选第 N 项（焦点在可编辑字段时数字键不触发）；Esc 立即拒绝（capture 阶段拦截并 preventDefault，焦点在输入框时也生效且不触发输入框的中断）——只有当目标在卡片内部（反馈 textarea 自己处理 Esc 退回选项）或输入框的补全/菜单弹层开着时让位。提问显示在输入框位置，同宽 820px 居中；Composer 只隐藏不卸载，草稿、附件和输入历史位置保留，回答成功后恢复。中性提问面板一次一题，顶部页签可回看，已答显示 ✓、逐题拒绝显示 —。选项是带序号的整行按钮，数字键选择（输入中不触发），单选约 200ms 后进入下一题；多选与自由文本用「下一题」，Enter 等同下一题/提交。末题在全部已答或已拒绝前禁用提交。「其他…」点击后就地展开单行输入，单选与普通选项互斥，多选可并存；自由文本限 2000 字符。底栏「拒绝回答」只清空并拒绝当前题，可撤销。label 末尾「（推荐）」显示为强调色「推荐」标签，回复仍带原始 label。发送中禁用整卡并显示进度，失败保留答案与错误。对话中按 pendingQuestion.callId 匹配的工具行显示强调色圆点与「等待你回答」，不转圈、不计秒；完成后恢复原有结果显示。

工具实时输出区域使用 `useStickyOutput` 粘底跟随：更新前距底部不超过 24px 时继续滚底，上翻离开底部后保留位置，滚回底部附近恢复跟随；展开时滚到底部。Shell 与外部 agent 等工具共用此区域。消息主滚动区保留独立的「回到最新消息」与长思考收起定位逻辑。

每轮结束后（包括中断），最后一段非空助手文字下方、回复操作栏之前显示本轮文件更改卡片（`src/TurnChangesCard.tsx`）；没有助手文字时放在本轮最后条目之后。标题行两行：加粗「已编辑 N 个文件」，下面等宽小字合计「+X −Y」（任一文件 approximate 时前面加「约」；与文件行一样，没有删除时只写 +X，不写 −0）；整卡不再折叠。文件列表默认只显示前 3 个，每行目录淡色 + 文件名，右侧 +a −r（没有删除时只写 +a，unavailable 右侧留空）；超过 3 个时列表下方一行「▶ 再显示 K 个文件」，展开后变「收起」、箭头转 −90° 朝上（按钮在展开内容下方），这个展开状态只在组件内、不持久化，切走再回来回到 3 个。「新建」「已删除」用淡色小字留在行上；「已在外部修改」与不可用原因不在行上，原因放进行 title，点开该行显示原因原文一行（代替 diff）。其余文件行默认收起，展开才请求 diff，正文复用现有 DiffBody。未追踪调用在列表下用淡色小字说明（「这一轮有 N 次 shell 调用，它们造成的改动不在统计里」）。没有可统计的文件时不渲染卡片外框、标题、合计、撤销与列表，只在原位置显示这行 shell 说明（已撤销的轮也一样）；连 shell 调用也没有则什么都不显示。已撤销的轮标题行右侧显示「已撤销 · …」，列表同样只露 3 个。生成中当前轮不显示。

数据来自 `session.turnChanges()`：Conversations 在打开会话回放完成、实时 turn.completed（含中断）和回退成功后查询，按 seq 存在会话状态，不在生成中查询；失败隐藏卡片、只写控制台诊断。文件差异来自 turnChangeDiff，按 `(seq, path)` 缓存，刷新后计数或不可用状态变化清缓存。接口与轮次规则见 [sessions.md「每轮文件改动」](../architecture/sessions.md#每轮文件改动)。

只有有效对话最后一轮、尚未 reverted 且有 `restorable` 文件时提供「↶ 撤销」（`TurnChangeFile.restorable`，口径同 rewind 的 `action !== "untracked"`，不按不可用文案判断）；忙时与编辑重发一样置灰。点击在卡片内读取 rewindTargets 的对应轮并列出还原/删除/无法还原、外部覆盖警告与未追踪调用；默认焦点「取消」，Esc 取消，说明对话保留。确认经 `Conversations.rewindFiles` 与重发共用串行回退锁和 busy 边界，执行 `rewind(seq, "files")`，不提交新消息、不新增权限判定。失败保留确认区与错误原文；成功刷新后标题及合计变淡划线、标题行右侧显示还原/删除/失败结果，现有回退通知保留，不重复通知。不做重做或逐文件撤销。

每轮结束后（包括中断），最后一段非空助手文字下方常显回复操作栏：「复制回复」只复制本轮最后一段助手文字的 Markdown 原文（entry.text），不包含工具调用之间的过程性文字、思考和工具调用；时间使用该段 `AssistantEntry.time`，本地当天显示 `HH:mm`，更早显示 `YYYY-MM-DD`。生成中的当前轮不显示操作栏。代码块无论是否有语言标签，顶部右侧均提供复制按钮，复制代码原文（流式也可用）。用户消息、回复操作栏与代码块共用剪贴板逻辑，成功短暂显示「已复制」，不可用或失败给出提示；按钮沿用用户悬停操作的颜色与样式。

### 5.3 桌面斜杠命令

命令表独立维护在 `src/commands.ts`，不导入 TUI。界面上已有对应操作的旧命令不再作为命令：输入它们只在输入框上方显示「去哪里操作」的提示（`role="status"`），Enter 不发送也不执行；未知 `/xxx` 提示「未知命令 /xxx；输入 / 查看可用命令」。

| 命令       | 行为                                                           |
| ---------- | -------------------------------------------------------------- |
| `/compact` | `session.compact()` 压缩当前上下文；无会话时报「请先打开会话」 |
| `/mcp`     | 查看本会话 MCP 状态（对话框输出）                              |

| 已移除命令                            | 提示的界面操作                                          |
| ------------------------------------- | ------------------------------------------------------- |
| `/model` `/effort` `/preset` `/shell` | 会话内指向底部状态栏对应 pill；空状态指向输入框卡片/托盘对应控件（Shell 提示在会话内切换） |
| `/context`                            | 底部状态栏的上下文用量（空状态提示会话内可用）            |
| `/new` `/clear`                       | 左栏「＋ 新会话」                                       |
| `/resume`                             | 在左栏选择要继续的会话                                  |
| `/help`                               | 输入 `/` 查看可用命令；其余按场景指向控件位置           |
| `/provider`                           | 在 设置 › 服务商 管理；状态栏模型菜单的「管理服务商…」也能进入 |
| `/settings`                           | 点左栏底部「设置」打开 设置 › 常规                      |
| `/theme`                              | 在 设置 › 外观 切换主题                                 |
| `/rewind` `/fork`                     | 后续版本提供                                            |
| `/exit` `/quit`                       | 关闭窗口即可退出                                        |

输入 `/` 显示分组补全弹层（`role="listbox"`）：「命令」组只含 `/compact`、`/mcp`；技能组（id `"skills"`）跟在命令组之后，显示名字、argument-hint 和截断说明，过滤停用、覆盖、user-invocable false 与命令冲突；外部 agent 组（id `"external"`）排在技能之后，只显示已启用且没有名称冲突的条目；空组不渲染。内置命令优先于技能，技能优先于外部 agent，名称冲突不区分大小写。发送技能走 submit.skill，用户消息带可展开的正文快照标签，模型调用显示「技能 <名字> 已加载」。

输入 `/<agent 名> 任务` 后走 `submit.delegate: { agent, task }`，保留配置中的 agent 名称与任务文本；草稿与已有会话共用此载荷路径。没有任务时只显示用法，不提交。委派仍经父模型调用 `task` 工具，入口权限照常询问，不把斜杠点名视为提前授权；历史用户消息不再显示委派折叠块：正文开头的 `/<agent>`（不区分大小写）渲染成行内标记（沿用 `@文件` chip 的视觉语言、独立类名 `.delegate-ref`，title 为「委派给外部 agent <名称>」）；正文不以它开头时（旧数据或其他客户端）在正文前补同样的标记。复制、编辑并重发仍用含 `/<agent>` 的原文。重名 agent 在设置列表和详情显示警告，不能斜杠点名，但模型仍可调用。

### 5.4 状态栏与上下文

**远程标识**：有远程 RPC 连接时显示「手机在线」，多台设备显示数量（按设备 id 去重）。点击展开当前手机列表，每台可立即「断开」，底部「打开远程设置」。没有连接不显示；已登记且被吊销或替换时显示警示，点击进入远程页。

`src/StatusBar.tsx` 左侧是会话控件 pill 组：模型（绿点 +「provider · model」+ ▶）、「思考 <level> ▶」、「权限 <preset> ▶」（预设值用警告色）、「Shell <kind> ▶」。模型与 Shell 打开与空状态 chip 共用的 `ChoiceMenu`（`src/Menu.tsx`，锚定 pill 自动向上弹出），模型菜单为「最近使用」+ 按服务商分组（组名用服务商显示名、组序与服务商页一致，搜索跨组过滤；会话内与空状态共用 `modelGroups`），底部有「管理服务商…」，进入 设置 › 服务商；思考档位与权限预设用自绘下拉 `Dropdown`（见 5.6），选项带中文名与一句说明；数据来自 `useSessionControls`（模型/档位/预设复用 `controls.controls`，Shell 是 `shellControl`：`auto`（「自动选择」）+ 探测到的 shell，未安装的置灰并标注「未安装」，被 env/config 覆盖时菜单底部给提示；打开 Shell 菜单时调 `loadShells()` 探测）。选择分别调 `setModel` / `setReasoningEffort`（并写 `prefs.lastEffort`）/ `setPermissionPreset` / `setShell`；手机远程改模型、档位或预设后，Core 广播 `session.config_changed`，状态栏随之刷新。Turn 进行中模型 pill 锁定（title「当前 Turn 结束后可切换」），思考档位、权限预设、Shell 仍可切换：档位菜单注明「下一个 Turn 生效」，预设菜单注明「从下一次权限判定起按新预设」（等待确认的请求仍由用户决定，切换不替它放行），Shell 菜单注明「下一次命令生效」。右侧不变：上下文用量（点击开上下文面板）、累计缓存命中（`sessionUsageSoFar`，含进行中 Turn 已完成的步骤，每步结束即更新，见 [view.md §8](../protocols/view.md#8-api)；服务商未返回缓存数据时显示「—」）、生成速度、Turn 状态。

**生成速度**（`src/speed.ts`，口径见 [ADR-0053 修订 2026-10-11](../decisions/ADR-0053-usage-and-cost.md)）：缓存之后、Turn 状态之前一段。流式期间显示 `~N tok/s`，用 `estimateTokens(正文 + 推理)` 除以客户端从首个增量起的用时，最多每秒刷新一次，前面有一个强调色脉动点（减少动态效果时不动）；这一步的 `message.assistant` 到达后改为 `usage.outputTokens ÷ (durationMs − ttftMs)`，缺 usage 或 timing 时退回客户端测得的用时（无 usage 时仍带 `~`）。生成用时不足 0.5 秒时不显示。只追踪本次打开后亲眼看到流式增量的步骤：历史消息没有到达时间，所以切换或恢复会话后、打开时已在流式的那一步结束前都不显示，直到下一次生成。悬停或聚焦弹出 `role="tooltip"`：结束后列输出、其中推理、TTFT、生成用时、请求总耗时（缺的项不列；时长小于 10 秒保留一位小数），底部一行「上一步 · 速度 = 输出 ÷ 生成用时」；流式期间只写「估算中」与已用时长。Esc 关闭。

**MCP 未连接标记**：`view.mcpServers`（[view.md §4](../protocols/view.md#4-临时事件归约)）里有 `failed` 或 `crashed` 的服务器时，右侧在上下文用量之前出现「MCP 未连接 N」（警告色小圆点 + 弱化文字，与其他条目同样式，不做横幅）。悬停或键盘聚焦时弹出 `role="tooltip"`，按名称列出每台服务器的名称、状态（启动失败 / 连接断开）与错误原因；点击进入 设置 › MCP。服务器恢复为 `ready`，或被移除、停用（`mcp.server` 为 `stopped`）后，计数随之减少，归零时标记消失。

状态栏始终一行：右侧上下文与 Turn 状态固定不缩，左侧仅模型 pill 可收缩，过长名称省略号截断，悬停显示完整「provider · model」（运行中同时提示不可切换）。主区变窄时按容器宽度依次让位：≤980px 隐藏生成速度 → ≤900px 隐藏累计缓存命中 → ≤820px 隐藏上下文进度条 → ≤740px 隐藏 Shell 项 → ≤660px 隐藏模型名前的「provider · 」前缀；≤700px 另外收紧间距。模型名最后才省略，至少保留约 10 个字符（`min-width: 10ch`），上下文数值与 Turn 状态始终保留；窗口最小宽度仍为 760px（主区宽度还要减去左栏）。

上下文面板取 `describeContext`，展示总量与预算、分段堆叠条和数值；对话历史从 `history.breakdown` 细分用户消息、助手回答、工具调用与结果、压缩摘要，不从可见消息重新估算。来源文本按 `contextSourceLabel` 中文化（「内置提示词」「自定义提示词」「N 个工具」「N 项」「N 条」，路径按主目录缩写）。底部提示「可以输入 /compact 压缩」。

上下文面板只在尚无数据时显示「正在读取…」。已有数据的后台刷新保留旧内容，成功后直接替换；失败时保留旧内容，在标题行以警告图标与悬停说明提示原因，不额外插入提示行。`aria-busy` 表达刷新状态，不参与布局。

已知限制（等 RPC 能力）：空状态的项目文件搜索需要 runtime 级 `fileIndex`（`fileIndex` 目前是 session 级，前端已用 `Composer.fileRefs` 作为数据接缝，届时只换数据源）。

### 5.5 设置区

「子代理」之后的「远程」页（`src/RemotePage.tsx`）只使用本机 `remote.*` RPC，未登记只读取 `remote.describe` 缓存，显示索取邀请/自建中继说明、邀请输入和登记按钮，不联网。已登记显示中继域名、状态、允许远程访问开关、设备在线与最近在线时间、推送订阅、断开/移除和退出登记；后两项必须在页内确认。状态变化通过 `remote.statusChanged` 更新。

「配对新手机」需要在线，弹出二维码、截止倒计时和可复制链接；`remote.paired` 显示设备名后自动关闭，失败显示中文原因，关闭或离开页面取消配对。`qrcode-generator@2.0.4` 以 M 纠错生成矩阵，React 渲染一个 SVG path，四模块留白，深浅主题均为浅底深码，不使用 innerHTML。固定信任说明指出中继看不到加密内容，但必须信任管理员不会篡改手机网页。存储与精确契约见 [rpc.md 第 11 节](../protocols/rpc.md#11-远程主机)。

左栏底部「设置」进入设置区：左栏整列换成设置导航（「← 返回 Esc」、「设置」标题、常规 / 模型 / 服务商 / MCP / 技能 / 子代理 / 外观 / 用量 / 后台日志九项、底部一行说明），会话树不显示；主区换成对应页面。空状态与状态栏的模型菜单底部「管理服务商…」直接进入「服务商」。设置区以 `.settings-over` 盖在主区之上，原来的会话或空状态（`.mainpane`）保持挂载并设为 `inert`，所以「← 返回」或 Esc 回到的是同一个会话，滚动位置不变；在导航项之间切换不算返回。Esc 只在没有被下拉、对话框先处理时才返回（下拉的 Esc 会 `preventDefault` 并停止冒泡；设置区里有打开的对话框时不返回）。被盖住的会话的窗口级快捷键（权限卡片的 Esc 拒绝与数字键作答、输入框的 Esc 中断）在其所在区域 `inert` 时一律不响应。服务商页与常规 / 模型 / 外观页都走常驻后台读写全局配置（不带 `workspaceRoot`，即后台启动目录的项目层参与合并）；会话控件（状态栏 pill、会话内查询）则带该会话的工作区——`listModels` / `defaultModel` / `describeSettings` / `describeSkills` / `describeExternalAgents` 等运行时查询都接受可选 `workspaceRoot`（rpc.md 3.1）。

设置布局按容器宽度调整，不使用窗口媒体查询：整个设置区宽度 <1000px 时导航从 295px 收到 200px，会话左栏不变；设置主内容 <900px 时服务商列表从 252px 收到 200px，名称与右侧模型数各自单行省略。详情标题与不收缩的状态标签一行，操作按钮另起一行横排并允许换行。详情内容 <520px 时信息卡改两列，<320px 时改一列，值允许折行。模型表名称列至少 12ch，<520px 先隐藏最大输出，<400px 再隐藏上下文；名称和能力始终保留，长模型名折行，无横向滚动。页尾说明为「R 推理 · I 图片输入。默认模型在「模型」页修改。」，其中「模型」可进入模型页。

**配置同步（ADR-0051 后单后台）**：只有一个后台，不再存在跨后台 `reloadConfig` 协调与「由我发起」计数。`provider.*` / `skills.*` / `agents.*` 的写方法由服务端串行执行「变更 → 重载 → 推 `runtime.providersChanged`」，页面、状态栏模型菜单与空状态模型 chip 收到通知后各自重新查询；`updateSettings` / `setDefaultModel` / `setModelRole` 只写设置层、不推通知，页面用返回值直接刷新。

#### 用量

「外观」与「后台日志」之间的「用量」页（`src/UsagePage.tsx`、`usage.css`）只读调用 `runtime.usageStats`：7 天 / 30 天 / 全部（默认 30 天），进入、切换范围或刷新时请求，不轮询；加载保留上次内容，失败显示错误与重试，迟到的旧范围响应不覆盖新范围。

概览五格：累计 tokens、预估费用、缓存命中率、会话 / Turn、最长 Turn。近一年热力图固定 365 天，最后一列结束于本地今天，月份标签按真实日期对应列定位；按 tokens / 费用着色，范围外日期淡化，悬停或键盘聚焦显示日期、tokens、约费用与 Turn 数，点击固定在下方；使用强调色五档，不用绿色。下方为 Token 构成与费用、常用工具与技能、可按费用或输入排序的模型表，共 11 列：模型 / 服务商、Turns、输入、输出、缓存命中、预估费用、Tokens/s、TTFT、近期速度、输入单价、输出单价（价格来源与分档标记写在模型名下）。

**分类色**（`src/UsageCharts.tsx`）：每个主题有五个分类色变量 `--a-cat1..5`，按范围内 tokens（输入 + 输出）取前 5 个模型依次着色，其余模型统一用灰色并在图例里叫「其他」；颜色与表格排序切换无关，模型表名称前有同色色块。

**每日用量**：只在「7 天」范围显示，位于常用工具与技能之后、模型表之前。标题「每日用量」，右侧「X tokens · 活跃 N 天」，下方图例。7 根柱，最后一根是本地今天，每根是满高轨道里按模型堆叠的柱，高度按 7 天中最大值归一；柱下为数值（万 / 亿，空日写「0」，空日只有轨道）与 `M/D` 日期，不写星期。悬停或聚焦弹出提示：「2026年10月6日」、「N 次请求 · X tokens」，再按 tokens 从多到少列出模型；空日写「这一天没有用量」。数据来自 `DailyUsageStats.requests` / `models`。

**可展开的模型行**：行首有 ▶ 指示，`aria-expanded`，点击或聚焦后按 Enter / 空格切换；默认收起，可同时展开多行，切换范围时保留展开状态（按 provider/model 记）。表格在预估费用之后新增三列：Tokens/s（一位小数）、TTFT（平均首字时间）、近期速度（最近 24 个有 Tokens/s 的性能桶的小折线，末端一个点）；没有带计时的请求时显示「—」。展开区左栏三组指标：效率（缓存命中率、缓存节省）、延迟（平均耗时、平均 TTFT、Tokens/s，下注「基于 N 次请求」，没有计时时写「没有带计时的请求」）、Tokens（未缓存输入、缓存读、缓存写、输出），其下一行小字是完整单价「单价 输入 $x · 缓存读 $x / 写 $x · 输出 $x（USD / 每百万 token）」，缺失的写「—」，分档模型显示基础档并注明「· 分档」——缓存单价只在这里出现；最后一行「首次使用 … · 最近使用 …」用相对时间，悬停 title 为绝对时间。错误率不显示（重试事件不落盘，见 [usage.md](../architecture/usage.md)）。右栏是 SVG 双轴折线图：左轴 Tokens/s（强调色实线 + 淡填充），右轴 TTFT（中性色虚线，秒）；标题与 x 轴标签随 `performanceGranularity`：按小时「每个活跃小时的性能」、标签 `10/9 14时`，按日「每个活跃日的性能」、标签 `10/9`，按周「每周的性能」、标签为周一的 `M/D`，提示写「2026-09-14 至 2026-09-20」。图区用 ResizeObserver 量出实际像素宽度作 viewBox 的宽，高度固定 220px，所以坐标轴数字（11px，与图例同级）、线宽与点半径都按屏幕像素，不随容器缩放；卡片顶部对齐，不随左栏拉高。两条纵轴各四等分：数据最大值留 10% 余量后除以 4 得原始步长，取不小于它的 1 / 2 / 2.5 / 5 × 10ⁿ 中最小者，最大值 = 步长 × 4（例如 304 tok/s → 0 / 100 / 200 / 300 / 400，TTFT 6.1s → 0 / 2 / 4 / 6 / 8s）；Tokens/s 轴刻度必为整数（步长小于 10 时不用 2.5），TTFT 轴以秒为单位、步长小于 1 秒时同样不用 2.5，标签去掉多余小数（`2s`、`0.5s`）。x 轴约 6 个标签，图区窄时每个标签至少留 96px；超过 40 个点不画圆点，只有 1 个点时只画点不连线，点在横向正中、x 轴只有这一个标签；每个桶有可聚焦的命中区，悬停或聚焦显示该桶时间、Tokens/s、TTFT 与请求数。没有点时写「这个范围内没有带计时的请求（旧版本记录不含计时）」。时长小于 10 秒保留一位小数（`3.0s`），否则取整。展开区按内容区可视宽度贴左（表格横向滚动时不被裁切），容器 ≤760px 时两栏改为上下排列。不用绿 / 红表示好坏，不用 canvas。未计价费用与单价显示「—」，只提示在配置文件模型条目里写 pricing，不链接到模型对话框。

tokens 用万 / 亿并去掉小数末尾的零（880 万、11.5 万），费用大于等于 $100 取整，否则两位小数；数字等宽、tabular-nums。窄内容区概览与排名换行，热力图与模型表横向滚动；样式只用现有主题变量，深浅主题共用。模型表下方一行写「按声明价格估算，以服务商账单为准」，页脚只在有被跳过的日志时出现。统计主文档见 [usage.md](../architecture/usage.md)。

#### 服务商

服务商页（`src/ProvidersPage.tsx`）在设置区内有自己的两列：

- **列表**：左列分「已配置」（`describeProviders`）与「可添加」（`listProviderPresets`，已按默认名配置过的预设不再列出，自定义类预设始终可添加）。行内显示状态点、显示名（条目声明了 `displayName` 时用显示名，否则 id）、「N 个模型」；当前会话正在用的服务商标「当前」（没有选中会话时取 `defaultModel` 的服务商，即新会话将用的那个），进入页面时默认选中它，凭据失效的行尾写「已失效」并标黄。停用的服务商（`ProviderOverview.enabled === false`）用空心状态点、名字变淡并标「已停用」；有模型被逐个停用时模型数写「已启用 N / 总数」。
- **详情**：标题行最左是本服务商的启用开关（`role="switch"`，位置与 MCP 页一致，`setProviderEnabled`），随后是操作按钮 + 信息卡（类型、地址、认证、凭据、保存位置、来源）+ 模型表。停用时信息卡上方出现「已停用」横幅和「重新启用」。按钮组只看 `ProviderOverview.authKind`，不按预设名或文案推断：`apiKey` 有「换密钥」（`setCredential`，password 输入，保存后清空），`none` 且为向导条目时显示为「设置密钥」；`account` 有「退出登录」（`logoutProvider`，只删本机凭据，确认对话框说明），失效时信息卡上方出现「账号登录已失效」横幅和「重新登录」，登录等待卡片内联在详情里；向导条目另有「刷新模型列表」（`refreshUpstreamLimits`）与「删除」（`removeSetupProvider`）。自定义条目（providers.json 里 id 不与内置预设相同的条目）另有「编辑」：打开与添加表单同款的编辑对话框，`describeSetupProvider` 预填显示名、服务地址、协议、自定义请求头与会话标识请求头；服务商 ID 锁定、凭据不进表单（仍走「换密钥」）。地址或协议变化时必须先「获取模型」（`probeSetupProviderModels` 按候选配置探测，不写配置），结果提示模型数与当前在用模型是否仍在清单里；探测失败允许「仍然保存」（不带新清单，条目保留原模型列表）。保存经 `updateSetupProvider` 整条替换（规则见 [provider-setup.md](../architecture/provider-setup.md) 第 6 节）。打开的会话在用该服务商时删除按钮置灰，悬停说明「当前会话正在使用，不能删除」；服务端返回 `provider_in_use` 时同样置灰。来自其他配置层（config.json、项目配置）的条目只读：没有换密钥、删除置灰并说明。删除是否允许以服务端为准。账号的访问令牌过期但刷新令牌还在时显示「有效」（Core 规则，[provider-setup.md](../architecture/provider-setup.md) 第 6 节）。
- **模型表**：可搜索；第一列是逐个模型的启用开关（`setModelsEnabled`，服务商停用时保留状态但不可点），列为名称、能力（R 推理、I 图片输入）、上下文（千分位）、最大输出（K），带「默认」「已编辑」「已停用」标记；表头右侧「全部启用」「全部停用」批量作用于当前列出的模型，有搜索词时改为「启用筛选结果」「停用筛选结果」并只作用于筛出的模型；表头计数在有模型被逐个停用时写「已启用 N / 总数」，服务商停用时写「服务商已停用 · 逐个设置保留 N / 总数」（N 由 `ModelInfo.disabled === "model"` 之外的模型数得出，开关状态即由此还原）；悬停行显示「设置」，打开模型设置对话框。
- **启停与确认**（[ADR-0054](../decisions/ADR-0054-provider-model-toggle.md)）：停用前先问 `describeToggleImpact`，受影响的打开会话数、默认模型、模型角色非空时弹页内确认（列出这些影响，确认后才写设置），没人使用时直接切换；重新启用不确认。开关状态只读 Core 字段：`ProviderOverview.enabled` / `enabledModelCount` 与 `ModelInfo.disabled`（`"provider" | "model"`），客户端不自行判断停用；模型清单用 `runtime.listModels({ includeDisabled: true })`——服务商页是唯一使用它的地方，其余模型列表默认滤除停用模型（设置页只用它给「已停用」的值加删除线）。停用写入 settings.json，配置与凭据保留，重新启用即恢复。
- **模型设置对话框**（`src/ModelSettingsDialog.tsx`）：显示名、上下文、最大输出、图片输入、推理、思考档位、协议、编辑工具八项，每项写来源（上游、推导、默认、已编辑等）；「全部恢复跟随」清掉全部用户值。改动只在「保存」时经 `saveModelSettings` 写入 providers.json 的 userModels，「取消」不写。推理选「否」时思考档位置灰。
- **添加服务商**：选「可添加」里的预设进入表单，字段由 `describeProviderSetup` 驱动（固定值只读显示；凭据方式按 apiKey / 环境变量 / 账号登录 / 外部文件，OpenRouter 可选浏览器登录或粘贴密钥）。「获取模型」调 `prepareProvider` 拿到草稿，之后「保存」才可点（`commitProvider`）；获取前保存置灰，获取后改任何字段都作废结果、释放草稿并重新置灰。获取期间可「取消获取」：前端立即回到可编辑，输入保留，晚到的响应若带回草稿立即 `discardProvider` 释放。结果区显示「已获取 N 个模型」与 notices，并按 `PrepareProviderResult.models` 预览：折叠时列前 4 个模型名和「等 N 个」，「展开全部 ▶」后是限高、内部滚动的表格（名称、能力、上下文、最大输出），「收起 ▶」还原，每次重新获取都回到折叠。失败写「获取失败」与原因；`-32005` 带 `data.field` 时错误只显示在对应字段下，结果区不再重复「获取失败」——与已有服务商重名也以 `field: "name"` 报告（[provider-setup.md](../architecture/provider-setup.md) 第 2 节「名称唯一性」）。`needsManualModel` 时出现「模型 ID」输入框。「取消」、切走或离开页面都会 `discardProvider` 释放草稿，进行中的草稿登录经 `login.cancel` 取消（RPC 层把 Core 的 `discardDraftLogin` 映射为 `login.cancel`）。
- **登录**：`login.start` / `login.startDraft` 后用外链白名单打开系统浏览器；等待卡片（`src/LoginWaitCard.tsx`）有复制链接、重新打开浏览器、取消、倒计时（以 `LoginStarted.expiresAt` 为准，仅展示），可展开「粘贴回调地址 / 粘贴授权码」走 `login.submitManual`。`login.completed` 带 `unstoredKey` 时密钥只在卡片里显示这一次，前端不存储、不打日志。
- **同步**：服务商变更后后台推 `runtime.providersChanged`，页面、状态栏模型菜单与空状态模型 chip 随之刷新（单后台，无跨后台传播）。

#### 技能

「MCP」之后的「技能」页（`src/SkillsPage.tsx`）复用 MCP 列表与详情样式，按用户和当前设置工作区项目分组。每次挂载重新扫描；标题下展示模型目录 token 预算、完整/名字/停用数量与未知模型兜底依据。详情包含只读覆盖开关、忽略字段原因表、覆盖/缺说明/命令冲突横幅、完整真实路径及其他入口、四格信息、说明截断标记、字段 chips、正文前 40 行和支持文件，解析失败汇总可展开文件路径与行号。

启停保存到 settings.json，提示已打开会话在本轮结束后更新，空闲会话立即生效。技能变更经服务端推送的 `runtime.providersChanged` 通知刷新（单后台）；正在对话的输入框取 session.describeSkills 快照，新会话草稿取运行时查询（带草稿工作区）。技能正文标签可展开日志快照，skill 工具使用普通工具行。

外壳 `open_skill_directory({ path, create })` 打开绝对目录，create 只允许 `<NOCTURNE_HOME>/skills`，使用既有 opener；目录错误返回中文说明。空态提供创建并打开该目录及 agentskills.io 规范链接。页眉的「导入技能…」打开导入对话框（U-08）：目标二选一（用户技能默认，当前工作区只在选中工作区时可选）→ 系统文件夹对话框选来源 → `skills.importSkills` 预检列出候选（大小、符号链接跳过数、缺说明、目标同名冲突三选一改名/覆盖/跳过，他层同名只提示不拦截）→ 执行 → 结果页逐项展示并给成功项「停用」按钮。技能行为主文档见 [skills.md](../architecture/skills.md)。

#### MCP

「服务商」后的「MCP」页（`src/McpPage.tsx`）复用列表、详情和 Dropdown。按程序管理与 config.json 只读分组，HTTP 标示标签；详情标题行包含来源小标签、启用拨动开关、分隔线与操作按钮。只读详情显示来源路径、置灰开关，保留测试连接。信息卡首行完整显示等宽命令或地址，允许任意字符折行，下面四格为最近测试、服务器、工作目录（HTTP 为传输）、超时。空态提供添加和 JSON 导入。测试结果仅保存在本次页面内存，不落盘；失败按错误码给出具体说明，401/403 显示「认证失败，请检查请求头」。

添加和编辑可切换 STDIO / 流式 HTTP，保留名称和超时；编辑名称以灰底淡色文字显示锁定态。环境变量与请求头共用值表，可选明文、环境变量引用或凭据库，下拉每项带一行说明；密钥形名称默认 stored，已保存值只显示状态并提供替换、清除，后端不可用时禁用 stored 并在说明行写原因。测试连接使用未保存草稿，失败也可保存，字段错误显示于输入框下方。导入在前端解析三种 JSON 形状，推断 HTTP，跳过 SSE 和混写条目，提示 OAuth 不支持，并逐台进入确认表单。

保存、删除和开关在服务端走配置写队列，写完后重载配置并更新已打开会话；MCP 变更自身不发 providersChanged，页面以响应回执刷新本页数据；请求失败时显示错误并同样重新拉取一次列表，因为磁盘上的配置可能已经改了。toast 说明空闲会话立即生效、运行中的会话在当前 Turn 完成后生效。接口见 [rpc.md](../protocols/rpc.md) 第 3.5 节，生命周期见 [mcp.md](../architecture/mcp.md)。

#### 外部 agent

外部 agent 现在是「技能」之后的「子代理」页里的一个分组（页面仍是 `src/ExternalAgentsPage.tsx`，左列另有内置档位分组，见 [subagent.md 第 19 节](../architecture/subagent.md#19-子代理档位)）。外部 agent 分组沿用 MCP 的列表/详情/内联表单布局。列表按 `external-agents.json` 程序管理与 `config.json` 只读分组；详情显示来源路径、命令、模式、字符串环境变量、会话配置项、启用开关和最近一次测试的时间/耗时/结果。手写配置只能查看和测试，不能在程序里编辑、删除或启停；项目级外部 agent 不读取，查询警告原样展示。

添加表单可填入本地预设 `omp --mode acp` 与 `npx @agentclientprotocol/codex-acp`，默认停用，不强制 approval 参数、模式或配置项。名称创建后锁定；命令、逐行参数、说明、可选模式、环境变量 JSON 和 `configOptions` JSON 均可编辑。环境变量只接受字符串字面值或 `${NAME}` 引用，不用 Nocturne 的凭据库。保存失败保留草稿，测试失败仍允许保存。删除需确认，只删除程序维护配置，不卸载外部工具或删除它的账号。

测试既支持已保存名称，也支持未保存草稿；只做 PATH 解析（Windows 上命令直接写 `npx` 即可，规则见 [subagent.md](../architecture/subagent.md)）、初始化和临时 ACP 新建会话，从不发送 prompt、不消耗对方额度。探测返回的登录方式不是未登录判据；登录在外部工具自己的界面完成。成功后把 agent 返回的每项 config option 显示为可搜索下拉（高度上限 420px），700 项值同样可按名称或 id 搜索、用键盘选择；每个选项下方显示对方给的说明，没有说明时显示值本身，用来区分同名选项（如多个服务商的「Grok 4.7」），对方分组时以分组名作标签；配置项 id 与名称只差大小写时不重复显示 id。未手动指定的配置沿用 agent 默认值并显示当前默认值，已指定时显示所选值，也可恢复默认或用 JSON 填写不透明 id/value。测试结果保存在本次应用运行的内存里（切换设置页不丢失，不落盘）；保存表单时，若命令、参数和环境变量与测试时一致则保留结果（探测不发送 configOptions，改配置项不影响结果），否则清除。

费用提示固定写明「费用与额度计在该 agent 自己的账号上」。保存、删除和启停的 RPC 在响应前推一次 `runtime.providersChanged`，页面据此重新查询（单后台，无跨后台传播）。会话输入框取 `session.describeExternalAgents` 的 Turn 快照，新会话草稿取 Runtime 当前列表（带草稿工作区）；空闲会话立即更新，运行中的会话在本轮结束后更新。执行期权限、审计和外部文件不参与检查点回退的边界见 [ADR-0049](../decisions/ADR-0049-external-agent-subagent.md)。

### 5.6 常规、模型与外观页

`src/SettingsPage.tsx` 按导航项渲染三页，页头是标题与一句说明。按 [ADR-0045](../decisions/ADR-0045-fullscreen-page-shell.md) 第 7 节逐项保存，每行右侧写来源层：

| 页 | 分组 | 项 | 保存方式 |
| --- | --- | --- | --- |
| 常规 | 权限 | 默认权限预设 | 下拉（`Dropdown`），首项「跟随默认」标出当前生效值；改完立即 `updateSettings`，提示「已保存 默认权限预设 = X」 |
| 常规 | 权限 | 安全审查 | 对话框：关闭 / Jev / 小模型；Jev 首次启用先显示数据外发说明（偏好 `jevDisclosureAccepted`），沿用其他服务商的凭据时用下拉选服务商，单独密钥用 password 输入、经 `reviewerKey` 提交、保存后清空；设置行副标题为「smart 下除只读命令外的操作先交给它判断」。对话框另有两个多行输入框「额外交人」「额外放行」（各带一行示例占位，单段最多 1000 字），随审查器配置一起保存为 `permission.reviewerRules`（两段都清空保存为 `null`）。「样例检查」的**测试**按钮用**已保存**的审查器配置逐条跑内置样例（一条一次 `testReviewerSample`，说明 / 期望 / 实际 / 用时逐行显示，不一致的行标红，末行「命中率 x/y（z%）」），运行中按钮变为「取消测试」（停止后续样例并丢弃在途结果，显示已取消和已有命中率），审查器关闭或未配置时按钮不可用；`shell allow *` 这类显式规则会绕过审查，只在 [config.md](../architecture/config.md) 说明，界面不据此猜测。TUI 本次不提供测试按钮和追加规则编辑（[tui.md](tui.md)） |
| 常规 | 执行 | Shell | 可选下拉（ChoiceMenu，触发器沿用 Dropdown 外观），打开时 runtime.listShells；自动项后分隔线、列全部种类，未检测到的置灰并说明原因；runtime.setShellSetting 返回值刷新整页，失败行下显示原文且值不变。被 env/user/project 覆盖时只读并写明来源；所有会话下一次调用起生效 |
| 常规 | 执行 | 压缩阈值 | 对话框，百分比或 token 数，留空恢复默认 |
| 常规 | 普通对话 | 工作区 | 「更改…」选目录、「恢复默认」；只写 prefs |
| 常规 | 更新 | 自动检查更新 | 拨动开关（`mcp-switch`），只写 `prefs.autoUpdate`（缺省开；显式关才存 `false`） |
| 常规 | 通知 | 总开关 / 提醒哪些事 / 完成阈值 / 提示音 / 测试通知 | 「常规」页末尾新开一节（[ADR-0056](../decisions/ADR-0056-session-notifications.md)）：总开关（`notifications.enabled`，带「已开启/已关闭」文字）关闭时下面各项变灰禁用；三个事件复选（`notifications.events.attention/error/done`）同处一行共用来源列；完成阈值下拉（`notifications.doneAfterSeconds`：30 秒 / 1 分钟 / 3 分钟 / 5 分钟 / 10 分钟，保存值不在档位里时单列一项「N 秒」并保留，「完成」未勾选时整行变灰）；提示音开关（`notifications.sound`，只管桌面端 toast）；「发送测试通知」走同一个 `notify_show` 发一条「这是一条测试通知」，外壳报告 `disabled` 时在按钮旁显示「Windows 已关闭 Nocturne 的通知，请到 系统 › 通知 打开」。逐项 `updateSettings`，失败值回到原样并在行下写红字 |
| 模型 | 默认 | 默认模型与档位 | 对话框，`setDefaultModel` 成对保存；所选模型没有档位时传 null |
| 模型 | 模型角色 | 子代理模型 / 看图模型 / 轻量模型 | 对话框选择模型或清除；看图模型只列支持图片输入的模型。页尾链接「服务商 › 模型表」进入服务商页改单个模型的设置 |
| 外观 | 主题 | 跟随系统 / 月之亮面（浅色） / 月之暗面（深色） | 三张预览卡片（`role="radio"`），主标签下用小字标注浅色/深色，只写 prefs（取值仍是 `system`/`light`/`dark`），立即生效 |

模型页的已选值先显示模型名与档位（如 `deepseek-v4.1-flash · high`），服务商放次行并在 title 中保留完整值；默认模型或模型角色指向已停用的模型时（[ADR-0054](../decisions/ADR-0054-provider-model-toggle.md)）该值加删除线，下方用警告色写「已停用，按未设置处理」（默认模型补「新会话需要先选模型」），设置值本身保留、重新启用后立即恢复；选择对话框的模型清单默认不列停用模型。模型名可折行，服务商单行省略。设置主内容 <700px 时模型行的值移到第二行，占满可用宽度，来源仍保留在标题右侧。

保存失败时值回到原样，该行描红并写「保存失败：原因，已恢复原值」；保存的值被更高层覆盖时来源写「已被覆盖 · 层名」并标黄。设置写方法返回更新后的 `SettingItem[]`，页面以返回值刷新（5.5 上文的配置同步）。

主题写 `document.documentElement.dataset.theme`，跟随系统时删掉该属性回到 `prefers-color-scheme`。更改普通对话工作区只写 `prefs.plainWorkspace` 并把新旧路径记进 `prefs.plainWorkspaces`，旧位置的对话仍归「对话」区；单后台不随工作区切换重启（ADR-0051）——若后台尚未启动则以新工作区为 cwd 启动，新会话按所选目录传 `cwd`/`workspaceRoot`。

**下拉**（`src/Dropdown.tsx`，desktop-v4.html A 屏）：设置页的下拉与状态栏的思考档位、权限预设菜单共用这一个组件，不用原生 `select`。触发器是 `role="combobox"`（`aria-haspopup="listbox"`、`aria-expanded`、打开时 `aria-controls` 指向 `role="listbox"`），焦点始终留在触发器，当前项用 `aria-activedescendant` 指示，选项是 `role="option"`（`aria-selected`，不可选的 `aria-disabled` 并悬停说明原因）。键盘：Tab 聚焦；Enter / 空格 / ↓ 打开；↑↓ 移动并跳过不可选项，Home / End 到首尾；Enter / 空格选择并关闭；Esc 关闭、焦点留在触发器且不冒泡给外层；Tab 关闭。点外部关闭。列表 `position: fixed`，优先向下，下方放不下且上方更宽裕时向上（状态栏在底部），放不下时限高滚动，最小宽 300px。每个选项是「名称 + 中文名 + 一行说明」，危险项（`bypass`）排在分隔线之后并用警告色。权限预设与思考档位的中文名和说明只在 `src/choice-info.ts` 维护一份。输入框卡片与托盘里的 chip 菜单仍用 `ChoiceMenu`。

可搜索下拉始终设置可用空间与 420px 中较小的高度上限；列表自身或其内部选项滚动不重新定位，页面或触发器祖先容器滚动时重新跟随触发器，仍保留限高。`Menu` 不监听 scroll，没有此类滚动后移除限高的问题。

已知限制：RPC 请求不能真正中止，「取消获取」只在前端丢弃结果。

### 5.7 后台日志页

「后台日志」（`src/BackendLogsPage.tsx`）查看运行中后台的 stderr：页头只有标题，缓冲边界以第 1 节为准；一个后台选择器（`Dropdown`，单后台下只有「后台」——当前后台的启动目录，无后台时不出现——与固定的「外壳」两项，外壳条目读外壳自身诊断日志）、等宽字体日志区、「刷新」与「复制全部」按钮（`backend_stderr` 只在打开页面或点「刷新」时调用，不轮询；选中「外壳」改走 `shell_log` 命令；「复制全部」把当前显示的缓冲整体写进剪贴板）。「外壳」条目（伪 backendId `-1`）始终存在，所以即使没有任何运行中的后台页面也不为空。所选后台缓冲为空时写「该后台暂无 stderr 输出；已退出后台的最后几行日志显示在崩溃横幅里」（外壳为「外壳暂无诊断输出」；退出后缓冲已回收，只有 `closed` 消息保留了尾部，见第 1 节日志边界）。读取失败显示错误与重试。

### 5.8 自动更新（ADR-0050）

`src/updater.ts` 的更新服务封装 `DesktopHost` 上的 `appVersion` / `checkUpdate` / `relaunch` / `note`（测试里用假宿主替换，`tauri-host.ts` 里落到 `@tauri-apps/plugin-updater` 与 `plugin-process`）。行为：

- **检查时机**：启动进入就绪页后自动检查一次；之后由 `prefs.lastUpdateCheck` 节流，24 小时内最多一次。`prefs.autoUpdate` 显式 `false` 时自动检查完全不跑。手动「检查更新」同样计入节流但不等 24 小时。
- **失败降级**：自动检查失败（网络不可达、签名/端点错误）只写外壳日志（`app_note`），不出任何 UI；手动检查失败把原因写在设置行内。界面上的失败原因统一经 `describeUpdateError` 映射成中文（签名相关 →「签名校验失败，已取消安装」，网络/下载 →「下载失败，请检查网络后重试」，其他 →「更新失败：」加原始信息），原始英文信息只写外壳日志。
- **提示**：发现新版本把 `{ version, notes }` 存进 `prefs.pendingUpdate`，并在窗口底部出提示条（`.updbar`，盖过设置层但不打断输入）：版本号 + 发布说明首行 + 「立即更新」「稍后」。「稍后」只清本次运行的提示状态，`pendingUpdate` 保留，下次启动若仍比当前版本新会继续提示；不比当前版本新时 `pendingUpdate` 被丢弃。
- **确认与安装**：点「立即更新」时若还有非空闲会话（运行中或等待确认），先弹「将中断 N 个正在运行的会话」确认框；没有则直接下载。安装前再调一次 `checkUpdate` 拿 `Update` 句柄（存的 `pendingUpdate` 没有安装入口），期间提示条显示下载进度；下载/签名校验失败把原因留在提示条并恢复 `pendingUpdate`。Windows 下安装器在 `downloadAndInstall` 期间接管并退出进程（被动安装），随后由更新流程自动重启；其他平台装完调 `process` 插件 `relaunch`。
- **更新器配置**：`tauri.conf.json` 开 `bundle.createUpdaterArtifacts`，`plugins.updater` 配 `pubkey`（minisign 公钥）、`endpoints` 指向 GitHub Release 的 `latest.json`、Windows `installMode: "passive"`。签名私钥只经 `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` 环境变量在构建期注入（见 [workflow.md](../development/workflow.md) 第 8 节）。

### 5.9 会话通知（ADR-0056）

同一个系统通知判定通过的分支也经 `notify.ts` 调用 `remote.push`：仅已登记、开启、在线且没有远程连接时发送。无载荷推送不含会话信息；失败静默记诊断（后台日志页的外壳条目），不新增后台通知判定规则。

判定全在客户端（`src/notify.ts` 纯函数 `decideNotification`，不碰 DOM、不调外壳）：输入事件、会话标题、Turn 开始时间、是否在看、生效设置，输出「不提醒」或 `{ title, body, kind }`。只对本次运行实时到达的事件判定——`Conversations` 以「订阅起始时间」定时间边界：订阅响应返回前后到达的持久事件按 `event.time` 与订阅起始区分，起始时刻及之后（含同 ms，`>=`）是回放窗口期内新产生的 `permission.requested`/`turn.completed`（`live=true`），之前的是旧回放（`live=false`）；恢复补写的 `turn.completed`（`recovered:true`）时间也是新的，按 `live=true` 透出，另由 `recovered` 在 `decideNotification`/`sessionMarkFor` 挡掉（不提醒不留痕）；易失事件（`runtime.status`/`question.requested`）从不回放，订阅期间到达即实时（`time` 缺失或非法按回放处理，不误报）——重放、打开历史会话读到的旧事件不提醒。桌面端「在看」= 窗口有焦点（`focus`/`blur` 维护，初始 `document.hasFocus()`）且设置区没盖住（`page === null`）且该会话是当前显示的会话；设置页获焦不算在看。新 `turn.started`（实时）清掉该会话旧留痕，`Sidebar` 运行中（`running`/`pending`）也不显示旧标签。权限操作文字（`operationForSubjectKind`）权限卡片与通知真的共用同一函数。三类事件：需要确认（`permission.requested`/`question.requested`，含子代理经父会话 `task` 工具冒泡的请求，天然按父会话判断、标题用父会话名）、出错停止（`turn.completed` 且 `reason === "error"`，不看用时）、完成（其他非中断结束，用时 ≥ `doneAfterSeconds`…

提醒动作：`host.notify`（`notify_show`）+ `host.requestAttention()`（任务栏 `Informational` 闪烁，窗口获焦即停）。外壳（`src-tauri/src/notify.rs`）不用 `tauri-plugin-notification`（桌面端无点击回调），直接用 `windows` crate 的 WinRT 绑定（`UI_Notifications`）：toast 的 tag/group 都是会话 id（64 字符上限），同一会话新通知替换旧的；`Activated` 回调里外壳先 `unminimize` + `set_focus` 再 emit `notify-activated`（带 sessionId），前端切到对应会话；toast 对象持有在 `NotifyState`（drop 即撤回调），切到该会话或窗口重新获焦时 `notify_dismiss` 先 Hide 原 toast 再按 tag/group 清通知中心历史并放掉对象。AUMID：安装版（release）直接用 bundle identifier（与 NSIS 快捷方式一致）；只有开发构建才探测注册表 `HKCU\Software\Classes\AppUserModelId\<bundle identifier>`，未登记退回 PowerShell 默认 AUMID（通知照常显示、署名不对），不崩溃。非 Windows 命令照常存在，调用返回 `unsupported` 静默不发。测试通知走同一个 `notify_show`（`sessionId: "test"`）。

### 5.10 右侧面板（ADR-0060）

决定与范围见 [ADR-0060](../decisions/ADR-0060-desktop-side-panel.md)；本节记录实现。标签有「变更」「文件」「终端」「浏览器」四种和新标签页。

**框架**（`src/PanelHost.tsx` 的 `useSidePanel` 管状态，`src/SidePanel.tsx` 渲染，纯函数在 `src/side-panel.ts`）：标题栏在最小化按钮左边放「会话概览」和「右侧面板」两个按钮（`PanelChrome.tsx` 经 `TitlebarSlot` portal 放进 `WindowFrame`），Ctrl+B 开关面板。面板左缘是分隔条（拖动或方向键），宽度夹在 320–960 px，且给对话区至少留 160 px；并排时对话区不足 480 px 就改为盖在对话区上（带阴影，标题栏层级更高，不被盖住）。

面板属于会话（ADR-0060 修订 2026-10-18（二））：每个会话有自己的标签、当前标签和开关，以及「变更」的文件树宽度与换行偏好；面板宽度和会话概览的开关是全局的。首页和新建会话页没有会话，也就没有面板：两个标题栏按钮置灰，Ctrl+B / Ctrl+T / Ctrl+P / Ctrl+Shift+G / Ctrl+` 不响应（仍拦下浏览器默认行为，比如 Ctrl+P 打印）。设置页同样不显示面板和概览浮层（ADR-0060 修订 2026-10-18（三）），按钮置灰、这些快捷键与概览的 Esc 都不响应；会话的面板状态原样保留，「← 返回」后恢复，终端在后台照常运行。第一条消息建好会话后面板可用，初始关闭；文件引用左键在当前会话的面板里打开。按会话的记录存本机 prefs 的 `panelSessions`（会话 id → 开关、「文件」「变更」「浏览器」标签、当前标签、`treeWidth`、`wrap`；浏览器标签只存地址和标题，不存历史；终端和新标签页不存），宽度存 `panelWidth`。第 1、2 轮存下的全局 `panelOpen` / `panelTabs` / `panelActiveTab` 在第一次拿到会话列表时迁移给最近活动（`mtimeMs` 最大）的会话，写入 `panelSessionsMigrated` 后不再读取，与 `fileOpenerMigrated` 同一模式。桌面没有删除或归档会话的入口；每次拿到会话列表时，本次运行里进过列表、这次不在了的会话视为已删除（不管它是否还打开着），一律整套清理：结束它的终端、删掉它的面板记录（`vanishedSessions`）。没进过列表的会话只有打开着时暂缓（刚建好、列表还没跟上），否则是上一次运行之后被删的，记录同样清掉；正在看的会话也暂缓，离开后下一份列表再判。标签可关闭（× 或中键）、拖动排序、方向键切换、Delete 关闭，＋ 或 Ctrl+T 开新标签页；标签栏横向滚动，当前标签不压缩；文件和终端标签显示「名称 + 淡色项目名」，浏览器标签显示网页标题（没有标题时显示主机名或文件名）、加载中转圈、加载完显示网站图标（工作区外的文件显示所在目录名），空间不够时整段隐藏项目名。面板拖窄时当前标签自动滚回可见区。关掉最后一个标签会留下一个新标签页。

**新标签页**：地址栏接受 http(s) 网址、不带协议的域名（补 `https://`；`localhost`、`127.0.0.1`、`[::1]` 补 `http://`）、`file://` 地址、`about:blank` 和本机 HTML 文件路径（相对路径按当前会话工作区，网络路径不收），回车后这个新标签页就地变成浏览器标签；带了协议、但协议不在白名单里的（`javascript:alert(1)`、`ms-settings:`、`mailto:` 等）提示「不支持 xxx: 地址」，其余不像网址的输入提示「请输入网址」，不接搜索引擎。没有内置浏览器的环境（`host.browsers` 缺失）照旧交给系统浏览器，只放行 https 网址和本机 http 地址；工具列表是「变更」（Ctrl+Shift+G）、「文件」（Ctrl+P）、「终端」（Ctrl+`）。在新标签页上打开变更、文件或终端时，替换这个新标签页而不是另开。

**变更**：数据来自所属会话的 `turnChanges` 与按需 `turnChangeDiff`，diff 正文复用 `DiffBody`，只读。左边按轮次倒序列出每个文件的 diff（进入视口才加载），右边是可折叠的目录树和筛选框：同一文件跨轮只占一行，+/− 为各轮之和并标「N 轮」，展开后逐轮列出，点某一轮滚到并高亮该轮的 diff（重复点同一轮会再滚一次）；头部的文件数按去重后的文件计。增减行数与对话里的改动卡片同一写法：总写 +N，有删除行才写 −M，不出现「−0」（目录树、diff 卡片头、概览浮层都是）。本轮更改卡片上的「查看变更」打开这个标签并滚到该轮。

diff 和目录树之间是分隔条（`role="separator"`，`aria-valuenow` 为树宽）：拖动或聚焦后 ← → 调整（Shift 加大步长，Home / End 到两端；按下分隔条即获得焦点，拖完直接用键盘接着调。面板左缘的分隔条同样），树宽夹在 180–420 px，松手写进会话面板。面板窄于 560 px 时（容器查询）目录树移到 diff 上方、最高 190 px，分隔条隐藏。目录树不横向滚动：名字放不下用省略号，+/− 固定在行尾、始终完整；悬停显示完整路径（绝对路径）。Windows 工作区里路径一律按 Windows 写法显示，工作区外的分组是 `Z:\nocturne-mockups` 这样的反斜杠形式。每张 diff 卡片头部滚动时吸顶，长路径从左边省略、保留文件名；头部的「换行」开关是会话级偏好，缺省开：长行（中英文、长 URL）在任意位置折行，续行缩进到代码起点，不重复行号和 +/−；关掉恢复每张卡片底部横向滚动，所有行取最长行的宽度，横向滚动时短行的底色不会中途断掉；行号和 +/− 列 `position: sticky` 固定在左侧，背景不透明（增删行在面板底色上叠同样的增删色），代码从下面滑过、不与行号重叠。对话里的改动卡片（`TurnChangesCard`）沿用不换行、横向滚动，与之前一致。

**文件**：Ctrl+P 打开快速打开，列表来自 `session.fileIndex`，按文件名打分排序；什么都没输入时，先列最近在这个会话的面板里打开过的文件（新的在前，按会话记在 `panelSessions` 的 `recent`，最多 20 个绝对路径），其余按路径字母序。↑↓/Enter/Esc 操作，点对话框外任何位置关闭。文件标签存绝对路径（工作区内的文件另记打开时的工作区，用来显示项目名），切换会话不变；内容经 `runtime.readFile` 读取，不需要打开会话，重启后恢复的文件标签在后台连上后直接显示（路径校验与时限在 Core，见 [rpc.md](../protocols/rpc.md)：映射到网络共享的盘符照常读取，字面 UNC 路径一律拒绝；读取超过时限显示「读取超时，所在磁盘可能不可用」和「重试」）。文本用 CodeMirror 6 只读显示：行号、所引行定位并高亮、Ctrl+F 搜索、按扩展名加载语法高亮（CSS、HTML、JS/TS/JSX、JSON、Markdown、Python、Rust、XML、YAML，其余纯文本），配色跟随主题。图片经 blob URL 直接显示。二进制或超过 2 MiB 的文件只给「在外部编辑器打开」和「在资源管理器中显示」；HTML 按源码显示，头部多一个「在浏览器标签打开」（没有内置浏览器时是「在系统浏览器打开」）。重启后恢复的文件若已被删除，显示「文件已不存在」。

编辑器选型：CodeMirror 6 按模块按需引入，只读显示需要的部分（`@codemirror/view`、`state`、`language`、`search`、`@lezer/highlight` 与 9 个语言包）都是 MIT；Monaco 体积大一个量级且需要 worker 与额外 CSP 放开，不选。CodeMirror 与语言包都走动态 `import()`，不进主包：主包从 776.0 kB 增至 810.8 kB（gzip 232.8 → 243.5 kB，增量是面板本身），CSS 105.1 → 117.8 kB；打开第一个文件标签时才加载 `code-viewer` 297.6 kB（gzip 96.0 kB），语言包按扩展名再各自加载，11 个分块合计 375.2 kB（gzip 147.9 kB）。手机网页不包含 CodeMirror。

**终端**（`src/TerminalPane.tsx`，进程控制在 `src/terminal-session.ts`，xterm 封装在 `src/terminal-view.ts`）：新标签页的「终端」卡片或 Ctrl+`（已有终端就切过去，没有就新开）。工作目录取当前会话的工作区（会话还在打开时用会话列表里的 cwd）；标签显示项目名（普通对话工作区显示「对话」），插在当前标签之后。终端属于会话：切到别的会话时进程和 xterm 屏幕都保留（标签页隐藏挂着，不卸载），切回来原样继续；会话被删除时、应用退出时结束进程。shell 缺省跟随「设置 › 常规 › 执行 › Shell」（开标签时按终端工作区读 `runtime.describeSettings` 的 `shell` 生效值）：`auto` 按 `runtime.listShells` 的 auto 顺序（pwsh → Git Bash → cmd）挑第一个外壳认得且已安装的，指定的种类或路径直接用，指定的没安装时退回 auto；头部「Shell」下拉只列外壳认得且已安装的，切换时结束旧进程、在同一标签起新进程，选择只记在这个标签上，不写回设置。外壳命令与校验见第 2 节。xterm.js 与 fit 插件（MIT）随标签首次打开动态加载，不进主包，手机网页不包含；回滚 5000 行，配色取 `--a-*` 主题令牌并跟随深浅主题切换；终端区跟随面板宽度重新排版。中文输入法的候选框跟随光标，上屏文字直接写入。浅色主题下 ANSI 黄 / 亮黄用加深的 `--a-termYellow` #7a5410 / `--a-termYellowBright` #8a5f12（对 #fafafb 背景 6.49:1 / 5.40:1），并开 xterm 的 `minimumContrastRatio: 4.5`，程序自己给的 256 色和真彩色也不低于这个对比度；深色主题不变。竖滚动条 10 px（`overviewRuler.width`），颜色取 `--a-scrollThumb`。复制粘贴按键（`src/terminal-keys.ts`）：有选区时 Ctrl+C 复制并清掉选区，没有选区时交给进程（中断）；Ctrl+Insert 同样复制并清掉选区，Shift+Insert 粘贴；Ctrl+Shift+C 复制但保留选区，Ctrl+Shift+V 走浏览器原生粘贴；带 Alt 的组合照旧交给进程。右键按 Windows Terminal 的规则、不弹菜单：程序开了鼠标上报（`term.modes.mouseTrackingMode !== "none"`，如 Claude Code、vim）时交给程序；否则有选区就复制并清掉选区，没有选区就粘贴。剪贴板都经外壳读写：复制用 `terminal_write_clipboard`（WebView2 里 `navigator.clipboard.writeText` 会静默失败），粘贴用 `terminal_read_clipboard`（不触发 WebView2 权限框）；失败时终端顶部显示「复制失败：…」/「粘贴失败：…」，几秒后消失。Ctrl+B / Ctrl+T / Ctrl+P / Ctrl+Shift+G / Ctrl+` 不进终端，照常是应用快捷键。一个标签一个进程，关闭标签即结束进程；进程退出显示「进程已退出（代码 N）」和「重新启动」（重启后焦点回到终端）。开进程期间的输入（ConPTY 启动时 `ESC[6n` 的光标位置回答）排队，拿到终端 id 后按序发出。终端标签不恢复；agent 看不到也操作不了终端，不经过权限层。

**浏览器**（ADR-0060 第 5 节与修订（四）；外壳在 `src-tauri/src/browser.rs`，规则是 `browser_policy.rs` 的纯函数，前端是 `src/BrowserPane.tsx`、`src/browser-pool.ts`、`src/browser-occlusion.ts`）：每个浏览器标签一个子 webview（`Window::add_child`，tauri 开 `unstable` 特性），压在面板占位区 `.sp-browser-slot` 的位置上；占位区尺寸变化（`ResizeObserver`、窗口 resize）时重新 `browser_layout`。工具栏是后退、前进、重新加载 / 停止、地址栏、「在系统浏览器打开」、「开发者工具」；地址栏规则同新标签页，Esc 撤回未提交的编辑。工作区内的 HTML 引用左键进浏览器标签（`file://`），和文件标签同一规则：本会话已有浏览器标签正在显示这个文件（比当前地址的路径，不计查询串和锚点）就切过去，没有才新开；文件标签头部的「在浏览器标签打开」也一样。工作区外的照旧是文件标签；引用的右键菜单有「查看源码」，按源码开文件标签。网页的 `target=_blank`、`window.open` 与 Ctrl+点击都在同一会话里、紧挨来源标签新开浏览器标签并切过去，不开原生弹窗；网页打开的新窗口不复用已有标签。网页的 `alert` / `confirm` / `prompt` 用 WebView2 自带的脚本对话框（画在网页 webview 里，标题写明来源网站，`confirm` 取消返回 `false`）。本地 HTML 里的 `download` 链接会直接打开文件，要下载请右键另存为：`file://` 页面的源是不透明的，Chromium 只对同源可读的地址执行 `download` 属性（`HTMLAnchorElement::HandleClick` 里的 `CanReadContent`），指向 `file:` 的链接被当成普通导航；同一页面里的 blob 下载和 http(s) 下载链接照常下载。下载弹「另存为」（rfd 同步对话框，挂主窗口为父窗口），取消即不下载、不提示（WebView2 取消时也会报一次失败的结束，外壳只对选好了保存位置的下载报结果）；开始、完成、失败在工具栏下方提示（「正在下载 x」「已下载 x」「下载失败：x」），失败时用开始时选的文件名；外壳按地址先进先出配对开始与结束（`browser_policy::Downloads`），同一地址连续下载两次各报一次，取消留下的失败结束只消掉取消记录、不会配走正在下载的那一个。被拦下的导航（见第 6 节）在同一位置提示，比如「已阻止打开外部程序（ms-settings:）」。这里只显示最近一条：新提示顶替旧的；「已下载」4 秒后自动消失（`NOTICE_HIDE_MS`），失败、拦截提示留到点 × 或下一次开始加载（加载只清拦截提示，不清下载提示）。

生命周期（`BrowserPool`）：webview 在标签第一次显示时才创建；切走标签、切换会话、进设置页或首页、关面板时隐藏（不销毁，网页状态保留）；后台 webview 最多 `MAX_LIVE_BROWSERS` = 5 个，超出时回收最久没显示的，只留最后的地址，再显示时按地址重新加载；显示中的不回收。关闭标签、会话被删除时销毁；前端页面重新加载与应用退出时外壳关掉全部。外壳关 webview 一律经 `close_later`，换一个线程调 `Webview::close`，不在调用方线程上直接关：同步命令跑在主线程上，主线程这时可能正在创建另一个浏览器 webview——tauri-runtime-wry 建 webview 时一直拿着 web context 的锁，同时嵌套泵消息等 WebView2 建好控制器，主界面发来的 IPC 就在这个嵌套循环里执行；这时直接关，析构 webview 又去拿同一把锁，主线程锁死、整个应用无响应（开发模式下 StrictMode 让 `BrowserPane` 注册→销毁→再注册，网页一开新窗口就必现）。从别的线程关只是给事件循环发消息，tao 等事件处理器返回、锁放开后再关。重启后按存下的地址恢复，不恢复前进后退历史。创建失败在占位区显示原因和「重试」，不自动重试。每个标签的命令排成一条链，连续的布局只发最后一次；被回收的旧 webview 迟到的消息按代数丢掉。原生 webview 的显隐走异步命令，主界面重排却在同一帧：关面板、关掉或切走正在显示的浏览器标签前，先 `hideShown()` 藏起显示中的 webview、等外壳处理完（最多 120 ms）再改界面，否则网页会晚一帧盖在对话区或别的标签上。

浮层遮挡：子 webview 盖在主界面之上，主界面的下拉、右键菜单、对话框、概览浮层、快速打开、状态栏提示等伸进浏览器区域时会被它压住。浏览器显示时用 `MutationObserver` 找和占位区相交的浮层（`OVERLAY_SELECTOR`），状态机 `coverStep`（live → capturing → covered）：先给浮层加 `data-nct-cover-hold`（透明），`browser_capture` 截一张当前页面换到占位区上，两帧后隐藏 webview、去掉浮层的透明；截图 300 ms 没到也照样隐藏。浮层都关掉后显示 webview、撤掉截图；截图期间浮层就关了则 webview 不动。

快捷键：焦点在网页里时外壳经 WebView2 的 `AcceleratorKeyPressed` 拦下 Ctrl+B / Ctrl+T / Ctrl+P / Ctrl+`，作为 `shortcut` 消息转给主界面，和主界面里按下效果相同（按住的自动重复只拦不转）；转发前把键盘焦点还给主界面 webview，否则快速打开等弹出后，接着打字和 Esc 仍落在网页里。Ctrl+C / Ctrl+V / Ctrl+F 等编辑键和 Esc 留给网页：外壳分不出网页是否处理过 Esc，拦下会让网页里的对话框关不掉，所以焦点在网页里时 Esc 不开关概览浮层。

**菜单焦点**：弹出菜单（`Menu.tsx`，「＋」、文件引用右键、状态栏的模型与思考等）和下拉（`Dropdown.tsx`，权限、Shell 等）同一套样式：当前选中只打强调色的 ✓，焦点项是 `--a-sel` 底色加正文色，同一时刻只有一项高亮。菜单打开就把焦点放在选中项（没有就第一项）并立刻高亮，鼠标打开和键盘打开一样（用 `:focus`，不用 `:focus-visible`：鼠标点开后程序聚焦不算 focus-visible）；悬停把焦点移到该项，和方向键移动的是同一个高亮。快速打开和输入框补全的当前行也是 `--a-sel`。

**会话概览**：标题栏按钮或 Esc 开关，打开状态是全局的、存 prefs（`overviewOpen`），只在有打开会话时显示，没有时按钮置灰、Esc 也不打开。Esc 的优先级：已被别处处理（`preventDefault`）的不算——权限卡片拒绝、提问卡片、下拉与菜单、状态栏提示、输入框的补全弹层（先关弹层）和正在运行时的中断、终端里的 Esc（交给进程）；焦点在面板浏览器的网页里时 Esc 根本不到主界面；快速打开和设置页开着时也不算；其余情况包括焦点在空闲的输入框里（有没有草稿都一样，输入框没有 Esc 清空草稿的行为）都开关浮层。浮层只有两行：项目（名称与工作区路径）和「变更」（本会话累计 +/−，点开变更标签）。面板关闭、且对话列让出浮层的位置（300 px）后对话区仍不小于 480 px 时（`overviewDocks`），浮层停靠在右侧，对话列、输入框、提问卡片整体左移让出位置；放不下就和面板开着时一样盖在对话区上。判定只看窗口与侧边栏宽度、不受停靠本身影响，拖动窗口跨过阈值时只切换一次，不来回闪；面板打开时浮层盖在对话区上，放在面板左边，对话区放不下时压在面板上，不盖侧边栏。

**滚动条**：面板里所有滚动区（diff、目录树、「文件」的 CodeMirror、终端框）共用 `styles.css` 的 `.thin-scroll`：10 px、轨道透明、滑块取 `--a-scrollThumb`，悬停换 `--a-scrollThumbHover` 并变粗，深浅主题各一组令牌。只写 `::-webkit-scrollbar`，不写 `scrollbar-width` / `scrollbar-color`（Chromium 设了这两个标准属性就忽略前者，又露出箭头按钮）。xterm 6 的滚动条是自绘的，宽度与颜色经终端选项给。

**文件引用**：左键在面板打开见 5.2（U-09）。「打开文件用」新增「Nocturne 面板」并作为缺省；旧版本存下的 `fileOpener` 没有 `fileOpenerMigrated` 标记时不读取，统一回到缺省，首次启动写入标记，此后用户的选择原样保留。工作区外的引用按 5.2 处理。工作区内的 HTML 引用左键进浏览器标签，菜单的「打开」一项注明「面板浏览器」，另有「查看源码」。

**手机**：手机网页没有面板、概览按钮与「查看变更」，Ctrl+B / Ctrl+P / Ctrl+T / Ctrl+` 不响应，不包含 xterm.js、CodeMirror 与内置浏览器（`dist-web` 里没有浏览器代码）；`runtime.readFile` 不在远程白名单里。

## 6. 安全边界

- 远程网络仅由 Node 后台连接，前端不增加网络权限。手机经配对、签名握手和端到端加密访问；能力上限由后台 [RPC 第 7 节白名单](../protocols/rpc.md#7-安全与日志) 强制限制，配置与远程设备管理只能从本机进行。中继下发的手机网页未被篡改是额外信任点，界面固定说明。

- `capabilities/main.json` 只授予主界面 webview（`webviews: ["main"]`，不写 `windows`，见下一条）：二十七个应用命令（`allow-backend-open/send/close/stderr`、`allow-node-probe`、`allow-plain-workspace`、`allow-pick-images`、`allow-open-skill-directory`、`allow-app-note`、`allow-shell-log`、`allow-detect-editors`、`allow-open-in-editor`、`allow-open-with-default`、`allow-notify-show`、`allow-notify-dismiss`、`allow-terminal-open/write/resize/close/read-clipboard/write-clipboard`、`allow-browser-create/navigate/layout/action/capture/destroy`）、`core:app:allow-version`（`appVersion()` 显示与版本过滤用）、`core:path:allow-resolve-directory`（前端 `homeDir()` 主目录解析所需；`pick_images` 的对话框与读文件都在 Rust 侧，不需要它）、窗口权限 `core:window:allow-minimize`、`allow-toggle-maximize`、`allow-internal-toggle-maximize`（Tauri drag-region 的原生双击）、`allow-close`、`allow-start-dragging`、`allow-is-maximized`、`allow-request-user-attention`（通知时任务栏闪烁，`Informational`）、`core:event:allow-listen` / `allow-unlisten`（通知点击 `notify-activated` 事件），以及 `dialog:allow-open`、自动更新的 `updater:allow-check` 与 `updater:allow-download-and-install` 以及重启用的 `process:allow-restart`、`opener:allow-open-url`（scope…
- 面板浏览器的隔离（ADR-0060 修订（四））：Tauri 会给每个 webview（包括 `add_child` 建的子 webview）注入 `__TAURI_INTERNALS__` 和 `invoke`，关不掉；隔离靠「有入口、调用一律拒绝」。capability 按「webview 标签或所在窗口标签」匹配，所以所有 capability 都只写 `webviews: ["main"]`，**以后新增的 capability 也不得用 `windows` 匹配**——写了就会把同一窗口下的浏览器 webview 一起算进去。浏览器 webview 的标签是 `nct-browser-<n>`，与任何 capability 都匹配不上；应用命令经 `AppManifest` 声明，插件命令同样先过 ACL，匹配不到 capability 就拒绝，与网页来源无关。前端的调用参数里不带 webview 标签（`test/tauri-host-browser.test.ts`），外壳测试检查 capability 不含 `windows`、标签不会是 `main`。
- 浏览器导航白名单（`browser_policy.rs`，第二道防线）：只允许 `http`、`https`、`file`、`about:blank`。应用自己的地址（`tauri:` / `ipc:` / `asset:` 协议、`tauri.localhost` / `ipc.localhost` / `asset.localhost`、开发时的 `devUrl` 同源）一律拦下（「不能打开应用内部地址」）；`javascript:`、`data:`、`blob:`、`view-source:` 等浏览器协议拒绝（「不支持 xxx: 地址」）；其余自定义协议不交给系统（「已阻止打开外部程序（xxx:）」，iframe 里的经 `LaunchingExternalUriScheme` 同样取消）。地址栏、`browser_create`、`browser_navigate` 和新窗口请求都过这份白名单。离开当前文档的导航里，`file:` 只允许用户自己要打开的那个文件，或当前文档本来就是本地文件 / 空白页；网页从 http(s) 跳到本地文件（链接、脚本、重定向）一律拦下（「网页不能跳转到本地文件」）；其中链接点击多数在 Chromium 内部就被静默拦掉，到不了 `NavigationStarting`，因此不一定有提示。网页自己文档里的 `javascript:` 链接不是导航，只在网页自己的权限内执行，不处理、也不打 DOM 补丁。
- opener 插件用 `Builder::new().open_js_links_on_click(false)` 注册：默认它往每个 webview（包括面板浏览器）注入一段脚本，把 `target=_blank` 和 Ctrl / Shift 点击的链接改成调 `open_url`，在浏览器 webview 里这条调用被 ACL 拒绝，链接就没了反应；主界面的外链都自己经 `host.openUrl` 打开，用不到它，也不该往第三方网页注入脚本。
- 浏览器的 cookie 与存储在 `<应用本地数据>/browser`，与主界面的 `<应用本地数据>/EBWebView` 分开，退出不清空。环境变量 `WEBVIEW2_USER_DATA_FOLDER` 会覆盖每个 WebView2 环境的数据目录（WebView2 文档：设了这个变量就用它代替调用方传的 userDataFolder），浏览器就会和主界面混在一起；所以启动时外壳读出它并从进程环境里删掉（`browser_policy::take_user_data_override`，此后起的 nctrn、终端等子进程也看不到它），主窗口改在 `setup` 里显式用这个目录创建，浏览器用 `<这个目录>/browser`。没设或为空时行为不变。
- 插件的初始化脚本：Tauri 把插件的初始化脚本注入每个 webview（包括面板浏览器里的第三方网页）。tauri-plugin-dialog 的脚本会把 `window.alert` 改成调 `plugin:dialog|message`、`window.confirm` 改成返回 Promise 的 async 函数：浏览器里调用被 ACL 拒绝，alert 不弹，confirm 恒为真；主界面里插件也没有 confirm 命令，同样恒为真。所以它经 `plugin_script::WithoutScript` 注册，只去掉初始化脚本、命令照常；`tauri-plugin-dialog` 的版本由测试钉在 2.8.0，升级时复核新脚本。主界面自己不用 `alert` / `confirm` / `prompt`（`apps/desktop/src` 开了 eslint `no-alert`），需要确认的操作用应用内确认框（`ProvidersPage.tsx` 的 `ConfirmDialog`：默认焦点在「取消」，Esc 与点遮罩等于取消）。
- 选中文字时的浮动工具栏：WebView2 自带的选区「迷你菜单」（mini menu）在 wry 的缺省参数 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` 里已经关掉，微软的「Microsoft Edge 与 WebView2 的差异」文档也把 Mini menu 列为 WebView2 中关闭、不可配置；主界面和面板浏览器都不另加开关。实测中出现的「AI 搜索 / 翻译 / 总结」类工具栏来自系统级划词软件（豆包），主界面也会出现，应用控制不了。
- tauri 开了 `unstable` 特性（子 webview 只在这个特性下可用），因此版本用 `=2.12.0` 固定，升级时要重跑面板浏览器的验收。
- 主窗口 `dragDropEnabled: false`：关掉 Tauri 的原生拖放接管，HTML5 drop 才能向输入框交付 `File` 对象（图片附件的拖入路径）。
- CSP：`default-src 'self'`；`connect-src` 只允许 `ipc:`/`http://ipc.localhost`；图片额外允许 `blob:`（图片附件预览用）；禁 `object-src`、`base-uri`、`form-action`、`frame-ancestors`。dev 模式（`devCsp`）仅为 Vite 额外放开 `ws://localhost:31420`、`http://localhost:31420` 与 style `'unsafe-inline'`。正式包不放 `'unsafe-inline'`，CodeMirror 与 xterm 运行时插入的 `<style>` 元素和 `setAttribute("style")` 会被拦下（文件查看器的行号与正文叠在一起、终端没有颜色和等宽格子）；`src/inline-style-shim.ts` 在 `main.tsx` 渲染前安装：被拦的 `<style>` 文本同步成构造样式表挂到 `document.adoptedStyleSheets`（跟随文本变化与移除），`style` 属性改写为 `element.style.cssText`。两者都不受 CSP 限制，CSP 本身不放宽。
- 外链白名单（`src/external-url.ts`）：`https:` 放行；`http:` 仅 `127.0.0.1` 与 `localhost`（本机回调页）；其余协议与解析失败忽略不打开。Rust 侧 opener scope 与之一致。
- 前端只用本机字体，不加载远程资源；不持久化任何凭据或会话内容。

## 7. 依赖边界与运行方式

`apps/desktop/src` 只能引 `@nocturne/rpc/client`、`@nocturne/core/protocol` 与同构 `@nocturne/remote`，不引 core 运行时、其他 workspace 包、Node 内置模块（含 Node 全局，eslint `no-restricted-globals` + depcheck `desktop-*` 规则强制）。Vite/vitest 用 alias 直接跑源码，dev 与测试不需要先构建 rpc。

- `pnpm desktop:dev`（先跑 `scripts/fetch-node.mjs` 补齐随附 Node，再 `pnpm --filter @nocturne/desktop dev` → `tauri dev`，自动先跑 `pnpm vite`）：开发运行，后台用 `apps/cli/dist/main.js`，需先 `pnpm build`。
- `pnpm desktop:build`（根 `package.json`）：依次跑 `pnpm build` → `node scripts/bundle-nctrn.mjs` → `node scripts/fetch-node.mjs` → `cargo test`（`apps/desktop/src-tauri`）→ `tauri build`（`beforeBuildCommand` 自动先跑 `pnpm vite build`），任何一步失败即终止。产出 NSIS 安装包 `apps/desktop/src-tauri/target/release/bundle/nsis/Nocturne_<ver>_x64-setup.exe`：per-user 安装（`installMode: "currentUser"`，装进 `%LOCALAPPDATA%\Nocturne`，不需要管理员权限），不签名；`resources/nctrn.mjs` 与 `resources/node/{node.exe,LICENSE}` 随包放进安装目录（`nctrn.mjs` 在根、`node/` 子目录），无需用户自装 Node。`bundle.createUpdaterArtifacts: true` 时旁边还产出 `<setup>.exe.sig` 签名文件（需 `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，见 [workflow.md](../development/workflow.md) 第 8 节）。卸载器只删安装目录，用户数据（`%APPDATA%\io.github.kanzaki-chiya.nocturne`）按 Tauri 默认保留。Rust 工具链只在这条流程需要。
- `pnpm release:build`（根 `package.json` → `scripts/release-build.mjs`）：发布总入口，bundle → npm pack → 取随附 Node → cargo test → tauri build → 生成 `latest.json`，产物收进 `release/<version>/`（不入库）。本地演练可传 `--config <覆盖.json>` 只覆盖 updater `pubkey`/`endpoints` 等字段。
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`（vitest + jsdom，完全离线，进入默认测试集）覆盖 `src/` 与 `test/`；`pnpm build` 构建手机网页，不构建 Tauri，也不需要 Rust。
- 后台、工具、Hook 与 MCP 的真实进程测试使用跨包辅助函数 `scripts/test/process-cleanup.mjs`，启动即登记句柄并预登记孤儿 PID 文件，失败/超时后的 `afterEach` 先清进程树再有限重试删除临时目录；Windows `taskkill /T /F` 自身停滞时兜底收回已登记 PID。测试包装平台工厂，不增加生产 Runtime 接口。同步构建探针保留命令自身超时。
- Rust 外壳只在 `desktop:*` 流程需要：在 `apps/desktop/src-tauri` 手动跑 `cargo build`、`cargo test`（切行、版本解析、关闭超时、进程级转发）、`cargo clippy --all-targets`；不进默认测试集。

## 8. 手机网页

手机能做的事以 [ADR-0052 修订 2026-10-15](../decisions/ADR-0052-remote-web-client.md) 为准：会话内操作全部放开，设置、凭据、持久授权、项目信任与 Shell 设置只能在电脑上改；方法清单见 [rpc.md §7](../protocols/rpc.md)。页面声明 PNG favicon 与通用 mobile-web-app-capable 元数据。握手失败先作废当前连接再关闭传输，确保关闭回调不会重复安排重连。固定 tag 通知启用 renotify，替换旧通知时仍提醒。

`web.html` → `src/web/main.tsx` 是独立单栏手机入口，不加载桌面 App；WebHost 仅打开安全外链与写无内容诊断，不实现 DesktopHost。`vite.web.config.ts` 沿用桌面 alias 并引入 remote，构建到 `dist-web/index.html`，开发验收中继以 `--web-root apps/desktop/dist-web` 托管；发布时由 [中继打包脚本](../../scripts/pack-relay.mjs) 放入 tgz 的 public/，无需 web-root 参数。HTTPS 真机验收另行进行。依赖边界由 `phone-web-no-tauri` 的可达检查强制。

- `storage.ts` 的接口生产用 IndexedDB `nocturne-remote`，测试用内存；不可导出的 CryptoKey 直接结构化克隆，不导出私钥。一份手机身份共用多台电脑；只保存电脑公钥、id、名称与配对/最近连接时间，不持久化会话内容。打开请求持久存储，失败忽略。移除仅删除手机记录并提示在电脑移除设备。
- 加载即清理配对片段，仅在内存留存；粘贴接受同源完整链接或片段。配对依次连接槽位、真实签名/MAC 与指纹校验、保存电脑，失败明确提示重新申请链接。iOS Safari 与主屏幕应用不共享 IndexedDB，提示添加后重新配对，依据见 ADR-0052 修订。
- `PhoneConnection` 同时只连接一台电脑，离线等待 host online，在线建立加密通道再 initialize(interactive:true)。不兼容停止；当前 RPC mismatch 错误没有结构化版本，仅从既有文案取服务端版本，不更改协议。4003/4004 停止重连；4002 返回等待；其他断线从 1 秒翻倍至 30 秒并 ±20% 抖动。后台不主动断开、不重连，回前台若已断即重连。
- `PhoneSessions` 保存已打开会话视图，重连逐个 resume 并按 lastSeq 订阅；不清空已显示内容。重连只恢复连接开始时已有的那批会话，恢复期间通知带来或用户点开的会话由 `open` 打开，与恢复共用 `opening` 去重，同一会话在一条连接上只 resume 一次（后台对重复 resume 报 `session_already_open`）。状态使用相同 conversationStatus 判定与 session-tree 路径/状态类型。拿到列表即算连上，后台只订阅持锁会话判定状态，其余会话点开时再订阅（避免会话多时迟迟连不上）。**列表保持最新**：连接期间监听 `runtime.sessionsChanged`（电脑或手机创建、分叉会话，首条消息与标题出现时由后台推送，[rpc.md §3.8](../protocols/rpc.md)），收到就重拉列表并订阅新出现的持锁会话；刷新中再来的通知合并成一次补拉，断线与切换电脑时退订。通知不覆盖别的进程（如 CLI）新开的会话：网页版回前台会重连，重连即重拉；App 因后台保持连接而不重连，由 `PhonePlatform.onForeground`（Activity 恢复）触发一次刷新。旧电脑没有这条通知时退化为只在回前台刷新。新建会话可在任意已有目录（未选的模型/档位/预设与桌面草稿一样交给 Core 解析）；目录不存在报 `workspace_not_found`，项目配置未信任报 `workspace_untrusted`，界面原样显示，手机不代为信任。另提供本轮改动（`turnChanges`/`turnChangeDiff`）、回退（`rewind`）与分叉（`forkSession` 后打开新会话）。
- 页面层级：首页（项目列表）→ 项目页 → 会话页，另有设置页与用量页，导航使用浏览器 history，返回手势逐级回退；从推送进入会话时先压入所在项目页。首页按 `session-tree.ts` 的纯函数分组排序：第一项是普通对话工作区（由 initialize 的 `sessionsDir` 推导 `<NOCTURNE_HOME>/workspace`；桌面自定义的普通对话目录与置顶保存在桌面本地，手机看不到），其后各项目显示会话数与最近活动，末尾「其他目录…」手动输入电脑上的完整路径。项目页底部常驻输入框，直接输入即在该项目新建会话（模型列表读到之前不能发送）。
- 手机工具行允许折行：参数保留至少 12em（极窄屏不超过整行），不再受实时输出的 35% 上限挤压；子代理模型与强度独占后续一行，进度、秒数与结果随后排布。长路径、模型名和错误摘要可断行，读取范围、等待回答与改动计数不撑宽页面。仅由 `phone.css` 覆盖，App 共用；桌面仍保持单行省略。
- 会话复用 Conversation；工具默认折叠，输入框是 `PhoneComposer`：圆角卡片内含发送按钮，下方工具栏依次为附件、权限预设、模型、思考档位、上下文用量圆环与「…」（Shell 只读、输入历史），点击在上方弹出带箭头的浮层（`Popover`，点外面或选完关闭，内容可滚动不超屏）。选项与可用性复用桌面 `useSessionControls`/`useDraftControls`（手机不读 `describeSettings`，未选过的档位与预设显示「默认」，也不写桌面的 `lastEffort`）；改动经 `session.config_changed` 同步到桌面状态栏。上下文浮层复用桌面上下文面板。输入 `/` 补全 `/compact`、`/mcp`、技能与外部 agent 委派，规则同 `commands.ts`，`/mcp` 结果用浮层显示；`@` 用 `fileIndex`/`resolveFiles` 补全文件引用（普通对话没有项目索引）。图片可拍照或从相册选择，由 `phone-images.ts` 按 Core 的图片上限（5 MiB、长边 8000）原样或经 canvas 缩放转码；发送前估算报文，超过 `MAX_MESSAGE` 减 64 KiB 的余量时提示不发。会话内图片走真实 `readAttachment`，后台按远程报文上限拒绝过大的附件，手机显示「图片过大，请在电脑上查看」。用户消息下常驻复制、编辑并重发、重发与分叉，分叉先内联确认。hidePersistentPermissions 仅隐藏写入项目持久授权的选项（如「本项目允许」），保留「拒绝并停止」；后台继续拒绝远程 `remember: "project"`。hideRequests 让外壳用底部面板统一显示权限和 QuestionCard；这些 prop 缺省保持桌面行为。另一端结算经视图关闭面板，unknown_request 静默关闭。
- 设置页只放手机本地内容：已配对电脑（改名、打开、移除）与添加电脑、推送通知开关、连接诊断（当前状态与最近几次断线原因和时间，只记在本机）、主题（跟随系统/亮/暗，存本机）、用量入口（只读 `usageStats`，复用桌面用量页，口径相同）、「关于」（完整的信任边界说明）。配对页只留一句「中继只转发密文；详细的信任说明见「设置 › 关于」」，欢迎页的标题栏因此提供设置入口。
- 跟随系统深浅 token（可在设置里固定亮/暗）、44px 触控、安全区；整页固定在 visualViewport 内（高度与 offsetTop 都跟随，iOS 弹出软键盘时不会滚出可视区），底部面板停在键盘上方。关于页写明完整信任边界。
- `public-web/manifest.webmanifest` 与 192/512 any、maskable、180 apple-touch 图标构成主屏幕应用；主题色沿用 token。`/sw.js` 固定路径、作用域 `/`，只监听 push 与 notificationclick，不监听 fetch、不缓存页面；无载荷推送固定文案「Nocturne：有会话需要你处理」，固定 tag 替换旧提醒。点击优先聚焦已有同源窗口并发 `{t:"nocturne.attention"}` 消息，否则打开 `/?attention`；网页拿到会话列表、后台订阅完持锁会话后，进入最近一个待确认或待回答的会话，没有则进入列表里最近的会话。
- `PhonePush` 只在点击「开启推送通知」时请求权限，从 `/v1/info` 取 VAPID 公钥。订阅通过设备认证连接发送给当前电脑；其他已配对电脑下次连接补发，同一份浏览器订阅共用。关闭取消浏览器订阅，当前电脑立即 unsubscribe，其他电脑下次连接补发取消。拒绝给系统/网站设置指引；iOS 非 standalone 不显示按钮，提示添加主屏幕（iOS 16.4+）。前述状态不持久化会话内容或通知载荷。
