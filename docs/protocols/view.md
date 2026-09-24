# 派生视图（SessionView）

状态：**提议 v0.1**（Phase 4 设计稿；实现后以已接受替换）

面向客户端的会话视图投影。`packages/core/src/protocol/view.ts` 中的纯函数 reducer 把事件流折叠成 `SessionView`，供 TUI 及后续所有客户端渲染使用（ADR-0002 第 5 条：派生视图由 `protocol` 提供，客户端不得各自重写投影逻辑）。

## 1. 定位与边界

- **纯函数、无 I/O**：只依赖 `protocol` 的类型；不触碰文件系统、网络、时钟。遵守 protocol 的全部依赖红线（modules.md §6）。
- **就地归约**：`reduceSessionView` 原地更新视图并递增 `revision`；客户端按需渲染。需要不可变快照的客户端自行 `structuredClone`（视图只含 JSON 数据）。
- **容差**：未知事件类型忽略（events.md §8 客户端规则）；事件乱序不崩溃——`tool.completed` 可能先于 `tool.started` 到达（权限拒绝路径），视图以"实体首次出现"为创建时机。
- **不含行为**：视图不决定能不能做什么，只表达"发生了什么"。权限判定、Turn 推进都在 Runtime；客户端只发命令。

## 2. 视图状态形状

```ts
interface SessionView {
  /** 每次归约 +1，客户端用作重渲染信号 */
  revision: number;
  /** 会话元信息（session.created 填充） */
  meta: {
    cwd: string;
    workspaceRoot: string;
    formatVersion: number;
    nocturneVersion: string;
  } | undefined;
  /** 当前生效配置：session.created → session.config_changed 覆盖 */
  config: { model: ModelRef | undefined; permissionPreset: string | undefined };
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
  /** 时间线条目：只由持久事件产生（可重放），见 §3 */
  entries: ViewEntry[];
  /** 运行时诊断：只由临时事件产生（不可重放），见 §5 */
  notices: SessionNotice[];
  /** 最后一个被归约的持久事件 seq（客户端对齐/诊断用） */
  lastSeq: number;
}
```

### ViewEntry

时间线条目按**实体首次出现**排序，一个实体只占一格：

```ts
type ViewEntry =
  | { kind: "user";      key: string; seq: number; turnId: string; content: ContentBlock[] }
  | AssistantEntry
  | ToolEntry
  | NoticeEntry;

interface AssistantEntry {
  kind: "assistant";
  key: string;                  // "a:<messageId>"
  turnId: string;
  messageId: string;
  seq: number | undefined;      // message.assistant 到达后填入
  /** 定稿后等于 content 中 text 块拼接；流式期间为 delta 累计 */
  text: string;
  reasoning: string;
  toolCalls: ToolCallRef[];
  streaming: boolean;           // 见过 delta 且 message.assistant 未达
  model: ModelRef | undefined;
  usage: Usage | undefined;
  finishReason: FinishReason | "aborted" | undefined;
}

interface ToolEntry {
  kind: "tool";
  key: string;                  // "t:<callId>"
  turnId: string | undefined;
  callId: string;
  name: string;                 // input.delta / started / completed 任一先到者提供
  seq: number | undefined;      // 首个持久支撑事件的 seq
  /** 展示状态机：preparing → awaiting_permission → running → 终态 */
  status: "preparing" | "awaiting_permission" | "running"
        | "ok" | "error" | "denied" | "cancelled" | "interrupted";
  input: unknown;               // tool.started 的规范化 input
  subjects: PermissionSubject[]; // tool.started / permission.requested 带来
  inputText: string;            // tool.input.delta 累计原文（仅供显示）
  permission: { action: PermissionAction; source: PermissionSource; rule: string | undefined }
    | undefined;                // tool.started 带来
  resolution: PermissionResolvedPayload | undefined; // 最近一条 resolved
  liveOutput: string;           // tool.progress 累计；completed 时清空
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

`PendingPermission`：

```ts
interface PendingPermission {
  requestId: string;
  callId: string;
  toolName: string | undefined; // preparing 工具条目存在时取得到，否则 undefined
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

## 3. 持久事件归约

| 事件 | 归约 |
|---|---|
| `session.created` | 填充 `meta`、`config` |
| `session.config_changed` | payload 中存在的键覆盖 `config`；追加 `config` notice 条目 |
| `turn.started` | `currentTurn = {turnId, turnIndex}`；`turnCount = max(turnCount, turnIndex)` |
| `message.user` | 追加 `user` 条目（key `u:<messageId>`） |
| `message.assistant` | `messageId` 已有流式条目则就地定稿（`text`/`reasoning`/`toolCallIds` 以 `content` 为准，`streaming=false`，填 `seq`/`model`/`usage`/`finishReason`）；否则新建已完结条目 |
| `tool.started` | `callId` 条目已存在（preparing/awaiting）则更新为 `running` 并填 `input`/`subjects`/`permission`/`seq`/`turnId`；否则新建 `running` 条目。归约器内部维护 `Map<callId, resolved>`，`started`/`completed` 建条目时回填最近的 `resolved` |
| `permission.requested` | `pendingPermission` 设置；`callId` 条目存在则 `status=awaiting_permission`、回填 `subjects`；记录进 `pendingByCallId` |
| `permission.resolved` | `requestId` 匹配则清 `pendingPermission`、`pendingByCallId`；`callId` 条目更新 `resolution`（`deny` 时 `status` 仍等 `tool.completed` 落定，`interrupted` 与 `denied` 都可能随后到达）；追加 `permission` notice 条目 |
| `tool.completed` | 条目不存在则新建（`denied`/`cancelled` 路径无 `started`）；`status` 取 `payload.status`（`ok`/`error`/`denied`/`cancelled`/`interrupted` 直映），填 `result`、`seq`、`turnId`、`name`；清 `liveOutput` |
| `context.compacted` | 追加 `compacted` notice 条目 |
| `turn.completed` | `currentTurn` 匹配则清除；`lastTurn`（含 `recovered`）/`turnCount`/`usage` 更新；`status=idle`；`retry`、`pendingPermission` 清空；本 Turn 仍 `streaming` 的条目强制 `streaming=false`（防御：正常情况下 `message.assistant finishReason=aborted` 已先定稿）；`reason!=="done"` 时追加 `turn_end` notice 条目（`recovered:true` 时文案区分"本次失败/中断"与"上次进程退出"） |

顺序约束：视图**不要求**事件全序正确——`resolved` 可在 `requested` 前（规则拒绝直接产生 `resolved`）、`completed` 可在 `started` 前。所有"回填"都通过 `callId`/`messageId`/`requestId` 键查找，不存在则先建占位条目。

## 4. 临时事件归约

| 事件 | 归约 |
|---|---|
| `runtime.status` | `status = payload.status`；`status !== "retrying"` 时清 `retry` |
| `provider.retry` | `retry = {attempt, maxAttempts, delayMs, error: {kind, message}}`；`status = "retrying"` |
| `runtime.warning` | 追加 `SessionNotice`（level=warning） |
| `runtime.error` | 追加 `SessionNotice`（level=error）；`code === "session_failed"` 时 `status = "failed"` |
| `message.assistant.delta` | 无条目则新建（`streaming=true`，`turnId` 取事件信封）；`text`/`reasoning` 按 `kind` 分别追加到对应缓冲区 |
| `tool.input.delta` | 无条目则新建 `preparing`；`inputText += payload.delta`；填 `name`（payload）/`turnId`（信封） |
| `tool.progress` | 条目存在则 `liveOutput += payload.chunk`（`payload.stream` 区分 stdout/stderr/info，客户端可分流渲染）；无条目则忽略——`progress` 不建占位，避免无支撑的幽灵工具行 |

临时事件只产生**瞬态字段**：`status`、`retry`、流式条目的 `text`/`reasoning`/`inputText`/`streaming`、`liveOutput`、`notices`。这些字段要么被后续持久事件覆盖/定稿，要么在收敛点归零，因此不影响重放等价（§6）。

## 5. 权限请求生命周期

```
ask 判定
  → permission.requested       pendingPermission 设置，工具条目 awaiting_permission
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

视图不变量：`pendingPermission` 仅在"有未决 requested 且 Turn 未闭合"时非空；一个会话同一时刻至多一个待决请求（执行管线串行，归约器以"后到者覆盖 + 不并发"处理，测试用场景断言覆盖）。

## 6. 重放与实时一致性

**收敛点**：`currentTurn === undefined && pendingPermission === undefined &&` 无 `streaming` 条目。

> **不变量 V1（重放等价）**：对任意合法事件序列 E（持久事件 + 任意交织的临时事件），在收敛点上，`reduce(E)` 与 `reduce(E.durable)` 的全部字段相等，除了 `notices`（仅由临时事件产生，重放缺失是设计行为）。

由此推出实现约束：`entries` 条目的一切字段只能来自持久事件（或其定稿后的瞬态镜像），`seq`/`key` 必须可从持久事件重建；瞬态字段必须有确定归零规则（§4 表格）。

重放等价允许客户端用**同一 reducer** 处理两条路径：

- 实时：`session.subscribe(ev => reduceSessionView(view, ev))`
- 恢复：`session.durableEvents().forEach(ev => reduceSessionView(view, ev))` 后继续 `subscribe`

恢复模式下，修复补写的事件（`resolved(cancelled)`、`completed(interrupted)`、`turn.completed(recovered)`）按 §3 正常归约，无需特殊分支。

## 7. 不变量清单

| # | 不变量 | 验证方式 |
|---|---|---|
| V1 | 收敛点重放等价（§6） | 场景矩阵 × {live 序列, 仅持久序列} 深比较 |
| V2 | 每个 `toolCallId` 恰有一条 `tool` 条目；`tool.completed` 落定且只落定一次 | 场景断言 |
| V3 | `pendingPermission` 至多一个，且其 `requestId` 未被 `resolved` | 场景断言 |
| V4 | `entries` 顺序 = 实体首次出现顺序；持久条目 `seq` 单调不降（按 `seq` 排序的条目序列合法） | 场景断言 |
| V5 | 视图 JSON 可序列化：`JSON.parse(JSON.stringify(view))` 与原件深比较相等 | 全场景 |
| V6 | 确定性：同一事件序列归约两次结果相等 | 全场景 |
| V7 | 未知事件类型被忽略，`revision` 仍递增 | 单测 |
| V8 | 收敛点上 `status==="idle"`、`retry===undefined`、无 `streaming` 条目、`liveOutput` 全空 | 场景断言 |

## 8. API

`@nocturne/core/protocol` 导出：

```ts
function createSessionView(): SessionView;
function reduceSessionView(view: SessionView, event: RuntimeEvent): void;
function replaySessionView(events: readonly DurableEvent[]): SessionView; // ≡ fold
```

`RuntimeEvent = DurableEvent | EphemeralEvent`（`subscribe` 的回调类型即此）。

### 测试计划（protocol/view.test.ts）

场景矩阵（每个场景跑 live 序列与 durable-only 序列两条路径）：

1. 纯文本一轮（含 text/reasoning delta）；
2. 工具调用一轮：input.delta → requested → resolved(allow) → started → progress → completed(ok)；
3. 规则拒绝：resolved(rule,deny) → completed(denied)（无 requested/started）；
4. ask 拒绝：`d`/`x` 两条路径 → completed(denied)；
5. 中断：Turn 中 interrupt → completed(interrupted) → turn.completed(interrupted)；
6. 进程退出恢复：日志止于 requested → 修复事件 → recovered turn.completed；
7. 多轮 + compacted + config_changed；
8. provider.retry → runtime.status(retrying) → 成功完成。

另加：乱序注入（completed 先于 started 的人工序列）、未知事件、V5–V8 通用断言。

## 9. 暂不设计

- 条目内细粒度 diff/文件变更投影：客户端从 `result.output`/`input` 自取（edit/write 的结构化 output 已含 diff）；
- 视图增量 diff 协议（op-based patch）：客户端用 `revision` 全量重渲染，Ink/React 自行 diff；
- 跨会话聚合视图、搜索索引；
- 虚拟滚动窗口化（条目量过大时的裁剪策略——TUI 静态回放天然规避）。
