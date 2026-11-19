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

## 修订（2026-11-18）：队列暂停时的等待收束与轮间过渡状态

- **返回字段口径**：等待工具（`nocturne_wait`，以及 `nocturne_start_session` / `nocturne_send` 的 `wait: true`）通过 `status`（`idle` / `running` / `waiting_for_permission` / `waiting_for_answer` / `paused` / `error`）表达会话当前状态，并通过 `turnOutcome` 表达刚结束这一轮的实际结果（`done` / `aborted` / `error`；未结束时与 `status` 一致）。
- **队列暂停立即返回**：当一轮以非 `done`（如 `aborted`、`error`）结束且存在待发排队输入时，Core 会将待发队列整列暂停（[ADR-0070](ADR-0070-steer-and-queue-input.md) 第 4 节）。桥层的 `waitForTrackedSession` 将 `paused` 视作会话已停止，不再因 `pendingInputIds.size > 0` 空等到超时；结果返回 `status: "paused"` 与刚结束轮次的真实 `turnOutcome`（例如 `"aborted"` 或 `"error"`），并附带 `queuedInputs`。
- **正常 `done` 队列接续不提前返回**：上一轮以 `done` 结束并从队首取出下一条消息开始接续轮次时，Core 会延迟发送 `runtime.status("idle")` 直至整条队列排空。桥层在非暂停队列被取空后进入过渡态，改由下一轮 `turn.started`、延迟的 `runtime.status("idle")` 或失败事件（`runtime.error("session_failed")` / `runtime.warning("input_queue_failed")`）解除，避免 `turn.started` 落盘/广播略慢时过早返回上一轮结果。
- **Turn 启动窗口代际令牌与跨轮回调隔离**：`waitForTrackedSession` 可在收到 `runtime.status("idle")` 后即刻返回，此时上一轮 `session.submit` / `session.enqueueInput` RPC 响应可能尚未回传。桥层以单调递增的代际令牌（`startTokenSeq` / `activeStartToken`）取代共享布尔标记来标识当前启动中的触发窗口：前序 RPC 迟到完成/报错只能清理匹配的旧令牌，不得误清新一轮启动标记；`triggerEnqueueOnTracked` 仅由 `turn.started` 或非空 `input.pending`（`items.length > 0`）解除本轮启动标记（忽略上一轮残留的 `turn.completed` 或取空队首时的空 `input.pending`）；`clearStartTurn` 清除令牌时同步唤醒 `waitWakeups`，确保启动 RPC 异步拒绝且无事件到达时 `waitForTrackedSession` 也能及时收束。

## 修订：2026-11-19 等待返回增量摘要、多会话等待与子会话提示

- **等待返回增量摘要**：`nocturne_wait` 与 `nocturne_start_session` / `nocturne_send` 的 `wait: true` 返回中，`lastTurn.tools` 改为按连接维护增量游标：同一连接对同一会话在同一轮次只列出上次返回后新增或状态变化的工具调用，在 `lastTurn.omittedPreviousTools` 中注明本次之前已省略条数；首次等待、进入新轮次或连接断开重连后从本轮开头算，不同连接互不影响。
- **单行压缩与条数上限**：每条工具摘要压成单行 `[工具名] 状态 — 目标`，`shell` 命令只取第一个非空行、折叠换行与连续空白并截断至 **120 字符**；单次最多列出最近 **20 条**工具调用，超出部分在 `lastTurn.omittedExcessTools` 注明省略条数。轮次结束时仍返回最终回复全文，整体受 64 KB 上限约束；完整工具清单仍由 `nocturne_read_session` 提供。
- **多会话等待**：`nocturne_wait` 支持 `sessionIds: string[]`（与单会话 `sessionId` 二选一，单个 `sessionId` 的旧调用方式与返回形状不变）。任一会话满足现有停止条件（或调用时已满足）即立即返回 `{ timedOut, readySessionIds, sessions }`，其中每项复用单会话状态与增量摘要并附 `ready: boolean`；默认超时 300s、上限 600s，超时返回各会话当前 `running` 状态，不中断任何会话。
- **子会话明确报错**：对子代理会话 ID 调用等待或打开类工具时，桥层从 `runtime.listSessions({ includeSubagents: true })` 的 `SessionSummary.parent` 解析父会话 ID，统一返回明确错误说明该会话为子代理会话并给出父会话 ID，避免暴露底层的「会话被另一个进程占用」。

## 修订：2026-11-19 外部 agent 改名

- **白名单与范围**：`runtime.renameSession` 加入 `AGENT_RUN_METHODS`（仅可运行范围可用，只读范围 `AGENT_READONLY_METHODS` 不开放）。
- **归属校验**：RPC 服务端的 agent 接入层在执行 `runtime.renameSession` 前校验目标会话的 `client.id` 必须等于当前外部 agent 的 id；不匹配（用户或其他外部 agent 创建的会话，或无来源标记）时拒绝执行并返回 `-32004 / agent_not_allowed`，不调用 Core。
- **新建会话指定标题**：`runtime.createSession` 不新增 `title` 参数；`nocturne_start_session` 增加可选 `title`，桥层在建会话后、提交首条消息前调用 `runtime.renameSession` 设为手动标题（不被自动标题覆盖）。若改名失败，会话照常创建并继续执行，返回中附带 `renameError` 说明原因。

## 修订：2026-11-20 外部 agent 作答

- **两项作答能力**：
  - **回答提问**：`session.respondQuestion` 加入 `AGENT_RUN_METHODS`（只读范围不开放），MCP 桥新增 `nocturne_answer({ sessionId, requestId, answers, wait?, timeoutSeconds? })`。答案结构与 `session.respondQuestion` 一致（每题提供 `selected` 与可选 `text`，或 `{ declined: true }` 放弃作答），`requestId` 过期或不存在按既有 RPC 错误（`unknown_request`）返回；作答后可选等待并沿用增量摘要规则。
  - **处理审批**：`session.respondPermission` 与 `session.respondSubagentPermission` 加入 `AGENT_RUN_METHODS`（只读范围不开放），MCP 桥新增 `nocturne_respond_permission({ sessionId, requestId, childSessionId?, reply, wait?, timeoutSeconds? })`。`reply` 沿用 `PermissionReply`；处理子代理转发审批时传入 `childSessionId`，走 `session.respondSubagentPermission`。桌面端照常弹出审批，任何一方先回复即生效，另一方界面随事件更新且后续重复回复按 `unknown_request` 返回。
- **三条安全边界（全部在 RPC 的 agent 接入层校验，不在 MCP 桥拦截）**：
  1. **只限自己创建的会话**：执行 `session.respondQuestion`、`session.respondPermission` 与 `session.respondSubagentPermission` 前，校验目标会话（子代理审批时为父会话）的 `client.id` 必须等于当前外部 agent 的 id，否则返回 `-32004 / agent_not_allowed` 且不调用 Core。
  2. **允许类只限最高档上限**：拒绝类回复（`decision: "deny"`，含 `stop: true` 与 `feedback`）在任意权限上限下均允许；允许类回复（`decision: "allow"`，含本次允许与 `remember: "session"` 本会话内允许）仅在该 agent 登记的权限上限为最高档（`bypass`）时允许，较低上限（`read-only` / `default` / `auto-edit` / `guarded` / `smart`）一律返回 `-32004 / agent_not_allowed`。
  3. **不写持久授权**：外部 agent 不得写入任何持久授权（Grant / 用户规则）。`PermissionReply.remember` 为 `"project"` 或 `"always"` 的变体在任意权限上限（含 `bypass`）下一律拒绝，返回 `-32004 / agent_not_allowed`。
- **等待提示与范围同步**：`initialize` 结果在 `origin === "agent"` 且已登记时附带自身 `agent: { id, scope, maxPermissionPreset }`，配对批准与范围变更时向该 agent 连接推送 `agent.selfChanged`。会话停在 `waiting_for_answer` / `waiting_for_permission` 时，等待返回保留 `pendingQuestion` / `pendingPermissions`（子代理转发审批条目附带 `childSessionId`），提示文本说明可调用的工具；若该 agent 不能批准，权限提示仅说明可拒绝或请用户在 Nocturne 中处理。
- **对原第 77 行规则的替代**：原「后果」第 77 行「权限确认与提问仍由用户本人处理；外部 agent 拿不到任何批准能力」中，在**外部 agent 自己创建的会话**范围内：提问可由该 agent 通过 `nocturne_answer` 回答；审批可由该 agent 通过 `nocturne_respond_permission` 拒绝，且当且仅当其登记权限上限为最高档（`bypass`）时可做非持久允许（本次 / 本会话）。对用户或其他外部 agent 创建的会话、较低权限上限下的批准，以及全部持久授权（`project` / `always`），原规则继续生效。

