# RPC 协议

> 状态：v1.0（协议版本 `1`）｜ 前置阅读：[events.md](events.md)、[view.md](view.md)｜ 决策：[ADR-0044](../decisions/ADR-0044-rpc-stdio.md)｜ 代码：`packages/rpc`

进程外客户端（桌面端、IDE 插件等）通过 JSON-RPC 2.0 使用 Runtime 的公开 API。本文是方法、报文与错误码的**主文档**；命令与事件本身的语义仍以 [events.md](events.md) 和 [modules.md](../architecture/modules.md) 第 3 节为准，RPC 只序列化它们，不另起一套（[ADR-0002](../decisions/ADR-0002-ui-independent-core.md)）。

## 1. 传输与报文

- 每条报文是**一行 JSON**，以 `\n` 分隔，不使用 Content-Length 头；不支持批量（数组报文报 `-32600`）。服务端对传输只有"按行收发"的要求（`LineTransport`），stdio 是第一种接入，`@nocturne/rpc/server` 提供 `createStdioTransport`，测试与嵌入方可用 `createMemoryTransportPair`。
- 三种报文：客户端→服务端的**请求**（有 `id`，等结果）、客户端→服务端的**通知**（无 `id`）、服务端→客户端的**通知**。没有服务端→客户端的请求：需要用户参与的流程都是"事件请求 + 命令回复"（权限、提问）。
- 约定：`undefined` 在线上是 `null`（客户端封装负责还原）；二进制数据（图片附件）用标准 base64 字符串；整数 `seq`、毫秒时间戳保持数字。
- 一个服务端共享一个 Runtime，可同时服务一条本机连接与多条远程连接，各自打开多个会话；会话方法都带 `sessionId`。嵌入接口为 `serve(transport, { origin?: "local" | "remote" })`，缺省 `local`，同一时刻第二条本机连接被拒。`origin` 由服务端接入方指定，不从客户端报文获取；本轮只实现内存/stdio 接入，不新增网络。

ADR-0060 第 5 轮的[桌面浏览器契约](desktop-browser.md)不在本协议新增浏览器/CDP 执行方法或反向请求。手机发起的 Turn 也可以用这组桌面浏览器工具，权限照常处理；调用者信息经 MCP 调用的 `_meta` 注入（见 [tool-api.md 第 7 节](tool-api.md#7-桌面运行时来源的调用者元数据)）。

## 2. 握手

第一条请求必须是 `initialize`，只能调用一次。

| 请求参数 | 说明 |
|---|---|
| `protocolVersion` | 整数；必须与服务端一致（第一版不做向下兼容），否则报错 `protocol_version_mismatch` |
| `clientName` | 客户端标识，诊断用 |
| `capabilities.interactive` | 客户端能否回复权限与提问请求；仅本机连接的声明用于创建 Runtime，远程声明不改变交互模式 |

结果对两种连接相同：`{ protocolVersion, nocturneVersion, sessionsDir? }`。Runtime 只在本机连接握手时创建，`interactive` 取自本机声明；创建失败时握手报错、连接保持，可重试。远程连接永远不创建 Runtime，本机尚未创建时远程握手报 `runtime_unavailable`，连接保持，可稍后重试。握手前发其他请求报 `not_initialized`（远程能力越界优先报第 7 节错误）。

## 3. 方法

方法名按对象分组，参数是对象。类型定义见 `packages/rpc/src/shared/methods.ts`（`RpcMethods`），客户端封装 `@nocturne/rpc/client` 提供同名的类型化方法。

### 3.1 `runtime.*`

| 方法 | 参数 → 结果 |
|---|---|
| `listSessions` | `{ cwd?, includeSubagents? }` → `(SessionSummary & { openHere?: boolean })[]`；`openHere` 表示此刻在本后台 Hub 已打开或正在打开，与调用连接是否持有引用无关；关闭后为 false。`locked` 仍按锁文件判定，不区分持有者。旧客户端忽略此字段，旧后台缺省时客户端沿用原来的锁标记与跟踪逻辑 |
| `createSession` | `CreateSessionOptions` → `SessionOpened`；ADR-0051 新增可选 `cwd` 与 `workspaceRoot`，按该目录加载项目层并把两个值写入 `session.created`。`cwd` 缺省沿用 Runtime 的 cwd；工作区根依次取显式 `workspaceRoot`、显式 `cwd` 的真实路径、Runtime 的 workspaceRoot；恢复会话沿用日志记录的工作区，不带参数 |
| `resumeSession` | `{ sessionId, model?, force? }` → `SessionOpened` |
| `forkSession` | `{ sessionId, targetSeq? }` → `{ sessionId }`（新会话未打开，用 `resumeSession` 打开） |
| `renameSession` | `{ sessionId, title }` → `null`；调用 Core 的 `Runtime.renameSession`，成功后通知会话列表变化；参数必须为字符串，标题内容的校验由 Core 负责 |
| `usageStats` | `{ days?: number }`（正整数，缺省全部）→ protocol 的 `UsageStats`（含按模型的 `requests`、`latency`、`performance`、`cacheSavings`、首末使用时间，范围内逐日的 `requests` 与 `models` 拆分，以及 `performanceGranularity`）；只读，不打开会话或取锁，见 [usage.md](../architecture/usage.md) |
| `listModels` / `defaultModel` / `listRecentModels` | 模型列表 / `ModelRef \| null` / `ModelRef[]`；前两者可带 `workspaceRoot`；`listModels` 另可带 `includeDisabled`（[ADR-0054](../decisions/ADR-0054-provider-model-toggle.md)：true 时含停用模型并带 `disabled`，默认滤除；停用模型也带 `unavailable`） |
| `describeSettings` / `updateSettings` | `SettingItem[]`；均可带 `workspaceRoot`，`updateSettings { patch, reviewerKey? }`；`describeSettings` 的模型设置项可带 `disabled: "provider" \| "model"`，由注册表解析派生，供设置值显示停用状态，模型选择列表仍用默认 `listModels()` |
| `listShells` | `{ workspaceRoot? }` → 全部已知种类的 DetectedShell[]（含不可用项） |
| `readFile` | `{ path }` → `{ kind: "text", absolutePath, text, bytes }` 或 `{ kind: "image", absolutePath, data: base64, mimeType, bytes }`；桌面右侧面板「文件」标签读本机文件（[ADR-0060](../decisions/ADR-0060-desktop-side-panel.md) 及其 2026-10-18 修订），不需要会话，只读、不产生事件、不经权限层，也不是 agent 工具。规则见下文 |
| `setShellSetting` | `{ kind, workspaceRoot? }` → `SettingItem[]`；先验证可用性再写设置，覆盖来源随结果返回，已有会话按实际变化记配置事件 |
| `setDefaultModel` | `{ model, reasoningEffort, workspaceRoot? }` → `SettingItem[]` |
| `describeModelRoles` / `setModelRole` | `ModelRoleInfo[]`；`setModelRole { role, ref }` → `SettingItem[]`；均可带 `workspaceRoot` |
| `getPreference` / `setPreference` | `{ key }` → `string \| null`；`{ key, value? }` → `null` |
| `listReviewerProviders` / `defaultReviewer` / `listReviewerModels` | 智能权限审查模型相关（[ADR-0036](../decisions/ADR-0036-smart-permissions.md)）；均可带 `workspaceRoot` |
| `listReviewerSamples` / `testReviewerSample` | `{}` → `{ id, title, expect }[]`（内置审查样例的说明与期望，ADR-0057）；`{ sampleId, workspaceRoot? }` → `{ id, title, expected, actual, match, durationMs, reason }`，用已保存的审查器配置（含追加规则）跑一条样例，客户端逐条调用并汇总命中率。审查器关闭 / 未配置报 `invalid_command`，模型不可用报 `invalid_model`，未知样例报 `invalid_command`；审查失败或超过 30 秒记为 `actual: "ask"` 并带原因，不报错。取消 = 客户端不再发后续请求 |
| `reloadConfig` | `{}` → `null`；重新读取配置文件并重建 Provider 注册表，推 `runtime.providersChanged`（在响应之前到达）；**变更方法**，走同一配置队列 |

带 `workspaceRoot` 的运行时级方法（ADR-0051）：`workspaceRoot` 指定按哪个工作区合并项目配置层，缺省为后台启动目录（旧客户端不传不受影响）。上述设置、模型、审查器方法及带该参数的 `provider.*` 方法，RPC 服务端先用 Core 的 `platform.resolveReal` 解析真实路径，再对该路径执行 `forWorkspace` 预加载并转交 Runtime 或配置接口；解析失败则保留客户端传入的原字符串，不因该解析失败拒绝请求。客户端不必预先解析短路径、大小写差异或符号链接。同步读方法依赖服务端已加载的工作区层，写方法也使用同一真实路径校验。该参数解决单后台服务多个项目的场景（桌面端按会话工作区传参），不是跨进程寻址。

`SessionOpened`：`{ sessionId, meta, config, warnings, recovery?, lastSeq }`。打开会话**不推事件**——事件要另行 `session.subscribe`。同一连接里已打开的会话再次 `resumeSession` 报 `session_already_open`。`Runtime.updateProviders` 映射为 `runtime.reloadConfig`：服务端在每个 `provider.*` 变更方法之后已经自动重载配置并推 `runtime.providersChanged`（见 3.3），`reloadConfig` 用于**别的进程**改了配置文件之后让本服务端同步（例如桌面端后台运行期间用户用 CLI 改了 providers.json 或 settings.json）。`updateSettings` / `setDefaultModel` / `setModelRole` 只写设置层，不推 `runtime.providersChanged`。服务端不追踪重载的来源：多个服务端进程之间协调时，客户端必须自己识别由 `reloadConfig` 引起的那次通知，不再转发，否则会互相触发成环。

### 3.2 `session.*`
子代理档位使用既有 runtime.describeSettings/updateSettings，逐条键 subagents.profiles.<name>，值与删除语义见 [config.md](../architecture/config.md#子代理档位设置)，不新增 RPC 方法。


| 方法 | 参数（除 `sessionId`）→ 结果 |
|---|---|
| `subscribe` | `{ afterSeq? }` → `{ lastSeq }`，见第 4 节 |
| `unsubscribe` | → `null`；服务端停止推送 |
| `submit` | `{ text?, content?, attachments?, skill?, delegate? }` → `TurnEndReason`；**请求一直挂到 Turn 结束**，与进程内 `submit()` 的 resolve 时机相同 |
| `enqueueInput` | `{ mode: "steer" \| "queue", text?, content?, attachments?, skill?, delegate? }` → `{ id, queued }`（ADR-0070）。Turn 进行中入列、立刻返回 `queued: true`；空闲时等同 `submit`、请求同样挂到 Turn 结束并返回 `queued: false`（`id` 只是对齐标记）；暂停中提交追加到队尾并恢复。子会话报 `invalid_command` |
| `updateInput` | `{ id, mode?, text? }` → `null`；条目已被消费报 `input_consumed`。只替换用户正文的文本，非文本块及附件、`@` 引用、技能与委派快照随原提交保留；要换附件或引用须撤回后重发。空闲时未暂停条目（包括插话）按提交顺序发出。`mode: "subagent"` 的条目（后台子代理结果，ADR-0073）不能编辑或切换，报 `invalid_command`；`cancelInput` 可撤回 |
| `cancelInput` | `{ id }` → `null`；条目已被消费报 `input_consumed` |
| `resumeInputs` | → `null`；解除暂停，空闲时立即发出队首（包括插话，请求挂到接续 Turn 结束），忙时交给安全点或 Turn 的结束边界 |
| `pendingInputs` | → `{ items: PendingInputItem[], paused }`，与临时事件 `input.pending` 同形的完整快照；`input.pending` 不回放，附加后用它对齐（[view.md](view.md#待发输入预览状态)） |
| `respondPermission` / `respondQuestion` | `{ requestId, reply }` → `null` |
| `setModel` / `setPermissionPreset` / `setReasoningEffort` / `setShell` | `{ model }` / `{ name }` / `{ level }` / `{ kind }` → `null` |
| `compact` | → `null` |
| `rewindTargets` / `rewind` | → `RewindTarget[]`；`rewind { targetSeq, mode }` → 文件回退汇总 |
| `turnChanges` | → `TurnChanges[]`；只读，忙时也可调用，轮划分与不可用原因见 [sessions.md](../architecture/sessions.md#每轮文件改动)。`TurnChangeFile.restorable` 表示撤销时该文件能否被还原或删除（与 rewind 的 `action !== "untracked"` 同口径） |
| `turnChangeDiff` | `{ seq, path }` → `TurnChangeDiff`（`{ diff, approximate? }`）；seq 为正整数、path 非空字符串，形状错误 invalid_params；无可用历史差异 invalid_command |
| `state` | → `SessionState` 去掉 `history` 与 `unsettledCalls`（历史由持久事件折叠得到；后者是进程内 Map） |
| `describeContext` | → `BuiltContext` 去掉发给模型的整份 `request`，只留报告与判定 |
| `reasoningEffortInfo` / `shellInfo` / `listShells` / `visionInfo` / `mcpServers` / `fileIndex` | 只读查询，结果同进程内 |
| `resolveFiles` | `{ paths: string[] }` → `FileRefResolution[]`（`{ input, absolutePath, withinWorkspace, relativePath?, exists, isDirectory }`，`relativePath` 只在工作区内给出）；只读，按会话工作区解析路径（相对路径相对工作区，绝对路径规范化后判定是否越界），`paths` 非字符串数组报 -32602。越界路径照常返回绝对路径与 exists，由客户端按「打开文件用」决定入口（U-09）。Windows 网络路径（`\\server\share`、`\\?\UNC\...`）不去访问，直接按 `exists: false` 返回；逐级解析链接时 junction / 符号链接指向网络位置的同样不访问。每个路径的解析与 `stat` 有 `RESOLVE_FILE_TIMEOUT_MS`（2 秒）时限，超时按 `exists: false` 返回（映射盘主机离线时不拖慢回答渲染，也不给它加链接），同一批里其余路径照常返回 |
| `readInputHistory` / `recordInputHistory` | → `string[]`；`{ text }` → `null` |
| `readAttachment` | `{ file }` → `{ data: base64, mimeType, bytes }`；只读取当前会话持久事件登记过的图片附件，见下文 |
| `close` | → `null`；释放本连接对会话的引用与订阅，最后引用且空闲时才刷盘、释放会话锁，其余会话不受影响 |

`submit` / `enqueueInput` 的 `attachments` 是 `[{ data: base64, mimeType: string, label?, source?: "paste" | "upload" | "answer" }]`，任意 MIME 接受；合格图片沿用图片通道，其余包括不合格图片存为 `files`（[ADR-0072](../decisions/ADR-0072-file-attachments.md)）。单个 20 MiB、合计至多 10 个，Core 超限报 `invalid_command`。`respondQuestion.reply.answers[i].attachments` 形状相同，仅自由回答可附文件，可只附文件；不合规报 `invalid_reply`。一组回答合计限额同提交。远程三个入口统一检查附件原始字节合计不超过 `remoteAttachmentLimit`（`floor(REMOTE_MESSAGE_LIMIT * 3 / 4) - 1024`），超限报 `attachment_too_large`。

解码后交给 Core，大小与格式校验仍在 Core（[ADR-0023](../decisions/ADR-0023-image-input.md)）。`data` 不是合法 base64 报 `invalid_params`，不进 Runtime。

`submit.delegate` 为 `{ agent: string, task: string }`，与 `skill` 互斥。RPC 保留任务原文，Core 校验 agent 已启用并生成明确的 `task.agent` 委派指令，将委派快照写入 `message.user`；它不绕过入口权限确认，也不是直接启动外部进程。见 [ADR-0049](../decisions/ADR-0049-external-agent-subagent.md)。

`readAttachment` 对应 `RuntimeSession.readAttachment(file)`，客户端 `RpcSession.readAttachment(file)` 将标准 base64 解码为 `Uint8Array`。Core 仅接受单个文件名，拒绝路径分隔符、`..`、绝对路径与 Windows 替代数据流；文件必须出现于本会话的持久 `message.user.attachments` / `files` 或 `tool.completed.attachments` / `files`（包括回退后仍保留的原始记录）。读取当前会话附件目录中的实际文件，每次校验字节数与 sha256，不通过父会话目录兜底，也不允许链接逃逸。分叉读取复制到新 id 的附件；子会话仅授权自身日志里的引用（[sessions.md](../architecture/sessions.md)）。

附件错误以 `SessionError`（`-32002`）返回：`invalid_attachment_file`（非法文件名或链接路径）、`attachment_not_found`（本会话未登记）、`attachment_missing`（文件缺失）、`attachment_corrupt`（大小或 sha256 不符）、`attachment_read_failed`（其他文件读取 I/O 错误，如访问被拒绝）。

`runtime.readFile`（第 3.1 节）对应 `Runtime.readFile(path)`，客户端 `RpcRuntime.readFile(path)` 把图片的 base64 解码为 `Uint8Array`；取代原来的 `session.readFile`，不保留兼容。`path` 只收绝对路径，不限工作区，任何本机普通文件都能读（实现在 Core `session/local-file.ts`）。Core 先做词法检查：空串、控制字符、相对路径、`..` 段、设备命名空间、Windows 备用数据流与设备名一律拒绝；Windows 网络路径（`\\server\share`、`//server/share`、`\\?\UNC\...`）直接拒绝且不去访问——路径来自模型回答，访问网络位置会让系统发起 SMB 连接并带上 Windows 凭据。随后逐级 `lstat` / `readlink` 解析链接得到真实路径（不用 `realpath`，它会跟着 junction 打开网络位置），链接目标是网络路径的同样拒绝。映射的网络驱动器盘符（如 `Z:`、`Q:`）按本地路径处理，照常读取。整个读取（`lstat` / `readlink` 逐级解析、`stat`、读内容）有 `READ_FILE_TIMEOUT_MS`（5 秒）总时限：映射盘的主机离线时系统调用可能挂几十秒，超时返回 `file_read_timeout`（可重试；底层调用无法取消，迟到的结果丢弃）。只读普通文件，上限 `READ_FILE_MAX_BYTES`（2 MiB），超过时整份拒绝、不截断；扩展名是常见图片格式的按图片返回，其余按 BOM（UTF-16）或严格 UTF-8 解码，前 8 KiB 含 NUL 或解码失败视为二进制。错误以 `SessionError`（`-32002`）返回：`invalid_file_path`、`file_network_path`、`file_not_found`、`file_not_regular`、`file_too_large`、`file_binary`、`file_read_timeout`（超过总时限）、`file_read_failed`（其他 I/O 错误，含链接层数过多）。

### 3.3 `provider.*`

服务商配置（[provider-setup.md](../architecture/provider-setup.md) 第 6 节）。方法名与 Core 数据接口一致；`prepareProvider` 的 `credential` 是判别联合（`{kind:"apiKey",key}` / `{kind:"env",name}` / `{kind:"login",loginId}` / `{kind:"external-file"}`），其余形状校验与配置判断全部在 Core，RPC 层不复制。

| 方法 | 参数 → 结果 |
|---|---|
| `listProviderPresets` | `{}` → `ProviderPreset[]` |
| `describeProviders` | `{ workspaceRoot? }` → `{ providers: ProviderOverview[]; setupWarning? }`（`workspaceRoot` 指定按哪个工作区合并项目层，ADR-0051；缺省为后台启动目录）；`ProviderOverview.authKind`（`"apiKey"` / `"env"` / `"account"` / `"external-file"` / `"none"`）是条目的认证方式，客户端据此决定显示「换密钥」还是「重新登录」，不再自行推断；`displayName` 是条目声明的显示名（缺省显示 id） |
| `describeProviderSetup` | `{ presetId }` → `ProviderSetupDescription` |
| `describeAccountStorage` | `{ providerId }` → `AccountStorageSetup \| null` |
| `prepareProvider` | `Omit<AddProviderInput,"modelId">` → `PrepareProviderResult`（只校验、暂存草稿，不落盘）；名称与已有服务商重复时报 -32005 / `field: "name"`（[provider-setup.md](../architecture/provider-setup.md)「名称唯一性」）。结果的 `models` 是获取到的上游模型摘要（`id`、`displayName?`、`reasoning?`、`imageInput?`、`contextWindow?`、`maxOutputTokens?`，与 `modelCount` 同数），供保存前预览 |
| `commitProvider` | `{ draftId, manualModelId? }` → `AddProviderResult`；**变更方法**；提交时再查一次同名，准备之后别处写入了同名条目同样报 -32005 / `field: "name"` |
| `discardProvider` | `{ draftId }` → `null` |
| `setCredential` | `{ providerId, key }` → `null`；**变更方法** |
| `listModelSettings` | `{ providerId, workspaceRoot? }` → `ModelSettingsView[]` |
| `saveModelSettings` | `{ providerId, modelId, patch, workspaceRoot? }` → `null`；**变更方法** |
| `refreshUpstreamLimits` | `{ providerId }` → `{ warning: string \| null }`；**变更方法** |
| `refreshModelsDev` | `{}` → `{ warning: string \| null }`；**变更方法** |
| `removeSetupProvider` | `{ providerId }` → `null`；**变更方法**；后台任一会话正在使用时报 `provider_in_use`（同 CLI/TUI 的规则；服务端对共享的全部已打开会话判断） |
| `logoutProvider` | `{ providerId }` → `null`；**变更方法** |
| `describeSetupProvider` | `{ providerId }` → `ProviderEntryConfig \| null`；providers.json 条目原文（不含凭据），供编辑表单预填；非向导条目为 `null` |
| `probeSetupProviderModels` | `{ providerId, type, baseURL?, headers? }` → `{ models: UpstreamModelEntry[] }`；按候选配置向候选地址发一次模型列表请求，凭据按条目现有规则解析，不写任何配置；失败原样报错，由客户端决定是否「仍然保存」 |
| `updateSetupProvider` | `{ providerId, patch }` → `{ providerId, modelCount, message }`；**变更方法**；只允许 providers.json 里的自定义条目——非向导条目报 -32005 / `field: "providerId"`，内置预设条目报 `field: "preset"`；`patch` 缺省字段保留原值（字符串空串表示清除），`models` 提供时随条目更新清单与 `source`/`fetchedAt` |
| `setProviderEnabled` | `{ provider, enabled }` → `null`；**变更方法**（[ADR-0054](../decisions/ADR-0054-provider-model-toggle.md)）：写 settings.json 的 `disabledProviders`，不重载配置，响应之前推一次 `runtime.providersChanged`；停用保留该服务商的逐个模型设置，重新启用即恢复 |
| `setModelsEnabled` | `{ provider, models: string[], enabled }` → `null`；**变更方法**：批量写 `disabledModels`（`models` 为模型 id，非空），供「全部启用 / 停用」；同样推 `runtime.providersChanged` |
| `describeToggleImpact` | `{ provider, models? }` → `ToggleImpact`（`{ affectedSessions, defaultModel, roles }`）；只读，`models` 省略时按整个服务商计算，供客户端停用前确认 |

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

Probe 返回 `ok/durationMs/tools`，可带 `serverInfo`、`error: { code, message }`。stdio 带脱敏的 `stderrTail`（最多 20 行），HTTP 带可选 `httpStatus`。错误码为 `spawn_failed/startup_timeout/initialize_failed/mcp_secret_missing/connect_failed/http_status/auth_required/http_redirect`。草稿编辑可以通过 `credentialServerId` 引用可编辑的已保存条目的凭据，不返回密钥值。不带 `credentialServerId` 的草稿只使用本次 `secrets`，不查询凭据库；stored 引用缺少对应 secret 时返回 `mcp_secret_missing`。

三种变更成功后自动重载并更新已打开会话；MCP 变更响应不发送 `providersChanged`。桌面端已是单后台（ADR-0051），同进程的 Runtime 重载即全部生效，不再有跨后台传播；多客户端部署时其他进程可经 `runtime.reloadConfig` 同步（3.1）。

### 3.6 `skills.*`（ADR-0048）

| 方法 | 参数与返回 |
|---|---|
| `skills.describeSkills` | `{ workspaceRoot?: string }` → `SkillsDescription`；每次重新扫描 |
| `skills.setSkillEnabled` | `{ name: string, enabled: boolean }` → `{ affectedSessions: number }`；走配置写队列，响应之前推 `runtime.providersChanged`，当前 Turn 的快照保持不变 |
| `skills.importSkills` | 预检 `{ mode: "preview", sourceDir, target: "user" \| "project", workspaceRoot? }` → `{ mode: "preview", targetDir, targetLayer, candidates }`；执行 `{ mode: "commit", target, workspaceRoot?, decisions: [{ sourcePath, name?, action: "rename" \| "overwrite" \| "skip" }] }` → `{ mode: "commit", targetDir, results, affectedSessions }`。commit 走配置写队列，响应之前推 `runtime.providersChanged`。字段错误报 -32005（`data.field`），参数形状错误报 -32602 |
| `session.describeSkills` | `{ sessionId }` → `SkillsDescription`；只返回本会话快照 |

`SkillsDescription` 为 `{ skills: SkillOverview[], warnings: { path, line, message, kind }[], budget: { usedTokens, limitTokens, fullCount, nameCount, disabledCount, basis }, scannedDirs: string[], homeDir: string }`；字段定义和默认模型/8000 token 兜底依据见 [skills.md](../architecture/skills.md) 第 5 节。`session.submit` 可带 `skill: { name: string, arguments?: string }`，Core 把渲染正文固定进 message.user，客户端恢复不重读文件。新字段兼容旧日志，不提升 formatVersion。

技能变更（`setSkillEnabled`、`importSkills` 的 commit）通知复用 providersChanged 以刷新客户端目录；多进程部署时其他后台由客户端转发 `reloadConfig`（3.1 的 echo 防环约定）。

### 3.7 `agents.*`（ADR-0049）

| 方法 | 参数与返回 |
|---|---|
| `agents.describeExternalAgents` | `{ workspaceRoot?: string }` → `ExternalAgentsDescription` |
| `agents.saveExternalAgent` | `{ mode: "create" \| "replace", name, config }` → `ExternalAgentOverview` |
| `agents.deleteExternalAgent` | `{ name }` → `null` |
| `agents.setExternalAgentEnabled` | `{ name, enabled }` → `null` |
| `agents.probeExternalAgent` | `{ name }` 或 `{ config: ExternalAgentConfig }` → `ExternalAgentProbeResult` |
| `session.describeExternalAgents` | `{ sessionId }` → `ExternalAgentsDescription`；会话当前的外部 agent 快照 |

描述结果为 `{ agents, warnings: string[] }`；条目含 `name/command/args/env?/mode?/configOptions?/description?/enabled/origin/editable/path?`。`origin` 为 `app` 或 `user`；只有 `external-agents.json` 的 app 条目可编辑，`config.json` 条目只读。创建名称跨来源不区分大小写唯一，冲突返回 `-32005`、`data.field: "name"`。项目配置的外部 agent 始终忽略；配置详情见 [config.md](../architecture/config.md#外部-agent-配置)。

探测结果包含 `ok/durationMs/configOptions`，可带 `agentInfo: { name, version, title? }`、`authMethods: { id, name, description? }[]` 和 `error: { code, message }`。`configOptions` 每项含 `id/name/description?/category?/currentValue/options: { value, name, description?, group? }[]`；对方按分组返回的选项会展平，`group` 为分组名，`description` 原样转交。探测只解析命令并执行 ACP initialize/session-new，从不发送 prompt；草稿探测不写配置、不消耗对方模型额度。

保存、删除、启停串行执行；Runtime 在写入成功后重载配置并在 Turn 边界更新已打开会话，服务端在响应之前发送**一次** `runtime.providersChanged`，失败不发通知。桌面端只监听该通知刷新页面（单后台）；多进程部署时客户端可按 3.1 的 echo 约定转发 `reloadConfig` 给其他后台，避免重复重载成环。

### 3.8 通知

ADR-0060 第 4 轮的只读子会话方法与通知见第 4.1 节。它们不复用可交互的 `session.*` 句柄。

| 方向 | 方法 | 参数 | 说明 |
|---|---|---|---|
| 客户端→服务端 | `session.interrupt` | `{ sessionId }` | 中断运行中的 Turn；无 Turn 时无操作。`submit` 请求随后以 `aborted` 返回。服务端也接受带 `id` 的请求形式（回复 `null`） |
| 服务端→客户端 | `event` | `{ sessionId, event }` | `event` 原样是 [events.md](events.md) 的 `RuntimeEvent` 信封，不另包一层 |
| 服务端→客户端 | `runtime.providersChanged` | `{}` | 服务商、技能或外部 agent 配置变更成功后的通知；`provider.*`、`skills.*` 写方法（`setSkillEnabled`、`importSkills` 的 commit）、`agents.*` 三个写方法的响应之前到达一次，登录和显式重载同原规则（3.3–3.7） |
| 服务端→客户端 | `runtime.sessionsChanged` | `{}` | 会话列表变了，请重拉 `runtime.listSessions`。**不带任何会话内容**（标题、路径都不带）。本后台的 `runtime.createSession`、`runtime.forkSession`、`runtime.renameSession` 成功后发；会话首条用户消息落盘（列表标题 `firstText` 从无到有）和 `session.titled`（生成的标题优先于首句）也发，其余事件不发。发送前合并：第一次变化起 300 ms 内的所有变化只发一条，窗口内不顺延。别的进程（如另开的 CLI）改的列表不经过本后台，没有通知，客户端回前台时自行重拉。旧客户端没有监听器，忽略即可 |
| 服务端→客户端 | `grants.changed` | `{ workspace?, sessionId? }` | 新增、撤销授权或改信任后重拉；会话 ID 为树根。易失、不写日志，广播给所有已握手连接（含远程） |
| 服务端→客户端 | `schedule.changed` | `{ taskId? }` | 定时任务列表、启停或运行状态变了，请重拉 `schedule.list`（ADR-0064）。易失，不写日志，不带任务内容；保存、删除、一次运行开始/结束/被跳过之后发。`taskId` 缺省表示整体变化。广播给所有已握手连接（含远程）。每次发出时同时触发一次 `runtime.sessionsChanged`（运行会建出新会话，照常 300 ms 合并） |
| 服务端→客户端 | `login.completed` | `LoginCompleted` | 登录会话完成或失败（含取消）；绝不先于对应 `login.start`/`startDraft` 的响应到达（3.4） |

### 3.9 `shutdown`

请求，无参数。服务端完成与"传输断开"相同的清理（第 6 节）后回复 `null`，再关闭传输。

### 3.10 `schedule.*`（ADR-0064）

定时任务的增删改查与立即运行。任务定义、存储、调度与跳过规则见 [schedule.md](../architecture/schedule.md)；这里只列接口。

| 方法 | 参数 → 结果 |
|---|---|
| `schedule.list` | `{}` → `{ tasks: ScheduleTaskOverview[], scheduler: { running, reason? }, warnings: string[] }` |
| `schedule.save` | `ScheduleSaveInput`（`id?`、`name`、`prompt`、`workspace?`、`model?`、`reasoningEffort?`、`permissionPreset?`、`schedule`、`enabled?`、`maxDurationMinutes?`）→ `ScheduleTaskOverview`。不带 `id` 为新建，带 `id` 为整体替换；暂停与恢复也走它（`enabled`） |
| `schedule.delete` | `{ id }` → `null`；任务和它的历史一并删除，已产生的会话保留；任务不存在时不报错 |
| `schedule.runNow` | `{ id }` → `{ started: true, sessionId }` 或 `{ started: false, reason: "previous_running" \| "concurrency" }`。`trigger` 记 `manual`，不改动计划的下一次时间 |
| `schedule.history` | `{ id }` → `ScheduleHistoryEntry[]`，新的在前，最多 200 条 |

- `ScheduleTaskOverview` 在任务定义之外带服务端算好的 `nextRunAt`（已暂停或 `manual` 缺省）、`lastRun`（最近一次实际运行，跳过的不算）、`running`、`stats.last7Days.{runs, skipped}`，客户端的列表与概况格直接用，不自己算。历史条目的 `denied` 是这次运行中被无人值守规则拒绝（`non_interactive`）的操作数，由 Core 在运行结束时从该会话的结算记录统计，客户端不扫会话日志。
- `scheduler.running` 为 `false` 时 `reason` 是 `disabled`（本进程没有以 `--scheduler` 启动，只有桌面端后台启用）或 `locked`（同一 `NOCTURNE_HOME` 下另一个 Nocturne 正在调度）。此时任务照常可管理，只是不会自动触发；`schedule.runNow` 在非调度器进程里被拒。
- 字段校验失败报 `-32005 / invalid_field`，`data.field` 为出错的字段（`name`、`prompt`、`workspace`、`model`、`reasoningEffort`、`permissionPreset`、`schedule`、`enabled`、`maxDurationMinutes`），客户端据此标输入框；任务数超上限等整体错误为 `config`，任务不存在或 id 无效为 `id`。`schedule.runNow` 在非调度器进程里报同一错误码，`field: "scheduler"`，运行没能开始为 `field: "run"`。字段级校验放在这里，没有给 `RuntimeCommandError` 的 `detail` 加字段。
- `runtime.createSession` 的参数**不含** `interactive` 与 `schedule`：前者是进程内会话选项，后者只由调度器写入。服务端只摘取列出的字段，客户端强行带上也会被忽略，不能伪造定时来源或把会话开成无人值守。
- 远程连接：`schedule.list`、`schedule.history`、`schedule.runNow` 在白名单内，`schedule.save`、`schedule.delete` 只在本机（第 7 节）。

### 3.11 `grants.*` 与会话授权（ADR-0068）

用户操作入口，不注册成模型工具；授权形状与实时撤销语义见 [permissions.md 5.4](../architecture/permissions.md#54-grant-的形状与匹配)。

| 方法 | 参数 → 结果 |
|---|---|
| `grants.workspaces` | `{}` → `{ workspace, grantCount, trusted, hasProjectConfig }[]`（真实路径） |
| `grants.list` | `{ workspace }` → `Grant[]` |
| `grants.revoke` | `{ workspace, kind, target }` → `null` |
| `grants.revokeAll` | `{ workspace }` → `null` |
| `grants.describeProject` | `{ workspace }` → `{ mcpServers: [{ name, command }], hooks: [{ event, count }], relaxedRuleCount }`，只解析、不执行 |
| `grants.setTrusted` | `{ workspace, trusted }` → `null`，新开或恢复会话生效 |
| `session.listGrants` | `{ sessionId }` → `Grant[]` |
| `session.revokeGrant` | `{ sessionId, kind, target }` → `null` |
| `session.revokeAllGrants` | `{ sessionId }` → `null` |

会话方法由 Core Runtime 的 `listSessionGrants/revokeSessionGrant/revokeAllSessionGrants` 解析会话树根，活动子会话 ID 与根 ID 等效；不打开或恢复子会话。单项以 kind + target 精确匹配，写入失败报错且列表不变。成功新增、撤销、改信任后由 Core 发易失变更，再由 Hub 广播；RPC 不缓存授权、不参与权限求值。工作区汇总与解析输出口径见 [config.md 第 4 节](../architecture/config.md#4-grant-的持久化)。远程只可查看和撤销，信任与命令描述在 Core 调用前拒绝（第 7 节）。

## 4. 订阅与回放

`session.subscribe { sessionId, afterSeq }`：服务端先挂实时监听并缓冲，再读日志，推送 `seq > afterSeq` 的全部**持久**事件，随后冲刷缓冲（按 `seq` 去重，已推过的不再推），最后转入实时推送（持久与临时都推）。请求在回放与衔接完成后才返回 `{ lastSeq }`，因此回放期间产生的新事件不丢、不重，`seq` 连续。

- **临时事件不回放**：断开期间错过的流式增量、进度不补发（[events.md](events.md) 第 1、2 节）。待发输入的 `input.pending` 属于此类：附加后另调 `session.pendingInputs` 取当前快照，两者同形，后到的整份覆盖（[view.md](view.md#待发输入预览状态)）。
- **不限流**：第一版服务端不为慢客户端设有界队列，事件直接写入传输（stdio 管道由操作系统缓冲）；持久事件本来可按 `seq` 补读，临时事件的丢弃策略留到出现慢连接问题时再定（与 [events.md](events.md) 第 6 节同步）。
- 同一连接内同一会话同一时刻只有一路订阅：再次 `subscribe` 替换该连接的前一路，不影响别的连接。不同连接各自按 `afterSeq` 回放并衔接实时推送，不丢不重。
- 实际会话在后台级 Hub 共享：第一条连接真正打开，其他连接 `resumeSession` 返回当前 `SessionOpened`（含当前 `lastSeq`），同连接重复打开仍报 `session_already_open`。两端命令共用 Core 行为：后到的 submit 报 `session_busy`，权限/提问任一端回复生效，重复回复报 `unknown_request`，中断任一端可发。
- 权限结算广播已有的 `permission.resolved`；Core 没有 `question.resolved`，提问回复后沿用 `runtime.status(running_tool)` 与对应 `tool.completed` 收束（ADR-0052 修订）。
- 客户端用 `protocol` 的 reducer 折叠视图（`createSessionView` / `reduceSessionView` / `replaySessionView`，`@nocturne/rpc/client` 重新导出，`trackSessionView` 封装"订阅 + 折叠"）。**验收标准**：同一会话经 RPC 折叠得到的 `SessionView` 与进程内重放相等（[view.md](view.md) 第 6 节，`revision` 与 `notices` 除外）。
- 重连：保存最后收到的持久事件 `seq`，重启后台后 `resumeSession`，再以 `afterSeq` 订阅即可续接；会话日志是唯一事实来源（[ADR-0003](../decisions/ADR-0003-session-event-log.md)）。

### 4.1 子会话只读观察（ADR-0060 第 4 轮）

**不新增或修改 RuntimeEvent**，不改变协议版本 `1` 或日志格式；新增 JSON-RPC 方法与通知，旧客户端不调用、不受影响。行为与事实来源见 [subagent.md 第 12 节](../architecture/subagent.md#12-客户端呈现)。

#### 查询与 Core API

新增 Runtime 级 API，不放在 `RuntimeSession`，因为 launcher 持有的子会话没有 Hub 的可交互句柄：

```ts
Runtime.listSubagents({ parentSessionId }): Promise<SubagentSummary[]>;
Runtime.readSubagentAttachment(
  { parentSessionId, childSessionId, file },
): Promise<ReadAttachmentResult>;
Runtime.observeSubagent(
  { parentSessionId, childSessionId, afterSeq?: number, signal?: AbortSignal },
  { onEvent(event: RuntimeEvent): void, onEnd(end: SubagentReadEnd): void },
): Promise<SubagentObservation>;

interface SubagentSummary {
  parentSessionId: string;
  callId: string;
  childSessionId: string;
  profile: string;                 // 启动参数 profile / agent / default，不读当前配置反推
  background?: true;               // 后台子代理（ADR-0073）；父 task 已结算时 state 仍可为 running
  taskSummary: string;             // task 原文压成单行，最多 120 个 Unicode 码点
  startedAt: string;               // 子 session.created.time，ISO 8601
  state: "running" | "ended" | "unsealed";
  endedAt?: string;                // 有终止事实才提供，不以读取时刻代替
  durationMs?: number;             // 父 task.completed.durationMs 优先；否则起止事件时间差
  durationApproximate?: true;      // 仅在使用事件时间差时提供
  outcome?: { status: ToolCallStatus; error?: { code: string; message: string } };
}
interface SubagentReadEnd {
  lastSeq: number;
  summary: SubagentSummary;
  source: "launcher" | "snapshot";
  tailIgnored: boolean;            // 只读快照略过不完整/无法解析的最后一行
}
interface SubagentObservation {
  lastSeq: number;                 // 回放和缓冲衔接后的持久高水位
  summary: SubagentSummary;
  mode: "live" | "snapshot";
  unsubscribe(): void;             // 幂等；只撤观察，不关闭子会话
}
```

`ToolCallStatus` 沿用 protocol。summary 是查询投影，不是新的会话状态或事件；最终结果正文仍从父 `task.completed.modelContent` 或子 `finish` 的已持久化输入读取，不复制进 summary。`outcome` 只来自父调用已持久化的结算，没有时省略；`endedAt` 优先取父结算时间，否则取可判定终止的最后一个子 `turn.completed.time`。缺父耗时的时间差是近似耗时，客户端须标注；没有结束事实时不提供最终耗时。

`listSubagents` 返回该父会话的**直接内置子会话**（含已结束），按 `startedAt`、`childSessionId` 升序。父日志必须存在；已有父 Session 时读其已提交事件，否则只读父日志。映射以子 `session.created.parent` 为准，父日志 `tool.started.input` 补档位和摘要；旧日志缺启动参数时档位用 `default`、摘要回退首条子 `message.user`，再缺则「子代理」（常量 `SUBAGENT_TASK_FALLBACK`，由 `@nocturne/core/protocol` 导出，Core 与桌面端共用）。不能根据当前档位配置判断历史调用属于内置还是外部。`task.output.childSessionId` 仅为定位提示，使用前仍校验 child 的 parent。外部 ACP 不返回伪造的 child id（桌面处理见 ADR 修订（五））。

工作树隔离的保留项（[ADR-0075](../decisions/ADR-0075-worktree-isolation.md) §6）：`subagent.worktrees({ parentSessionId })` 返回该父会话登记的副本与分支（含已收束的 `changes`）；`subagent.deleteWorktree({ parentSessionId, childSessionId })` 删除副本与 `nocturne/` 分支，子代理仍在运行时报 `invalid_command`；`subagent.diff({ parentSessionId, childSessionId, file })` 返回该文件 `base..head` 的差异文本，文件必须在结果清单内。

查询可复用 `listSessions({ includeSubagents: true })` 的只读日志头扫描建立候选索引，但不能把 `locked` 当作运行状态，也不能只靠该列表的容错跳过逻辑校验指定 child。运行态来自 Runtime 共享的 launcher 登记簿；缓存失效可重扫日志，不能把缓存作为持久事实源。

#### RPC 映射与通知

Core 的 signal 可在建立和实时阶段取消观察，unsubscribe 同样幂等取消；signal 不上 RPC 线，服务端用它取消建立中的订阅。回放与缓冲冲刷每 128 条让出事件循环，每条 event 各发一条通知，不把整个日志塞进单条消息。固定快照由一次 readFile 获得，日志解码也按 128 条分批。

| 方法 | 参数 → 结果 |
|---|---|
| `subagent.list` | `{ parentSessionId }` → `SubagentSummary[]`；不要求 `resumeSession` 或打开父会话 |
| `subagent.cancel` | `{ parentSessionId, childSessionId }` → `null`；映射 `Runtime.cancelSubagent`（[ADR-0073](../decisions/ADR-0073-background-subagents.md) §4）。只对本父会话运行中的后台子代理有效，否则 `invalid_command`；结果随后以 `message.user.subagent(status: "cancelled")` 交付父会话。与观察方法不同，它是会话内操作，远程允许（第 7 节） |
| `subagent.readAttachment` | `{ parentSessionId, childSessionId, file }` → `{ data: base64, mimeType, bytes }`；只读子日志登记的图片附件，同 3.2 的文件名、真实路径、字节数和 sha256 校验，不借父目录兜底、不打开 child |
| `subagent.subscribe` | `{ parentSessionId, childSessionId, subscriptionId, afterSeq? }` → `{ lastSeq, summary, mode }`；衔接完成后响应 |
| `subagent.unsubscribe` | `{ subscriptionId }` → `null`；连接内幂等，也能取消正在回放的观察 |

| 服务端通知 | 参数 | 说明 |
|---|---|---|
| `subagent.event` | `{ subscriptionId, parentSessionId, childSessionId, event }` | 原样 RuntimeEvent，事件的 sessionId 必须等于 childSessionId；不混入父 `event` 通道 |
| `subagent.closed` | `{ subscriptionId, parentSessionId, childSessionId, end: SubagentReadEnd }` | 本次观察自然结束，最后一条事件之后至多一次；不是 RuntimeEvent、不写日志 |

`RpcRuntime.listSubagents(parentSessionId)` 封装查询；`RpcRuntime.readSubagentAttachment(input)` 将附件 base64 解码为 Uint8Array，返回类型同 Core 的 ReadAttachmentResult；复用已有附件读取校验器并以只读子日志前缀为授权引用集合，不要求先订阅。`RpcRuntime.observeSubagent(input, observer)` 封装订阅，返回只读 observation 与幂等退订，不返回 `RpcSession`。客户端包在发送前生成本连接内不复用的 subscriptionId、挂好通知路由，再发请求；不向调用方要求手工维护 id。同连接同一 `(parentSessionId, childSessionId)` 再订阅替换旧观察；其他 child 或其他连接互不影响。服务端按代数取消旧回放、缓冲和监听，旧 subscriptionId 的迟到消息由客户端丢弃。通知（包括快照的 closed）允许先于 subscribe 响应，封装必须缓存终止状态，不得在收到响应后重新标成 live。subscribe 失败时清掉通知路由与监听；unsubscribe 不产生 closed。

#### 回放、衔接与结束

1. **运行中**：在 Runtime 登记簿中同步取得该 child 的观察源，先挂事件与 launcher 终止监听并缓冲，再复制 `child.durableEvents()` 的已提交前缀。登记簿查找、挂监听、取前缀之间不插入异步间隙；之后分批回放可以让出事件循环。只推 `seq > afterSeq` 的持久事件，冲刷缓冲时按 seq 去重，再接实时持久与临时事件。此路径不重新打开日志，不获取子锁。
2. **运行中结束**：launcher 的最后一轮 `turn.completed` 不一定代表调用结束（可能还要催促）；必须等 launcher 的 SessionEnd、所有排队写入与 child.close 完成后，才排入观察源的终止标记。标记排在全部已提交事件之后；回放期间结束则连同终止标记一起缓冲，冲刷完成后发 closed。异步 close 期间仍保留登记项；查找只会得到完整观察源或关闭后的只读快照，不能落入一个无人监听的交接窗口。
3. **未登记/已结束/后台重启后**：只读固定字节快照，校验后回放，mode 为 snapshot，最后发 closed；没有文件监听、轮询日志或跨进程接流。即使另一个进程正持锁也只表示「本次日志快照」，不能声称它已结束或本后台正在运行。主动刷新可重读快照。
4. **未收束日志**：读到的合法持久前缀照常推送；没有当前 launcher，也无可证明终止的日志事实时 summary.state 为 unsealed，显示「日志未收束／运行状态未知」。closed 只表示本次读取结束，绝不等于成功或中断。即使有旧 `turn.completed(done)`，缺 finish 且可能还有催促轮，也不能据此认定完成。运行源不存在时，有父结算且子 Turn 已闭合、或已闭合的成功 finish、或子最后一轮明确以非 done 原因结束，才可判 ended；尚有未闭合 Turn 时始终 unsealed。
5. **只读解析**：只读 reader 可共享解码、连续 seq/首条 session.created/版本校验，不调用 `store.load`、`loadEvents` 的修尾路径或 repair。不取锁、不 fsync、不建目录、不启动 Hook/MCP/Provider、不截断、不备份尾部、不追加恢复事件；忽略未换行尾行（即使能解析）或无法解析的最后一行并置 tailIgnored。中间损坏、seq 空洞/倒序、sessionId 不匹配或不支持的版本报错，不跳过坏行拼接后文。未知持久类型仍按 session_log_newer 报错，不当普通坏尾忽略。

临时事件只交付挂监听后收到的部分，按原顺序最多一次，不承诺补回订阅前的增量；同第 4 节。afterSeq 缺省 0，必须是非负安全整数且不大于读到的持久高水位，否则 invalid_params；换后台只用最后持久 seq 续接，瞬态内容清空，持久去重由观察封装保证。客户端若没有保留之前的 SessionView，必须从 0 重放。

#### 只读边界、错误与清理

- Core 对两个 session id 验证为安全的单文件名标识（非空、至多 128 个 ASCII 字母/数字/下划线/连字符），不接受路径；RPC 对字符串、subscriptionId（非空、至多 128 字符）及 afterSeq 做形状校验，重复的在用 subscriptionId 报 invalid_params。文件不存在为 `SessionError / session_not_found`，父子关系不匹配（包括把顶层会话当 child）为新增 `SessionError / subagent_parent_mismatch`，非法 Core id 为 `SessionError / invalid_session_id`；日志错误沿用 session_log_corrupt / session_log_newer，I/O 读取失败为新增 session_read_failed。均按第 5 节映射 -32002；RPC 形状错误为 -32602。list 单个不可读候选可按既有列表规则跳过，指定 child 的 subscribe 必须明确报错。
- 观察方法（list / subscribe / unsubscribe / readAttachment）**均不进远程白名单**（`subagent.cancel` 例外，见第 7 节），按 ADR-0060 第 6 节，远程在 Core 调用前报 remote_not_allowed；ADR-0052 的配对、加密与既有 session 方法规则不变。新通知只发给持有观察的本机连接，不广播。以后手机要使用须另审白名单，不因「只读」自动开放。
- readAttachment 同样先校验父子关系与安全 id；file 必须为字符串，否则 invalid_params；附件层错误沿用第 3.2 节。该补充只读方法用于保持主对话的图片输出渲染，不使用 runtime.readFile 绕过附件引用校验。只读观察的 DTO 放 protocol，行为与观察源放 Core，RPC 客户端仍仅运行时依赖 protocol。
- 观察不在 Hub.sessions / Connection.sessions 登记可交互句柄，不增持有子锁的引用，不提供 submit/respondPermission/respondQuestion/interrupt/close 子会话的方法。未显式打开的 child 对既有 session 命令仍为 unknown_session；已有显式 resume 的行为不在本接口中改变。它不是 agent 工具，不经权限求值，也不创建 Grant。
- 连接持有观察表（含还在建立的观察）；unsubscribe、替换、父 `session.close`、连接断开和 shutdown 都撤监听、取消回放并丢缓冲。未完成的异步读取返回时检查取消代数并立即退订，不得复活。自然 closed 后释放表项；客户端缓存视图不影响服务器清理。观察退出不触碰 launcher、并发槽或 child.close。本机整条连接断开导致 Turn 中断是第 6 节既有宿主行为，不是观察的副作用。
- `resumeSession` 保留原来的交互式打开/锁/修复语义，**不能描述为只读**；`listSessions({includeSubagents})` 保留原语义，既不建立事件订阅也不授予操作能力。本接口是新增方法，不是给这两者添加一个含糊的 readonly 开关。

## 5. 错误

失败响应是 JSON-RPC error：`code` 取固定数值，`message` 是原来的用户可读文案，`data.code` 是原来的**字符串错误码**，`data.name` 是错误类名。客户端按 `data.code` 分支，与进程内按 `error.code` 分支等价（`RpcError.code`）。

| `code` | 含义 | `data.code` 举例 |
|---|---|---|
| `-32700` / `-32600` | 报文不是合法 JSON / 不是合法请求 | `parse_error`、`invalid_request` |
| `-32601` | 方法不存在 | `method_not_found` |
| `-32602` | 参数缺失或类型错误（在进入 Runtime 之前校验） | `invalid_params` |
| `-32603` | RPC 层内部错误 | `internal_error` |
| `-32000` | 其他 Core 错误（原样透传 `message`） | 原 `error.code`（如有） |
| `-32001` | `RuntimeCommandError`（命令被拒绝，原因码见 [events.md](events.md) 第 7 节） | `session_busy`、`unknown_request`、`invalid_reply`、`input_consumed`（编辑或撤回的待发输入已被 Turn 取走，ADR-0070）、`invalid_command`、`invalid_model`（因模型不可用，如已停用；此时 `data` 另带 `disabled: "provider" \| "model"` 与 `model: { provider, model }`，双重停用时另带 `providerDisabled: true`（`disabled` 记 `"model"`，一键重新启用需同时恢复两者），见 [ADR-0054](../decisions/ADR-0054-provider-model-toggle.md) §3，客户端据此区分「已停用」与「已删除」） |
| `-32002` | `SessionError` | 会话层错误码 |
| `-32003` | `ProviderLoginError` | 登录错误码 |
| `-32004` | RPC 层状态错误 | `runtime_unavailable`（本机尚未创建 Runtime）、`remote_not_allowed`（远程方法或参数越界，中文文案说明限制）、`workspace_not_found` / `workspace_untrusted`（远程新建会话的目录不存在或需在电脑上信任）、`response_too_large` / `attachment_too_large`（远程结果超过报文上限）、`not_initialized`、`already_initialized`、`protocol_version_mismatch`、`unknown_session`、`session_already_open`、`shutting_down`、`provider_config_unavailable`（服务端未注入服务商配置）、`provider_in_use`（后台任一会话正在使用的服务商拒绝删除）、`unknown_login`（登录会话不存在或已结束） |
| `-32005` | `ProviderSetupError` / `McpSettingsError` / `ExternalAgentSettingsError` / `ScheduleError`（管理表单字段错误） | `invalid_field`；`data.field` 为对应字段名，客户端据此标输入框。外部 agent 使用 `name`、`mode`、`command`、`configOptions` 等，名称冲突同样返回 `name`（3.7） |

客户端侧另有 `connection_closed`：连接断开时所有在途请求以它失败，而不是悬挂。

## 6. 生命周期

- **本机输入结束**（stdin EOF）：不再接收请求，输出仍可用。主动关闭全部远程传输，中断所有运行中的 Turn，等待已接收的本机请求（包括等待握手或打开会话的请求）返回；EOF 后才开始的本机 submit 同样中断并返回 `aborted`。所有回复写完并刷出后，关闭全部会话（刷盘、释放会话锁）、释放 Runtime 资源，再结束 `serve`。之后新 Runtime 可直接恢复会话，没有残留锁。
- **完整断开**（输出 EPIPE、客户端崩溃）：执行同样的中断与清理，但输出不可用时丢弃回复。`LineTransport.onClose` 表示输入结束或完整断开；异步缓冲输出的传输实现可选的 `flush()`，保证清理前已发送的报文刷出。
- **登录与草稿清理**（两种断开与 `shutdown` 相同）：进行中的登录会话全部 `cancel`（关闭回环端口，其 `login.completed` 照常推送）；本连接未提交的 `prepareProvider` 草稿丢弃（只释放内存，不写盘、不消费登录）；已完成未提交的草稿登录经 `discardDraftLogin` 丢弃暂存凭据。草稿与草稿登录因此不跨连接存活。
- **远程断开**：只清理本连接的订阅、会话引用与在途请求，不中断 Turn，不等待挂起 submit；Turn 结束后的回复直接丢弃。引用归零且空闲才真正关闭；运行中的 Turn 收束后再关，其间又有连接打开则保留。
- **`shutdown` 请求**：仅本机可调用，同样的后台清理完成后回复，再关闭传输；远程报 `remote_not_allowed`，不影响后台。
- 握手前断开：不创建 Runtime，正常结束。

## 7. 安全与日志

- stdio 本机连接仍由父进程持有；配置了远程主机时由后台主动连中继，按 [ADR-0052](../decisions/ADR-0052-remote-web-client.md) 实施邀请、配对与加密，不能把能力白名单当作鉴权。全部 `remote.*` 方法仅开放给本机，不进入远程白名单。
- 远程能力白名单在服务端显式登记，以 `RpcMethodName` 编译检查；新增方法默认不开放。边界原则（[ADR-0052 修订 2026-10-15](../decisions/ADR-0052-remote-web-client.md#2026-10-15手机功能对齐桌面端设置除外)）：远程连接不能改动撤销手机后仍然生效的东西（设置、凭据、新增持久授权、项目信任）；撤销已有授权只收紧，按 [ADR-0068](../decisions/ADR-0068-grants-management.md) 放开，会话内操作全部放开。方法越界和参数越界均报 `-32004 / remote_not_allowed`，且不调用 Core，不消费待处理请求：

| 方法 | 远程 |
|---|---|
| `initialize` | 仅连接握手，不创建 Runtime |
| `runtime.listSessions`、`runtime.usageStats` | 允许（只读）；`listSessions` 的 `cwd` 只是过滤条件 |
| `runtime.listModels`、`runtime.defaultModel`、`runtime.listRecentModels`、`runtime.describeModelRoles`、`runtime.listShells` | 允许（只读），`workspaceRoot` 不受限 |
| `runtime.createSession` | 允许全部选项。显式 `cwd` / `workspaceRoot` 须是已存在的绝对路径文件夹，否则 `workspace_not_found`；工作区根有项目配置但未信任、且不是列表可见的非子代理会话用过的 cwd 或工作区根（真实路径匹配）时报 `workspace_untrusted`，信任只能在电脑上决定。`text` 不触发 Turn |
| `runtime.resumeSession`、`runtime.forkSession`、`runtime.renameSession` | 允许；恢复可带 `model`、`force`，重命名只改会话标题 |
| `session.subscribe`、`session.unsubscribe`、`session.close`、`session.state` | 允许 |
| `session.submit` | 允许完整载荷（图片、文件引用、技能、`delegate`） |
| `session.enqueueInput` | 允许完整载荷（同 `submit`）。ADR-0070 的「追加消息」：手机可在运行中插话或排队 |
| `session.updateInput` / `session.cancelInput` / `session.resumeInputs` / `session.pendingInputs` | 允许；待发输入是同一会话的共享状态，手机改了桌面立刻看到（`input.pending`） |
| `session.interrupt` | 请求与通知均允许 |
| `subagent.cancel` | 允许（ADR-0073）：取消本会话的后台子代理是会话内操作。手机不能用 `subagent.list`，运行中的后台子代理从会话视图推导（`pendingBackgroundSubagents`） |
| `session.respondPermission` | `reply.remember === "project"` 拒绝并保持待处理；`"session"` 或省略允许 |
| `session.respondQuestion` | 允许 |
| `session.setModel`、`session.setReasoningEffort`、`session.setPermissionPreset`、`session.compact`、`session.rewind`、`session.rewindTargets`、`session.turnChanges`、`session.turnChangeDiff` | 允许（会话内，随会话结束） |
| `session.describeContext`、`session.describeSkills`、`session.describeExternalAgents`、`session.mcpServers`、`session.listShells`、`session.shellInfo`、`session.reasoningEffortInfo`、`session.visionInfo`、`session.fileIndex`、`session.resolveFiles` | 允许（只读） |
| `session.readAttachment` | 允许；附件原始字节超过远程上限报 `attachment_too_large` |
| `session.readInputHistory`、`session.recordInputHistory` | 允许 |
| `schedule.list`、`schedule.history`、`schedule.runNow` | 允许（ADR-0064）。前两者只读；`runNow` 不改任务、不留下撤销手机后仍生效的东西，等同会话内操作（它跑的是电脑上已有的、用户在本机写好的指令，权限仍按任务的预设，无人值守时越权操作被直接拒绝） |
| `grants.workspaces`、`grants.list`、`grants.revoke`、`grants.revokeAll`、`session.listGrants`、`session.revokeGrant`、`session.revokeAllGrants` | 允许：查看和收紧授权，不允许新增项目授权 |
| `grants.setTrusted`、`grants.describeProject` | 拒绝且不调用 Core；信任会放宽，项目命令无需发送手机 |
| `schedule.save`、`schedule.delete` | 拒绝：改的是持久配置，启停与编辑也走 `save`，手机页面里这些控件禁用并提示「请在电脑上操作」 |
| `runtime.readFile` | 拒绝：只服务本机右侧面板（ADR-0060），手机没有面板，也不扩大远程可读的文件范围 |
| 其他全部方法 | 拒绝。包括 `session.setShell`（会写 `settings.json` 的 Shell 设置）；全部 `runtime.*` 设置写入与 `describeSettings`、`getPreference`、`setPreference`、`reloadConfig`、审查器查询与测试、`refreshModelsDev`、`refreshUpstreamLimits`、`shutdown`；全部 `provider.*`、`login.*`、`remote.*`、`mcp.*`、`agents.*`、`skills.*`，以及上面未列出的 `schedule.*` |

- **报文上限**：加密通道单条消息超过 `MAX_MESSAGE`（16 MiB）会整条关闭。远程连接的成功结果编码后超过 `REMOTE_MESSAGE_LIMIT`（`MAX_MESSAGE` 减 64 KiB 余量）时改报 `-32004 / response_too_large`；`readAttachment` 先按原始字节预检（base64 后不超上限，`remoteAttachmentLimit`），超限报 `attachment_too_large`，文案「附件过大，请在电脑上查看」。请求方向由手机网页发送前估算，服务端不再放宽。
- 远程连接对服务端→客户端通知没有白名单，通知由发送方决定发给谁：`event` 只发给订阅了该会话的连接，`remote.*` 只发本机连接，`login.completed` 只发发起登录的连接，`runtime.providersChanged`、`runtime.sessionsChanged`、`schedule.changed` 与 `grants.changed` 广播给所有已握手连接（含远程）。`runtime.sessionsChanged` 不带内容，手机收到后调用的 `runtime.listSessions` 本来就在上面的白名单里，远程能力边界不变。
- `runtime.providersChanged` 广播给所有已握手连接；`login.completed` 只发给发起登录的连接。Runtime 句柄、实际会话、配置对象与变更队列在 Hub 共享；订阅、请求、握手、草稿和登录属于单连接。
- 会话已被其他连接打开时，`resumeSession` 的 `model` / `force` 被忽略，返回当前状态。
- 权限判定只在 Runtime 的权限层。RPC 层只转发 `permission.requested` 事件与 `respondPermission` 回复，不判断"要不要确认"。
- 诊断记录（`diagnostics` 回调）只含连接状态（含 `origin`）、方法名与结果（成功与否、错误码），**不含任何参数与通知内容**——参数里可能有密钥明文（`provider.prepareProvider`、`provider.setCredential`）或用户输入，通知里可能有一次性密钥（`login.completed.unstoredKey`）。
- **敏感参数**：服务端维护一张敏感方法表（`SENSITIVE_METHODS`）——`runtime.updateSettings` 的 `reviewerKey`、`provider.prepareProvider` 中 `credential.kind === "apiKey"` 的 `key`、`provider.setCredential` 的 `key`、`provider.updateSetupProvider` 的 `patch.headers` 各值、`provider.probeSetupProviderModels` 的 `headers` 各值、`login.submitManual` 的 `text`。这些方法失败时，错误响应 `message` 与 `data` 里出现的秘密值一律替换为 `[redacted]`；其他方法沿用 Core 的固定文案错误（Core 错误本身不含秘密）。通知内容不进诊断，密钥只经其语义通道传递（如 `login.completed.unstoredKey` 恰好一次）。

## 8. 与公开 API 保持一致

方法清单以公开 API 为准，RPC 层不另加能力。`packages/rpc/src/server/coverage.ts` 登记 `Runtime`、`RuntimeSession` 与 `RuntimeConfig` 每个成员对应的 RPC 方法或"不映射"的原因，键类型由 `keyof` 推导：公开 API 新增成员而没有登记，编译失败；覆盖测试再用真实对象的键与服务端方法表对照。服务商配置函数另有 `PROVIDER_FUNCTION_METHODS` / `PROVIDER_FUNCTIONS_NOT_MAPPED` 一张表，覆盖测试直接读 `packages/core/src/index.ts` 的导出块校验全集。公开 API 新增方法时，同步在 `RpcMethods`、服务端处理表、客户端封装与本文补映射。

| Core 公开 API | RPC 方法 | 客户端返回 |
|---|---|---|
| `RuntimeSession.readAttachment(file)` | `session.readAttachment({ sessionId, file })` | `{ data: Uint8Array, mimeType, bytes }`（线上 `data` 为 base64） |
| `Runtime.cancelSubagent({ parentSessionId, childSessionId })` | `subagent.cancel` | `void` |

## 9. 服务端进程

`nctrn rpc --stdio`（`apps/cli`，[cli.md](../apps/cli.md) 第 2 节）是第一个服务端入口：stdout 只写本文的报文，诊断与警告写 stderr；stdin 关闭、`shutdown` 请求或终止信号都按第 6 节清理后以退出码 0 退出。桌面端附带的 Node 单文件就是 `nctrn` 本身。端到端测试 `apps/cli/test/rpc.e2e.test.ts` 启动真实子进程，核对回放视图与磁盘日志一致、stdout 纯协议、断开后会话锁被释放。

## 10. 客户端包

`@nocturne/rpc/client` 运行时只依赖 `@nocturne/core/protocol`，对 `@nocturne/core` 只有 `import type`，也不使用 Node 内置模块（传输由使用方注入），由 `.dependency-cruiser.cjs` 的 `rpc-client-*` 规则强制。桌面端前端只引这个入口和 `protocol`，打包不会带进 Node 代码。入口：`createRpcClient(transport, { clientName, interactive? })`、`RpcError`、`trackSessionView`、`encodeBase64`。

## 11. 远程主机

`createRpcServer` 可注入 `remote: { home, credentials, connect? }`；不注入时全部远程管理方法报 `-32004 / remote_unavailable`，没有网络行为。CLI 使用同一 RuntimeConfig 的用户 home 与凭据存储。本机握手成功、有登记且 enabled 才连接中继；本机断开或 shutdown 先关中继、再关全部手机连接。网络请求复用进程入口的代理 dispatcher。

登记文件是用户级 `remote.json`：`{version:1,origin,hostId,enabled,devices:[{id,name,pub,createdAt,lastSeenAt?}]}`，pub 是配对得到的 raw 公钥 b64u，唯一设备鉴权来源。中继列表不能新增/覆盖可信公钥；只同步名称、时间、在线和推送状态，删除已不存在设备；未知设备只显示、不允许握手。
设备轮询逐字段比较登记内容，无变化不写盘；损坏文件按未登记处理并保留，重新登记写入前改名为 `remote.json.corrupt-<时间戳>-<随机后缀>`，警告显示备份文件名。

| 方法 | 参数 → 结果 |
|---|---|
| `remote.describe` | `{}` → `RemoteStatus`；仅缓存，不联网 |
| `remote.register` | `{invite}` → `RemoteStatus`；先登记中继，再存凭据与原子写文件，重复登记报 `remote_already_registered` |
| `remote.unregister` | `{}` → `RemoteStatus`；在线等待 unregistered，离线也可清理本地但附管理员吊销警告 |
| `remote.setEnabled` | `{enabled}` → `RemoteStatus`；关闭即断开中继及全部设备连接 |
| `remote.startPairing` | `{}` → `{url,expiresAt}`；需要在线，新配对作废旧配对 |
| `remote.cancelPairing` | `{}` → `null` |
| `remote.removeDevice` | `{id}` → `RemoteStatus`；需要在线，删除中继记录及对应连接 |
| `remote.disconnectDevice` | `{id}` → `null`；只断开当前连接，允许重连 |
| `remote.push` | `{}` → `{sent}`；离线返回零 |

`RemoteStatus`：`{registered,relay?:{origin,hostId},enabled,connection,devices,connections,pairing?:{expiresAt},warnings:string[]}`。connection 为 off/connecting/online/offline/revoked/replaced；devices 为 `{id,name,createdAt,lastSeenAt?,online,push}[]`，connections 为 `{deviceId,name,since}[]`。不含私钥、公钥或配对秘密。

只给本机已握手连接发送 `remote.statusChanged {status}`、`remote.paired {device:{id,name}}`、`remote.pairingFailed {code}`。客户端用类型化 `call` 调用方法，`onNotification(method,handler)` 监听通知（返回退订函数）。配对帧等待 60 秒；错误沿用 RemoteChannelError 或 limit/revoked/timeout。

断线以 1 秒起、翻倍、60 秒上限、±20% 抖动重连，成功后清零；4003/4004 记 revoked，4001 记 replaced，停止重连。诊断只记录连接状态，不含邀请、秘密或帧。状态错误属于 -32004，包括 remote_unavailable/remote_already_registered/remote_not_registered/remote_offline/remote_storage_failed/credential_missing/credential_backend_unavailable；中继 403/409/429 保留 invalid_invite/already_registered/rate_limited。
