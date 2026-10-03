# ADR-0044：RPC 第一版：stdio 上的 JSON-RPC，一个进程一个 Runtime

- 状态：已接受（维护者 2026-10-03 确认：服务商向导改为原生数据接口；一个后台一个客户端；暂不拆 `packages/protocol`）
- 日期：2026-10-03

## 背景

桌面端选定 Tauri（维护者 2026-10-03 决定，理由是不想像 Electron 应用那样臃肿）。Tauri 的外壳是 Rust，界面跑在系统 WebView 里，Core 是 Node 代码，只能作为附带的 Node 进程运行。界面和 Core 不在同一进程，所以桌面端之前必须先有进程外的接口。

[ADR-0002](ADR-0002-ui-independent-core.md) 早已定下"命令进、事件出"，并规定 RPC 序列化的是同一组语义、不另起一套。[events.md](../protocols/events.md) 第 1 节规定远程客户端先按 `seq` 回放持久事件、再接收实时事件。[modules.md](../architecture/modules.md) 第 5 节预留了 `rpc` 模块，[repository-layout.md](../development/repository-layout.md) 第 3 节写了实现 RPC 时拆出服务端包。本 ADR 把这些预留落成可实现的决定。

盘点现有客户端（TUI、CLI）对 Core 的实际用法，有三处不能直接序列化：

1. **绕过公开 API 读内部会话**：TUI 和 CLI 通过 `RuntimeSession.session.durableEvents()` 取持久事件来回放视图，`session` 是内部 `Session` 对象。
2. **回调式交互**：服务商向导经 `WizardIo`（`ask`、`askSecret`、`chooseMulti` 等）由 Core 回调客户端；登录经 `LoginSession`，内含 `completion: Promise` 和方法。
3. **装配在 CLI 里**：`loadConfig`、代理设置、MCP 连接器、`createRuntime` 的组装都在 `apps/cli`，不在 Core。

## 决定

### 1. 传输与报文

- 第一版只做 **stdio**：服务端从 stdin 读、向 stdout 写，stderr 只用于诊断。不开网络端口。
- 报文用 **JSON-RPC 2.0**，每行一条 JSON（以 `\n` 分隔，不用 Content-Length 头）。MCP 也用 JSON-RPC，团队和工具链都熟悉；按行分隔便于调试和用 Tauri 逐行转发。
- 三种报文：客户端→服务端的请求（有 `id`，等结果）、客户端→服务端的通知（无 `id`，如中断）、服务端→客户端的通知（事件推送）。没有服务端→客户端的请求：需要用户参与的流程一律是"通知或事件 + 客户端请求回复"（ADR-0002 第 3 条）。
- 二进制数据（图片附件）用 base64 字符串。单图上限沿用 ADR-0023 的 5 MB，编码后约 6.7 MB 一行，可接受。

### 2. 进程与包

- 服务端入口是 **`nctrn rpc --stdio`**，放在 `apps/cli`，复用 CLI 现有的配置加载、代理、MCP 装配。桌面端附带的 Node 单文件就是 `nctrn` 本身，一个构建产物同时当 CLI 和桌面端后台用。
- 新增 workspace 包 **`packages/rpc`**，两个入口：
  - `@nocturne/rpc/server`：给定一个 `Runtime`，把公开 API 映射成 JSON-RPC 方法、把事件推成通知。只依赖 Core 公开入口，与传输无关（stdio 只是第一种接入）。
  - `@nocturne/rpc/client`：类型化的客户端封装，运行时只依赖 `@nocturne/core/protocol`（事件类型与视图 reducer），对 `@nocturne/core` 只允许 `import type`。由 depcheck 规则强制。桌面端前端只引这个入口和 `protocol`，打包不会带进 Node 代码。
- 暂不拆 `packages/protocol`：`protocol` 子路径本身是纯函数、无 I/O，已满足"客户端只依赖协议类型"。哪天有非 TypeScript 客户端再拆。repository-layout.md 第 3 节里"实现 RPC 服务端时拆出 `packages/server`"一行改为指向 `packages/rpc`。
- **一个服务端进程只有一个 Runtime、一个客户端**，可以同时打开多个会话（桌面端多标签）。多客户端共享同一进程留到以后；跨进程仍由会话锁（ADR-0009）互斥。

### 3. 握手与版本

- 第一条请求必须是 `initialize`：客户端报 `protocolVersion`（整数）、`clientName`、能力（`interactive`：能否回复权限与提问请求）。
- 服务端回 `protocolVersion`、`nocturneVersion`、`sessionsDir` 等只读信息。版本不一致直接报错，第一版不做向下兼容；桌面端和后台随同一版本发布，不会错配。
- `interactive` 决定传给 `createRuntime` 的 `interactive`：客户端声明不能回复时，权限请求按配置的非交互规则处理，与今天的 `-p` 模式一致。

### 4. 方法映射

方法名按对象分组，参数是对象，会话方法都带 `sessionId`：

| 分组 | 方法（与公开 API 一一对应） |
|---|---|
| `runtime.*` | `listSessions`、`createSession`、`resumeSession`、`forkSession`、`listModels`、`defaultModel`、`listRecentModels`、`describeSettings`、`updateSettings`、`setDefaultModel`、`describeModelRoles`、`setModelRole`、`getPreference`、`setPreference` 等 |
| `session.*` | `submit`、`respondPermission`、`respondQuestion`、`setModel`、`setPermissionPreset`、`setReasoningEffort`、`setShell`、`compact`、`rewindTargets`、`rewind`、`describeContext`、`reasoningEffortInfo`、`shellInfo`、`listShells`、`visionInfo`、`mcpServers`、`fileIndex`、`readInputHistory`、`recordInputHistory`、`close` |
| 通知（客户端→服务端） | `session.interrupt` |

- `session.submit` 的请求一直挂到 Turn 结束，结果是 `TurnEndReason`，与进程内 `submit()` 的 resolve 时机相同。中断不取消这个请求，而是发 `session.interrupt`，请求随后以 `aborted` 返回。
- 方法清单以公开 API 为准，不在 RPC 层另加能力。公开 API 新增方法时，`packages/rpc` 同步加映射，并由测试检查两边的方法集合一致。
- 错误：`RuntimeCommandError`、`SessionError`、`ProviderLoginError` 等映射为 JSON-RPC error，`code` 用实现定义区间内的固定值，`data.code` 带原来的字符串错误码（如 `session_busy`、`unknown_request`），`message` 是原来的用户可读文案。客户端按 `data.code` 分支，与进程内按 `error.code` 分支等价。

### 5. 事件订阅与回放

- `runtime.createSession` / `resumeSession` 只打开会话、返回 `sessionId` 和摘要，不自动推事件。
- 客户端调用 **`session.subscribe { sessionId, afterSeq }`**：服务端先发 `seq > afterSeq` 的全部持久事件，再无缝衔接实时事件（持久与临时都推）。实现上先挂监听、缓冲，再读日志，读完后按 `seq` 去重冲刷缓冲，保证不丢不重。
- 推送格式：通知 `event`，参数 `{ sessionId, event: RuntimeEvent }`，事件原样是 events.md 的信封，不另包一层。
- 临时事件不回放：断开期间错过的流式片段、进度条不补发，与 events.md 对临时事件的定义一致。
- 客户端用 `protocol` 里的同一个 reducer 折叠视图。验收标准之一：同一会话经 RPC 回放得到的 `SessionView` 与进程内回放相等（view.md 第 6 节的重放等价）。
- 配套修改公开 API：`RuntimeSession` 增加 `durableEvents()`，TUI 和 CLI 改用它；`RuntimeSession.session`（内部对象）从公开类型中移除。这一步先于 RPC 实现，让进程内客户端与远程客户端走同一套接口。

### 6. 需要用户参与的流程

- **权限与提问**：已经是"事件请求 + 命令回复"，直接映射，无需改动。
- **登录**：`LoginSession` 拆成方法与通知。`login.start` 返回 `loginId`、`authorizeUrl`、`manualInput`、`userCode`；完成或失败以通知 `login.completed` 推送；`login.submitManual`、`login.cancel` 是请求。`login.start` 可以针对已保存的服务商（重新登录），也可以针对添加中的草稿（预设 id 加表单里的名称与地址），后者完成后把 `loginId` 交给 `addProvider`。账号凭据在无系统后端时的保存位置（明文或仅本次运行）作为 `login.start` 的参数，由表单显式选择。浏览器由客户端打开（Tauri 用系统浏览器），不由服务端打开。
- **服务商配置改为数据接口，不再回调客户端**。现有 `runProviderSetupWizard` / `runProviderKeyWizard` 经 `WizardIo` 一问一答，界面只能是问答式；桌面端要原生表单，所以 Core 改为"描述 + 提交"两个数据接口，向导的判断逻辑（哪些预设问名称与地址、哪些走登录、无凭据后端时怎么办、模型列表失败怎么提示）全部留在 Core：
  - `describeProviderSetup(presetId)`：返回这个预设需要填写的字段与可选的凭据方式（名称、服务地址、会话标识请求头、API key / 环境变量 / 浏览器登录 / 外部登录文件、账号凭据的保存位置），每项带默认值、是否必填、说明文案，以及当前凭据后端是否可用。客户端据此画表单，不自己判断预设差异。
  - `addProvider(input)`：一次提交表单。凭据部分是判别联合：`{ kind: "apiKey", key }`、`{ kind: "env", name }`、`{ kind: "login", loginId }`（引用已完成的登录，见上一条）、`{ kind: "external-file" }`。Core 校验、获取模型列表、保存条目、刷新 models.dev，返回 `{ providerId, modelCount, notices }`，`notices` 是"密钥可能无效""模型将手动填写"这类结果提示。校验失败以带字段名的错误返回，客户端标到对应输入框。
  - 换密钥用已有的 `setCredential`；模型设置编辑本来就是数据接口（`listModelSettings` / `saveModelSettings`），直接映射。
  - CLI 逐行向导与 TUI 服务商页改为基于这两个接口的外壳，行为与文案不变；`WizardIo` 及 `runProviderSetupWizard` / `runProviderKeyWizard` 在迁移完成后删除。provider-setup.md 第 6 节随之改写。
- `addProvider`、`setCredential` 的参数里有密钥明文，只在本机两个进程之间的管道里传输。服务端诊断日志对这类方法只记方法名，不记参数；客户端（Tauri 外壳）转发时同样不落日志。

### 7. 生命周期

- stdin 关闭（客户端退出或崩溃）即视为断开：服务端中断运行中的 Turn，关闭全部会话（刷盘、释放会话锁），关闭 MCP 进程，然后退出。
- 服务端异常退出时，客户端从 stdout 关闭得知，向用户报告并可重启后台、按 `afterSeq` 重新订阅。会话日志是唯一事实来源（ADR-0003），重启不丢已持久化内容。
- 客户端发 `shutdown` 请求时，服务端完成同样的清理后回复，再退出。

### 8. 安全边界

- 第一版不监听任何端口，不需要鉴权：能连上 stdio 的只有启动它的父进程，权限等同于运行 `nctrn` 的用户。
- WebSocket 或其他网络传输留到远程客户端需要时另写 ADR，届时必须带令牌鉴权和来源校验。
- 权限判定仍只在 Runtime 的权限层。RPC 层不判断"要不要确认"，只转发 `permission.requested` 与回复（AGENTS.md 硬性约束）。

### 9. 验证方式

- `packages/rpc` 的离线测试：在同一进程里用内存管道连接 server 与 client，用 `FakeProvider` 跑完整 Turn，覆盖握手、方法映射、错误映射、订阅回放无缝、权限与提问往返、中断、断开清理。
- 端到端：测试中启动真实的 `nctrn rpc --stdio` 子进程，跑一轮会话，核对回放视图与进程内一致。
- 不要求先做一个基于 RPC 的 CLI 模式；桌面端是第一个正式的远程客户端。

### 10. 分步实现

1. 公开 API 整理：`RuntimeSession.durableEvents()`，TUI/CLI 改用，移除公开的 `session` 字段；补充测试。
2. `packages/rpc`：报文层、server 映射、client 封装、订阅回放，离线测试。
3. `nctrn rpc --stdio` 入口与生命周期，端到端测试。
4. 服务商配置数据接口：Core 新增 `describeProviderSetup` / `addProvider`，CLI 与 TUI 向导迁移到其上（行为与文案不变，现有向导测试改写后全部通过），删除 `WizardIo`。
5. 登录与服务商配置的 RPC 映射。

每步结束运行全部检查，文档同步（modules.md 第 5 节转为正式模块、repository-layout.md 包表、events.md 第 1 节远程客户端一行指向本 ADR、新增 `docs/protocols/rpc.md` 作为方法与报文的主文档）。

## 后果

- 桌面端、将来的 IDE 插件和远程客户端共用一套接口，Core 不为任何一个客户端改行为。
- 公开 API 每加一个方法，RPC 也要跟一个映射，测试会强制两边一致；这是持续的维护成本。
- 服务商配置改成数据接口，CLI 与 TUI 的向导要迁移一遍，工作量比保留回调大；换来桌面端可以做原生表单，三个客户端共用同一套校验与提示，RPC 也不需要反向请求。
- 第一版一进程一客户端，桌面端同一窗口多标签没问题；多个窗口共享后台、或 TUI 与桌面端同时连同一后台，需要以后另行设计。
- `nctrn` 单文件同时承担 CLI 和桌面后台，分发（v0.7）和桌面端打包共享同一构建流程。

## 备选方案

- **WebView 直接通过本机 WebSocket 连 Node 后台**：少一层 Rust 转发，但要开本机端口，就得做鉴权和来源校验，防止浏览器里的任意网页连上来。stdio 由父进程独占，第一版更简单也更安全。
- **自定义报文格式**：没有收益；JSON-RPC 的请求、通知、错误三件套正好覆盖需要的语义。
- **Content-Length 分帧（LSP 风格）**：能承载多行内容，但 JSON 本身可以不含换行，按行分隔调试更直观，转发也更简单。
- **订阅时由服务端推送整份 `SessionView` 快照**：省去客户端折叠，但要在服务端维护视图并定义快照增量协议，违背"派生视图由 protocol reducer 在客户端计算"（ADR-0002 第 5 条）。
- **把装配从 CLI 移进 Core 或新包**：更"干净"，但改动面大且现在只有一个服务端入口；先让 `nctrn rpc` 复用 CLI 装配，等出现第二个入口再抽。
- **向导保留回调形状，映射成服务端→客户端请求**：改动最小，但桌面端只能做一问一答的界面，并且 RPC 要多支持一种反向请求。维护者选择做原生表单，不采用。


## 修订

### 2026-10-03：第 2 步实现时与正文不一致之处

正文不改，以本节为准：

1. **方法清单**：第 4 节表格里的 `runtime.*` 以"等"收尾，实际映射为公开 `Runtime` 的全部成员，包括 `listReviewerProviders`、`defaultReviewer`、`listReviewerModels`；另有 `session.subscribe` 的退订半边 `session.unsubscribe`。`Runtime.updateProviders` 的参数是含函数的进程内 `RuntimeConfig`，无法序列化，第 2 步不映射（在 `coverage.ts` 登记了原因），按第 10 节第 5 步改为服务端重载配置的数据方法。
2. **返回值形状**：`runtime.forkSession` 返回 `{ sessionId }`（对象，便于以后加字段），客户端封装仍还原成字符串；`createSession` / `resumeSession` 的结果 `SessionOpened` 带 `lastSeq`；`session.state` 去掉 `history` 与 `unsettledCalls`（历史可由持久事件折叠，后者是进程内 Map），`session.describeContext` 去掉发给模型的整份 `request`。
3. **通知的请求形式**：`session.interrupt` 除通知外也接受带 `id` 的请求（回复 `null`），便于只会发请求的简易客户端；语义相同。
4. **单订阅**：第 5 节未说明同一会话重复订阅。实现为同一会话同一时刻只有一路订阅，再次 `subscribe` 替换前一路（否则旧监听器会收到回放重复）；多个消费者用 `RpcClient.onEvent` 分发。
5. **错误码数值**：第 4 节只说"实现定义区间内的固定值"，现固定为：`-32000` 其他 Core 错误、`-32001` `RuntimeCommandError`、`-32002` `SessionError`、`-32003` `ProviderLoginError`、`-32004` RPC 层状态错误（`not_initialized`、`protocol_version_mismatch` 等）。完整表见 [rpc.md](../protocols/rpc.md) 第 5 节。
6. **客户端依赖规则更严**：第 2 节只要求运行时只依赖 `protocol`；depcheck 同时禁止客户端与共享层使用 Node 内置模块、依赖服务端，传输由使用方注入。
7. **慢订阅者**：[events.md](../protocols/events.md) 第 6 节预告"引入 RPC 时改为有界队列"。第一版 RPC 服务端不限流，事件直接写入传输（stdio 管道由操作系统缓冲），有界队列与临时事件丢弃策略留到出现慢连接问题时再定；events.md 第 6 节已同步。
8. **握手时创建 Runtime**：第 3 节说 `interactive` 决定传给 `createRuntime` 的值，因此 Runtime 在 `initialize` 时才创建（服务端以工厂函数注入，创建失败时握手报错、连接保持可重试）。

### 2026-10-03：第 3 步实现时与正文不一致之处

1. **"关闭 MCP 进程"**：MCP 连接是会话级的（[mcp.md](../architecture/mcp.md) 第 5 节），不存在进程级 MCP 句柄；"关闭全部会话"已包含 MCP 服务器进程树的清理，入口不另设 MCP 收尾步骤。
2. **参数范围**：`nctrn rpc --stdio` 不接受 `-y`、`--preset`、`-p`、`--cli`、`--tui`、`-c`、`--resume`、`--sessions`（用法错误，退出码 2）；`-y` 的"自动批准"与"权限由客户端决定"冲突，`--stdio` 缺省也是用法错误。配置层参数（`--model`、`--base-url` 等）与 `--debug` 照常生效。
3. **退出机制**：清理完成后依靠事件循环自然排空退出，另设 3 秒不阻止自然退出的兜底定时器强制 `process.exit`。直接在清理后立即 `process.exit` 会在 Windows 上触发 libuv 断言崩溃（退出码 `0xC0000409`，端到端测试发现）。终止信号（SIGINT/SIGTERM/SIGHUP）与 stdin 关闭等价。
4. **配置要求**：与 `trust` / `setup` 一致不要求已有模型或服务商，但配置里已声明却无法解析的模型/服务商照常以退出码 2 报错。
5. **打包**：`@nocturne/rpc` 的构建产物是 `.js` / `.d.ts`（`platform: "neutral"`），`package.json` 的 `exports` 按此声明。

### 2026-10-03：第 4 步实现时与正文不一致之处

正文不改，以本节为准：

1. **`describeProviderSetup` 的签名**：第 6 节写作按预设描述，实际为 `describeProviderSetup(config, presetId)`——"没有系统凭据后端"等差异取决于当前 `RuntimeConfig` 的凭据后端，描述必须带上它。描述额外给出 `fetchableModels`（提交时是否获取模型列表，界面据此显示"正在获取模型列表…"或"正在保存…"）与 `manualModel`（上游无列表时手填模型 ID 的提问）。
2. **文案的归属**：步骤摘要行、"已获取 N 个模型"、401/403 与其他失败的提示、保存后可用的命令提示、models.dev 警告、结果行"已保存 X，N 个模型"都由 Core 给出（`AddProviderResult.notices` / `message`，辅助函数 `setupFieldStep` / `setupCredentialStep` / `setupCredentialNotice`），客户端不拼文案。
3. **登录与草稿**：条目未保存时的浏览器登录经新增的 `startDraftProviderLogin`，会话带 `loginId`，凭据暂存在 Core（不落盘），`addProvider` 收到 `{ kind: "login", loginId }` 才校验并提交。账号凭据在获取模型列表之前写入存储（令牌要用来取列表）。
4. **保存位置的选择提前**：`ProviderLoginOptions.chooseAccountStorage` 回调删除（回调不能走 RPC），改为 `accountStorage: "plaintext" | "memory"` 参数，客户端先根据描述的 `accountStorage` 让用户选择再启动登录；缺省时 Core 在授权开始前就拒绝。**可见变化**：无系统凭据后端时，选择发生在浏览器授权之前，而不是授权完成之后。
5. **"确认页"先于获取模型列表**：`addProvider` 是一次性提交（校验 → 获取列表 → 保存 → 刷新 models.dev），所以 TUI 的「保存配置」确认页出现在获取模型列表之前；原来先获取、后确认的顺序无法在不回调的前提下保留。获取结果与失败提示改在确认之后显示；获取期间 Esc 中止请求并回到确认页（原为回到上一步重放答案）。Grok CLI 这类要手填模型 ID 的服务，在确认之后才出现「模型 ID」提问（`addProvider` 抛 `ProviderSetupError("modelId")` 后补问重交）。获取与保存期间的忙碌行文案为"正在获取模型列表…"或"正在保存…"。其余步骤、文案与结果行不变（见验收截图对照）。
6. **`WizardIo` 的去向**：Core 中的 `WizardIo`、`runProviderSetupWizard`、`runProviderKeyWizard`、`runProviderModelWizard` 与 `config/wizard.ts` 删除。CLI 与 TUI 需要完全相同的提问顺序，所以共享一份**客户端**流程放在 `apps/tui`（`provider-setup-flow`、`provider-prompts` 的 `SetupPrompts`/`SetupAbort`），CLI 经 `@nocturne/tui` 子路径引用；它只按 Core 的描述提问，不含预设判断。`/provider model` 的逐字段问答是纯客户端流程，移到 `apps/cli/src/model-wizard.ts`。`/provider key` 直接调用 `RuntimeConfig.setCredential`。
7. **未映射的方法**：`describeProviderSetup`、`addProvider` 与草稿登录依赖进程内的 `RuntimeConfig`，与 `Runtime.updateProviders` 一样留到第 5 步改为服务端数据方法，第 4 步不新增 RPC 映射。

- **2026-10-04：服务商准备与保存分离。** 第 4 步验收发现模型列表失败提示和 Grok CLI 模型 ID 被移到保存确认后。新增 `prepareProvider` / `commitProvider` / `discardProvider`；准备阶段只在内存解析及续期凭据、获取模型列表，不落盘或消费 loginId；草稿绑定配置，15 分钟过期清理。共享 CLI/TUI 流程先显示准备结果和手填模型再确认，桌面表单也可在保存前展示结果。保留 `addProvider` 为 prepare + commit 兼容组合。
- **2026-10-04：CLI/TUI 静态边界补齐。** 允许清单加入 provider-setup-flow、provider-prompts、provider-login，与既有 slash-catalog、text-format 共五个入口；其他 TUI 入口必须惰性加载。依赖规则同时覆盖 src 与 exports 指向的 dist，纯文本规则覆盖构建共享块，三个向导入口及其间接依赖不得加载 Ink/React。
- **2026-10-04：stdin EOF 先排空回复。** 第 7 节的“连接关闭”细化为输入结束与完整断开：EOF 不禁用输出，先中断运行中及尚未开始的 submit，等待已接收请求返回并刷出回复，再关闭会话和释放锁；只有输出 EPIPE 等完整断开才丢弃回复。`LineTransport` 增加可选 `flush()`，stdio 实现它以保证进程退出前输出已写完。
