# RPC 协议

> 状态：v1.0（协议版本 `1`）｜ 前置阅读：[events.md](events.md)、[view.md](view.md)｜ 决策：[ADR-0044](../decisions/ADR-0044-rpc-stdio.md)｜ 代码：`packages/rpc`

进程外客户端（桌面端、IDE 插件等）通过 JSON-RPC 2.0 使用 Runtime 的公开 API。本文是方法、报文与错误码的**主文档**；命令与事件本身的语义仍以 [events.md](events.md) 和 [modules.md](../architecture/modules.md) 第 3 节为准，RPC 只序列化它们，不另起一套（[ADR-0002](../decisions/ADR-0002-ui-independent-core.md)）。

## 1. 传输与报文

- 每条报文是**一行 JSON**，以 `\n` 分隔，不使用 Content-Length 头；不支持批量（数组报文报 `-32600`）。服务端对传输只有"按行收发"的要求（`LineTransport`），stdio 是第一种接入，`@nocturne/rpc/server` 提供 `createStdioTransport`，测试与嵌入方可用 `createMemoryTransportPair`。
- 三种报文：客户端→服务端的**请求**（有 `id`，等结果）、客户端→服务端的**通知**（无 `id`）、服务端→客户端的**通知**。没有服务端→客户端的请求：需要用户参与的流程都是"事件请求 + 命令回复"（权限、提问）。
- 约定：`undefined` 在线上是 `null`（客户端封装负责还原）；二进制数据（图片附件）用标准 base64 字符串；整数 `seq`、毫秒时间戳保持数字。
- 一个服务端同一时刻只接**一个客户端**，可以同时打开多个会话；会话方法都带 `sessionId`。

## 2. 握手

第一条请求必须是 `initialize`，只能调用一次。

| 请求参数 | 说明 |
|---|---|
| `protocolVersion` | 整数；必须与服务端一致（第一版不做向下兼容），否则报错 `protocol_version_mismatch` |
| `clientName` | 客户端标识，诊断用 |
| `capabilities.interactive` | 客户端能否回复权限与提问请求；`false` 时服务端用 `interactive: false` 创建 Runtime，权限请求按配置的非交互规则处理（与 `-p` 一致） |

结果：`{ protocolVersion, nocturneVersion, sessionsDir? }`。Runtime 在握手时才创建（`interactive` 取自客户端声明）；创建失败时握手报错、连接保持，客户端可重试。握手前发其他请求报 `not_initialized`。

## 3. 方法

方法名按对象分组，参数是对象。类型定义见 `packages/rpc/src/shared/methods.ts`（`RpcMethods`），客户端封装 `@nocturne/rpc/client` 提供同名的类型化方法。

### 3.1 `runtime.*`

| 方法 | 参数 → 结果 |
|---|---|
| `listSessions` | `{ cwd?, includeSubagents? }` → `SessionSummary[]` |
| `createSession` | `CreateSessionOptions` → `SessionOpened` |
| `resumeSession` | `{ sessionId, model?, force? }` → `SessionOpened` |
| `forkSession` | `{ sessionId, targetSeq? }` → `{ sessionId }`（新会话未打开，用 `resumeSession` 打开） |
| `listModels` / `defaultModel` / `listRecentModels` | → 模型列表 / `ModelRef \| null` / `ModelRef[]` |
| `describeSettings` / `updateSettings` | → `SettingItem[]`；`updateSettings { patch, reviewerKey? }` |
| `setDefaultModel` | `{ model, reasoningEffort }` → `SettingItem[]` |
| `describeModelRoles` / `setModelRole` | → `ModelRoleInfo[]`；`setModelRole { role, ref }` → `SettingItem[]` |
| `getPreference` / `setPreference` | `{ key }` → `string \| null`；`{ key, value? }` → `null` |
| `listReviewerProviders` / `defaultReviewer` / `listReviewerModels` | 智能权限审查模型相关（[ADR-0036](../decisions/ADR-0036-smart-permissions.md)） |
| `reloadConfig` | `{}` → `null`；重新读取配置文件并重建 Provider 注册表，推 `runtime.providersChanged`（在响应之前到达）；**变更方法**，走同一配置队列 |

`SessionOpened`：`{ sessionId, meta, config, warnings, recovery?, lastSeq }`。打开会话**不推事件**——事件要另行 `session.subscribe`。同一连接里已打开的会话再次 `resumeSession` 报 `session_already_open`。`Runtime.updateProviders` 映射为 `runtime.reloadConfig`：服务端在每个 `provider.*` 变更方法之后已经自动重载配置并推 `runtime.providersChanged`（见 3.3），`reloadConfig` 用于**别的进程**改了配置文件之后让本服务端同步（例如桌面端一个项目后台写了 providers.json 或 settings.json，其他项目后台随之重载）。`updateSettings` / `setDefaultModel` / `setModelRole` 只写设置层，不推 `runtime.providersChanged`。服务端不追踪重载的来源：多个后台之间协调时，客户端必须自己识别由 `reloadConfig` 引起的那次通知，不再转发，否则会互相触发成环（桌面端的做法见 [desktop.md](../apps/desktop.md)）。

### 3.2 `session.*`

| 方法 | 参数（除 `sessionId`）→ 结果 |
|---|---|
| `subscribe` | `{ afterSeq? }` → `{ lastSeq }`，见第 4 节 |
| `unsubscribe` | → `null`；服务端停止推送 |
| `submit` | `{ text?, content?, attachments? }` → `TurnEndReason`；**请求一直挂到 Turn 结束**，与进程内 `submit()` 的 resolve 时机相同 |
| `respondPermission` / `respondQuestion` | `{ requestId, reply }` → `null` |
| `setModel` / `setPermissionPreset` / `setReasoningEffort` / `setShell` | `{ model }` / `{ name }` / `{ level }` / `{ kind }` → `null` |
| `compact` | → `null` |
| `rewindTargets` / `rewind` | → `RewindTarget[]`；`rewind { targetSeq, mode }` → 文件回退汇总 |
| `state` | → `SessionState` 去掉 `history` 与 `unsettledCalls`（历史由持久事件折叠得到；后者是进程内 Map） |
| `describeContext` | → `BuiltContext` 去掉发给模型的整份 `request`，只留报告与判定 |
| `reasoningEffortInfo` / `shellInfo` / `listShells` / `visionInfo` / `mcpServers` / `fileIndex` | 只读查询，结果同进程内 |
| `readInputHistory` / `recordInputHistory` | → `string[]`；`{ text }` → `null` |
| `readAttachment` | `{ file }` → `{ data: base64, mimeType, bytes }`；只读取当前会话持久事件登记过的图片附件，见下文 |
| `close` | → `null`；关闭这一个会话（刷盘、释放会话锁），其余会话不受影响 |

`submit.attachments` 是 `[{ data: base64, mimeType, label? }]`；解码后交给 Core，大小与格式校验仍在 Core（[ADR-0023](../decisions/ADR-0023-image-input.md)）。`data` 不是合法 base64 报 `invalid_params`，不进 Runtime。

`readAttachment` 对应 `RuntimeSession.readAttachment(file)`，客户端 `RpcSession.readAttachment(file)` 将标准 base64 解码为 `Uint8Array`。Core 仅接受单个文件名，拒绝路径分隔符、`..`、绝对路径与 Windows 替代数据流；文件必须出现于本会话的持久 `message.user.attachments` 或 `tool.completed.attachments`（包括回退后仍保留的原始记录）。读取当前会话附件目录中的实际文件，每次校验字节数与 sha256，不通过父会话目录兜底，也不允许链接逃逸。分叉读取复制到新 id 的附件；子会话仅授权自身日志里的引用（[sessions.md](../architecture/sessions.md)）。

附件错误以 `SessionError`（`-32002`）返回：`invalid_attachment_file`（非法文件名或链接路径）、`attachment_not_found`（本会话未登记）、`attachment_missing`（文件缺失）、`attachment_corrupt`（大小或 sha256 不符）、`attachment_read_failed`（其他文件读取 I/O 错误，如访问被拒绝）。

### 3.3 `provider.*`

服务商配置（[provider-setup.md](../architecture/provider-setup.md) 第 6 节）。方法名与 Core 数据接口一致；`prepareProvider` 的 `credential` 是判别联合（`{kind:"apiKey",key}` / `{kind:"env",name}` / `{kind:"login",loginId}` / `{kind:"external-file"}`），其余形状校验与配置判断全部在 Core，RPC 层不复制。

| 方法 | 参数 → 结果 |
|---|---|
| `listProviderPresets` | `{}` → `ProviderPreset[]` |
| `describeProviders` | `{}` → `{ providers: ProviderOverview[]; setupWarning? }`；`ProviderOverview.authKind`（`"apiKey"` / `"env"` / `"account"` / `"external-file"` / `"none"`）是条目的认证方式，客户端据此决定显示「换密钥」还是「重新登录」，不再自行推断 |
| `describeProviderSetup` | `{ presetId }` → `ProviderSetupDescription` |
| `describeAccountStorage` | `{ providerId }` → `AccountStorageSetup \| null` |
| `prepareProvider` | `Omit<AddProviderInput,"modelId">` → `PrepareProviderResult`（只校验、暂存草稿，不落盘）；名称与已有服务商重复时报 -32005 / `field: "name"`（[provider-setup.md](../architecture/provider-setup.md)「名称唯一性」）。结果的 `models` 是获取到的上游模型摘要（`id`、`displayName?`、`reasoning?`、`imageInput?`、`contextWindow?`、`maxOutputTokens?`，与 `modelCount` 同数），供保存前预览 |
| `commitProvider` | `{ draftId, manualModelId? }` → `AddProviderResult`；**变更方法**；提交时再查一次同名，准备之后别处写入了同名条目同样报 -32005 / `field: "name"` |
| `discardProvider` | `{ draftId }` → `null` |
| `setCredential` | `{ providerId, key }` → `null`；**变更方法** |
| `listModelSettings` | `{ providerId }` → `ModelSettingsView[]` |
| `saveModelSettings` | `{ providerId, modelId, patch }` → `null`；**变更方法** |
| `refreshUpstreamLimits` | `{ providerId }` → `{ warning: string \| null }`；**变更方法** |
| `refreshModelsDev` | `{}` → `{ warning: string \| null }`；**变更方法** |
| `removeSetupProvider` | `{ providerId }` → `null`；**变更方法**；本连接任一会话正在使用时报 `provider_in_use`（同 CLI/TUI 的规则；因服务端持有会话，由服务端对本连接全部已打开会话判断） |
| `logoutProvider` | `{ providerId }` → `null`；**变更方法** |

**配置对象与重载**（ADR-0044 追加记录）：

- 服务端持有一份"当前" `RuntimeConfig`——初始是创建 Runtime 的那个对象，每次变更方法成功后换成注入的 `reload()` 重新加载出的新对象，随后 `updateProviders` 重建 Provider 注册表并推 `runtime.providersChanged`（在响应之前到达），响应返回时 `runtime.listModels` 等读到的已是新值。变更方法串行执行（配置队列），不会并发重载。
- 启动时配置对象的 `base` 是加载时快照：本进程新添加的服务商只有重载后的对象看得到（`login.start`、`provider.logoutProvider` 依赖它），这是服务端必须换成新对象的原因。
- **草稿与草稿登录固定在创建时的配置对象**：Core 的草稿（`draftId`）与草稿登录暂存凭据按 `RuntimeConfig` 对象登记；`prepareProvider` 用 `credential.kind === "login"` 的 loginId 是本连接 `login.startDraft` 产生的时用该登录创建时的对象，`commitProvider`/`discardProvider` 用该 `draftId` 创建时的对象。草稿跨连接无效：连接断开即被丢弃（第 6 节）。
- 变更本身抛错：不重载，原样返回错误。**重载抛错：请求以重载错误失败，但此前的写入已生效**（providers.json / 凭据已落盘，Runtime 仍用旧配置），不伪造回滚。
- `addProvider` 不映射：它是 prepare+commit 的兼容组合，客户端分两步调用以便保存前展示 `PrepareProviderResult`。

### 3.4 `login.*`

登录会话（[provider-setup.md](../architecture/provider-setup.md) 第 6 节）：`start`/`startDraft` 返回 `loginId`、`authorizeUrl`（浏览器由客户端打开，服务端不打开）、`manualInput`（`"callback-url"` / `"code"` / `"none"`；`"none"` 是设备码登录，`userCode` 供在浏览器核对）与 `expiresAt`（Unix 毫秒，服务端放弃等待的时刻；客户端倒计时以它为准，不自行假设超时时长），完成或失败经 `login.completed` 通知。

| 方法 | 参数 → 结果 |
|---|---|
| `login.start` | `{ providerId, accountStorage?, remote? }` → `LoginStarted`；已保存服务商（重）登录，`loginId` 由服务端生成 |
| `login.startDraft` | `{ presetId, name, baseURL?, accountStorage?, remote? }` → `LoginStarted`；表单里未保存的草稿登录，`name` 必填，`loginId` 沿用 Core 分配的 |
| `login.submitManual` | `{ loginId, text }` → `null`；粘贴回调 URL 或授权码 |
| `login.cancel` | `{ loginId }` → `null`；进行中 → 取消（随后收到 `cancelled` 的 `login.completed`）；已完成未提交的草稿登录 → 丢弃暂存凭据（无通知）。不存在的 `loginId` 报 `unknown_login` |

`accountStorage`：`"plaintext" \| "memory"`，服务端没有系统凭据后端且为账号型登录时由客户端先经 `describeAccountStorage` 了解选项、再由用户选择后传入，没有默认值；`remote` 为真时不开本机回环端口，改走手动粘贴。

`login.completed` 参数：`{ loginId, result?: { providerId, account? }, error?: { code, message }, unstoredKey?, warning? }`——`result` 只含 providerId 与账号描述，不含令牌；`error` 对 `ProviderLoginError` 用其固定文案，其他异常一律 `{code:"failed",message:"登录未完成，请重新登录"}`；**通知绝不先于对应 `start`/`startDraft` 的响应到达**。已保存服务商登录成功先触发一次自动重载（`runtime.providersChanged` 在 `login.completed` 之前）；重载失败时 `warning` 带提示（凭据已写入）。OpenRouter 在无系统凭据后端时的一次性密钥只出现在该登录的 `login.completed.unstoredKey` 一条通知里，设置环境变量的命令文本由客户端生成。

### 3.5 `mcp.*`

管理接口由 Core 校验，探测不经过权限层。配置详见 [mcp.md](../architecture/mcp.md)。

| 方法 | 参数 → 结果 |
|---|---|
| `mcp.describeMcpServers` | `{ workspaceRoot? }` → `{ servers: McpServerOverview[], warnings: string[] }` |
| `mcp.saveMcpServer` | `{ mode: "create" \| "replace", id, config, secrets?, workspaceRoot? }` → `McpServerOverview` |
| `mcp.deleteMcpServer` | `{ id, workspaceRoot? }` → `null` |
| `mcp.setMcpServerEnabled` | `{ id, enabled, workspaceRoot? }` → `null` |
| `mcp.probeMcpServer` | `{ id, workspaceRoot? }` 或 `{ config, secrets?, credentialServerId?, workspaceRoot? }` → `McpProbeResult` |

Overview 含 `id/origin/editable/trusted/path/transport/enabled/startupTimeoutMs/callTimeoutMs`；stdio 含 `command/args/cwd/env`，HTTP 含 `url/headers`。值列表为 `{ name, kind: "literal" | "env" | "stored", value?, stored?: "set" | "missing" }[]`，不返回凭据。`config` 是对应传输的条目，stored 值只用 `{ stored: true }`；`secrets` 是变量或请求头名到字符串或 null 的映射，HTTP 凭据名转小写。只有 app 条目可修改，create 名称跨来源不区分大小写，冲突为 `-32005`、`data.field: "id"`；其他管理校验错误同样带字段。未信任项目拒绝探测。

Probe 返回 `ok/durationMs/tools`，可带 `serverInfo`、`error: { code, message }`。stdio 带脱敏的 `stderrTail`（最多 20 行），HTTP 带可选 `httpStatus`。错误码为 `spawn_failed/startup_timeout/initialize_failed/mcp_secret_missing/connect_failed/http_status/auth_required/http_redirect`。草稿编辑可以通过 `credentialServerId` 引用可编辑的已保存条目的凭据，不返回密钥值。

三种变更成功后自动重载并更新已打开会话；MCP 变更响应不发送 `providersChanged`，桌面端显式调用 `BackendPool.propagateConfig`。其他后台的 `reloadConfig` 仍发送原通知，由现有 echo 计数消费。

### 3.6 通知

| 方向 | 方法 | 参数 | 说明 |
|---|---|---|---|
| 客户端→服务端 | `session.interrupt` | `{ sessionId }` | 中断运行中的 Turn；无 Turn 时无操作。`submit` 请求随后以 `aborted` 返回。服务端也接受带 `id` 的请求形式（回复 `null`） |
| 服务端→客户端 | `event` | `{ sessionId, event }` | `event` 原样是 [events.md](events.md) 的 `RuntimeEvent` 信封，不另包一层 |
| 服务端→客户端 | `runtime.providersChanged` | `{}` | 服务商配置/凭据变更完成且 Runtime 已用重载后配置重建：在对应 `provider.*` 变更方法（或已保存服务商 `login.start` 成功）的响应/完成通知之前到达一次（3.3、3.4） |
| 服务端→客户端 | `login.completed` | `LoginCompleted` | 登录会话完成或失败（含取消）；绝不先于对应 `login.start`/`startDraft` 的响应到达（3.4） |

### 3.7 `shutdown`

请求，无参数。服务端完成与"传输断开"相同的清理（第 6 节）后回复 `null`，再关闭传输。

## 4. 订阅与回放

`session.subscribe { sessionId, afterSeq }`：服务端先挂实时监听并缓冲，再读日志，推送 `seq > afterSeq` 的全部**持久**事件，随后冲刷缓冲（按 `seq` 去重，已推过的不再推），最后转入实时推送（持久与临时都推）。请求在回放与衔接完成后才返回 `{ lastSeq }`，因此回放期间产生的新事件不丢、不重，`seq` 连续。

- **临时事件不回放**：断开期间错过的流式增量、进度不补发（[events.md](events.md) 第 1、2 节）。
- **不限流**：第一版服务端不为慢客户端设有界队列，事件直接写入传输（stdio 管道由操作系统缓冲）；持久事件本来可按 `seq` 补读，临时事件的丢弃策略留到出现慢连接问题时再定（与 [events.md](events.md) 第 6 节同步）。
- 同一会话同一时刻只有一路订阅：再次 `subscribe` 替换前一路，服务端只有一份推送，不会向旧监听器重复发事件。
- 客户端用 `protocol` 的 reducer 折叠视图（`createSessionView` / `reduceSessionView` / `replaySessionView`，`@nocturne/rpc/client` 重新导出，`trackSessionView` 封装"订阅 + 折叠"）。**验收标准**：同一会话经 RPC 折叠得到的 `SessionView` 与进程内重放相等（[view.md](view.md) 第 6 节，`revision` 与 `notices` 除外）。
- 重连：保存最后收到的持久事件 `seq`，重启后台后 `resumeSession`，再以 `afterSeq` 订阅即可续接；会话日志是唯一事实来源（[ADR-0003](../decisions/ADR-0003-session-event-log.md)）。

## 5. 错误

失败响应是 JSON-RPC error：`code` 取固定数值，`message` 是原来的用户可读文案，`data.code` 是原来的**字符串错误码**，`data.name` 是错误类名。客户端按 `data.code` 分支，与进程内按 `error.code` 分支等价（`RpcError.code`）。

| `code` | 含义 | `data.code` 举例 |
|---|---|---|
| `-32700` / `-32600` | 报文不是合法 JSON / 不是合法请求 | `parse_error`、`invalid_request` |
| `-32601` | 方法不存在 | `method_not_found` |
| `-32602` | 参数缺失或类型错误（在进入 Runtime 之前校验） | `invalid_params` |
| `-32603` | RPC 层内部错误 | `internal_error` |
| `-32000` | 其他 Core 错误（原样透传 `message`） | 原 `error.code`（如有） |
| `-32001` | `RuntimeCommandError`（命令被拒绝，原因码见 [events.md](events.md) 第 7 节） | `session_busy`、`unknown_request`、`invalid_reply`、`invalid_command` |
| `-32002` | `SessionError` | 会话层错误码 |
| `-32003` | `ProviderLoginError` | 登录错误码 |
| `-32004` | RPC 层状态错误 | `not_initialized`、`already_initialized`、`protocol_version_mismatch`、`unknown_session`、`session_already_open`、`shutting_down`、`provider_config_unavailable`（服务端未注入服务商配置）、`provider_in_use`（会话正在使用的服务商拒绝删除）、`unknown_login`（登录会话不存在或已结束） |
| `-32005` | `ProviderSetupError`（服务商配置表单的字段错误） | `invalid_field`；`data.field` 是字段名（`preset`、`name`、`baseURL`、`credential`、`draftId`、`modelId`），客户端据此标输入框；`name` 也用于报告与已有服务商重名（`已有同名服务商 X（所在层）`） |

客户端侧另有 `connection_closed`：连接断开时所有在途请求以它失败，而不是悬挂。

## 6. 生命周期

- **输入结束**（stdin EOF）：不再接收请求，输出仍可用。服务端中断运行中的 Turn，等待已接收的请求（包括等待握手或打开会话的请求）返回；EOF 后才开始的 submit 同样中断并返回 `aborted`。所有回复写完并刷出后，关闭全部会话（刷盘、释放会话锁）、释放 Runtime 之外的资源，再结束 `serve`。之后新 Runtime 可直接恢复会话，没有残留锁。
- **完整断开**（输出 EPIPE、客户端崩溃）：执行同样的中断与清理，但输出不可用时丢弃回复。`LineTransport.onClose` 表示输入结束或完整断开；异步缓冲输出的传输实现可选的 `flush()`，保证清理前已发送的报文刷出。
- **登录与草稿清理**（两种断开与 `shutdown` 相同）：进行中的登录会话全部 `cancel`（关闭回环端口，其 `login.completed` 照常推送）；本连接未提交的 `prepareProvider` 草稿丢弃（只释放内存，不写盘、不消费登录）；已完成未提交的草稿登录经 `discardDraftLogin` 丢弃暂存凭据。草稿与草稿登录因此不跨连接存活。
- **`shutdown` 请求**：同样的清理完成后回复，再关闭传输。
- 握手前断开：不创建 Runtime，正常结束。

## 7. 安全与日志

- 第一版不监听端口，不鉴权：能连上传输的只有启动服务端的父进程，权限等同于运行 `nctrn` 的用户（[ADR-0044](../decisions/ADR-0044-rpc-stdio.md) 第 8 节）。
- 权限判定只在 Runtime 的权限层。RPC 层只转发 `permission.requested` 事件与 `respondPermission` 回复，不判断"要不要确认"。
- 诊断记录（`diagnostics` 回调）只含连接状态、方法名与结果（成功与否、错误码），**不含任何参数与通知内容**——参数里可能有密钥明文（`provider.prepareProvider`、`provider.setCredential`）或用户输入，通知里可能有一次性密钥（`login.completed.unstoredKey`）。
- **敏感参数**：服务端维护一张敏感方法表（`SENSITIVE_METHODS`）——`runtime.updateSettings` 的 `reviewerKey`、`provider.prepareProvider` 中 `credential.kind === "apiKey"` 的 `key`、`provider.setCredential` 的 `key`、`login.submitManual` 的 `text`。这些方法失败时，错误响应 `message` 与 `data` 里出现的秘密值一律替换为 `[redacted]`；其他方法沿用 Core 的固定文案错误（Core 错误本身不含秘密）。通知内容不进诊断，密钥只经其语义通道传递（如 `login.completed.unstoredKey` 恰好一次）。

## 8. 与公开 API 保持一致

方法清单以公开 API 为准，RPC 层不另加能力。`packages/rpc/src/server/coverage.ts` 登记 `Runtime`、`RuntimeSession` 与 `RuntimeConfig` 每个成员对应的 RPC 方法或"不映射"的原因，键类型由 `keyof` 推导：公开 API 新增成员而没有登记，编译失败；覆盖测试再用真实对象的键与服务端方法表对照。服务商配置函数另有 `PROVIDER_FUNCTION_METHODS` / `PROVIDER_FUNCTIONS_NOT_MAPPED` 一张表，覆盖测试直接读 `packages/core/src/index.ts` 的导出块校验全集。公开 API 新增方法时，同步在 `RpcMethods`、服务端处理表、客户端封装与本文补映射。

| Core 公开 API | RPC 方法 | 客户端返回 |
|---|---|---|
| `RuntimeSession.readAttachment(file)` | `session.readAttachment({ sessionId, file })` | `{ data: Uint8Array, mimeType, bytes }`（线上 `data` 为 base64） |

## 9. 服务端进程

`nctrn rpc --stdio`（`apps/cli`，[cli.md](../apps/cli.md) 第 2 节）是第一个服务端入口：stdout 只写本文的报文，诊断与警告写 stderr；stdin 关闭、`shutdown` 请求或终止信号都按第 6 节清理后以退出码 0 退出。桌面端附带的 Node 单文件就是 `nctrn` 本身。端到端测试 `apps/cli/test/rpc.e2e.test.ts` 启动真实子进程，核对回放视图与磁盘日志一致、stdout 纯协议、断开后会话锁被释放。

## 10. 客户端包

`@nocturne/rpc/client` 运行时只依赖 `@nocturne/core/protocol`，对 `@nocturne/core` 只有 `import type`，也不使用 Node 内置模块（传输由使用方注入），由 `.dependency-cruiser.cjs` 的 `rpc-client-*` 规则强制。桌面端前端只引这个入口和 `protocol`，打包不会带进 Node 代码。入口：`createRpcClient(transport, { clientName, interactive? })`、`RpcError`、`trackSessionView`、`encodeBase64`。
