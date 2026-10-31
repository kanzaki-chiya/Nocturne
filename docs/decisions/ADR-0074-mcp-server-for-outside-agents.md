# ADR-0074：对外 MCP 接口——外部 agent 经桌面后台驱动会话

- 状态：已接受
- 日期：2026-10-30
- 修订：[rpc.md](../protocols/rpc.md)（新增 `agent` 来源与本机管道接入）、[events.md](../protocols/events.md)（`session.created.client`）、[ADR-0052](ADR-0052-remote-web-client.md)（设备列表增加外部 agent）、[ADR-0051](ADR-0051-desktop-single-backend.md)（后台多一个本机接入）

## 背景

Nocturne 目前只是 MCP 客户端（[ADR-0011](ADR-0011-mcp-client.md)）。进程外能驱动 Runtime 的只有桌面端（stdio RPC）和配对过的手机（远程通道）。用户在终端里用 Claude Code、Codex 时，想让它们把一件事交给 Nocturne 的会话去做（换一个模型、换一个工作区、让人在桌面端旁观和介入），现在做不到。

参照：T3 Code 的环境自带 MCP 服务器（`docs/user/outside-agents.md`），外部 agent 登录一次、由用户选定能力范围（只读 / 可运行），之后可以列出、读取、新建会话、发消息；新建的会话权限不超过批准时选的档位；会话等用户回答时，等待结果返回「需要在应用里处理」。

两种做法：

- **`nctrn mcp` 自带 Runtime**：最简单，但它持有会话锁时桌面端打不开该会话，也没人能批准权限确认，只能非交互运行，剩余 `ask` 一律拒绝。
- **挂到桌面后台**：会话是同一个 Runtime 里的普通会话，桌面端实时可见，权限确认和提问照常在桌面端弹出。

本 ADR 采用后者。

## 决定

### 1. 结构：`nctrn mcp` 是 stdio 桥

- 用户在外部 agent 里登记：`claude mcp add nocturne -- nctrn mcp`（Codex 等同理）。
- `nctrn mcp` 对外是 stdio MCP 服务器（`@modelcontextprotocol/sdk`），对内是 RPC 客户端，经本机管道连接桌面后台。它不创建 Runtime，不读写会话日志，不读凭据。
- MCP 工具全部在桥里用现有 RPC 方法组合实现（第 4 节），**Core 不新增能力**，RPC 只新增接入与来源（第 2、3 节），沿用「RPC 层不另加能力」（rpc.md 第 8 节）。
- 代码位置：新包 `packages/mcp-server`（依赖 `@nocturne/rpc/client`、`@nocturne/remote`、MCP SDK，不依赖 Core 运行时）；CLI 只加子命令入口。依赖方向同步写进 [modules.md](../architecture/modules.md)。
- **桌面端未运行**：桥照常完成 MCP `initialize` 并列出工具，每次工具调用返回 `isError`：`Nocturne desktop is not running. Ask the user to open it, then retry.` 不自动拉起桌面端，不自带 Runtime 兜底。

### 2. 本机管道与 `agent` 来源

- 桌面端启动后台时加 `--agent-pipe`，后台在本机监听：Windows 为命名管道 `\\.\pipe\nocturne-agent-<用户 SID 哈希>`，ACL 只允许当前用户；其他平台为 `<nocturneHome>/agent.sock`，权限 `0600`。TUI、`nctrn rpc` 不加该参数时不监听。管道作为附加能力启动：若因同一 `nocturneHome` 下已有另一后台占用管道（`address_in_use`）、Windows SID 无法获取（`sid_unavailable`）、ACL 收紧失败（`acl_failed`）或其他原因（`other`）失败，不阻断本机 `initialize`（若监听句柄已创建但 ACL 收紧失败则先关闭句柄），记录日志并在 `agent.describe` /「设置 › 远程 › 外部 Agent」中显示未启动状态与原因。
- 管道上的每条连接以 `serve(transport, { origin: "agent" })` 接入。`origin` 由后台接入方指定，不从报文获取（同 rpc.md 第 1 节）。`agent` 连接与远程连接一样不创建 Runtime；本机连接尚未握手时报 `runtime_unavailable`。
- 管道上跑远程通道的握手与加密（[remote-channel.md](../protocols/remote-channel.md) 第 4–6 节，`acceptChannel` / `connectChannel` 不依赖底层传输），身份认证与远程设备同一套，不另起鉴权。
- **安全口径**：这是「征得用户同意、限定能力范围」的边界。同一系统用户下的其他程序能读到桥的身份文件，因此它防不住本机同用户的恶意程序；这与 `~/.nocturne` 本身的信任边界一致，在设置页的说明里写明。

### 3. 配对与能力范围

- 桥首次运行时生成长期身份，存在 `<nocturneHome>/mcp-bridge/identity.json`（仅当前用户可读），每个 `nocturneHome` 一份。
- 后台遇到未登记的身份时，不拒绝连接，而是向本机连接推 `agent.pairingRequested { requestId, clientName, fingerprint }`；`clientName` 取外部 agent 在 MCP `initialize` 里给的 `clientInfo.name`。桌面端弹窗显示名称与指纹，用户选择：
  - **只读**：可调用第 4 节标为只读的工具；
  - **可运行**：全部工具，并选一个**权限上限**（`read-only` / `default` / `smart` / `guarded` / `bypass`，缺省 `default`）。
- 用户在本机回复 `agent.respondPairing { requestId, approve, scope?, maxPreset? }`。等待期间桥的工具调用返回 `Waiting for the user to approve this agent in Nocturne.`；2 分钟无应答视为拒绝。拒绝不登记，下次调用可再发起。
- 登记信息与手机设备存在同一份用户级配置里（项目层不能覆盖，同 ADR-0052），带 `kind: "agent"`。「设置 › 远程」的设备列表里外部 agent 单独一组，可改范围、吊销；吊销立即断开该连接。`agent.*` 方法与 `remote.*` 一样只开放给本机连接。
- `agent` 连接的白名单从远程白名单收窄而来（rpc.md 第 7 节的原则：撤销后不留后患）：
  - 只读范围：`runtime.listSessions`、`runtime.listModels`、`runtime.defaultModel`、`session.subscribe` / `unsubscribe` / `state` / `pendingInputs`、`runtime.resumeSession`（只用于读取，见第 4 节）、`session.close`。
  - 可运行范围另加：`runtime.createSession`、`session.submit`、`session.enqueueInput`、`session.interrupt`。
  - 一律不开放：`respondPermission`、`respondQuestion`（外部 agent 不能代替用户批准或回答）、`setPermissionPreset`、`rewind`、`forkSession`、全部设置、凭据、授权、信任、`schedule.*`、`runtime.readFile`。越界报 `-32004 / agent_not_allowed`，不调用 Core。
- `createSession` 的 `permissionPreset` 不能高于该 agent 的上限，缺省取上限与用户默认预设中较低者；超出报 `invalid_params`。工作区信任规则同远程（`workspace_untrusted`，信任只能在电脑上决定）。

### 4. MCP 工具

工具名带 `nocturne_` 前缀。会话范围**不限于该 agent 自己开的会话**：可以读、发消息、中断任一非子代理会话，与手机一致。

| 工具 | 范围 | 行为 |
|---|---|---|
| `nocturne_list_sessions` | 只读 | `{ cwd?, limit? }`，返回 id、标题、工作区、模型、状态、最后活动时间，新的在前，缺省 20 条 |
| `nocturne_read_session` | 只读 | `{ sessionId, turns? }`，打开并订阅，用 `protocol/view` 折叠，返回最近 `turns`（缺省 3）轮的用户消息与最终回复文本（不含思考与工具细节，工具调用只列一行名称和结果状态），以及当前状态 |
| `nocturne_list_models` | 只读 | 可用模型与默认模型 |
| `nocturne_start_session` | 可运行 | `{ cwd, prompt, model?, reasoningEffort?, permissionPreset?, wait? }`，新建会话并提交首条消息；返回 `sessionId`，`wait: true` 时同 `nocturne_wait` |
| `nocturne_send` | 可运行 | `{ sessionId, prompt, wait? }`，走 `enqueueInput` 的 `queue` 模式：**从不打断**，会话忙时排到下一轮，空闲时立即开始 |
| `nocturne_wait` | 可运行 | `{ sessionId, timeoutSeconds? }`（缺省 300，上限 600），等当前这一轮结束 |
| `nocturne_interrupt` | 可运行 | `{ sessionId }` |

- **状态**：`idle`、`running`、`waiting_for_permission`、`waiting_for_answer`、`paused`（待发输入暂停）。
- **等待结果**：Turn 结束返回 `{ status: "done" | "error" | "aborted", reply }`，`reply` 是最后一条助手消息的文本；超时返回 `{ status: "running" }`，不中断；会话停在权限确认或提问上时立即返回 `waiting_for_permission` / `waiting_for_answer`，附一行 `Ask the user to respond in Nocturne.`。客户端给了 `progressToken` 时，桥按步骤推 MCP 进度通知。
- 桥打开的会话引用在 MCP 连接关闭时释放（`session.close`），不影响桌面端已打开的同一会话。
- 输出是给模型读的纯文本 + `structuredContent`，单次结果超过 64 KB 时截断并说明，完整内容让用户在桌面端看。

### 5. 会话来源标记

- `session.created` 新增可选字段 `client?: { kind: "agent", name: string, deviceId: string }`，`agent` 连接创建会话时由 RPC 服务端填入（不取自客户端参数）。可选字段，旧版本忽略，不提升 `formatVersion`（events.md 第 8 节）。
- 桌面端与手机的会话列表在这类会话的标题旁显示一个小图标，悬停显示 agent 名称；不加文字标签。TUI 的 `/resume` 列表同样只加一个标记字符。

## 后果

- Claude Code、Codex 能把任务交给 Nocturne 的会话，用户在桌面端实时看到过程，权限确认与提问仍由用户本人处理；外部 agent 拿不到任何批准能力。
- 可运行范围的 agent 能往用户手动开的会话发消息，消息按**该会话自己的权限预设**执行：用户把某个会话设成 `bypass`，agent 发的消息也在 `bypass` 下跑。权限上限只约束 agent 新建的会话。这是选择「全部会话可写」的代价，在配对弹窗里用一句话写明。
- 没有开桌面端时外部 agent 用不了 Nocturne；纯 TUI 用户的独立模式以后另议。
- 后台多了一个本机接入面；它只在桌面端启动的后台上打开，能力受白名单与配对约束。
- 不做 HTTP + OAuth 的远程 MCP（给 ChatGPT 等托管 agent），不把桌面浏览器、定时任务等 Nocturne 自身能力包装成 MCP 工具。

## 备选方案

- **`nctrn mcp` 自带 Runtime**：会话锁与桌面端冲突，权限只能非交互拒绝，见背景。不采用。
- **localhost HTTP + 令牌**：MCP 客户端都支持，但要开 TCP 端口、处理令牌下发与轮换，同机其他用户也能连到端口；命名管道配合 ACL 更窄。HTTP 留给以后的远程 MCP。
- **只允许动 agent 自己开的会话**：更稳，但不能让外部 agent 接手用户手动开的会话；用户选择全开。
- **桥直接复用远程白名单**：远程允许 `respondPermission`、`setPermissionPreset`、`rewind`，对外部 agent 太宽；单独收窄。
