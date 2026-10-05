# 桌面端（Tauri 外壳 + React 前端）

> 状态：v0.5 骨架与连接、对话、设置区（服务商、常规、模型、外观）已实现（[ADR-0046](../decisions/ADR-0046-desktop-tauri.md) 第 9 节第 1–3 步） | 前置阅读：[protocols/rpc.md](../protocols/rpc.md) | 代码位置：`apps/desktop/`

`apps/desktop` 是 Nocturne 的桌面端：一个 Tauri 进程内，React 前端经 `@nocturne/rpc/client` 与若干 `nctrn rpc --stdio` 后台进程通信，Rust 外壳只负责进程管理与按行转发。所有会话语义（握手、方法调用、事件）都在前端处理，外壳不解析报文。

## 1. 进程结构与后台策略

- **一个项目一个后台**：`backend_open` 以项目目录为 cwd 启动 `node <脚本> rpc --stdio`，同一项目的会话共用这个后台。会话列表是全局的（`<NOCTURNE_HOME>/sessions`），前端用任意一个运行中的后台 `runtime.listSessions()` 取全部会话。
- **常驻后台**：应用启动即以普通对话工作区（见第 3 节）为 cwd 开一个后台，用它列出全部会话，窗口打开期间常驻；项目的后台仍按原规则在打开该项目的会话时才启动（第 2 步实现）。因此第一次启动、没有任何项目时，左栏也能直接列出全部会话。
- **后台生命周期**：Rust 外壳在 Tauri 页面开始加载钩子中同步推进后台代际，F5 或 Vite 整页重载后并行关闭旧页面全部后台（关 stdin → 等自行退出 → 5 秒强杀），不依赖前端异步 `beforeunload`；在途 `backend_open` 在启动前校验分发时捕获的代际，旧页面请求被取消，旧清理只使用旧代快照，不影响新页面后台。窗口关闭时对所有后台（含正在重载清理的后台）执行相同关闭流程，全部结束后退出应用；Windows 上后台在 spawn 后被放入全局 Job Object（`KILL_ON_JOB_CLOSE`），外壳被强杀时后台一起结束。Job 创建或加入失败不致命，往该后台的 stderr 缓冲记一行说明。纯 React Fast Refresh 不重新加载文档，由前端组件生命周期释放连接。
- **日志边界**：stdin/stdout 的内容在任何地方都不记录、不打印、不写盘（报文里可能含密钥明文）；stderr 按行截断（64 KiB/行）保留最近 500 行在内存中。缓冲只在两处离开外壳：后台退出时随 `closed` 消息交给前端（崩溃横幅显示末尾几行），以及前端经 `backend_stderr` 命令按需拉取（「后台日志」页，只在打开页面或点「刷新」时读，不轮询）。后台退出即从注册表移除，此后 `backend_stderr` 返回 `unknown_backend`——缓冲不随进程保留，退出后唯一的 stderr 副本在 `closed` 消息里。

## 2. 命令与消息格式

Rust 外壳提供七个 Tauri 命令（经 `tauri_build` 的 `AppManifest::commands` 声明为应用命令，在 `capabilities/main.json` 中逐个授予 `allow-backend-open` 等权限），错误统一返回可序列化的 `{ code, message }`（message 为中文）：`node_unavailable`、`backend_script_missing`、`invalid_workspace`、`spawn_failed`、`unknown_backend`、`workspace_unavailable`、`file_too_large`、`io`。

| 命令              | 参数 → 结果                                         | 说明                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend_open`    | `{ workspace, channel }` → `backendId`（u32，自增） | 校验工作区目录存在；取缓存的 Node 探测结果（无缓存先探测一次，不满足报 `node_unavailable`）；解析后台脚本；spawn 后 stdout 行经 channel 推给前端                                                                                                                                                                                                                                              |
| `backend_send`    | `{ backendId, line }` → `null`                      | 写 `line + \n` 到该后台 stdin 并 flush；每个后台的 stdin 有独立 Mutex                                                                                                                                                                                                                                                                                                                         |
| `backend_close`   | `{ backendId }` → `null`                            | 关 stdin、等自行退出、5 秒超时强杀，进程确实结束才返回；重复调用或对已退出的后台调用返回 `null`                                                                                                                                                                                                                                                                                               |
| `backend_stderr`  | `{ backendId }` → `string[]`                        | 返回该后台内存中的 stderr 缓冲（最近 500 行，每行 ≤ 64 KiB）；不写盘。后台不存在或已退出（缓冲随进程回收）报 `unknown_backend`                                                                                                                                                                                                                                                                |
| `node_probe`      | `{}` → `NodeProbe`                                  | 每次重新探测并刷新缓存（说明页的「重新检测」）                                                                                                                                                                                                                                                                                                                                                |
| `plain_workspace` | `{}` → 绝对路径字符串                               | 解析 `<NOCTURNE_HOME>/workspace`（`NOCTURNE_HOME` 规则与 Core `nocturneHome()` 一致），不存在时创建（POSIX 上新建目录 0700），返回绝对路径；失败报 `workspace_unavailable`                                                                                                                                                                                                                    |
| `pick_images`     | `{}` → 原始字节（`Response`）                       | 系统文件对话框多选图片（过滤 png/jpg/jpeg/gif/webp）；外壳读取所选文件字节返回，前端不传路径——读取范围仅限用户显式选中的文件。单个文件 > 64 MiB 报 `file_too_large`：与 stdout 单行上限同级的内存护栏（不是附件规则，格式与尺寸校验仍在 Core）。自定义二进制帧，重复记录 `[u32 LE 文件名 UTF-8 字节数][文件名][u32 LE 数据字节数][数据]`；取消选择返回空体。前端解码在 `src/picked-images.ts` |

`plain_workspace` 单独成命令而不并入 `backend_open`：前端归类「对话」需要这个路径且目录必须由外壳创建，而 `backend_open` 仍只接受已存在的目录——前端不能借它创建任意目录。

Channel 消息（serde tag `kind`）：

```ts
type BackendMessage =
  { kind: "line"; line: string } | { kind: "closed"; code: number | null; stderr: string[] };
```

`code` 是退出码，被强杀或拿不到时为 `null`；`stderr` 是该后台内存缓冲的全部内容（≤500 行）。监督线程（`try_wait` 约 50ms 轮询）在进程退出后等待 stdout 读线程排空（最多 2 秒，防孙进程继承管道卡住），保证**所有 line 消息都在 closed 之前发出**；closed 每个后台只发一次。stdout 切行上限 64 MiB/行，超过则记一行 stderr 并强杀后台（宁可显式失败也不悄悄丢报文让请求挂死）。

前端 `TauriLineTransport`（`src/transport.ts`）把这套命令实现成 `LineTransport`：`send` 经 promise 链串行保证顺序（写失败吞掉，断开会经 closed 体现）；注册 `onLine` 前到达的行被缓冲并按序交付；`closed` 在已交付完缓冲行后触发 `onClose`（只一次）；`exited` 暴露退出结果；`backend_open` 失败包装成带 `code` 的 `DesktopError`。`BackendPool`（`src/backends.ts`）按 `projectKey` 保持一个后台并做握手，退出时移出池并通知 UI。握手失败（含后台 spawn 后秒退）的 `ensure` 会等 `exited` 拿到退出码与 stderr 尾部，把它们带进抛出的错误——否则横幅只看到「连接已断开」，后台为什么没起来无从排查。

**崩溃与恢复**：后台退出后 UI 显示「后台已退出（退出码 N）」横幅，附 `closed` 消息里 stderr 的末尾几行（可展开全部），操作是「重启后台」与「查看日志」（进入「后台日志」页）。退出时 `src/conversations.ts` 把该后台上的已打开会话标为 `dead` 并各自保留 `SessionView` 与 `lastSeq`：当前会话保持选中，空闲清理跳过 dead 会话，打开 dead 会话自动走恢复流程。「重启后台」只重开退出的那一个后台（其余不动），随后对每个 dead 会话依次 `resumeSession` 并以 `afterSeq: lastSeq` 重新订阅，拿到退出期间落盘但没收到的持久事件；恢复失败的会话单独记录错误并保持 dead，不阻塞其余会话的恢复，之后重新打开时重试。

## 3. Node 查找与说明页

查找顺序（`src-tauri/src/node.rs`）：

1. 环境变量 `NOCTURNE_NODE`（非空即视为指定；文件不存在直接失败，后续步骤记 `skipped`）；
2. 资源目录 `<resource_dir>/node/node.exe`（非 Windows 为 `node`；本版不随附，`not-bundled`）；
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
- **项目**：项目 = 其余会话 `cwd` 的归并键 ∪ 手动添加的项目 − 隐藏项目。`projectKey(path)` 去末尾分隔符（根目录除外）；像 Windows 路径（`盘符:` 或含 `\`）则统一 `\` 并小写。显示用第一次见到的原始路径，项目名取末段。排序存 `projectSort`：默认「最近活动」（有会话的项目按最新 `mtimeMs` 降序，其后是无会话的手动项目按添加顺序），「名称」时对全部项目按名称排序；项目内规则同对话区。「项目」标题行右侧的「…」（弹出菜单：排序、已移除的项目…）与「＋」（打开项目）在悬停时显示；项目行悬停显示的「＋」在该项目新建会话。「…」菜单的「已移除的项目…」列出隐藏的项目（显示名称、悬停见完整路径），点一项即从隐藏集合移除并恢复显示。
- **置顶**：按置顶数组顺序列出仍存在的会话，每条标出所属项目名（对话为「对话」）；置顶不受项目隐藏影响。右键会话行置顶/取消置顶，右键项目标题「从列表移除」（把项目路径加入隐藏集合，不删会话、不动手动项目列表，可在「…」菜单恢复）。
- 会话行优先显示已打开会话视图的标题，否则为 `firstText ?? "未命名会话"`；meta 为相对时间（<60s「现在」<1h「N 分钟」<24h「N 小时」<48h「昨天」<30d「N 天」否则 `YYYY-MM-DD`，锁定加「🔒 」前缀）。运行中的会话显示主色圆点；等待权限确认或提问回复的会话显示「待确认」，切走后仍保持这个状态。

界面状态存 localStorage 键 `nocturne.desktop.prefs.v1`：`{ pinned: string[]; projects: string[]; hidden: string[]; projectSort: "activity" | "name"; lastEffort?: string; theme?: "light" | "dark"; plainWorkspace?: string; plainWorkspaces: string[] }`（会话 id、原始路径、项目路径；`projectSort` 缺省 `"activity"`；`lastEffort` 是上次选用的思考档位，作为新会话草稿的默认档位，非字符串字段被忽略；`theme` 缺省即跟随系统；`plainWorkspace` 是自选的普通对话工作区，缺省用外壳的默认路径；`plainWorkspaces` 缺省 `[]`，记住用过的工作区路径；各字段逐个校验，类型不对的回退默认，缺新字段的旧数据照常读取；旧数据里的 `lastProject` 字段忽略）。读写失败均不影响本次运行，写失败时 `persistent` 标为 false（`src/prefs.ts`）。

启动流程：`node_probe` → 不 ok 显示说明页；ok 后 `plain_workspace` 取默认普通对话工作区（`prefs.plainWorkspace` 优先）→ `ensure` 开常驻后台（握手）→ `listSessions()`（不传 cwd）。`plain_workspace` 或 `ensure` 失败显示真实错误与「重试」；后台退出则显示崩溃横幅，「重启后台」只重开那个后台并恢复其会话（见第 2 节崩溃与恢复）。「打开项目…」（「项目」标题行的「＋」）走系统文件夹对话框 → 加入手动项目、取消隐藏、刷新列表，不启动后台。列表在连上后、打开项目后、窗口重新获得焦点时（节流 ≥ 2 秒）刷新。

未选中会话时主区显示 hero 空状态（`src/App.tsx` `DraftPane`）：月亮标记 + 标题 + 同一个输入框（宽度上限 680）。普通对话标题为「有什么可以帮你？」；项目草稿为「要在 <项目名> 里做什么？」——项目名是可点按钮（虚线下划线），点击打开与输入框托盘目录 chip 同一个目录菜单。目录菜单内容：「普通对话」（副标题「不属于任何项目」）/ 分隔线 /「项目」组逐项目（名称 + 小字路径）/ 分隔线 /「打开其他文件夹…」。

### 5.1 会话打开、创建与关闭

`src/conversations.ts` 管理打开的会话与订阅。点击会话先 `ensure` 所属项目后台，再 `resumeSession`、通过 `trackSessionView` 订阅并回放历史；普通对话共用常驻后台。遇到 `session_locked` 先显示「正在别处使用」，只有用户选择「强制打开」后才以 `force: true` 重试。

「＋ 新会话」、项目行「＋」和空状态目录菜单只进入草稿；第一条普通消息发送时才 `createSession`，不创建空会话。草稿里显式选过的字段（模型、思考档位、权限预设）写进 `createSession({ model, reasoningEffort?, permissionPreset? })`——模型总会带上（默认取最近使用或 `defaultModel`），未触碰的档位/预设省略，由 Core 解析项目级默认。发送采用接受语义：`session.submit` 返回即视为已接受（持久用户事件随后才到），Turn 视图出现新条目或新 Turn 也算接受；`submit` 在接受前拒绝（如附件校验失败）则抛错，输入框保留草稿与全部附件。接受后才设置选中会话并清掉草稿工作区；被拒的刚创建会话走正常 `closeIfIdle` 路径关闭。切换时关闭空闲的旧会话及订阅；运行中、等待权限确认或提问回复的旧会话保留打开，结束后若不再选中则关闭。项目没有打开会话时释放其后台；普通对话常驻后台不释放。主区始终只有当前会话的一条消息流和一组请求卡片；`Conversation` 与 `Composer` 使用带组件前缀的不同 React key，切换会话时分别重建，不能共用同一个会话 id 作为同级 key。

### 5.2 消息、输入与交互请求

`src/Conversation.tsx` 按共享 `SessionView` 渲染用户消息、助手 Markdown、可折叠思考、工具调用和文件 diff、警告与通知，不另写事件折叠。用户消息是右对齐气泡，`@路径` 渲染成等宽 chip（title 来自匹配的 fileRef 元数据：「已附带 N/M 行」「目录」「已附带文件 · 已截断」）；助手行无标签无边线；思考默认折叠为一行（「思考中 Ns」/「思考了 Ns」/「思考」，时长由 `src/reasoning.ts` 从流式事件累计），点开展开全文（规则见下文「长思考」）。工具行单行显示「图标字母 + 动作 + 参数 + · 范围 + 简短结果」：cwd 内路径相对化（`src/paths.ts` `displayPath`，Windows 风格忽略大小写与分隔符），区外按原样绝对路径；>10 秒才显示时长（「12 秒」/「1 分 45 秒」）。ok 的 edit/write/apply_patch 只渲染 diff 卡片（`+N`/`−M` 计数，去掉 `---`/`+++`/`index`/`\ No newline` 行，hunk 之间「⋯」分隔，默认展开可收起）；出错仍渲染工具行。被拒绝的工具只显示一行红色「✕ 已拒绝<操作>」（feedback 放 title）；`permission`（allow/deny）与 `config` 子类型的 notice 不进消息流。Markdown 原始 HTML、脚本、事件属性和远程图片不执行、不加载；允许的链接由宿主打开。流式更新自动跟随底部，用户向上滚动后停止跟随，点击「回到最新消息」恢复。左栏和消息滚动区使用细、无箭头滚动条，滑块为 `--a-borderStrong`。

思考时长不足 1 秒时，无论进行中还是已结束都只显示「思考」。

**长思考**（desktop-v4.html F/G 屏）：思考块的标题行是按钮（`aria-expanded`），展开后标题为「思考 · N 秒 ▴」（超过一分钟写「M 分 S 秒」，进行中写「思考中 · …」），并吸附在消息滚动区顶部（`position: sticky`），读到块中间也能一键收起；整块滚出视野后标题随之离开，不会盖住后面的消息。思考正文高于一屏（滚动区可视高度）时，正文末尾再给一个「▴ 收起思考」按钮，不到一屏只用标题行。收起由消息流决定怎么滚（`ThinkScrollContext`）：处于跟随最新时同步滚到底部，跟随保持开启（在滚动事件之前定好位置，块变矮引起的回滚不会被当成用户上翻）；未跟随时若标题行已在视野上方，把它滚回滚动区顶部，读者停在刚收起的位置。diff 正文剥离每行自带的第一个 `+`、`-` 或空格，仅在标记列显示符号，保留正文自己的符号与缩进，`@@` 不进入正文。压缩回执只显示「上下文已压缩」，不展示压缩模式、seq 或 payload。

增删 diff 行与标题计数使用独立的样式类；增删正文均使用默认文字颜色和相同字号，行号、标记与正文对齐，仅背景和标记列区分增删。结束回执不展示英文原因标识，中断显示「已中断」。「回到最新消息」位于消息滚动区下方的独立操作行，不覆盖正文。

失败工具行右侧标红「失败」，下一行灰色简述是可展开的原文入口：`not_read` 对应「文件需要先读取」，`stale_file` 对应「文件在读取后被修改过」，其他取 Core message 第一句（不把扩展名或小数中的句点当句末），工作区内路径相对化；不显示错误码。完整错误 message 保持原文，默认折叠，点击简述后显示，避免同时重复展示 modelContent。

用户气泡里的图片附件经 `AttachmentImageSource`（`src/attachment-images.ts`）按 sha256 缓存为 blob URL；发送成功登记原始字节，缓存未命中时仅在气泡进入可视区后调用 `session.readAttachment`。缩略图保持比例，最大 160px，沿用输入框预览的圆角、边框与底色。加载中显示占位，读取或显示失败时退回文件名 chip，title 给出失败原因；工具结果中的图片仍只显示 chip，不加载缩略图。

`src/Composer.tsx` 是空状态与会话共用的输入框（`variant: "draft" | "session"`）：Enter 发送，Shift+Enter 换行；`isComposing`、composition 状态或旧输入法 `keyCode=229` 时不发送。输入历史经 `readInputHistory` / `recordInputHistory`；运行中发送键变成 ■ 与 Esc 一样调用 `interrupt`。两种布局：draft 是卡片 + 托盘（`.cbox`/`.tray`：附件缩略图行、textarea、工具行「＋ + 模型 chip + 档位 chip + 发送键」、托盘「目录 chip + 权限预设 chip + 输入提示」，托盘负 margin 塞在卡片底边之下、卡片压在上层）；session 使用同样的卡片外观，卡片内为两层，上层文字区、下层工具行，工具行左侧为「＋」、右侧为发送键（运行中为 ■ 中断键），无 tray、无模型或档位 chip，这些设置由会话状态栏负责。textarea 自动长高到 ~40vh/280px 后内部滚动；redirect/vision 提示显示在卡片上方气泡，错误在下方。菜单统一走 `src/Menu.tsx`（`role="menu"`，↑↓/Home/End/Enter/Esc，外部点击关闭，焦点回触发键）；展开方向：渲染后量高度，下方放得下就向下（`top = anchor.bottom + 6`），放不下向上，两侧都放不下取较大一侧并限高滚动；项标题不换行、detail 单行省略号（悬停见全文），菜单宽 250–420px，滚动条与消息流一致（细、无箭头）。

空状态占位文字为「输入消息，@ 引用文件」，不提示只有会话内可用的斜杠命令；会话内占位文字仍包含 Enter 发送与 Shift+Enter 换行。

- 模型 chip（仅空状态）：「最近使用」（`listRecentModels` ∩ `listModels`，按 recents 顺序）+「全部模型」两组；不可用的模型带原因置灰。会话内切换在状态栏 pill（同一 ChoiceControl 数据与 Menu）。
- 档位 chip（仅空状态）：当前模型可用档位（会话来自 `reasoningEffortInfo`，草稿来自 `ModelInfo.capabilities.reasoningEffort`）；current≠effective 时提示「本 Turn 使用 X；Y 将在下一 Turn 生效」。选择写入 `prefs.lastEffort`。
- 预设 chip（仅空状态托盘）：`PERMISSION_PRESET_NAMES`；草稿里未触碰不计入选项。
- 运行中模型与预设控件禁用（title「当前 Turn 结束后可切换」），档位仍可切；Shell pill 同样 Turn 中禁用。
- 「＋」菜单：「添加图片…」（系统对话框 `pick_images`）与「引用文件…」（在光标处插入 `@` 并打开文件弹层）；`fileRefs` 为 null 时「引用文件…」置灰并给出原因。
- 图片附件三条路径：对话框、粘贴（剪贴板 image/* 文件）、拖入（`dragDropEnabled: false` 让 HTML5 drop 拿到 File 对象；非图片报「只能拖入图片」，不支持的类型报「不支持的图片类型（支持 PNG、JPEG、GIF、WebP）」）。缩略图 `<img>` + 文件名 + ✕（`aria-label`「移除 <名>」），object URL 随移除/卸载回收。附件存在且有 `getVisionHint` 时拉一次提示（如「当前模型不支持图片，将由 <模型> 描述后发送」）。发送载荷 `{ data: Uint8Array, mimeType, label }`，提交被拒时附件与草稿一并保留。
- `@` 引用：文件索引懒加载（`fileRefs.load()`，`key` 变化才重取；会话内 `key` 用 `view.turnCount`）。弹层按 `src/file-refs.ts` 的排序（文件名前缀 > 文件名包含 > 路径包含，同级短路径优先），Tab/Enter 选择插入 `@路径 `（含空格路径写成 `@"a b.txt" `；目录不带尾随空格、弹层继续展开列下一级）。纯文本里输入的 `@` 引用经 textarea 底下的镜像层高亮（`parseFileRefs` 区间上色，发送的仍是纯文本）。草稿/普通对话没有项目文件索引：`fileRefs` 为 null，输入 `@` 不弹层，菜单项 title 给出原因（`fileRefsUnavailable`）；空状态下项目文件搜索等 runtime 级 `fileIndex` 能力，见文末限制说明。

权限和提问请求显示在消息流底部；仅调用 `respondPermission` / `respondQuestion` 回传选择，权限判定仍在 Core。权限卡片按钮严格按 Core 给出的 `options` 顺序渲染（`allow_once 允许一次`、`allow_session 本会话允许`、`allow_project 本项目允许`、`deny 拒绝`、`deny_stop 拒绝并停止`），不自行增删选项；标题是「需要确认 · <操作>」（操作来自首个 subject kind：shell 执行命令 / edit 修改文件 / read 读取文件 / network 访问网络 / mcp 调用 MCP 工具 / subagent 启动子任务），右侧短理由来自审查结论（「审查器拿不准，交给你决定」「审查器建议拒绝」「审查器认为可以执行」，无审查为「按权限规则需要确认」），原始 reason 放 title。subject 逐行等宽显示（shell 前缀「<shell kind> ›」，路径按 `displayPath` 相对化）。键盘：卡片挂载即获得焦点，数字键 1–N 直选第 N 项（焦点在可编辑字段时数字键不触发）；Esc 立即拒绝（capture 阶段拦截并 preventDefault，焦点在输入框时也生效且不触发输入框的中断）——只有当目标在卡片内部（反馈 textarea 自己处理 Esc 退回选项）或输入框的补全/菜单弹层开着时让位。提问支持单选、多选、自由文本和明确拒答。

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

输入 `/` 显示分组补全弹层（`role="listbox"`）：「命令」组只含 `/compact`、`/mcp`；组结构（`completeSlash` 返回 `SlashGroup[]`，`id` 预留 `"skills"`）为将来技能命令留口，空组不渲染。

### 5.4 状态栏与上下文

`src/StatusBar.tsx` 左侧是会话控件 pill 组：模型（绿点 +「provider · model」+ ▾）、「思考 <level> ▾」、「权限 <preset> ▾」（预设值用警告色）、「Shell <kind> ▾」。模型与 Shell 打开与空状态 chip 共用的 `ChoiceMenu`（`src/Menu.tsx`，锚定 pill 自动向上弹出），模型菜单底部有「管理服务商…」，进入 设置 › 服务商；思考档位与权限预设用自绘下拉 `Dropdown`（见 5.6），选项带中文名与一句说明；数据来自 `useSessionControls`（模型/档位/预设复用 `controls.controls`，Shell 是 `shellControl`：`auto`（「自动选择」）+ 探测到的 shell，未安装的置灰并标注「未安装」，被 env/config 覆盖时菜单底部给提示；打开 Shell 菜单时调 `loadShells()` 探测）。选择分别调 `setModel` / `setReasoningEffort`（并写 `prefs.lastEffort`）/ `setPermissionPreset` / `setShell`。右侧不变：上下文用量（点击开上下文面板）、累计缓存命中、Turn 状态。

状态栏始终一行：右侧上下文与 Turn 状态固定不缩，左侧仅模型 pill 可收缩，过长名称省略号截断，悬停显示完整「provider · model」（运行中同时提示不可切换）。主区变窄时按容器宽度依次让位：≤900px 隐藏累计缓存命中 → ≤820px 隐藏上下文进度条 → ≤740px 隐藏 Shell 项 → ≤660px 隐藏模型名前的「provider · 」前缀；≤700px 另外收紧间距。模型名最后才省略，至少保留约 10 个字符（`min-width: 10ch`），上下文数值与 Turn 状态始终保留；窗口最小宽度仍为 760px（主区宽度还要减去左栏）。

上下文面板取 `describeContext`，展示总量与预算、分段堆叠条和数值；对话历史从 `history.breakdown` 细分用户消息、助手回答、工具调用与结果、压缩摘要，不从可见消息重新估算。来源文本按 `contextSourceLabel` 中文化（「内置提示词」「自定义提示词」「N 个工具」「N 项」「N 条」，路径按主目录缩写）。底部提示「可以输入 /compact 压缩」。

已知限制（等 RPC 能力）：空状态的项目文件搜索需要 runtime 级 `fileIndex`（`fileIndex` 目前是 session 级，前端已用 `Composer.fileRefs` 作为数据接缝，届时只换数据源）。

### 5.5 设置区

左栏底部「设置」进入设置区：左栏整列换成设置导航（「← 返回 Esc」、「设置」标题、常规 / 模型 / 服务商 / 外观 / 后台日志五项、底部一行说明），会话树不显示；主区换成对应页面。空状态与状态栏的模型菜单底部「管理服务商…」直接进入「服务商」。设置区以 `.settings-over` 盖在主区之上，原来的会话或空状态（`.mainpane`）保持挂载并设为 `inert`，所以「← 返回」或 Esc 回到的是同一个会话，滚动位置不变；在导航项之间切换不算返回。Esc 只在没有被下拉、对话框先处理时才返回（下拉的 Esc 会 `preventDefault` 并停止冒泡；设置区里有打开的对话框时不返回）。被盖住的会话的窗口级快捷键（权限卡片的 Esc 拒绝与数字键作答、输入框的 Esc 中断）在其所在区域 `inert` 时一律不响应。服务商页与常规 / 模型 / 外观页都走常驻的普通对话后台读写全局配置。

设置布局按容器宽度调整，不使用窗口媒体查询：整个设置区宽度 <1000px 时导航从 295px 收到 200px，会话左栏不变；设置主内容 <900px 时服务商列表从 252px 收到 200px，名称与右侧模型数各自单行省略。详情标题与不收缩的状态标签一行，操作按钮另起一行横排并允许换行。详情内容 <520px 时信息卡改两列，<320px 时改一列，值允许折行。模型表名称列至少 12ch，<520px 先隐藏最大输出，<400px 再隐藏上下文；名称和能力始终保留，长模型名折行，无横向滚动。页尾说明为「R 推理 · I 图片输入。默认模型在「模型」页修改。」，其中「模型」可进入模型页。

**多后台同步**：每个项目一个后台，服务端只在自己的变更后重载。桌面端（`src/backends.ts` 的 `BackendPool`）做协调：某个后台推来 `runtime.providersChanged`（它自己的服务商变更），或设置页写设置成功（`updateSettings` / `setDefaultModel` / 模型角色），就对**其他**已连接的后台各调一次 `runtime.reloadConfig`。为了不形成循环，`BackendPool` 为每个后台记一个「由我发起、通知还没到」的计数：发起 `reloadConfig` 前加一，该后台的下一次 `providersChanged`（服务端保证先于响应到达）消费一次计数且不再转发；`reloadConfig` 失败时把计数还回去，后台退出或释放时清掉。

#### 服务商

服务商页（`src/ProvidersPage.tsx`）在设置区内有自己的两列：

- **列表**：左列分「已配置」（`describeProviders`）与「可添加」（`listProviderPresets`，已按默认名配置过的预设不再列出，自定义类预设始终可添加）。行内显示状态点、「N 个模型」；当前会话正在用的服务商标「当前」（没有选中会话时取 `defaultModel` 的服务商，即新会话将用的那个），进入页面时默认选中它，凭据失效的行尾写「已失效」并标黄。
- **详情**：标题 + 操作按钮 + 信息卡（类型、地址、认证、凭据、保存位置、来源）+ 模型表。按钮组只看 `ProviderOverview.authKind`，不按预设名或文案推断：`apiKey` 有「换密钥」（`setCredential`，password 输入，保存后清空），`none` 且为向导条目时显示为「设置密钥」；`account` 有「退出登录」（`logoutProvider`，只删本机凭据，确认对话框说明），失效时信息卡上方出现「账号登录已失效」横幅和「重新登录」，登录等待卡片内联在详情里；向导条目另有「刷新模型列表」（`refreshUpstreamLimits`）与「删除」（`removeSetupProvider`）。打开的会话在用该服务商时删除按钮置灰，悬停说明「当前会话正在使用，不能删除」；服务端返回 `provider_in_use` 时同样置灰。来自其他配置层（config.json、项目配置）的条目只读：没有换密钥、删除置灰并说明。删除是否允许以服务端为准。账号的访问令牌过期但刷新令牌还在时显示「有效」（Core 规则，[provider-setup.md](../architecture/provider-setup.md) 第 6 节）。
- **模型表**：可搜索；列为名称、能力（R 推理、I 图片输入）、上下文（千分位）、最大输出（K），带「默认」「已编辑」标记；悬停行显示「设置」，打开模型设置对话框。
- **模型设置对话框**（`src/ModelSettingsDialog.tsx`）：显示名、上下文、最大输出、图片输入、推理、思考档位、协议、编辑工具八项，每项写来源（上游、推导、默认、已编辑等）；「全部恢复跟随」清掉全部用户值。改动只在「保存」时经 `saveModelSettings` 写入 providers.json 的 userModels，「取消」不写。推理选「否」时思考档位置灰。
- **添加服务商**：选「可添加」里的预设进入表单，字段由 `describeProviderSetup` 驱动（固定值只读显示；凭据方式按 apiKey / 环境变量 / 账号登录 / 外部文件，OpenRouter 可选浏览器登录或粘贴密钥）。「获取模型」调 `prepareProvider` 拿到草稿，之后「保存」才可点（`commitProvider`）；获取前保存置灰，获取后改任何字段都作废结果、释放草稿并重新置灰。获取期间可「取消获取」：前端立即回到可编辑，输入保留，晚到的响应若带回草稿立即 `discardProvider` 释放。结果区显示「已获取 N 个模型」与 notices，并按 `PrepareProviderResult.models` 预览：折叠时列前 4 个模型名和「等 N 个」，「展开全部 ▾」后是限高、内部滚动的表格（名称、能力、上下文、最大输出），「收起 ▴」还原，每次重新获取都回到折叠。失败写「获取失败」与原因；`-32005` 带 `data.field` 时错误只显示在对应字段下，结果区不再重复「获取失败」——与已有服务商重名也以 `field: "name"` 报告（[provider-setup.md](../architecture/provider-setup.md) 第 2 节「名称唯一性」）。`needsManualModel` 时出现「模型 ID」输入框。「取消」、切走或离开页面都会 `discardProvider` 释放草稿，进行中的草稿登录经 `login.cancel` 取消（RPC 层把 Core 的 `discardDraftLogin` 映射为 `login.cancel`）。
- **登录**：`login.start` / `login.startDraft` 后用外链白名单打开系统浏览器；等待卡片（`src/LoginWaitCard.tsx`）有复制链接、重新打开浏览器、取消、倒计时（以 `LoginStarted.expiresAt` 为准，仅展示），可展开「粘贴回调地址 / 粘贴授权码」走 `login.submitManual`。`login.completed` 带 `unstoredKey` 时密钥只在卡片里显示这一次，前端不存储、不打日志。
- **同步**：服务商变更后后台推 `runtime.providersChanged`，页面、状态栏模型菜单与空状态模型 chip 随之刷新，其他后台经上面的协调重载。

### 5.6 常规、模型与外观页

`src/SettingsPage.tsx` 按导航项渲染三页，页头是标题与一句说明。按 [ADR-0045](../decisions/ADR-0045-fullscreen-page-shell.md) 第 7 节逐项保存，每行右侧写来源层：

| 页 | 分组 | 项 | 保存方式 |
| --- | --- | --- | --- |
| 常规 | 权限 | 默认权限预设 | 下拉（`Dropdown`），首项「跟随默认」标出当前生效值；改完立即 `updateSettings`，提示「已保存 默认权限预设 = X」 |
| 常规 | 权限 | 安全审查 | 对话框：关闭 / Jev / 小模型；Jev 首次启用先显示数据外发说明（偏好 `jevDisclosureAccepted`），沿用其他服务商的凭据时用下拉选服务商，单独密钥用 password 输入、经 `reviewerKey` 提交、保存后清空 |
| 常规 | 执行 | Shell | 只读，写明由谁指定；会话内在状态栏切换 |
| 常规 | 执行 | 压缩阈值 | 对话框，百分比或 token 数，留空恢复默认 |
| 常规 | 普通对话 | 工作区 | 「更改…」选目录、「恢复默认」；只写 prefs |
| 模型 | 默认 | 默认模型与档位 | 对话框，`setDefaultModel` 成对保存；所选模型没有档位时传 null |
| 模型 | 模型角色 | 子代理模型 / 看图模型 / 轻量模型 | 对话框选择模型或清除；看图模型只列支持图片输入的模型。页尾链接「服务商 › 模型表」进入服务商页改单个模型的设置 |
| 外观 | 主题 | 跟随系统 / 浅色 / 深色 | 三张预览卡片（`role="radio"`），只写 prefs，立即生效 |

模型页的已选值先显示模型名与档位（如 `deepseek-v4.1-flash · high`），服务商放次行并在 title 中保留完整值；模型名可折行，服务商单行省略。设置主内容 <700px 时模型行的值移到第二行，占满可用宽度，来源仍保留在标题右侧。

保存失败时值回到原样，该行描红并写「保存失败：原因，已恢复原值」；保存的值被更高层覆盖时来源写「已被覆盖 · 层名」并标黄。写设置成功后通知 `BackendPool` 让其他后台重载（5.5）。

主题写 `document.documentElement.dataset.theme`，跟随系统时删掉该属性回到 `prefers-color-scheme`。更改普通对话工作区时先在新位置开常驻后台，成功后写 `prefs.plainWorkspace` 并把新旧路径记进 `prefs.plainWorkspaces`，旧位置的对话仍归「对话」区；旧位置没有打开的会话时释放其后台。

**下拉**（`src/Dropdown.tsx`，desktop-v4.html A 屏）：设置页的下拉与状态栏的思考档位、权限预设菜单共用这一个组件，不用原生 `select`。触发器是 `role="combobox"`（`aria-haspopup="listbox"`、`aria-expanded`、打开时 `aria-controls` 指向 `role="listbox"`），焦点始终留在触发器，当前项用 `aria-activedescendant` 指示，选项是 `role="option"`（`aria-selected`，不可选的 `aria-disabled` 并悬停说明原因）。键盘：Tab 聚焦；Enter / 空格 / ↓ 打开；↑↓ 移动并跳过不可选项，Home / End 到首尾；Enter / 空格选择并关闭；Esc 关闭、焦点留在触发器且不冒泡给外层；Tab 关闭。点外部关闭。列表 `position: fixed`，优先向下，下方放不下且上方更宽裕时向上（状态栏在底部），放不下时限高滚动，最小宽 300px。每个选项是「名称 + 中文名 + 一行说明」，危险项（`bypass`）排在分隔线之后并用警告色。权限预设与思考档位的中文名和说明只在 `src/choice-info.ts` 维护一份。输入框卡片与托盘里的 chip 菜单仍用 `ChoiceMenu`。

已知限制：RPC 请求不能真正中止，「取消获取」只在前端丢弃结果。

### 5.7 后台日志页

「后台日志」（`src/BackendLogsPage.tsx`）查看运行中后台的 stderr：页头写明「后台进程 stderr 的内存缓冲（最近 500 行），不写盘、不轮询」；一个后台选择器（`Dropdown`，列出每个项目后台与常驻聊天后台，标签为「项目名（类型） + 工作区」）、等宽字体日志区、「刷新」与「复制全部」按钮（`backend_stderr` 只在打开页面或点「刷新」时调用，不轮询；「复制全部」把当前显示的缓冲整体写进剪贴板）。没有运行中的后台时选择器置灰并写「打开一个会话后再来看」；所选后台缓冲为空时写「该后台暂无 stderr 输出；已退出后台的最后几行日志显示在崩溃横幅里」（退出后缓冲已回收，只有 `closed` 消息保留了尾部，见第 1 节日志边界）。读取失败显示错误与重试。

## 6. 安全边界

- `capabilities/main.json` 只授予：七个应用命令（`allow-backend-open/send/close/stderr`、`allow-node-probe`、`allow-plain-workspace`、`allow-pick-images`）、`core:path:allow-resolve-directory`（前端 `homeDir()` 主目录解析所需；`pick_images` 的对话框与读文件都在 Rust 侧，不需要它）、窗口权限 `core:window:allow-minimize`、`allow-toggle-maximize`、`allow-internal-toggle-maximize`（Tauri drag-region 的原生双击）、`allow-close`、`allow-start-dragging`、`allow-is-maximized`（后五项同属 `core:window:`）、`dialog:allow-open`、`opener:allow-open-url`（scope 只允许 `https:*` 与 `http://127.0.0.1:*` / `http://localhost:*`）。不授予 `core:default` 或 `core:window:default`，不启用 fs、shell、http 插件，`withGlobalTauri: false`。
- 主窗口 `dragDropEnabled: false`：关掉 Tauri 的原生拖放接管，HTML5 drop 才能向输入框交付 `File` 对象（图片附件的拖入路径）。
- CSP：`default-src 'self'`；`connect-src` 只允许 `ipc:`/`http://ipc.localhost`；图片额外允许 `blob:`（图片附件预览用）；禁 `object-src`、`base-uri`、`form-action`、`frame-ancestors`。dev 模式（`devCsp`）仅为 Vite 额外放开 `ws://localhost:1420`、`http://localhost:1420` 与 style `'unsafe-inline'`。
- 外链白名单（`src/external-url.ts`）：`https:` 放行；`http:` 仅 `127.0.0.1` 与 `localhost`（本机回调页）；其余协议与解析失败忽略不打开。Rust 侧 opener scope 与之一致。
- 前端只用本机字体，不加载远程资源；不持久化任何凭据或会话内容。

## 7. 依赖边界与运行方式

`apps/desktop/src` 只能引 `@nocturne/rpc/client` 与 `@nocturne/core/protocol`，不引 core 运行时、其他 workspace 包、Node 内置模块（含 Node 全局，eslint `no-restricted-globals` + depcheck `desktop-*` 规则强制）。Vite/vitest 用 alias 直接跑 `packages/rpc/src/client` 与 `packages/core/src/protocol` 源码，dev 与测试不需要先构建 rpc。

- `pnpm desktop:dev`（= `pnpm --filter @nocturne/desktop dev` → `tauri dev`，自动先跑 `pnpm vite`）：开发运行，后台用 `apps/cli/dist/main.js`，需先 `pnpm build`。
- `pnpm desktop:build`（根 `package.json`）：依次跑 `pnpm build` → `node scripts/bundle-nctrn.mjs` → `tauri build`（`beforeBuildCommand` 自动先跑 `pnpm vite build`），任何一步失败即终止。产出 NSIS 安装包 `apps/desktop/src-tauri/target/release/bundle/nsis/Nocturne_<ver>_x64-setup.exe`：per-user 安装（`installMode: "currentUser"`，装进 `%LOCALAPPDATA%\Nocturne`，不需要管理员权限），不签名，不打包 Node（用户需自装 ≥ 24.14.0）；`resources/nctrn.mjs` 随包放进安装目录根。卸载器只删安装目录，用户数据（`%APPDATA%\io.github.kanzaki-chiya.nocturne`）按 Tauri 默认保留。Rust 工具链只在这条流程需要。
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`（vitest + jsdom，完全离线，进入默认测试集）覆盖 `src/` 与 `test/`；`pnpm build` 不构建桌面端，也不需要 Rust。
- Rust 外壳只在 `desktop:*` 流程需要：在 `apps/desktop/src-tauri` 手动跑 `cargo build`、`cargo test`（切行、版本解析、关闭超时、进程级转发）、`cargo clippy --all-targets`；不进默认测试集。
