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

`SessionOpened`：`{ sessionId, meta, config, warnings, recovery?, lastSeq }`。打开会话**不推事件**——事件要另行 `session.subscribe`。同一连接里已打开的会话再次 `resumeSession` 报 `session_already_open`。`Runtime.updateProviders` 的参数是含函数的进程内配置，无法序列化，不在本版映射（见 ADR-0044 第 10 节第 5 步）。

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
| `close` | → `null`；关闭这一个会话（刷盘、释放会话锁），其余会话不受影响 |

`submit.attachments` 是 `[{ data: base64, mimeType, label? }]`；解码后交给 Core，大小与格式校验仍在 Core（[ADR-0023](../decisions/ADR-0023-image-input.md)）。`data` 不是合法 base64 报 `invalid_params`，不进 Runtime。

### 3.3 通知

| 方向 | 方法 | 参数 | 说明 |
|---|---|---|---|
| 客户端→服务端 | `session.interrupt` | `{ sessionId }` | 中断运行中的 Turn；无 Turn 时无操作。`submit` 请求随后以 `aborted` 返回。服务端也接受带 `id` 的请求形式（回复 `null`） |
| 服务端→客户端 | `event` | `{ sessionId, event }` | `event` 原样是 [events.md](events.md) 的 `RuntimeEvent` 信封，不另包一层 |

### 3.4 `shutdown`

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
| `-32004` | RPC 层状态错误 | `not_initialized`、`already_initialized`、`protocol_version_mismatch`、`unknown_session`、`session_already_open`、`shutting_down` |

客户端侧另有 `connection_closed`：连接断开时所有在途请求以它失败，而不是悬挂。

## 6. 生命周期

- **传输关闭**（stdin 结束、客户端崩溃）：服务端先中断运行中的 Turn，关闭全部会话（刷盘、释放会话锁），释放 Runtime 之外的资源，然后结束 `serve`。被中断的 Turn 照常收束落盘为 `aborted`；之后新 Runtime 可直接恢复该会话，没有残留锁。
- **`shutdown` 请求**：同样的清理完成后回复，再关闭传输。
- 握手前断开：不创建 Runtime，正常结束。

## 7. 安全与日志

- 第一版不监听端口，不鉴权：能连上传输的只有启动服务端的父进程，权限等同于运行 `nctrn` 的用户（[ADR-0044](../decisions/ADR-0044-rpc-stdio.md) 第 8 节）。
- 权限判定只在 Runtime 的权限层。RPC 层只转发 `permission.requested` 事件与 `respondPermission` 回复，不判断"要不要确认"。
- 诊断记录（`diagnostics` 回调）只含连接状态、方法名与结果（成功与否、错误码），**不含任何参数**——参数里可能有密钥明文（`addProvider`、`setCredential`，第 5 步映射后同样适用）或用户输入。

## 8. 与公开 API 保持一致

方法清单以公开 API 为准，RPC 层不另加能力。`packages/rpc/src/server/coverage.ts` 登记 `Runtime` 与 `RuntimeSession` 每个成员对应的 RPC 方法或"不映射"的原因，键类型由 `keyof` 推导：公开 API 新增成员而没有登记，编译失败；覆盖测试再用真实对象的键与服务端方法表对照。公开 API 新增方法时，同步在 `RpcMethods`、服务端处理表、客户端封装与本文补映射。

## 9. 客户端包

`@nocturne/rpc/client` 运行时只依赖 `@nocturne/core/protocol`，对 `@nocturne/core` 只有 `import type`，也不使用 Node 内置模块（传输由使用方注入），由 `.dependency-cruiser.cjs` 的 `rpc-client-*` 规则强制。桌面端前端只引这个入口和 `protocol`，打包不会带进 Node 代码。入口：`createRpcClient(transport, { clientName, interactive? })`、`RpcError`、`trackSessionView`、`encodeBase64`。
