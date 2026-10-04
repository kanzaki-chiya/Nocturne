# 桌面端（Tauri 外壳 + React 前端）

> 状态：v0.5 骨架与连接已实现（[ADR-0046](../decisions/ADR-0046-desktop-tauri.md) 第 9 节第 1 步）；会话视图、服务商与设置页在后续步骤｜前置阅读：[protocols/rpc.md](../protocols/rpc.md)｜代码位置：`apps/desktop/`

`apps/desktop` 是 Nocturne 的桌面端：一个 Tauri 进程内，React 前端经 `@nocturne/rpc/client` 与若干 `nctrn rpc --stdio` 后台进程通信，Rust 外壳只负责进程管理与按行转发。所有会话语义（握手、方法调用、事件）都在前端处理，外壳不解析报文。

## 1. 进程结构与后台策略

- **一个项目一个后台**：`backend_open` 以项目目录为 cwd 启动 `node <脚本> rpc --stdio`，同一项目的会话共用这个后台。会话列表是全局的（`<NOCTURNE_HOME>/sessions`），前端用任意一个运行中的后台 `runtime.listSessions()` 取全部会话。
- **常驻后台**：应用启动即以普通对话工作区（见第 3 节）为 cwd 开一个后台，用它列出全部会话，窗口打开期间常驻；项目的后台仍按原规则在打开该项目的会话时才启动（第 2 步实现）。因此第一次启动、没有任何项目时，左栏也能直接列出全部会话。
- **后台生命周期**：窗口关闭时对所有后台并行执行关闭（关 stdin → 等自行退出 → 5 秒强杀），全部结束后退出应用；Windows 上后台在 spawn 后被放入全局 Job Object（`KILL_ON_JOB_CLOSE`），外壳被强杀时后台一起结束。Job 创建或加入失败不致命，往该后台的 stderr 缓冲记一行说明。
- **日志边界**：stdin/stdout 的内容在任何地方都不记录、不打印、不写盘（报文里可能含密钥明文）；stderr 按行截断（64 KiB/行）保留最近 500 行在内存中，随 `closed` 消息交给前端。

## 2. 命令与消息格式

Rust 外壳提供五个 Tauri 命令（经 `tauri_build` 的 `AppManifest::commands` 声明为应用命令，在 `capabilities/main.json` 中逐个授予 `allow-backend-open` 等权限；第 4 步再加 `backend_stderr`，共六个），错误统一返回可序列化的 `{ code, message }`（message 为中文）：`node_unavailable`、`backend_script_missing`、`invalid_workspace`、`spawn_failed`、`unknown_backend`、`workspace_unavailable`、`io`。

| 命令 | 参数 → 结果 | 说明 |
|---|---|---|
| `backend_open` | `{ workspace, channel }` → `backendId`（u32，自增） | 校验工作区目录存在；取缓存的 Node 探测结果（无缓存先探测一次，不满足报 `node_unavailable`）；解析后台脚本；spawn 后 stdout 行经 channel 推给前端 |
| `backend_send` | `{ backendId, line }` → `null` | 写 `line + \n` 到该后台 stdin 并 flush；每个后台的 stdin 有独立 Mutex |
| `backend_close` | `{ backendId }` → `null` | 关 stdin、等自行退出、5 秒超时强杀，进程确实结束才返回；重复调用或对已退出的后台调用返回 `null` |
| `node_probe` | `{}` → `NodeProbe` | 每次重新探测并刷新缓存（说明页的「重新检测」） |
| `plain_workspace` | `{}` → 绝对路径字符串 | 解析 `<NOCTURNE_HOME>/workspace`（`NOCTURNE_HOME` 规则与 Core `nocturneHome()` 一致），不存在时创建（POSIX 上新建目录 0700），返回绝对路径；失败报 `workspace_unavailable` |

`plain_workspace` 单独成命令而不并入 `backend_open`：前端归类「对话」需要这个路径且目录必须由外壳创建，而 `backend_open` 仍只接受已存在的目录——前端不能借它创建任意目录。

Channel 消息（serde tag `kind`）：

```ts
type BackendMessage =
  | { kind: "line"; line: string }
  | { kind: "closed"; code: number | null; stderr: string[] };
```

`code` 是退出码，被强杀或拿不到时为 `null`；`stderr` 是该后台内存缓冲的全部内容（≤500 行）。监督线程（`try_wait` 约 50ms 轮询）在进程退出后等待 stdout 读线程排空（最多 2 秒，防孙进程继承管道卡住），保证**所有 line 消息都在 closed 之前发出**；closed 每个后台只发一次。stdout 切行上限 64 MiB/行，超过则记一行 stderr 并强杀后台（宁可显式失败也不悄悄丢报文让请求挂死）。

前端 `TauriLineTransport`（`src/transport.ts`）把这套命令实现成 `LineTransport`：`send` 经 promise 链串行保证顺序（写失败吞掉，断开会经 closed 体现）；注册 `onLine` 前到达的行被缓冲并按序交付；`closed` 在已交付完缓冲行后触发 `onClose`（只一次）；`exited` 暴露退出结果；`backend_open` 失败包装成带 `code` 的 `DesktopError`。`BackendPool`（`src/backends.ts`）按 `projectKey` 保持一个后台并做握手，退出时移出池并通知 UI（显示「后台已退出（退出码 N）」与「重新连接」）。

## 3. Node 查找与说明页

查找顺序（`src-tauri/src/node.rs`）：

1. 环境变量 `NOCTURNE_NODE`（非空即视为指定；文件不存在直接失败，后续步骤记 `skipped`）；
2. 资源目录 `<resource_dir>/node/node.exe`（非 Windows 为 `node`；本版不随附，`not-bundled`）；
3. `PATH` 逐目录找 `node.exe` / 可执行的 `node`。

找到后运行 `<node> --version`（5 秒超时，Windows 加 `CREATE_NO_WINDOW`；`.cmd`/`.bat` 脚本由 Rust std 自动经 cmd.exe 执行），取 stdout 第一行。版本解析接受可选 `v` 前缀、忽略 `-`/`+` 后缀，要求 ≥ 24.14.0（ADR-0046 第 2 节；与根及 CLI 的 `engines` `>=24.14` 一致）。

`NodeProbe` 结构（camelCase；步骤恒为 env/bundled/path 三项，`status` 为 kebab-case）：

```ts
type NodeSource = "env" | "bundled" | "path";
interface NodeProbeStep { source: NodeSource; status: "unset" | "not-bundled" | "missing" | "found" | "skipped"; path: string | null }
interface NodeProbe {
  required: string;   // "24.14.0"
  steps: NodeProbeStep[];
  selected: { source: NodeSource; path: string; version: string | null; error: string | null } | null;
  ok: boolean;
}
```

探测不通过时前端显示说明页（`src/NodeHelp.tsx`）：逐项展示查找结果、要求版本与「打开 nodejs.org」「重新检测」按钮；重新检测通过后不重启应用直接进正常流程。

## 4. 后台脚本路径

- 环境变量 `NOCTURNE_DESKTOP_BACKEND` 非空则优先使用；
- debug 构建用 `<仓库>/apps/cli/dist/main.js`（`pnpm build` 的产物）；
- release 构建用 `<resource_dir>/nctrn.mjs`（随应用打包，第 4 步实现）。

文件不存在报 `backend_script_missing`，message 带路径并提示先 `pnpm build`。

## 5. 会话树与界面状态

左栏结构从上到下（`src/session-tree.ts` 为纯函数，`src/Sidebar.tsx` 渲染）：「＋ 新会话」（本步置灰不可点，第 2 步实现）→「置顶」→「对话」→「项目」。

- **空会话过滤**：`firstText` 缺省或 trim 后为空且未锁定的会话不显示（置顶、对话、项目都过滤）；被锁定的空会话照常显示为「未命名会话」。
- **对话**：普通对话工作区 `<NOCTURNE_HOME>/workspace` 的会话平铺列出（cwd 经 `projectKey` 归并比较），按 `mtimeMs` 降序，默认前 5 条 +「展开显示（还有 N 个）」/「收起」；已置顶的不重复出现，置顶的对话会话项目标签为「对话」。手动项目里路径等于工作区的也不显示为项目。还没拿到工作区路径时所有会话按项目处理。
- **项目**：项目 = 其余会话 `cwd` 的归并键 ∪ 手动添加的项目 − 隐藏项目。`projectKey(path)` 去末尾分隔符（根目录除外）；像 Windows 路径（`盘符:` 或含 `\`）则统一 `\` 并小写。显示用第一次见到的原始路径，项目名取末段。排序存 `projectSort`：默认「最近活动」（有会话的项目按最新 `mtimeMs` 降序，其后是无会话的手动项目按添加顺序），「名称」时对全部项目按名称排序；项目内规则同对话区。「项目」标题行右侧的「…」（弹出菜单：排序、已移除的项目…）与「＋」（打开项目）在悬停时显示；项目行悬停显示的「＋」在该项目新建会话（第 2 步实现，本步置灰）。「…」菜单的「已移除的项目…」列出隐藏的项目（显示名称、悬停见完整路径），点一项即从隐藏集合移除并恢复显示。
- **置顶**：按置顶数组顺序列出仍存在的会话，每条标出所属项目名（对话为「对话」）；置顶不受项目隐藏影响。右键会话行置顶/取消置顶，右键项目标题「从列表移除」（把项目路径加入隐藏集合，不删会话、不动手动项目列表，可在「…」菜单恢复）。
- 会话行：`firstText ?? "未命名会话"`，meta 为相对时间（<60s「现在」<1h「N 分钟」<24h「N 小时」<48h「昨天」<30d「N 天」否则 `YYYY-MM-DD`，锁定加「🔒 」前缀）；状态 `idle`/`running`/`pending` 本步恒为 `idle`，组件已支持另外两种（`.dot.run`、`.dot.warn` + `.meta.pend`「待确认」）。

界面状态存 localStorage 键 `nocturne.desktop.prefs.v1`：`{ pinned: string[]; projects: string[]; hidden: string[]; projectSort: "activity" | "name" }`（会话 id、原始路径、项目路径；`projectSort` 缺省 `"activity"`；旧数据里的 `lastProject` 字段忽略）。读写失败均不影响本次运行，写失败时 `persistent` 标为 false（`src/prefs.ts`）。

启动流程：`node_probe` → 不 ok 显示说明页；ok 后 `plain_workspace` 取普通对话工作区 → `ensure` 开常驻后台（握手）→ `listSessions()`（不传 cwd）。`plain_workspace` 或 `ensure` 失败显示真实错误与「重试」，后台退出横幅的「重新连接」同样重走这条链。「打开项目…」（「项目」标题行的「＋」）走系统文件夹对话框 → 加入手动项目、取消隐藏、刷新列表，不启动后台。列表在连上后、打开项目后、窗口重新获得焦点时（节流 ≥ 2 秒）刷新。主区未选中会话时提示「从左侧选择一个会话」，一个会话都没有时提示「还没有会话」。

## 6. 安全边界

- `capabilities/main.json` 只授予：五个应用命令（`allow-backend-open/send/close`、`allow-node-probe`、`allow-plain-workspace`）、`dialog:allow-open`、`opener:allow-open-url`（scope 只允许 `https:*` 与 `http://127.0.0.1:*` / `http://localhost:*`）。不启用 fs、shell、http 插件，`withGlobalTauri: false`。
- CSP：`default-src 'self'`；`connect-src` 只允许 `ipc:`/`http://ipc.localhost`；图片额外允许 `blob:`（图片附件预览用）；禁 `object-src`、`base-uri`、`form-action`、`frame-ancestors`。dev 模式（`devCsp`）仅为 Vite 额外放开 `ws://localhost:1420`、`http://localhost:1420` 与 style `'unsafe-inline'`。
- 外链白名单（`src/external-url.ts`）：`https:` 放行；`http:` 仅 `127.0.0.1` 与 `localhost`（本机回调页）；其余协议与解析失败忽略不打开。Rust 侧 opener scope 与之一致。
- 前端只用本机字体，不加载远程资源；不持久化任何凭据或会话内容。

## 7. 依赖边界与运行方式

`apps/desktop/src` 只能引 `@nocturne/rpc/client` 与 `@nocturne/core/protocol`，不引 core 运行时、其他 workspace 包、Node 内置模块（含 Node 全局，eslint `no-restricted-globals` + depcheck `desktop-*` 规则强制）。Vite/vitest 用 alias 直接跑 `packages/rpc/src/client` 与 `packages/core/src/protocol` 源码，dev 与测试不需要先构建 rpc。

- `pnpm desktop:dev`（= `pnpm --filter @nocturne/desktop dev` → `tauri dev`，自动先跑 `pnpm vite`）：开发运行，后台用 `apps/cli/dist/main.js`，需先 `pnpm build`。
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`（vitest + jsdom，完全离线，进入默认测试集）覆盖 `src/` 与 `test/`；`pnpm build` 不构建桌面端，也不需要 Rust。
- Rust 外壳只在 `desktop:*` 流程需要：在 `apps/desktop/src-tauri` 手动跑 `cargo build`、`cargo test`（切行、版本解析、关闭超时、进程级转发）、`cargo clippy --all-targets`；不进默认测试集。
