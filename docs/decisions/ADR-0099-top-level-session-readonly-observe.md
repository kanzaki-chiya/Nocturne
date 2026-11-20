# ADR-0099：顶层会话只读快照观察与手机端按需唤醒

- 状态：已接受
- 日期：2026-11-19
- 相关：[architecture/sessions.md](../architecture/sessions.md)、[protocols/rpc.md](../protocols/rpc.md) 第 4.2 / 7 / 8 节、[ADR-0009](ADR-0009-session-lock.md)、[ADR-0052](ADR-0052-remote-web-client.md)、[ADR-0084](ADR-0084-phone-side-panel.md)

## 背景

在远程手机端打开一条尚未在桌面后台运行的历史长会话（例如样本 `202611190224-079332c3`，1367 条持久事件、3.3 MB）时，既有流程必须先调 `runtime.resumeSession`，再 `session.subscribe` 回放事件。

实测拆分服务端 `resumeSession` 耗时（不含公网 RTT）：

- 首次冷启动 745.8 ms，热启动 516.8–541.4 ms（叠加工网 RTT 与 `session.subscribe` 往返后，手机侧打开阶段约 1.1–1.25 s）；
- 其中真正读取并解析事件日志的 `store.load` 仅占 **45.3 ms**（取锁 1.1 ms、读盘 2.0 ms、JSONL 解析 37.6 ms、对账 1.4 ms、修复 3.0 ms、构造 0.2 ms）；
- 绝大部分耗时在 `assembleSession`（冷启动 **690.5 ms**）：`resolvePlugins` 365.5 ms（热 320.8–335.2 ms）、`skillDiscover` 167.7 ms（热 9.6–12.4 ms）、工作树与权限策略 54.5 ms（热 50.8–69.5 ms）、长期记忆快照 47.1 ms、Git 仓库探测 37.2 ms、其余初始化 18.6 ms。

这些装配工作只为「执行新一轮对话 / 工具 / 权限策略」服务，而用户从手机点开历史会话时，多数场景是先浏览内容。如果强行把所有装配都延迟到 `submit` 阶段，会破坏 `resumeSession` 后立即查询上下文报告、技能目录、插件、MCP、权限与记忆快照的既有语义；而且 `resumeSession` 本身仍须获取会话锁并修复损坏末行。因此需要新增独立的**顶层会话只读快照观察**路径，让手机打开未运行会话时免去完整唤醒，交互时再无损升级。

## 决定

### 1. Core 只读快照接口

在 `Runtime` 上新增两个只读方法，DTO 放在 `@nocturne/core/protocol`（`SessionObservationSnapshot`、`SessionObserveInput`、`SessionObserver`、`SessionAttachmentInput`）：

- `Runtime.observeSession(input: { sessionId, afterSeq? }, observer: { onEvent }, options?: { signal? }): Promise<SessionObservationSnapshot>`
  - 校验 `sessionId` 为安全单文件名标识；只允许观察**顶层会话**，若日志首条 `session.created` 带有 `parent`（子会话），报 `RuntimeCommandError("invalid_command")`（子会话继续走 `observeSubagent`）。
  - **已在本 Runtime 打开**：直接读取该会话内存中的已提交持久事件快照，返回 `openHere: true`、`tailIgnored: false`；不重新读盘，不增加打开计数，不触碰会话锁。
  - **未在本 Runtime 打开**：复用只读日志读取器 `readLogReadonly`，一次 `readFile` 获得固定字节快照后解析，**不获取会话锁、不创建或删除 `.lock`、不截断修复损坏末行**（末行残缺时仅在内存忽略并置 `tailIgnored: true`）。返回 `openHere: false`。
  - `afterSeq` 缺省 `0`，须为非负整数且 `<= lastSeq`，否则报 `invalid_after_seq`；仅按顺序通过 `observer.onEvent` 推送 `seq > afterSeq` 的持久事件，每 128 条让出一次事件循环。
- `Runtime.readSessionAttachment({ sessionId, file }): Promise<ReadAttachmentResult>`
  - 同样拒绝子会话、不打开会话、不取锁；授权集合取自该会话的持久事件（已打开取内存，未打开取只读日志），复用 `readSessionAttachment` 做安全文件名、防符号链接逃逸、字节数与 SHA-256 校验。

### 2. RPC 映射与远程边界

新增请求方法与服务端通知，不修改既有 `runtime.resumeSession` / `session.subscribe` 语义：

- `session.observe`：`{ sessionId, observeId, afterSeq? }` → `SessionObservationSnapshot`
  - 请求建立期间经 `session.observeEvent` 通知逐条推送 `seq > afterSeq` 的持久事件（`{ observeId, sessionId, event }`），全部推送完成后再返回响应，天然保序；通知只发给发起该请求的连接，不广播。
  - 客户端 `RpcRuntime.observeSession` 在发送前自动生成连接内唯一的 `observeId` 并挂载路由，完成或异常时清理；调用方通过 `signal` 取消时会停止分发并丢弃迟到通知。
- `session.observeAttachment`：`{ sessionId, file }` → `{ data: base64, mimeType, bytes }`
  - 远程连接沿用 `session.readAttachment` 相同的 `remoteAttachmentLimit` 字节上限检查，超限报 `attachment_too_large`。
- **远程权限边界**：`session.observe` 与 `session.observeAttachment` 加入 `REMOTE_METHODS`，严格不超出原有 `resumeSession` + `session.subscribe` + `session.readAttachment` 的可见范围；不在 `Hub.sessions` / `Connection.sessions` 登记交互句柄，也不允许经观察路径执行任何写操作。
- **兼容性**：旧客户端不受影响；旧后台不支持 `session.observe`（返回 `-32601` / `method_not_found`）时，手机客户端自动退回既有 `resumeSession + subscribe` 流程，并在当前连接内记住不支持标记，避免重复试探。

### 3. 手机端打开生命周期与按需升级规则

桌面端打开会话的流程保持不变。手机网页端（`apps/desktop/src/web/sessions.ts`）按以下状态机运行：

1. **打开判定**：
   - 若会话列表里该会话 `openHere === true`（已在桌面后台运行），直接走既有 `runtime.resumeSession` + `trackSessionView`（命中后台已有内存会话，无需装配，且能立即收实时流）。
   - 若 `openHere !== true` 且当前连接支持只读观察，调用 `client.runtime.observeSession({ sessionId })` 把持久事件归约进 `SessionView`，将条目置为只读观察态（`observed = true`），**不调用 `resumeSession`，不持有后台会话引用，不触发 `session.state` / `session.listGrants` / `session.describeSkills` / `session.reasoningEffortInfo` / `session.shellInfo`**。
   - 若观察返回 `openHere === true`（打开瞬间桌面刚好打开了它），立即无缝升级为实时订阅。
2. **只读态行为**：
   - 正常渲染消息、虚拟列表滚动、展开工具详情、读取已登记图片附件（路由到 `client.runtime.readSessionAttachment`）、打开会话概览跳转。
   - 切离该会话或清理空闲会话时，直接释放前端条目，**不发 `session.close`**。
   - 重连后若该会话仍处于只读观察态且后台未打开，用当前 `view.lastSeq` 作为 `afterSeq` 做增量只读观察补齐期间新增事件。
3. **按需升级触发点**：
   - **用户交互**：用户在会话内发起任意需要活跃会话的操作（发送/插话/排队消息、批准/拒绝权限、回答提问、中断、切换模型/思考档位/权限预设/shell、压缩、回退、查看单轮变更/diff、撤销会话授权、读写输入历史、打开子代理侧栏/工作树等），代理句柄自动调用 `upgrade(id)`。
   - **后台状态变化**：收到 `runtime.sessionsChanged` 刷新列表后，若某个处于只读观察态的会话在后台变为 `openHere === true`，自动后台升级并订阅实时流。
4. **无损续接规则**：
   - 同一会话的并发升级请求合并到同一个升级 Promise，避免重复 `resumeSession`。
   - 升级时记录升级前已完成归约的 `afterSeq = entry.view.lastSeq`，依次执行 `resumeSession(id)` 与 `trackSessionView(session, { afterSeq, view: entry.view })`，在原有 `SessionView` 上原地衔接。
   - 仅拉取 `seq > afterSeq` 的增量持久事件与实时事件：既不会重传已展示的历史事件，也不会丢失观察与升级之间其他端写入的新事件。
   - 升级完成后将 `observed` 置为 `false`，通知组件刷新活跃态元数据（如 `state`、`grants`、`skills`、`effort`、`shell`），再继续执行触发升级的那次原始操作。

## 后果

- **正面**：手机打开未运行的长期历史会话时，服务端跳过插件、技能、工作树、记忆与 Git 探测，只读日志并流式回放，打开等待从秒级压到百毫秒以内，且不占用后台会话锁、不污染后台活跃会话集合。
- **约束**：只读态下无法依赖需唤醒会话才能查到的运行时探测数据（如当前可用 shell、已激活 MCP 连接状态、动态技能目录）；这些信息在首次升级后自动补齐。
- **边界**：`resumeSession` 继续保留完整的交互打开、取锁、坏尾修复与装配语义，不新增模糊的 `readonly` 参数。

## 备选方案

1. **在 `resumeSession` 内把插件/技能/工作树/记忆等装配延迟到首次 `submit`**：实测 `assembleSession` 涉及 690 ms 多项状态（包括权限策略、MCP、技能目录、模型上下文报告），且 `resumeSession` 仍需获取会话锁、执行坏尾修复与对账，打开即占锁会影响并发查看；同时桌面端与 RPC 客户端假设 `resumeSession` 返回即可查询 `describeContext` / `describeSkills` / `listGrants`。相比之下，独立的只读快照观察语义清晰、边界干净、零侵入桌面端。
2. **让 `session.observe` 建立持续的文件监听长订阅**：顶层历史会话在未唤醒时不会在本进程写入；一旦本后台唤醒（`openHere: true`），已有 `runtime.sessionsChanged` 通知驱动手机端自动升级到标准 `session.subscribe`。不维护额外文件 watcher 可避免跨平台文件锁与句柄泄漏。

## 修订

- 2026-11-21：远程连接下行传输体积的进一步压减由 [ADR-0103](ADR-0103-remote-channel-compression.md) 在加密通道层以共享 `deflate-raw` 流解决，`session.observe` / `session.observeEvent` 报文形状不变。
