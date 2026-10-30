# Subagent（子代理会话）

> 状态：已接受 v0.1（Phase 6 已验收）｜ 前置阅读：[tools.md](tools.md)、[sessions.md](sessions.md)、[permissions.md](permissions.md)、[agent-loop.md](agent-loop.md)、[mcp.md](mcp.md)、[hooks.md](hooks.md) ｜ 决策：[ADR-0013](../decisions/ADR-0013-subagent.md)

Subagent 是"一个工具启动一个受控子会话"：父会话中的模型调用内置 `task` 工具，工具经注入的 `SubagentLauncher` 创建一条独立的会话日志并运行受控 Turn（受限工具集、独立上下文、继承或收紧的权限），子代理用 `finish` 工具交回结果，`task` 把结果作为普通工具结果返回父会话。

```text
父会话                          子会话（普通 Session，独立日志）
  │ 模型调用 task                │
  │   tool.started(task)         │
  │   └────────▶ launcher.launch │
  │              │  session.create（session.created.parent 记父关联）
  │              │  runTurn ──▶   │  turn.started / message.user(task)
  │              │               │    …受限工具集的正常执行管线…
  │              │               │  finish(result) → turn.completed(done)
  │              │  （缺 finish → 催促重试，末轮强制 toolChoice）
  │              │  session.close│
  │   tool.completed(task) ◀─────┘  结果文本/结构化结果作为 ToolResult
```

核心原则：

- **子会话是普通会话**：一条独立 JSONL 日志、一把锁、同一个 `runTurn`、同一个执行管线。除本文明列的差异外，没有任何"子会话专用分支"。
- **`task` 是普通工具**：走 `ToolDefinition` 注册接口与九步执行管线，Agent Loop 中没有 `task` 分支；父侧恰好一个 `tool.completed` 的不变量由执行器保证，与其他工具一致。
- **权限只继承或收紧**：子会话的有效判定对每个主体都不宽于父会话（第 7 节）。
- **不新增事件类型**：父子关联用 `session.created` 的 `parent` 字段；客户端可见进度走既有 `tool.progress` 临时事件；重放等价不变量不受影响。

## 1. 工具契约（`task`）

`task` 是内置工具（`tools/builtin/`），形状为普通 `ToolDefinition`：

| 输入字段 | 类型 | 说明 |
|---|---|---|
| `task` | `string`（必填） | 交给子代理的完整任务描述。子会话看不到父会话历史，任务必须自包含（需要的文件、约束、产出格式都写在这里） |
| `preset` | `"general" \| "explore"` | 工具集预设（第 6 节）。缺省 `general`；与 `tools` 互斥 |
| `tools` | `string[]` | 显式工具名白名单（与 `preset` 互斥）；未知名 → `invalid_input` 并列出可用名 |
| `outputSchema` | `JsonSchema`（object） | 要求子代理按此 schema 提交结构化结果；无法编译 → `invalid_input` |
| `timeoutMs` | `integer` | 本次调用的超时上限，正整数生效、封顶 `traits.maxTimeoutMs`（读取规则见 tool-api.md 第 1 节）。参数说明要求：省略即默认；实现、修改代码、审查、调研类任务都不要设短于默认值的超时，只有确定很快的查询才缩短 |

`traits`：`{ mutates: true, concurrencySafe: false, timeoutMs: 600_000, maxTimeoutMs: 3_600_000, maxModelChars: 30_000 }`。`traits.timeoutMs` 取 `RuntimeOptions.subagent.timeoutMs`（默认 600_000，上限 3_600_000，第 3 节），与 launcher 的默认超时是同一个值。`mutates: true` 如实声明（`general` 子代理可能写文件）；`concurrencySafe: false` 因为并行子代理在没有工作区隔离的前提下可能同时改同一批文件（隔离明确不做，见第 16 节）。

`permissionSubjects` 返回 `[{ kind: "subagent", target }]`：`target` 为预设名（`general`/`explore`）或 `"custom"`（`tools` 白名单）。新增的 `subagent` 主体类别让用户能在规则层把"派生子代理"本身当作受控动作（如 `subagent * → deny` 即为本特性的用户级开关），各预设的默认值见 [permissions.md](permissions.md) 第 6 节（`default`/`auto-edit` 下 `explore` 默认放行、`general`/`custom` 需确认）。

工具描述向父模型如实说明权限收敛：子会话非交互，需要确认的操作在子会话内会被拒（第 7 节）——只读/探索任务优先用 `explore`，需要写入或执行的任务要么先由规则/Grant/`--yes` 放行，要么由父代理自己执行。避免父模型派出注定失败的写操作子代理浪费步数。

**ToolResult**：

- `status: "ok"`：`modelContent` 为子代理 `finish` 提交的结果文本（`outputSchema` 时为序列化 JSON）；`output` 携带 `{ childSessionId, childLogPath, model, turns, steps, usage, structured? }`。`modelContent` 超预算走既有截断+落盘路径（[tools.md](tools.md) 第 4 节，`spillPath` 在父会话附件目录）；完整过程永远在子会话日志里，`childLogPath` 随结果告知。
- `status: "error"` 的错误码：

| code | 含义 |
|---|---|
| `subagent_turn_failed` | 子会话 Turn 以 `error`/`max_steps`/`truncated`/`refused` 结束（message 带 reason 与 error 摘要） |
| `subagent_no_result` | 催促与强制轮次用尽仍未收到 `finish`；`modelContent` 附子会话最后文本尾部供父模型利用 |
| `subagent_concurrency` | 运行级并发上限已满（第 11 节），提示稍后重试 |
| `invalid_input` | `outputSchema` 无法编译、`tools` 含未知名、`preset` 与 `tools` 同给 |
| `subagent_unavailable` | 运行时未启用本特性（正常装配下工具不注册，此为防御分支） |

`cancelled`/`timeout` 由执行器或 launcher 按中止信号来源结算（第 4 节：父会话中断 → `cancelled`，本次 task 超时 → `timeout`）；`permission_denied`/`hook_denied` 由父侧权限管线产生——`task` 调用本身与其他工具一样先过主体声明与权限求值。

## 2. 结束协议（`finish` 工具与催促）

子会话必须显式提交结果，不能靠"输出停了"判定完成：

- `finish` 是**只在子会话注册表中出现**的工具（不进父会话注册表）。输入 `{ result }`：`outputSchema` 缺省时 `result` 为字符串；给出 `outputSchema` 时 `finish` 的 `inputSchema` 为 `{ properties: { result: <outputSchema> }, required: ["result"] }`——**结构化校验复用管线第 2 步的既有 schema 校验**，不符时子模型收到 `invalid_input` 并可修正重试，不需要新机制。
- `finish` 的 `permissionSubjects` 返回 `[]`（自动放行——它只是返回通道，不触碰任何资源）；`traits.mutates = false`。
- 终止判定：`TurnDeps` 新增可选 `shouldFinish(state)` 谓词，Agent Loop 在每个工具调用结算后检查；launcher 提供的实现是"子会话历史中已存在 `name = finish` 且 `status = ok` 的 `tool.completed`"。命中即 `finish("done")`——子 Turn 以正常 `done` 收尾，不是中断。谓词由 launcher 注入，Agent Loop 本身仍不出现工具名。
- **催促与兜底**：一个子 Turn 以 `done` 结束但没有 `finish` 调用时，launcher 在同一子会话上再开一个 Turn，message.user 为催促提示（如 `你还没有提交结果；请立即调用 finish 工具提交 {result}`）。上限 `maxAttempts`（默认 3：首轮 + 2 次催促）；**最后一轮**通过 `ModelRequest` 新增的可选字段 `toolChoice: { name: "finish" }` 强制模型调用结束工具（provider-api.md 第 3 节）。全部轮次用尽仍无 `finish` → `subagent_no_result`。
- **`toolChoice` 与扩展思考**：部分服务在开启思考时不接受强制指定工具（如 Anthropic extended thinking 下 `tool_choice` 只接受 `auto`/`none`，强行发送返回 400）。采用**兜底轮临时关闭思考**：最后一轮的 TurnDeps 不携带 `reasoningEffort`（仅这一轮，子会话此前轮次不受影响），使 `toolChoice` 可正常表达（ADR-0018 第 3 节）。另加一层通用防御——适配器知道自己发出的组合不被服务端接受时（思考 + 强制 tool_choice 等），**主动丢弃 `toolChoice`** 并在 `provider.request` 诊断中标注，而不是把必然失败的请求发出去。
- 非 `done` 的结束（`error`/`max_steps`/`truncated`/`refused`）不进入催促循环，直接 `subagent_turn_failed`——这些是失败信号，不是"忘了提交"。

## 3. Launcher 接线（无循环依赖）

沿用 `HookRunner`/`McpConnector` 的同一注入模式：

| 件 | 位置 | 说明 |
|---|---|---|
| `SubagentLauncher`、`SubagentRequest`、`SubagentOutcome` 接口 | `tools`（`tools/types.ts`） | 纯类型；`launch(request, ctx)`，`ctx` 携带父会话 `sessionId`/`turnId`/`callId`/`signal` 与 `progress(chunk)` 回调 |
| `task` 工具 | `tools/builtin/task.ts` | `createTaskTool(launcher)` 工厂；`execute` 只做输入预检与 `launcher.launch` 结果映射 |
| `finish` 工具 | `agent` 内部（`agent/subagent.ts`） | 由 launcher 按 `outputSchema` 现场构造，只出现在子注册表 |
| `createSubagentLauncher(deps)` | `agent/subagent.ts` | 唯一允许 import `runTurn` 的装配实现；`agent` 依赖 `tools`/`session`/`permission`/`config` 本已合法 |
| 装配 | `core/index.ts` `wrapSession` | 创建 depth=0 的 launcher 并把 `createTaskTool(launcher)` 注册进会话注册表 |

**为什么不成环**：`tools` 只持有 `SubagentLauncher` **接口**（与 `HookRunner` 相同手法）；`agent` 依赖 `tools` 拿接口、提供实现；`core/index` 是唯一同时看到两者的装配点。`tools` 不 import `agent`，依赖方向与 depcheck 规则不变。

**launcher 依赖（`SubagentDeps`，全部由 index 在 `wrapSession` 内捕获注入）**：

- `store`（`SessionStore`）与 `sessionsDir`：创建/关闭子会话；
- `platform`、`diagnostics`：子会话执行环境的共享部分；
- `instructions`/`environment`/`model`（`ResolvedModel`）/`turnConfig` 基值：子 TurnDeps 的输入；
- `makePolicy(sessionId): PermissionPolicy`：按子会话参数重建规则的工厂闭包（规则、Grant、预设上下文都留在 index 手中）；
- `makeHookRunner(sessionId, subagentMeta): HookRunner | undefined`：同一批已过滤的 Hook 条目换会话绑定重建（第 10 节）；
- `mcpTools(): readonly ToolDefinition[]`：父会话 `McpSession.tools()` 的快照读取（第 10 节）；
- `depth` 与 `limits`（`maxDepth`/`maxConcurrent`/`maxStepsPerTurn`/`maxAttempts`）：见第 6、11 节；
- `limiter`：Runtime 级并发信号量（`createRuntime` 创建一份，所有会话/层级共享）。

**递归结构**：launcher 在创建子会话的注册表时，若子会话自身 `depth < maxDepth`，以同一 deps 构造 depth+1 的 launcher 并注册子级 `task`——嵌套派生是同一条路径的自然递归，不是第二套机制。

**`RuntimeOptions.subagent`**（缺省即启用默认值）：

```ts
subagent?: {
  enabled?: boolean          // 默认 true；false 时 task 不注册（模型不可见）
  maxDepth?: number          // 允许的最大会话深度，默认 1（子代理默认不能再派生）
  maxConcurrent?: number     // Runtime 级并存子会话上限，默认 4（第 11 节）
  maxStepsPerTurn?: number   // 子会话单 Turn 步数上限，默认 50
  maxAttempts?: number       // 缺 finish 时的总轮次上限（首轮 + 催促），默认 3
  timeoutMs?: number         // task 默认超时：同时是 traits.timeoutMs 与 launcher
                             // 的缺省值；默认 600_000，超过 3_600_000 按上限计
}
```

运行级限制仍由 `RuntimeOptions.subagent` 提供；命名档位配置为 `subagents.profiles`（第 19 节），用户级权限开关仍是 `subagent * → deny`。

## 4. 子会话生命周期

```text
launch(request, ctx)
  → limiter 占位（满 → subagent_concurrency）
  → store.create({ …父会话 cwd/workspaceRoot/model/preset,
                   parent: { sessionId: ctx.sessionId, callId: ctx.callId } })
       # session.created 持久记录父子关联（events.md 3.1 兼容新增字段）
  → 组装子会话部件：注册表（第 6 节）、子 policy/gate（第 7 节）、子 execEnv、
    子 HookRunner、TurnDeps（含 shouldFinish、basePrompt、独立 maxSteps）
  → runTurn(childDeps, [task 文本])            # message.user = 任务原文
  → 未 finish 则催促轮次（第 2 节），直到 finish-ok 或轮尽
  → finally：child.close()（释放锁；不写父会话任何事件）、归还 limiter 占位
  → 返回 SubagentOutcome
```

**中断传播**：子 Turn 的 signal 是 `AbortSignal.any([ctx.signal, launcher 超时计时器, 父会话 failedSignal, 子会话 failedSignal])`——父会话中断/本次调用超时/任一侧持久化失败都会取消子会话。launcher 等到子 Turn 实际收束（子日志写下 `turn.completed(reason="aborted")`）后才返回，保证子日志自洽。

**恰好一个 `tool.completed`**：`launch` 只被 `task.execute` 调用一次、只返回一次；无论子会话内部经历了多少轮/多少工具，父日志中这次调用的事件序列与普通工具完全一致（`tool.started` → `tool.completed`；期间的子会话进度以 `tool.progress` 临时事件呈现，见第 12 节）。子会话的所有事实都写在子日志里，父日志不记录子会话内部事件。

**出错、超时、超步数**：子 Turn 的 `turn.completed` reason 映射为结果——`done` 且有 `finish` → `ok`；`done` 无 `finish` → 进入催促；`error`/`max_steps`/`truncated`/`refused` → `subagent_turn_failed`；`aborted` 按中止信号来源结算：父会话中断（`ctx.signal` 非超时中止）→ `cancelled`，本次 task 超时（launcher 自己的计时器，或经 `ctx.signal` 传入的执行器超时信号，reason 为 `TimeoutError`）→ `timeout` 并附「超过 Nms 未完成 + 可能已修改工作区请先检查 git status + 只读审查/调研任务也不要设短于默认值的超时」提示，父/子日志 `failedSignal` 中止 → `subagent_turn_failed`。`timeout`/`cancelled` 与 `subagent_turn_failed`、`subagent_no_result` 一样附子会话已有的产出（`partialOutputOf`）和 `statsOf`（子会话路径、已完成步数）：已完成工具调用的清单（最近 15 条：工具名、参数摘要、状态、结果首行至多 120 字）加最后一段助手文本；`task` 工具把它以「子会话没有提交结果，以下是它已有的产出（未完成，可能不完整，请自行核对）」交给模型。超时常落在写报告的最后一步，那一步的文字不会落盘，前面的调研靠这份清单留给父模型。父会话中断时执行器按既有规则把整个调用归一为 `cancelled`（Turn 随之结束），产出只留在子会话日志里，不进入父模型的上下文。子会话创建失败、`close` 抛错等内部异常 → `tool_failed`（执行器既有兜底）。

**重复调用保护**（[ADR-0063](../decisions/ADR-0063-loop-guard.md)）：`turnConfig` 原样传给子 Turn（只额外压 `maxSteps`），所以 `turn.loopGuard` 在子会话同样生效。子模型在自己的 Turn 里连续重复同一调用到 `stopAt` 时，子 Turn 以 `error(code = "loop_detected")` 收束，按上面的规则映射为 `subagent_turn_failed`（message 为「子会话 Turn 以 error 结束」），父模型拿到普通错误结果、附已有的产出清单。触发第 `warnAt` 次的说明由子会话的 Builder 用同一份实现重建，因此子日志里同样没有额外事件。

## 5. 会话与持久化

- **日志**：`<NOCTURNE_HOME>/sessions/<childSessionId>.jsonl` + `.lock`，与顶层会话同目录、同格式、同锁语义（ADR-0009）。子会话的落盘附件在 `attachments/<childSessionId>/` 下——`presetContext.sessionId` 传子会话 id，预设规则自动放行它自己的附件目录。
- **父子关联**：`session.created` 增加可选字段 `parent?: { sessionId: string; callId: string }`（兼容新增，旧版本忽略）。`callId` 是父会话中那次 `task` 调用的标识——由此可从子日志找到父会话与触发它的那格调用。
- **列表可见性**：`SessionSummary` 增加 `parent` 字段；`SessionStore.list`/`listSessions` 增加 `includeSubagents?: boolean`，**默认 false**——`--sessions`、`/resume`、`-c/--continue` 都只面向顶层会话，子会话是运行痕迹而非可交互会话（避免 `-c` 误恢复一条子日志）。按 id 显式 `resumeSession(childId)` 仍然可行，但它会取得锁并可能修复日志，不是只读接口；只读查看采用第 12 节的独立设计。
- **恢复**：
  - 父会话被杀/中断时子代理在跑：父侧按既有修复把未结算的 `task` 调用补 `tool.completed(interrupted)` + `turn.completed(process_exited, recovered)`；
  - 子日志到 kill 点为止的内容是完整的已提交前缀（每条日志独立）；未收束的 Turn 与调用**在下一次打开该子日志时**按第 6 节惰性修复——与任何崩溃会话一致，父侧恢复不主动触碰子日志（打开、取锁、修复是子日志自己的生命周期动作）。
  - 正常中断（非强杀）时子 Turn 先收束再返回，子日志以 `turn.completed(aborted)` 闭合，不需要修复。

## 6. 受限工具集与递归

父会话存在技能目录时，可选池包含非 mutating 的 `skill`，general 与 explore 默认可用。子会话使用启动时父目录与正文快照，加载记录和摘要后重载属于子会话；技能支持文件的读取仍走父权限策略的只读继承。详见 [skills.md](skills.md) 第 3 节。

**可选池** = 内置工具 ∪ 父会话 MCP 工具（`mcpSession.tools()` 快照）∪ `task`（仅子会话自身 `depth < maxDepth` 时），再按特性排除 `traits.needsUser === true` 的工具——子会话非交互，`ask_user`（ADR-0032）永远不在池内；同样排除 `traits.mutatesSchedule === true` 的工具——子代理不能创建或改写定时任务（ADR-0064）。子注册表 = 池 ∩ 选择 + `finish`（恒在，不可被 `tools` 列出也不可被排除）。

| 选择方式 | 语义 |
|---|---|
| `preset: "general"`（默认） | 可选池全部 |
| `preset: "explore"` | 只读探索：`traits.mutates === false` 的工具（read/grep/glob/web_fetch 与声明 `readOnlyHint` 的 MCP 工具自动在内；write/edit/shell/task 自动排除）。按特性筛选而非按名字列表（pitfalls #3）。注意 `readOnlyHint` 是**服务器自己声明**的标注，不可信——它只决定工具能否进入 explore 工具集，调用时的放行仍由权限层逐项判断（第 7 节） |
| `tools: [...]` | 显式白名单 ∩ 可选池；未知名 → `invalid_input` 并列出可用名（自愈路径与 `unknown_tool` 一致）；`finish` 不接受列出；点名 `needsUser` 或 `mutatesSchedule` 工具（如 `ask_user`、`schedule`）因不在池内同样以 `invalid_input` 拒绝 |
| `preset` + `tools` 同给 | `invalid_input` |

工具名空间不变（子会话里仍是 `read`、`mcp__x__y`）；模型在子会话中调用池外/不存在工具 → `unknown_tool` 正常结算。

`web_fetch` 自动进入 explore 工具集，但子会话非交互，未获规则或 Grant 放行的主机仍被拒绝。父会话「本会话允许」过的主机按第 7.2 节只读继承，可以直接读取其他页面；被拒访问应写入 finish 结果，由父代理处理。网页抓取契约见 [tools.md](tools.md) 第 6 节。

**递归上限**：`maxDepth`（默认 1）是会话深度上限——`depth` 为祖先进会话数（顶层 0）。`depth == maxDepth` 的会话注册表里没有 `task`，模型硬调会得到 `unknown_tool`；这靠**不注册**实现，不靠运行时分支。

## 7. 权限模型

硬约束：**子会话的有效权限不得宽于父会话；权限判定仍只发生在权限层。**

### 7.1 方案比较

| 方案 | 子会话 ask 的处理 | 能力 | 成本 |
|---|---|---|---|
| (a) 冒泡到父会话客户端 | 转发为父会话的确认请求 | 完整（子代理可以获批写/执行） | 需要跨会话的请求路由（`respondPermission` 按会话路由，子请求要注册进父 gate 的 pending map）、父日志出现外来 `callId` 的 `permission.requested`（或新事件类型 + reducer 扩展）、双向中断传播——一组新的持久语义与失败模式 |
| (b) 非交互子会话 | `ask` 一律 `deny`（`source: "non_interactive"` 既有路径） | 收窄：父会话里需要人确认的操作，子会话做不了 | **零新机制**：`createPolicyGate(..., { interactive: false })` 是现成路径；全部权限事实留在子日志 |
| (c) 按工具集预设 | 不是 ask 的处理方式，是正交能力裁剪：`explore` 只含只读工具，**在默认规则下**工作区内的只读操作不会产生 ask | 只读场景在默认规则下完整 | 与 (a)/(b) 都兼容；不是"任何规则下都放行"——工作区外读取、`mcp` 主体等在 `default` 下仍是 ask，在子会话里照常被拒 |

**结论：本阶段采用 (b) + (c)**。理由：(b) 是现有语义的直接复用且安全保证可证明；(c) 的预设让"天然不需要确认"的只读子代理不受影响；`--yes`、规则、`PermissionRequest` Hook 与项目 Grant 覆盖了无人值守场景下的大部分放行需求；交互式 `default` 预设下子代理做不了的写/执行操作，子代理在结果里说明需求、父代理自己执行即可——比"批准 task 调用即授权整个子任务"（oh-my-pi 的 yolo 做法，明确不采用）更符合逐项把关的权限哲学。(a) 留作以后扩展：在 `PermissionGate` 增加可选的 `forwardAsk` 委托即可接入，不推翻本设计。

### 7.2 子会话的有效策略

子会话的 `PermissionPolicy` 由 `makePolicy(childSessionId)` 用**与父会话相同的输入**重建：

- 同一 `workspaceRoot`、同一预设名、同一批已合并的可信规则与不可信收紧规则（含受保护路径、高风险命令）；
- 同一 `project` Grant 集合（工作区级，本就按目录归属）；
- **会话 Grant 共享**：父会话的 `sessionGrants` 数组以只读方式传给子策略——"本会话内允许"的语义扩展为**会话树内允许**（子会话是这次会话工作的委派部分）。子会话的非交互 gate 没有 `respond` 路径，永远写不进新授权；
- 同一 `autoApproveAsk`：`--yes` 是运行级操作者决定，子会话继承它（提升范围与父会话逐点一致，不覆盖 deny、不绕过 Hook 强制的 ask）；
- `presetContext.sessionId` 换为**子会话** id（附件目录规则绑定自己的落盘目录）。

子会话 gate：`createPolicyGate(childPolicy, { interactive: false, hooks: childHookRunner, caseSensitive, preset, reviewer, ...reviewSources }（`reviewSources` 是父会话的审查输入来源：用户消息、项目说明、可信 remote、补充事实与追加规则）)`，审查器 getter 沿用父会话实例。

**不宽于父会话的论证**：对每个主体，子会话的求值输入（规则、Grant、autoApproveAsk、Hook 建议）与父会话完全相同，唯一差异是 ask 分支——smart 的剩余 ask 都先经同一审查器，allow/block 直接结算；仍需确认时父会话等人回答，子会话 `deny(source: "non_interactive")`。因此子会话的任何 `allow` 都是父会话同一求值下也会得到的 `allow`；差异方向只有"更严"。

### 7.3 各机制在子会话中的行为

| 机制 | 子会话行为 |
|---|---|
| 规则 deny（含不可信项目收紧、受保护路径） | 照常 deny——没有任何子会话机制能越过 |
| 规则 ask | 先按父策略经 Hook 与 smart 审查；剩余 ask 为 `non_interactive` deny（smart 下白名单外的 shell、network、未声明只读的 MCP 都会送审，审查交给你确认或直接交人的命令在子会话里就是被拒——ADR-0057，子会话可用的命令比以前少）（不发 `permission.requested`）。拒绝消息由子会话 gate 的 `nonInteractiveDenyHint` 注入指引文案：**"子代理无法请求用户确认；需要写入或执行的操作请在 `finish` 结果中说明，由父代理执行"**——让子模型把受阻操作转化为结果内容，而不是反复重试浪费步数 |
| 会话 Grant | 继承父会话的授权集（只读共享），精确匹配照常 `allow(source:"grant")` |
| 项目 Grant | 同一 workspaceRoot，照常生效 |
| `--yes` / `autoApproveAsk` | 继承：规则判定的 ask 提升为 allow；**仍不覆盖 deny，也不提升 Hook 强制的 ask** |
| `PreToolUse` Hook | 照常触发（deny/ask/updatedInput 语义不变）；强制的 ask 在子会话走"PermissionRequest Hook → 无回答则 non_interactive deny" |
| `PermissionRequest` Hook | 照常触发：可信 Hook 的 `allow`/`deny` 直接结算——这是团队自动化的既有委托点，也是子会话内 ask 唯一可能的放行来源 |
| `PostToolUse` Hook | 照常触发（feedback 追加进子会话的工具结果） |
| `task` 调用本身 | 在**父会话**走正常权限管线：`subagent <preset|custom>` 主体；`default`/`auto-edit` 预设下 `explore` 默认 `allow`（只读子代理能做的事父会话本就会自动放行，多出的只是 token 成本），`general`/`custom` 保持 `ask`；`deny_stop` 等选项语义不变 |

## 8. 上下文

- **不继承父会话历史**：子会话的 `message.user` 就是 `task` 文本；父会话的对话、工具结果、压缩记录一律不进入子上下文。
- **系统提示**：`BuildContextInput` 新增可选 `basePrompt`（缺省即现有 `BASE_SYSTEM_PROMPT`），子会话传入子代理提示：身份（父代理派生的任务会话）、`finish` 提交协议（含 `outputSchema` 要求）、不能向用户提问的约束、其余工作约定。工具规格、项目指令、环境信息段的组装不变。
- **继承**：项目指令（用户级与各级 `AGENTS.md`——它们是项目事实）、环境信息、由 task 角色决定的 `ResolvedModel`（未配置时继承父模型，模型清单与 Provider 由会话级注册表解析，子会话不另建）。思考档位同样继承：子会话 `session.created.reasoningEffort` 写父会话当前档位按子模型可用集合就近降档后的值（ADR-0018 第 5 节）。
- **预算与压缩**：按子模型自己的能力与窗口独立计算；L1/L2 压缩机制照常（它就是一次普通 Turn）。子会话通常短命，压缩很少触发，但机制不需要例外。
- **token 成本**：子会话的用量记在子日志的 `turn.completed.usage`，并随 `task` 结果的 `output.usage` 汇总给父侧。

## 9. 模型选择与 Turn / Agent Loop

[ADR-0040](../decisions/ADR-0040-model-roles.md)：子代理独立模型由 `task` 角色决定，未配置或引用无效时继承父会话当前模型。派生时固定模型与档位，催促轮继续使用同一个子模型；档位继承父会话意图并按子模型可用集合就近降档。`session.created.model` 与 `task.output.model` 记录实际模型，TUI 工具行显示该模型。

自定义档位可覆盖模型和思考强度，完整规则见第 19 节；default 仍使用上述角色行为。`runTurn` 的注入点不含工具名/角色分支：

- `TurnDeps.basePrompt?: string` → 传给 `buildContext`（第 8 节）；
- `TurnDeps.shouldFinish?(state): boolean` → 每个工具调用结算后检查，命中走 `finish("done")`；
- `TurnDeps.toolChoice?: { name: string }` → 设置时进入本 Turn 每个 `ModelRequest`（催促兜底轮专用）。

子会话内没有 `setModel`/`setPermissionPreset`/`compact` 命令入口（它是工具驱动的会话，没有客户端命令面）；`compact` 作为 Turn 内自动压缩照常工作。

## 10. MCP 与 Hooks

- **MCP**：子注册表直接放入父会话 `mcpSession.tools()` 返回的 `ToolDefinition`（经第 6 节裁剪）——这些定义已绑定既有连接，**不产生新的服务器进程、不做第二次 initialize**。子会话取的是创建时刻的快照；`list_changed`/重连的暂存切换只发生在父会话自己的 Turn 边界。`mcp` 主体求值照常（子会话里同样只能得到"父会话也会自动放行"的结果）。
- **Hooks**：子会话沿用父会话**已按信任过滤后的同一批条目**，以子会话 `sessionId`/`cwd`/`workspaceRoot` 重建 runner。全部点位照常触发——`SessionStart`（`resumed:false`）、`TurnStart`（`text` 为任务或催促文本）、`PreToolUse`/`PermissionRequest`/`PostToolUse`、`TurnEnd`、`SessionEnd`（`close` 时）。`HookInput` 增加可选 `subagent?: { parentSessionId, parentCallId, depth }`：Hook 脚本据此区分子会话（例如只审计、或对子会话一律不放宽）。Hook 失败降级、`hook_failed` 警告、只能收紧的边界全部不变；子会话里的 `runtime.warning` 写子会话自己的临时事件。

## 11. 并发

- 当前执行管线**串行**（agent-loop.md 3.2），同一 Turn 内多个 `task` 调用顺序执行；`task` 标 `concurrencySafe: false`，将来并行调度也不参与。
- 仍然需要上限：`maxConcurrent`（默认 4）是 **Runtime 级**信号量，覆盖两种真实并发达成路径——同一 Runtime 的多个会话同时跑子代理（多会话宿主/未来 RPC），以及嵌套派生形成的祖先链各占一个槽。槽满时 `launch` 立即以 `subagent_concurrency` 失败（fail-fast 而非排队：排队在嵌套持槽时会形成等待环）。失败是普通工具结果，模型可稍后重试。

## 12. 客户端呈现

**不新增事件类型。** `task` 在父会话就是一格普通工具条目（`tool.started`/`tool.completed`）；运行期间 launcher 订阅子会话事件并把**一行式摘要**经 `ctx.progress` 转发为父会话的 `tool.progress(stream:"info")`：子 Turn 开始、每个子工具调用的 `<name> → <status>` 结算行。发送方不补换行；CLI 为每条 `info` 单独成行，TUI 的视图归约在 `liveOutput` 中分行后展示尾部（[tool-api.md](../protocols/tool-api.md) 第 2 节）。

**为什么不流式转发子会话内部内容**：子代理的文本与工具明细全量复制到父时间线会淹没父会话视图，且这些信息已经完整、可审计地写在子日志里（`output.childLogPath` 指路）。一行一结算的进度在"知道它在干活"与"不打扰"之间取平衡；要看全程，在独立只读视图里观察子会话，不把它的事件混入父 reducer。

`--sessions` 与 `/resume` 默认不列出子会话（第 5 节）；子代理调用本身在父会话的权限确认提示中显示为 `subagent <preset>` 主体，文案与其他主体一致。

### 12.1 只读发现与观察（ADR-0060 第 4 轮）

精确类型、RPC 方法、回放算法、错误与清理契约以 [rpc.md 第 4.1 节](../protocols/rpc.md#41-子会话只读观察adr-0060-第-4-轮) 为主文档。实现位于 `session/subagent-registry.ts`、`session/subagent-observe.ts` 与 `session/readonly-log.ts`，由 Runtime 装配并向 launcher 注入共享登记簿。

- **发现不靠解析进度文本**：新增 `Runtime.listSubagents({parentSessionId})`，返回直接内置子会话的 child id、父 callId、启动档位/任务摘要、起止时间与可证明的状态。`session.created.parent` 是持久映射；运行中无需等父 `tool.completed.output`。可复用只读日志头索引查历史映射，不新增事件或事件字段，也不把当前档位配置用于解释历史。
- **Runtime 级观察登记簿**：与运行级 limiter 同寿命，注入所有 launcher（递归共享），不是 Hub 的 sessions 表。子创建事件提交后、执行和进度转发前登记 child Session；登记时可捕获 request 的档位与摘要，父日志仍保留原始任务。索引以 `(parentSessionId, callId, childSessionId)` 关联；同一父调用意外出现多个 child 时保留各自 id，不任取一个覆盖。launcher 在 finally 中处理 SessionEnd、等写入与 close 后才发内存终止信号并移除活动项；异常和失败也必须走这条清理路径。观察者抛错或退出不得影响运行、锁、并发槽或结果返回。
- **结束和重启**：活动登记簿不落盘；结束后无需永久保留 Session 引用，按子日志 parent 重建映射，父工具输入补展示元数据。重启不复活子代理，不把旧的 running 工具行当作活动登记；只读日志前缀决定可显示内容。已结束、未收束和来自别的进程的日志都能看，但后两者不能被伪装成本后台实时运行或成功。子会话被删除后保留的面板标签显示不可用，不自动派生或恢复运行。
- **无缝接流与自然结束**：新增 `Runtime.observeSubagent` 返回观察对象，不返回 `RuntimeSession`。活动 child 直接接已有 Session 的已提交事件，回放先监听后取快照、按 seq 去重；终止信号与事件一起衔接。不能在一个 `turn.completed(done)` 后就退订，因为 launcher 可能继续催促。无活动项走独立只读 reader，不经 load/repair；不完整尾行仅在内存略过，不取锁、不写任何文件。EOF 是读取完成，不是子代理成功。
- **嵌套**：观察 API 以直接父子关系校验，能看任意深度的内置 child；先 list 当前 child 的直接子级，再携带该 child 作为 parent 观察孙级。本轮桌面不做嵌套跳转入口，不展开递归树；顶层概览只列直接子代理。
- **外部 ACP**：没有 Nocturne 子会话，不伪装为 SessionView、不把 `external/<callId>.jsonl` 翻译成 RuntimeEvent。保留父工具行的进度、最终结果与已有审计路径；不提供「在面板中查看」。概览可由父工具条目的 `subagent external:<name>` 主体识别运行中的外部调用，显示「外部 agent · 仅主对话进度」，不作为可点击项。审计文件可能缺失/不完整（第 17 节），本轮不增加专用解析器。

### 12.2 视图与权限边界

每个被观察 child 使用独立的 `createSessionView` / `reduceSessionView`，无需改变 reducer、事件类型或持久重放规则。`message.user` 是任务原文（后续可能是催促），展示层标成「任务」/「催促」，保留可展开的原文，不把它当成用户可编辑气泡；思考、普通工具、输出使用主对话的同一渲染原语。`finish` 是普通工具条目，成功提交时从其持久 input.result 展示「最终结果」（字符串为 Markdown、结构化值为格式化 JSON）；`finish.tool.completed.modelContent` 只是提交回执，不是结果正文。父 task 结算到达后以其状态和耗时为准；无成功 finish 时显示失败/最后输出，不能拿最后一条 assistant 文本冒充最终结果。

图片输出由只读 `Runtime.readSubagentAttachment` 提供，复用既有附件引用/路径/哈希校验，不创建 RpcSession；文件引用的展示可以复用主对话渲染，但不为此打开 child 或启用任何交互命令。

观察完成状态放在视图外的只读来源元数据中，不给 reducer 注入虚假的 turn.completed；未收束日志可以仍有 currentTurn / pendingPermission，但界面停止转圈并提示「日志未收束／运行状态未知」。实时订阅前丢失的思考增量不能补造；持久 message.assistant 到达后按完整内容收敛，思考时长只展示已知值。

**权限语义不扩展**：当前内置子会话及 ACP 都是非交互 gate，剩余 ask 直接 non_interactive deny，不产生等待用户确认。父 task 启动前的确认留在主对话，此时还没有 child，不提供可用的子标签入口；标签内受阻操作提示「子代理无法请求确认；需由主代理在主对话处理」。若读取旧日志发现未决 permission.requested，只展示只读状态与「确认仍在主对话处理；此处不能批准」，无应答按钮；历史未收束请求不声称当前仍在等待。未来若做权限冒泡，另行设计，不能在这轮为了造一个等待状态而改变第 7 节。

只读观察不启动会话、不授予交互句柄，不进入工具权限管线、不新增 Grant。已有 resumeSession 仍是显式打开；不得借观察对象调用 submit、respondPermission、respondQuestion 或 interrupt。新 RPC 仅本机开放，远程由服务端白名单拒绝，ADR-0052 的通道与手机现有能力保持不变。

## 13. 诊断与关联（含 traceId 决定）

诊断记录新增三类（observability.md 第 2 节表）：

| kind | 内容 |
|---|---|
| `subagent.launch` | 子 sessionId、`parentSessionId`/`parentCallId`、preset 或 tools、depth |
| `subagent.attempt` | 子 sessionId、turnIndex、是否强制 toolChoice |
| `subagent.done` | 子 sessionId、status、turns、steps、usage、durationMs、error? |

父子关联的事实源是 `session.created.parent`（持久、类型化）；诊断记录里子会话条目带 `sessionId = <子会话>` 与上述 parent 字段，串起一次调用链。

**`traceId` 本阶段不引入**：events.md 第 1 节曾预留"引入 Subagent 时加可选 traceId"，但本阶段的真实需求只是"父子会话关联"——已由 `session.created.parent` 的类型化字段覆盖；`traceId` 设计给跨进程链路，唯一的消费场景在 RPC 阶段。现在给每个事件信封加没有消费方的字段属于为假想需求设计（pitfalls #18）。observability.md 第 5 节"RPC 化之后再引入"维持不变；events.md 的预留措辞改为指向 RPC 阶段与本节。

## 14. 角色系统边界（结论）

**本阶段不开放用户/项目自定义的 agent 定义文件**（frontmatter Markdown 那类"名字 + 系统提示 + 工具集 + 模型"的描述文件）：

- 自定义 agent 文件 = 角色系统的雏形（可命名的 persona、独立提示词、独立模型选择）。roadmap 明确不做角色系统；它一旦开放，命名、作用域、信任、模型覆盖会一起进来，超出"受控子会话"的本阶段边界。
- 本阶段只有**内置工具集预设**（`general`/`explore`）：它们只裁剪工具集，不含独立提示词或角色。`preset` 参数与 launcher 的工具集裁剪点是预留的接入点——将来若要做角色/自定义定义，从这里扩展，而不是现在先建抽象（pitfalls #18）。
- 子代理的提示词是单一固定文本（第 8 节），不接受用户注入；任务本身由父模型经 `task` 字段传入——自定义"行为"只发生在任务内容这一层，不需要定义文件。

## 15. 协议与类型变更清单

全部为兼容变更（events.md 第 8 节、tool-api.md 第 6 节、provider-api.md 第 6 节口径）：

| 变更 | 位置 | 兼容性 |
|---|---|---|
| `session.created` payload 增加 `parent?: { sessionId, callId }` | events.md 3.1、`CreateSessionInput` | 可选新增字段，旧版本忽略 |
| `session.created` / `session.config_changed` payload 增加 `reasoningEffort` | events.md 3.1、ADR-0018 | 可选新增字段，旧版本忽略；子会话记录继承父会话（就近降档后）的档位 |
| `SessionSummary.parent`、`listSessions({ includeSubagents })` | sessions.md 8、store | 默认隐藏，行为只增不改 |
| `PermissionSubject.kind` / `SubjectRequest.kind` 增加 `"subagent"` | events.md 4、tool-api.md 1、permissions.md 3/6 | 新类别；旧日志不受影响；预设新增一行规则 |
| `BuildContextInput.basePrompt?`、`TurnDeps.basePrompt?/shouldFinish?/toolChoice?` | context.md、agent-loop.md | 可选注入点，缺省行为不变 |
| `ModelRequest.toolChoice?: { name }` | provider-api.md 3 | 可选请求字段；适配器映射或忽略 |
| `HookInput.subagent?` | hooks.md 2 | 可选 stdin 字段 |
| `RuntimeOptions.subagent` | modules.md 3.3 | 可选，缺省启用默认值 |
| 诊断 `subagent.*` | observability.md 2 | 诊断通道新增记录种类 |

**不改**：事件类型集合（无新持久/临时事件）、`ToolResult` 形状、执行管线步序、视图 reducer、锁与日志格式版本。

## 16. 本阶段不做

- **Swarm / 编排**：没有多代理协作、调度器或拓扑概念；
- **角色系统 / 自定义 agent 定义文件**：第 14 节；
- **Agent 间消息总线**：父子间唯一通道是 `task` 输入与 `finish` 结果；
- **分布式执行**：子会话在同一进程内运行；
- **子代理常驻与唤醒**：`finish` 后子会话关闭，不存在再次唤起的入口；
- **隔离工作区**（worktree/overlay）：子代理与父会话共享同一工作区视图；
- **子会话权限冒泡**：见 7.1；
- **并行 task 数组**：一次调用一个子会话；批量并行等并行调度存在后再评估；

- **配置文件 `subagent` 段**：默认值已覆盖本阶段；开关走 `RuntimeOptions.subagent.enabled` 或权限规则 `subagent * → deny`。

ADR-0036 第一轮：子会话沿用父会话的审查器实例与最近用户意图，smart 的剩余 ask 可先经审查放行或拦截；unsure 仍按非交互 deny 处理，不向用户发确认。只由用户确认的集合沿用父策略，审查用量随子会话汇总。见 [permissions.md](permissions.md) 5.3、7。

## 17. 外部 agent（ACP）

[ADR-0049](../decisions/ADR-0049-external-agent-subagent.md) 定义外部委派。`RuntimeOptions.externalAgents` 注入无状态 `ExternalAgentConnector`，由 `@nocturne/acp` 实现、CLI 装配；Core 不依赖 ACP SDK。connector 不维护名称列表，`run(config, request, ctx)` 每次接收 Core 的配置快照。Core 从程序维护层与用户配置合并结果中筛选 `enabled` 条目，重载后在空闲时立即重建 `task`，正在运行的 Turn 暂存到边界再切换；当前 Turn 的工具描述、schema 和每次外部调用配置保持一致。`task.agent` 选择已启用的外部 agent，与 `preset`、`tools`、`outputSchema` 互斥。没有已启用外部 agent 时，工具 schema 与描述不出现此字段；内置子代理禁用但外部启用时仍注册 `task`，此时 `agent` 必填。嵌套子会话的 `task` 不暴露外部 agent。

入口主体为 `subagent external:<name>`，所有交互式预设默认 `ask`。执行期 connector 仅按 [ADR-0049 第 3 节](../decisions/ADR-0049-external-agent-subagent.md#3-权限入口把关加上外部请求进权限层) 映射 ACP 请求，权限层用父策略重建非交互 gate：同一审查器与只读会话 Grant，剩余 `ask` 拒绝，不产生新 Grant。回调返回决定及来源，供审计记录。只选择 `allow_once`；没有该选项也拒绝，永不选择 `allow_always`。不支持客户端文件系统或终端能力。

每次调用新进程，依次 `initialize`、`session/new`（工作区根）、可选 `session/set_mode`、逐项 `session/set_config_option`、`session/prompt`，完成后清理整个进程树；中断先 `session/cancel`，短宽限后清理。`configOptions` 的键和值是不透明字符串；对方拒绝某项时返回 `external_agent_config_rejected` 并指出该 id。需要认证时返回 `external_agent_auth_required`，由用户去相应命令行工具登录。外部调用与内置子代理共用 Runtime 级并发槽，不常驻、不复用会话。

超时统一由 `task` 执行器控制（默认 600_000ms，超时触发 `ctx.signal`）；connector 不另设隐式默认超时。只有 `request.timeoutMs` 显式传入时，connector 才设置对应计时器。

`timeoutMs` 省略时使用默认 10 分钟；工具参数说明要求实现、修改代码、审查、调研类任务都不要设短于默认值的超时，只有确定很快的查询才主动缩短（同一条说明覆盖内置子代理与外部 agent 两条路径）。默认值不变。connector 的计时器或执行器的 TimeoutError 信号导致超时时，失败信息附最近至多 5 条进度标题，并提示「它可能已修改工作区文件，请先检查 git status」。标题去控制字符、压成单行并截断至 300 字符，名称至 100 字符，整条超时说明不超过 2048 字符。

仅带非空 `title` 的 `tool_call` / `tool_call_update` 输出进度，不用 `status` 或 `kind` 兜底；同一调用的相同标题去重。`failed` 单独输出一次「<名称>：<标题>（失败）」，没有新标题时使用该调用先前记录的标题；没有任何标题的失败更新也不输出。原始更新仍完整进入审计日志。

进程退出通过 `PipeProcess.exited()` 提前检测，异常时 `detachOutput()` 关闭本地输出，避免后代继承管道拖住调用。Windows 清树沿 MCP 的 `taskkill /T /F`，覆盖根进程仍存活时的正常关闭与取消；根已崩溃形成的孤儿后代是该机制的限制，见 [ADR 修订](../decisions/ADR-0049-external-agent-subagent.md#修订)。POSIX 清理独立进程组。

外部过程不创建 Nocturne 子会话或事件类型。只转发带配置名称前缀的单行工具进度，不转发回复片段；最终回复作为 `modelContent`，沿现有预算截断与落盘。`output` 为 `{ agent, agentVersion?, transcriptPath, transcriptError?: true, stopReason, permissionDecisions: { allowed, denied } }`，不填 `usage`。原始 `session/update` 与权限判定（主体、结果、来源）逐行写入父附件目录的 `external/<callId>.jsonl`；初始化或追加写入失败只记录一次 `external_agent.transcript_failed` 诊断，设置 `output.transcriptError: true`，停止后续写入，调用与权限判定继续正常进行。此时 `transcriptPath` 可能指向缺失或不完整的审计文件。

**保证边界**：只拦截外部 agent 主动请求的操作，应配置其逐项询问模式；费用与额度计在对方账号上；检查点和回退不追踪外部 agent 改动的文件；外部 agent 看不到 Nocturne 的 `task`，不能嵌套。配置与默认禁用的 omp/Codex 预设见 [config.md](config.md#外部-agent-配置)。

## 18. 管理、探测与用户点名

Runtime 提供 `describeExternalAgents({workspaceRoot?})`、`saveExternalAgent({mode,name,config})`、`deleteExternalAgent({name})`、`setExternalAgentEnabled({name,enabled})`、`probeExternalAgent({name}|{config})`；会话提供异步 `describeExternalAgents()`。查询返回 `{agents,warnings}`，保留停用条目与来源信息；写操作只修改程序维护层并重载，手写条目只读，配置细节见 [config.md](config.md#外部-agent-配置)。

探测可以使用已保存名称或未保存草稿，不依赖启用状态。connector 的 `probe(config,{nocturneHome,timeoutMs?})` 先解析命令（Windows 上不带扩展名的命令只按 PATHEXT 补扩展名，不命中同名无扩展名文件——npm 目录里给 Git Bash 用的 `npx` 脚本不会抢在 `npx.cmd` 之前，命令直接写 `npx` 即可；带扩展名的命令与非 Windows 平台原样查找；找不到报 `external_agent_not_installed`），再 `initialize`、在 `<NOCTURNE_HOME>` 临时目录 `session/new`，读取 agent 信息、认证方式与会话可选配置项，最后关闭进程并移除临时目录；不发送 prompt、不代办登录，探测结果不持久化。

客户端把 `/<agent名> 任务` 提交为 `delegate:{agent,task}`，与 `skill` 互斥。Core 在 Turn 边界校验名称对应已启用 agent（忽略大小写定位、使用配置中的规范名称），附明确的 `task` 工具指令、指定的 `agent` 和未转义改写的任务原文；`message.user.delegate` 与消息内容共同构成快照，历史折叠、在线视图、恢复与回放均读取日志，不根据当前配置重新生成。该指令不会直接调用 connector，也不会自动授权；模型发起的 `task` 仍走入口权限管线。

斜杠优先级为内置命令、技能、外部 agent。命令或技能与 agent 重名时不能斜杠点名，列表显示警告，模型仍可调用。CLI/TUI 的 `/agents` 只读，桌面端管理与探测入口见 [desktop.md](../apps/desktop.md)。

## 19. 子代理档位

[ADR-0058](../decisions/ADR-0058-subagent-profiles.md)：task.profile 缺省 default；可选值为 default、已启用且模型可用的内置档位、已启用外部 agent。只有 default 时不公开 profile 字段且描述保持原状。agent 字段兼容一个版本，按同名 profile 处理；同时指定时报 invalid_input。外部档位仍与 preset/tools/outputSchema 互斥。

声明为 `{description, model?, effort?, tools?, timeoutMs?, enabled}`，由 config 层解析，launcher 使用解析结果；Agent Loop 不认识档位。default 模型即 modelRoles.task，不迁移数据，不能删或停用。其他档位模型留空跟随当前会话；effort 留空继承父会话，再以 clampReasoningEffort 就近降档。实际模型和强度记 session.created，并由 task.output.model / reasoningEffort 供客户端呈现（后者可选，旧输出兼容）。运行中以既有 tool.progress 传递模型和强度。

explore 档位不能请求 general，显式 tools 必须是只读池子集；general 可用 preset/tools 收窄。档位 timeoutMs 是默认值，请求可覆盖且封顶 3600 秒。不存在、停用或模型不可用报 invalid_input 并列出可选档位，不换模型；模型不可用时排除出选择表，并与 `model_role_unavailable` 同一方式提示：写入 `session.warnings`、发 runtime.warning(subagent_profile_unavailable)，同一档位同一模型只提示一次。档位表、default 模型和可用性在设置保存或模型开关后的下一个空闲边界（submit / setModel 开头）随服务商注册表一起重建，当前会话无需重开。枚举外的 profile 在 schema 校验阶段即被拒绝，报错附带可选值。嵌套子会话使用同一内置档位表，但不暴露外部 agent。

选择表由共享 subagentSelectionTable 生成，何时用后追加模型、强度和只读标记；外部标记账号费用。reason 可选，展示前截到 200 字，不参与判断。profile/reason 留在工具参数中，不新增事件字段；权限主体与第 7 节不变，档位只改变工具上限。配置分层、补丁和名称约束见 [config.md](config.md#子代理档位设置)。

## 20. 后台子代理

后台交付与生命周期见 [ADR-0073](../decisions/ADR-0073-background-subagents.md)，可写后台隔离见 [ADR-0075](../decisions/ADR-0075-worktree-isolation.md)。Git 操作集中在 `agent/worktree.ts`；`task.isolation: "worktree"` 与 `background` 同显同隐，只接受后台调用，工作区与预设路径映射到副本，项目配置和信任仍来自父会话。收束时提交结果并附 `changes`；`apply_subagent_changes` 经过 edit 主体权限与检查点。

- **开关**：`RuntimeOptions.subagent.background`（缺省关闭）。TUI、桌面端后台、`nctrn rpc` 开启；`nctrn -p` 与定时任务会话关闭。只有顶层、非定时任务会话的 `task` 才在 schema 与描述里出现 `background`，子会话里没有。
- **准入**：`agent/background-subagents.ts` 的 `backgroundAdmission({ tools, isolation, external })` 是唯一判断：外部 agent 一律拒绝，隔离方式为 `"none"` 时只放行全部 `traits.mutates === false` 的工具集（`explore`、只读档位、只读 `tools` 白名单）。launcher 在建子会话之前调用它，外部 agent 由 `task` 的 `validateInput` 经注入的同一函数拒绝。
- **启动**：子会话建好即返回 `output: { childSessionId, childLogPath, model, background: true }`，不发 `tool.progress`。子 Turn 的中止信号不含父 Turn 的 signal；超时沿用 `timeoutMs`。占用 `maxConcurrent` 槽直到收束；另有每父会话 `maxBackground`（缺省 3）。
- **交付与生命周期**：`BackgroundSubagents` 集中收束、取消（`Runtime.cancelSubagent`）、丢弃（父会话关闭、回退到启动调用之前）与重启补报（按父日志补 `interrupted` 暂停条目，分叉继承的前缀不补）。结果以 `message.user.subagent` 交付，作为 `mode: "subagent"` 的待发输入（[agent-loop.md](agent-loop.md) §2、[view.md](../protocols/view.md)）。
- **观察**：`listSubagents` 的 `SubagentSummary.background` 标出后台项；运行状态以登记簿为准，父 `task` 已结算不代表子代理结束。


