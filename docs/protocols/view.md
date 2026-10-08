# 派生视图（SessionView）

> 状态：已接受 v1.0（2026-09-24 验收）｜ 前置阅读：[events.md](events.md) ｜ 代码位置：`packages/core/src/protocol/view.ts`（测试在 `packages/core/test/view.test.ts`——reducer 测试依赖 Runtime 组装，按 depcheck 约定放测试目录）

面向客户端的会话视图投影。`protocol` 中的纯函数 reducer 把事件流折叠成 `SessionView`，供 TUI 及后续所有客户端渲染使用（ADR-0002 第 5 条：派生视图由 `protocol` 提供，客户端不得各自重写投影逻辑）。

## 1. 定位与边界

- **纯函数、无 I/O**：只依赖 `protocol` 的类型；不触碰文件系统、网络、时钟。遵守 protocol 的全部依赖红线（modules.md §6）。
- **就地归约**：`reduceSessionView` 原地更新视图并递增 `revision`；客户端按需渲染。需要不可变快照的客户端自行 `structuredClone`（视图只含 JSON 数据）。
- **容差**：未知事件类型忽略（events.md §8 客户端规则）；事件乱序不崩溃——`tool.completed` 可能先于 `tool.started` 到达（权限拒绝路径），`permission.resolved` 先于 `tool.started`（ask 回复在闸门内结算后才放行执行）。
- **不含行为**：视图不决定能不能做什么，只表达"发生了什么"。权限判定、Turn 推进都在 Runtime；客户端只发命令。

## 2. 视图状态形状

```ts
interface SessionView {
  /** 每次归约 +1，客户端用作重渲染信号；不参与重放等价（§6） */
  revision: number;
  /** session.titled 优先，否则取首条用户消息原文首行 */
  title: string | undefined;
  /** 会话元信息（session.created 填充） */
  meta: {
    cwd: string;
    workspaceRoot: string;
    formatVersion: number;
    nocturneVersion: string;
  } | undefined;
  /** 当前生效配置：session.created → session.config_changed 覆盖 */
  config: { model: ModelRef | undefined; permissionPreset: string | undefined; reasoningEffort: ReasoningEffort | undefined };
  /** 展示状态：runtime.status 的最近一次取值，收敛点回退 idle */
  status: RuntimeStatus;
  /** 重试信息（provider.retry 的 payload；离开 retrying 时清空） */
  retry: ProviderRetryPayload | undefined;
  /** 当前未闭合的 Turn（turn.started 设置，turn.completed 清除） */
  currentTurn: { turnId: string; turnIndex: number } | undefined;
  /** 最近一个已完结 Turn 的摘要（状态栏用） */
  lastTurn:
    | { turnIndex: number; reason: TurnEndReason; steps: number; usage: Usage; recovered: boolean }
    | undefined;
  /** 已完结 Turn 数 */
  turnCount: number;
  /** 累计用量（各 turn.completed.usage 累加） */
  usage: Usage;
  /** 等待用户回复的权限请求（至多一个：执行管线串行） */
  pendingPermission: PendingPermission | undefined;
  /** 待回答的提问（ADR-0032；只由临时事件 question.requested 产生，
      至多一个；对应 callId 的 tool.completed 或 turn.completed 到达时清除） */
  pendingQuestion: PendingQuestion | undefined;
  /** 时间线：只由持久事件创建，可重放（§3） */
  entries: ViewEntry[];
  /** 当前任务清单；全部完成后由下一条持久化 message.user 归档 */
  todos: TodoItem[];
  /** 在途实体：只由临时事件创建，对应持久事件到达时转入 entries（§4） */
  live: {
    assistants: LiveAssistant[];
    tools: LiveTool[];
  };
  /** 运行时诊断：只由临时事件产生，不可重放（§4） */
  notices: SessionNotice[];
  /** 最后一个被归约的持久事件 seq（客户端对齐/诊断用） */
  lastSeq: number;
}
```

### 持久条目（entries）

时间线条目按**首个支撑持久事件的 seq** 排序，一个实体只占一格：

```ts
type ViewEntry =
  | { kind: "user"; key: string; seq: number; turnId: string; content: ContentBlock[];
      attachments?: ImageAttachment[]; fileRefs?: FileRef[]; skill?: { name: string; body: string }; delegate?: { agent: string; task: string }; descriptions?: AttachmentDescribedPayload[] }
  | AssistantEntry
  | ToolEntry
  | NoticeEntry;

interface AssistantEntry {
  kind: "assistant";
  key: string;                  // "a:<messageId>"
  turnId: string;
  messageId: string;
  seq: number;                  // message.assistant 的 seq
  time: string;                 // message.assistant 事件时间（ISO 8601），不读当前时钟
  text: string;                 // content 中 text 块拼接
  reasoning: string;            // content 中 reasoning 块拼接
  toolCalls: ToolCallRef[];
  model: ModelRef;
  usage: Usage | undefined;
  finishReason: FinishReason | "aborted";
}

interface ToolEntry {
  kind: "tool";
  key: string;                  // "t:<callId>"
  turnId: string;
  callId: string;
  name: string | undefined;     // 首个带来名字的持久事件提供；requested 先于 started 时可能暂缺
  seq: number;                  // 首个支撑持久事件的 seq
  /** 展示状态机：awaiting_permission → running → 终态（无 preparing，见 §4） */
  status: "awaiting_permission" | "running"
        | "ok" | "error" | "denied" | "cancelled" | "interrupted";
  input: unknown;               // tool.started 的规范化 input
  subjects: PermissionSubject[]; // permission.requested / tool.started 带来；detail 只供确认框显示
  permission: { action: PermissionAction; source: PermissionSource; rule: string | undefined }
    | undefined;                // tool.started 带来
  resolution: PermissionResolvedPayload | undefined; // 最近一条 resolved
  review?: PermissionReviewedPayload; // 最近一条审查，工具上方与确认框显示
  descriptions?: AttachmentDescribedPayload[]; // 图片描述，按 attachmentRef 关联
  /** tool.progress 累计（临时数据）；completed 时清空，收敛点上必为空 */
  liveOutput: string;
  result:
    | { status: ToolCallStatus; modelContent: string; output: unknown;
        error: { code: string; message: string } | undefined; truncated: boolean;
        spillPath: string | undefined; durationMs: number | undefined }
    | undefined;
}

interface NoticeEntry {
  kind: "notice";
  key: string;                  // "n:<seq>"
  seq: number;
  subtype: "permission" | "turn_end" | "compacted" | "config";
  message: string;              // 已格式化的单行摘要（与 CLI 输出同文案口径）
  payload: unknown;             // 原始事件 payload，客户端需要更多细节时用
}
```

### 在途实体（live）

```ts
interface LiveAssistant {
  kind: "assistant";
  messageId: string;
  turnId: string | undefined;   // 事件信封的 turnId
  text: string;                 // text delta 累计
  reasoning: string;            // reasoning delta 累计
}

interface LiveTool {
  kind: "tool";
  callId: string;
  name: string;                 // tool.input.delta 的 payload.name
  turnId: string | undefined;
  inputText: string;            // 参数 JSON 片段累计（仅供显示）
}
```

`live` 是**纯瞬态**区：内容由 `message.assistant.delta` / `tool.input.delta` 创建，在对应的 `message.assistant` / `permission.requested` / `tool.started` / `tool.completed` 到达时**转入 `entries`**（inputText 等流式字段随之丢弃——它们本来就不该出现在可重放视图里）。`live` 中的实体不保证有持久落点：流被中断、参数没发完的调用可能永远没有 `tool.started`，这类孤儿在 `turn.completed` 时随 `live` 整体清空（不按 `turnId` 筛选——`LiveTool.turnId` 可为空，且串行管线同一时刻至多一个 Turn）。

`PendingPermission`：

```ts
interface PendingPermission {
  review?: PermissionReviewedPayload; // 同一 callId 的最近审查
  requestId: string;
  callId: string;
  toolName: string | undefined; // live.tools / entries 里能取到就填，否则 undefined
  subjects: PermissionSubject[];
  reason: string;
  options: PermissionOption[];
}
```

`SessionNotice`（临时诊断，不进入 `entries`）：

```ts
interface SessionNotice {
  level: "warning" | "error";
  code: string;                 // runtime.warning / runtime.error 的 code
  message: string;
}
```

`attachment.described` 按附件所在事件 seq 与序号关联用户或工具条目，非空描述加入 `descriptions`；空描述只记录已尝试，不生成展示行。描述及其角色用量不加入主对话累计用量，重放与实时归约一致。

## 3. 持久事件归约

`entries` 只在持久事件到达时创建；同 `callId`/`messageId` 已存在条目则就地更新：

| 事件 | 归约 |
|---|---|
| `session.created` | 填充 `meta`、`config` |
| `session.titled` | 覆盖 `title`，不创建时间线条目、不累计角色用量 |
| `session.config_changed` | payload 中存在的键覆盖 `config`（`shell` 不进 `config`，ADR-0022）；追加 `config` notice 条目（shell 切换文案：`shell 已切换为 <kind>（<path>）`） |
| `turn.started` | `currentTurn = {turnId, turnIndex}`；`turnCount = max(turnCount, turnIndex)` |
| `message.user` | 当前 `todos` 非空且每项均为 `completed` 时先置空；尚有未完成项时保留，历史工具快照不变。追加 `user` 条目（key `u:<messageId>`），保留 `attachments`、`fileRefs` 与 `skill`；首条消息且尚无标题时，以 `firstUserText` 原文首行填充 `title`；引用内容仍在 `content` 中，客户端可用元数据显示摘要 |
| `message.assistant` | `live.assistants` 中同 `messageId` 者移除并晋升：新建条目插入时间线（流式 text/reasoning 丢弃，以 `content` 为准）；无 live 对应物则直接新建条目 |
| `permission.reviewed` | 同 callId 的 live 工具晋升为 awaiting 条目，记录 `review`；不写 notice，避免同一审查显示两次。后续 requested 将审查理由复制到 `pendingPermission.review` |
| `permission.requested` | `pendingPermission` 设置；同 `callId` 的 `live.tools` 项移除并晋升为 `awaiting_permission` 条目（回填 `subjects`），无 live/entries 对应物则新建 `awaiting_permission` 条目（`name` 暂缺）；记录进 `pendingByCallId` |
| `permission.resolved` | `requestId` 匹配则清 `pendingPermission`、`pendingByCallId`；`callId` 的 entries 条目更新 `resolution`（`deny` 时 `status` 仍等 `tool.completed` 落定）；追加 `permission` notice 条目（`source: "reviewer"` 时不追加：结论已由该工具条目的 `review` 展示）。归约器内部维护 `Map<callId, resolved>`，供晚到的 `started`/`completed` 回填 |
| `tool.started` | 同 `callId` 的 `live.tools` 项移除并晋升（`inputText` 丢弃）；`entries` 中已有条目（requested 建的 awaiting）则更新为 `running` 并填 `input`/`subjects`/`permission`/`turnId`/`name`；否则新建 `running` 条目 |
| `tool.completed` | 同 `callId` 的 `live.tools` 项丢弃（未执行即终态）；`entries` 条目不存在则新建（`denied`/`cancelled` 路径无 `started`）；`status` 取 `payload.status`，填 `result`/`seq`（若尚无）/`turnId`/`name`；清 `liveOutput`；同 `callId` 的 `pendingQuestion` 清除（ADR-0032） |
| `context.compacted` | 追加 `compacted` notice 条目 |
| `turn.completed` | `currentTurn` 匹配则清除；`lastTurn`（含 `recovered`）/`turnCount`/`usage` 更新；`status=idle`；`retry`、`pendingPermission`、`pendingQuestion` 清空；**清空整个 `live`**（管线串行、同一时刻至多一个 Turn；`LiveTool.turnId` 可为空，按 turnId 筛选会留下无持久落点的孤儿，破坏 V8）；`reason!=="done"` 时追加 `turn_end` notice 条目（`recovered:true` 时文案区分"本次失败/中断"与"上次进程退出"） |

顺序约束：视图**不要求**事件全序——`resolved` 可在 `requested` 前（规则拒绝直接产生 `resolved`）、`completed` 可在 `started` 前、`requested` 可在 `input.delta` 前（Provider 不流式参数时）。所有关联都通过 `callId`/`messageId`/`requestId` 键查找。

## 4. 临时事件归约

临时事件只写瞬态字段（`status`/`retry`/`live`/`notices`/`liveOutput`），**不创建 `entries` 条目**——这是重放等价（§6）成立的前提：

| 事件 | 归约 |
|---|---|
| `runtime.status` | `status = payload.status`；`status !== "retrying"` 时清 `retry` |
| `provider.retry` | `retry = payload`；`status = "retrying"` |
| `runtime.warning` | 追加 `SessionNotice`（level=warning） |
| `runtime.error` | 追加 `SessionNotice`（level=error）；`code === "session_failed"` 时 `status = "failed"` |
| `message.assistant.delta` | 按 `messageId` 查找/新建 `live.assistants` 项；`kind` 分流追加 `text`/`reasoning` |
| `tool.input.delta` | 按 `callId` 查找/新建 `live.tools` 项；`inputText += payload.delta`；填 `name`/`turnId` |
| `tool.progress` | `callId` 的 entries 条目存在时，`stdout`/`stderr` 原样拼接到 `liveOutput`，允许半行；`info` 作为独立一行拼接并在视图中补换行；无条目则忽略——`progress` 不建占位，避免无支撑的幽灵工具行 |
| `question.requested` | `pendingQuestion = { requestId, callId, questions }`（ADR-0032）；不建 entries/live 条目 |

`mcp.server` 不归约（失败与崩溃经 `runtime.warning` 进入 notices）。

Phase 6 的 Subagent **不需要视图扩展**：`task` 在父会话是普通工具条目，子会话内部进度经 `tool.progress`（`stream:"info"`）一行式进入 `liveOutput`（[subagent.md](../architecture/subagent.md) 第 12 节）；子会话自身的事件写在子日志，不进父会话的事件流，V1 重放等价不受影响。

## 5. 权限请求生命周期

```
ask 判定
  → permission.requested       pendingPermission 设置；live 工具晋升为 awaiting 条目
  → permission.resolved        pendingPermission 清除，permission notice，resolution 回填
  → （allow）tool.started      条目 running（permission.source=user）
  → （deny） tool.completed    条目终态 denied
规则拒绝（无 requested）
  → permission.resolved(action=deny, source=rule) → tool.completed(denied)
规则/授权允许（无 requested/resolved）
  → tool.started(permission.source=rule|grant)   → tool.completed
中断发生在 ask 等待期间
  → permission.resolved(action=deny, source=cancelled) → tool.completed(cancelled)
    → turn.completed(reason=aborted)
进程在 ask 等待期间被杀
  → 日志止于 permission.requested；恢复修复只补写
    tool.completed(interrupted) + turn.completed(reason=error,
    error.code=process_exited, recovered=true)——不补 resolved。
    pendingPermission 由 turn.completed 的防御规则清除。
```

视图不变量：`pendingPermission` 仅在"有未决 requested 且 Turn 未闭合"时非空；同一时刻至多一个待决请求（执行管线串行）。

提问（ADR-0032）的生命周期对应更简单：`question.requested` 是临时事件，设置 `pendingQuestion`；它没有独立的 resolved 事件——回答、逐题拒绝、中断、超时都经等待中的 `ask_user` 调用以 `tool.completed` 落定，`pendingQuestion` 随之清除；`turn.completed` 的防御规则兜底。进程在等待期间被杀时日志止于 `tool.started`（`question.requested` 不落盘），恢复补写 `tool.completed(interrupted)` + `turn.completed(recovered)`，重放路径上 `pendingQuestion` 从未出现，天然一致。客户端对 `ask_user` 条目的标题与回答只读取持久事件 `tool.started.input`、`tool.completed.output`（取消/超时/非交互读取其状态与错误码），不插入提交前的临时摘要，恢复后显示相同。

## 6. 重放与实时一致性

**收敛点**：`currentTurn === undefined && pendingPermission === undefined && pendingQuestion === undefined && live` 为空。

> **不变量 V1（重放等价）**：对任意合法事件序列 E（持久事件 + 任意交织的临时事件），在收敛点上，`reduce(E)` 与 `reduce(E.durable)` 在除 `revision`、`notices` 外的全部字段相等。

支撑 V1 的三条构造规则：

1. `entries` 条目只能由持久事件创建/更新（§3）——`permission.reviewed`/`requested`/`resolved`/`tool.started`/`completed` 都是持久事件，两条路径产生**相同顺序相同内容**的条目；
2. 临时事件只写瞬态区（§4），且每个瞬态字段都有归零/晋升规则：`live` 条目在持久落点到达时转入 entries（流式字段丢弃），`liveOutput` 在 `completed` 时清空，`retry` 离开 `retrying` 时清空，`status` 在 `turn.completed` 归 `idle`；
3. `revision`、`notices` 被显式排除：`revision` 随临时事件计数，两路径必然不同；`notices` 只由临时事件产生，重放缺失是设计行为（CLI 的对应输出同样不进日志）。

重放等价允许客户端用**同一 reducer** 处理两条路径：

- 实时：`session.subscribe(ev => reduceSessionView(view, ev))`
- 恢复：`session.durableEvents().forEach(ev => reduceSessionView(view, ev))` 后继续 `subscribe`

恢复模式下，修复补写的事件（`tool.completed(interrupted)`、`turn.completed(recovered)`）按 §3 正常归约，无需特殊分支。TUI 全屏模式把持久 `entries`、实时流式文本与 `live` 排进对话视口的可见窗口；`--inline` 模式把已结束块追加到 `<Static>` 回滚区、未结束块留在活动区。写入窗口/回滚区是客户端渲染行为，不改变 `SessionView` 的持久事件规则。

## 7. 不变量清单

| # | 不变量 | 验证方式 |
|---|---|---|
| V1 | 收敛点重放等价（§6；排除 `revision`、`notices`） | 场景矩阵 × {live 序列, 仅持久序列} 深比较 |
| V2 | 每个 `toolCalls[].callId` 恰有一条 `tool` 条目；`tool.completed` 落定且只落定一次 | 场景断言 |
| V3 | `pendingPermission` 至多一个，且其 `requestId` 未被 `resolved`；`pendingQuestion` 至多一个，且其 `callId` 无对应 `tool.completed` | 场景断言 |
| V4 | `entries` 顺序 = 首个支撑持久事件的 `seq` 升序；条目 `seq` 单调不降 | 场景断言 |
| V5 | 视图 JSON 可序列化：`JSON.parse(JSON.stringify(view))` 与原件深比较相等（`live` 用数组不用 Map） | 全场景 |
| V6 | 确定性：同一事件序列归约两次结果相等 | 全场景 |
| V7 | 未知事件类型被忽略，`revision` 仍递增 | 单测 |
| V8 | 收敛点上 `status==="idle"`、`retry===undefined`、`pendingQuestion===undefined`、`live` 为空、`liveOutput` 全空 | 场景断言 |

## 8. API

`@nocturne/core/protocol` 导出：

```ts
function createSessionView(): SessionView;
function reduceSessionView(view: SessionView, event: RuntimeEvent): void;
function replaySessionView(events: readonly DurableEvent[]): SessionView; // ≡ fold
```

`RuntimeEvent = DurableEvent | EphemeralEvent`（`subscribe` 的回调类型即此）。

### 测试覆盖（packages/core/test/view.test.ts）

场景矩阵（每个场景跑 live 序列与 durable-only 序列两条路径，断言 V1）：

1. 纯文本一轮（含 text/reasoning delta）；
2. 工具调用一轮：input.delta → requested → resolved(allow) → started → progress → completed(ok)；
3. 规则拒绝：resolved(rule,deny) → completed(denied)（无 requested/started）；
4. ask 拒绝 `d`：requested → resolved(user,deny,feedback) → completed(denied)；
5. ask 拒绝并停止 `x`：requested → resolved(user,deny) → completed(denied) → turn.completed(aborted)；
6. 实时中断：Turn 中 interrupt → completed(cancelled) → turn.completed(aborted)；
7. 崩溃恢复：日志止于 requested → 修复补写 completed(interrupted) + turn.completed(error, process_exited, recovered)；
8. 多轮 + compacted + config_changed；
9. provider.retry → runtime.status(retrying) → 成功完成；
10. **V1 顺序专项**：按 stream.ts / executor.ts 的真实发出顺序构造 live 序列（input.delta 早于 message.assistant 落盘、resolved 早于 started、规则拒绝无 requested），断言与 durable-only 重放在收敛点相等。

另加：乱序注入（completed 先于 started 的人工序列）、未知事件、V5–V8 通用断言。

## 9. 暂不设计

- 条目内细粒度 diff/文件变更投影：客户端从 `result.output`/`input` 自取（edit/write 的结构化 output 已含 diff）；
- 视图增量 diff 协议（op-based patch）：客户端用 `revision` 全量重渲染，Ink/React 自行 diff；
- 跨会话聚合视图、搜索索引；
- 虚拟滚动窗口化（条目量过大时的裁剪策略——TUI 静态回放天然规避）。

## 回退

`session.rewound` 含对话时，归约器使用与 Core 折叠同源的 `effectiveEvents` 重建条目、清单、附件描述和工具簿记，移除目标用户消息及后续事件（其 turn.started 同时移除）。当前配置、标题、累计用量与 Turn 计数保留。通知是可重放的 `NoticeEntry(subtype="rewound")`，显示目标首行、成功还原数、失败数；仅还原文件时保留已有条目并追加通知。`checkpoint.file` 不创建条目。在线与重放遵循相同规则，见 [ADR-0041](../decisions/ADR-0041-checkpoints-rewind-fork.md)。
