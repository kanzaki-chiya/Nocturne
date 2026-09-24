# Subagent（子代理会话）

> 状态：提议 v0.1（Phase 6 设计）｜ 前置阅读：[tools.md](tools.md)、[sessions.md](sessions.md)、[permissions.md](permissions.md)、[agent-loop.md](agent-loop.md)、[mcp.md](mcp.md)、[hooks.md](hooks.md) ｜ 决策：[ADR-0013](../decisions/ADR-0013-subagent.md)

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
| `timeoutMs` | `integer` | 本次调用的超时上限，封顶 `traits.maxTimeoutMs` |

`traits`：`{ mutates: true, concurrencySafe: false, timeoutMs: 600_000, maxTimeoutMs: 3_600_000, maxModelChars: 30_000 }`。`mutates: true` 如实声明（`general` 子代理可能写文件）；`concurrencySafe: false` 因为并行子代理在没有工作区隔离的前提下可能同时改同一批文件（隔离明确不做，见第 16 节）。

`permissionSubjects` 返回 `[{ kind: "subagent", target }]`：`target` 为预设名（`general`/`explore`）或 `"custom"`（`tools` 白名单）。新增的 `subagent` 主体类别让用户能在规则层把"派生子代理"本身当作受控动作（如 `subagent * → deny` 即为本特性的用户级开关），各预设的默认值见 [permissions.md](permissions.md) 第 6 节。

**ToolResult**：

- `status: "ok"`：`modelContent` 为子代理 `finish` 提交的结果文本（`outputSchema` 时为序列化 JSON）；`output` 携带 `{ childSessionId, childLogPath, turns, steps, usage, structured? }`。`modelContent` 超预算走既有截断+落盘路径（[tools.md](tools.md) 第 4 节，`spillPath` 在父会话附件目录）；完整过程永远在子会话日志里，`childLogPath` 随结果告知。
- `status: "error"` 的错误码：

| code | 含义 |
|---|---|
| `subagent_turn_failed` | 子会话 Turn 以 `error`/`max_steps`/`truncated`/`refused` 结束（message 带 reason 与 error 摘要） |
| `subagent_no_result` | 催促与强制轮次用尽仍未收到 `finish`；`modelContent` 附子会话最后文本尾部供父模型利用 |
| `subagent_concurrency` | 运行级并发上限已满（第 11 节），提示稍后重试 |
| `invalid_input` | `outputSchema` 无法编译、`tools` 含未知名、`preset` 与 `tools` 同给 |
| `subagent_unavailable` | 运行时未启用本特性（正常装配下工具不注册，此为防御分支） |

`cancelled`/`timeout` 由执行器统一结算（中断与超时信号语义不变）；`permission_denied`/`hook_denied` 由父侧权限管线产生——`task` 调用本身与其他工具一样先过主体声明与权限求值。

## 2. 结束协议（`finish` 工具与催促）

子会话必须显式提交结果，不能靠"输出停了"判定完成：

- `finish` 是**只在子会话注册表中出现**的工具（不进父会话注册表）。输入 `{ result }`：`outputSchema` 缺省时 `result` 为字符串；给出 `outputSchema` 时 `finish` 的 `inputSchema` 为 `{ properties: { result: <outputSchema> }, required: ["result"] }`——**结构化校验复用管线第 2 步的既有 schema 校验**，不符时子模型收到 `invalid_input` 并可修正重试，不需要新机制。
- `finish` 的 `permissionSubjects` 返回 `[]`（自动放行——它只是返回通道，不触碰任何资源）；`traits.mutates = false`。
- 终止判定：`TurnDeps` 新增可选 `shouldFinish(state)` 谓词，Agent Loop 在每个工具调用结算后检查；launcher 提供的实现是"子会话历史中已存在 `name = finish` 且 `status = ok` 的 `tool.completed`"。命中即 `finish("done")`——子 Turn 以正常 `done` 收尾，不是中断。谓词由 launcher 注入，Agent Loop 本身仍不出现工具名。
- **催促与兜底**：一个子 Turn 以 `done` 结束但没有 `finish` 调用时，launcher 在同一子会话上再开一个 Turn，message.user 为催促提示（如 `你还没有提交结果；请立即调用 finish 工具提交 {result}`）。上限 `maxAttempts`（默认 3：首轮 + 2 次催促）；**最后一轮**通过 `ModelRequest` 新增的可选字段 `toolChoice: { name: "finish" }` 强制模型调用结束工具（provider-api.md 第 3 节；适配器映射到服务方的 tool_choice，不支持则忽略）。全部轮次用尽仍无 `finish` → `subagent_no_result`。
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

**递归结构**：launcher 在创建子会话的注册表时，若 `depth + 1 ≤ maxDepth`，以同一 deps 构造 depth+1 的 launcher 并注册子级 `task`——嵌套派生是同一条路径的自然递归，不是第二套机制。

**`RuntimeOptions.subagent`**（缺省即启用默认值）：

```ts
subagent?: {
  enabled?: boolean          // 默认 true；false 时 task 不注册（模型不可见）
  maxDepth?: number          // 允许的最大会话深度，默认 1（子代理默认不能再派生）
  maxConcurrent?: number     // Runtime 级并存子会话上限，默认 4（第 11 节）
  maxStepsPerTurn?: number   // 子会话单 Turn 步数上限，默认 50
  maxAttempts?: number       // 缺 finish 时的总轮次上限（首轮 + 催促），默认 3
  timeoutMs?: number         // task 默认超时，默认 600_000（上限 3_600_000）
}
```

配置文件不新增 `subagent` 段（第 16 节）；用户级开关是权限规则 `subagent * → deny`， embedder 用 `RuntimeOptions.subagent.enabled`。

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

**中断传播**：子 Turn 的 signal 是 `AbortSignal.any([ctx.signal, 父会话 failedSignal, 子会话 failedSignal])`——父会话中断/工具超时/任一侧持久化失败都会取消子会话。launcher 等到子 Turn 实际收束（子日志写下 `turn.completed(reason="aborted")`）后才返回，保证子日志自洽；父侧这次 `task` 调用随后由执行器按 `cancelled`/`timeout` 结算。

**恰好一个 `tool.completed`**：`launch` 只被 `task.execute` 调用一次、只返回一次；无论子会话内部经历了多少轮/多少工具，父日志中这次调用的事件序列与普通工具完全一致（`tool.started` → `tool.completed`；期间的子会话进度以 `tool.progress` 临时事件呈现，见第 12 节）。子会话的所有事实都写在子日志里，父日志不记录子会话内部事件。

**出错、超时、超步数**：子 Turn 的 `turn.completed` reason 映射为结果——`done` 且有 `finish` → `ok`；`done` 无 `finish` → 进入催促；`error`/`max_steps`/`truncated`/`refused` → `subagent_turn_failed`；信号中止 → 执行器结算 `cancelled`/`timeout`（不占用 `subagent_*` 错误码）。子会话创建失败、`close` 抛错等内部异常 → `tool_failed`（执行器既有兜底）。

## 5. 会话与持久化

- **日志**：`<NOCTURNE_HOME>/sessions/<childSessionId>.jsonl` + `.lock`，与顶层会话同目录、同格式、同锁语义（ADR-0009）。子会话的落盘附件在 `attachments/<childSessionId>/` 下——`presetContext.sessionId` 传子会话 id，预设规则自动放行它自己的附件目录。
- **父子关联**：`session.created` 增加可选字段 `parent?: { sessionId: string; callId: string }`（兼容新增，旧版本忽略）。`callId` 是父会话中那次 `task` 调用的标识——由此可从子日志找到父会话与触发它的那格调用。
- **列表可见性**：`SessionSummary` 增加 `parent` 字段；`SessionStore.list`/`listSessions` 增加 `includeSubagents?: boolean`，**默认 false**——`--sessions`、`/resume`、`-c/--continue` 都只面向顶层会话，子会话是运行痕迹而非可交互会话（避免 `-c` 误恢复一条子日志）。按 id 显式 `resumeSession(childId)` 仍然可行：它只是打开一条普通日志，供排查与只读回放。
- **恢复**：
  - 父会话被杀/中断时子代理在跑：父侧按既有修复把未结算的 `task` 调用补 `tool.completed(interrupted)` + `turn.completed(process_exited, recovered)`；
  - 子日志到 kill 点为止的内容是完整的已提交前缀（每条日志独立）；未收束的 Turn 与调用**在下一次打开该子日志时**按第 6 节惰性修复——与任何崩溃会话一致，父侧恢复不主动触碰子日志（打开、取锁、修复是子日志自己的生命周期动作）。
  - 正常中断（非强杀）时子 Turn 先收束再返回，子日志以 `turn.completed(aborted)` 闭合，不需要修复。

## 6. 受限工具集与递归

**可选池** = 内置工具 ∪ 父会话 MCP 工具（`mcpSession.tools()` 快照）∪ `task`（仅 `depth + 1 ≤ maxDepth` 时）。子注册表 = 池 ∩ 选择 + `finish`（恒在，不可被 `tools` 列出也不可被排除）。

| 选择方式 | 语义 |
|---|---|
| `preset: "general"`（默认） | 可选池全部 |
| `preset: "explore"` | 只读探索：`traits.mutates === false` 的工具（read/grep/glob 与 `readOnlyHint` 的 MCP 工具自动在内；write/edit/shell/task 自动排除）。按特性筛选而非按名字列表（pitfalls #3） |
| `tools: [...]` | 显式白名单 ∩ 可选池；未知名 → `invalid_input` 并列出可用名（自愈路径与 `unknown_tool` 一致）；`finish` 不接受列出 |
| `preset` + `tools` 同给 | `invalid_input` |

工具名空间不变（子会话里仍是 `read`、`mcp__x__y`）；模型在子会话中调用池外/不存在工具 → `unknown_tool` 正常结算。

**递归上限**：`maxDepth`（默认 1）是会话深度上限——`depth` 为祖先进会话数（顶层 0）。`depth == maxDepth` 的会话注册表里没有 `task`，模型硬调会得到 `unknown_tool`；这靠**不注册**实现，不靠运行时分支。

## 7. 权限模型

硬约束：**子会话的有效权限不得宽于父会话；权限判定仍只发生在权限层。**

### 7.1 方案比较

| 方案 | 子会话 ask 的处理 | 能力 | 成本 |
|---|---|---|---|
| (a) 冒泡到父会话客户端 | 转发为父会话的确认请求 | 完整（子代理可以获批写/执行） | 需要跨会话的请求路由（`respondPermission` 按会话路由，子请求要注册进父 gate 的 pending map）、父日志出现外来 `callId` 的 `permission.requested`（或新事件类型 + reducer 扩展）、双向中断传播——一组新的持久语义与失败模式 |
| (b) 非交互子会话 | `ask` 一律 `deny`（`source: "non_interactive"` 既有路径） | 收窄：父会话里需要人确认的操作，子会话做不了 | **零新机制**：`createPolicyGate(..., { interactive: false })` 是现成路径；全部权限事实留在子日志 |
| (c) 按工具集预设 | 不是 ask 的处理方式，是正交能力裁剪：`explore` 预设的调用在任何规则下都只求值为 allow，天然不产生 ask | 只读场景完整 | 与 (a)/(b) 都兼容 |

**结论：本阶段采用 (b) + (c)**。理由：(b) 是现有语义的直接复用且安全保证可证明；(c) 的预设让"天然不需要确认"的只读子代理不受影响；`--yes`、规则、`PermissionRequest` Hook 与项目 Grant 覆盖了无人值守场景下的大部分放行需求；交互式 `default` 预设下子代理做不了的写/执行操作，子代理在结果里说明需求、父代理自己执行即可——比"批准 task 调用即授权整个子任务"（oh-my-pi 的 yolo 做法，明确不采用）更符合逐项把关的权限哲学。(a) 留作以后扩展：在 `PermissionGate` 增加可选的 `forwardAsk` 委托即可接入，不推翻本设计。

### 7.2 子会话的有效策略

子会话的 `PermissionPolicy` 由 `makePolicy(childSessionId)` 用**与父会话相同的输入**重建：

- 同一 `workspaceRoot`、同一预设名、同一批已合并的可信规则与不可信收紧规则（含受保护路径、高风险命令）；
- 同一 `project` Grant 集合（工作区级，本就按目录归属）；
- **会话 Grant 共享**：父会话的 `sessionGrants` 数组以只读方式传给子策略——"本会话内允许"的语义扩展为**会话树内允许**（子会话是这次会话工作的委派部分）。子会话的非交互 gate 没有 `respond` 路径，永远写不进新授权；
- 同一 `autoApproveAsk`：`--yes` 是运行级操作者决定，子会话继承它（提升范围与父会话逐点一致，不覆盖 deny、不绕过 Hook 强制的 ask）；
- `presetContext.sessionId` 换为**子会话** id（附件目录规则绑定自己的落盘目录）。

子会话 gate：`createPolicyGate(childPolicy, { interactive: false, hooks: childHookRunner, caseSensitive })`。

**不宽于父会话的论证**：对每个主体，子会话的求值输入（规则、Grant、autoApproveAsk、Hook 建议）与父会话完全相同，唯一差异是 ask 分支——父会话等人回答，子会话直接 `deny(source: "non_interactive")`。因此子会话的任何 `allow` 都是父会话同一求值下也会得到的 `allow`；差异方向只有"更严"。

### 7.3 各机制在子会话中的行为

| 机制 | 子会话行为 |
|---|---|
| 规则 deny（含不可信项目收紧、受保护路径） | 照常 deny——没有任何子会话机制能越过 |
| 规则 ask | `non_interactive` deny（不发 `permission.requested`） |
| 会话 Grant | 继承父会话的授权集（只读共享），精确匹配照常 `allow(source:"grant")` |
| 项目 Grant | 同一 workspaceRoot，照常生效 |
| `--yes` / `autoApproveAsk` | 继承：规则判定的 ask 提升为 allow；**仍不覆盖 deny，也不提升 Hook 强制的 ask** |
| `PreToolUse` Hook | 照常触发（deny/ask/updatedInput 语义不变）；强制的 ask 在子会话走"PermissionRequest Hook → 无回答则 non_interactive deny" |
| `PermissionRequest` Hook | 照常触发：可信 Hook 的 `allow`/`deny` 直接结算——这是团队自动化的既有委托点，也是子会话内 ask 唯一可能的放行来源 |
| `PostToolUse` Hook | 照常触发（feedback 追加进子会话的工具结果） |
| `task` 调用本身 | 在**父会话**走正常权限管线：`subagent <preset|custom>` 主体，默认预设下 `ask`（启动子代理由用户把关）；`deny_stop` 等选项语义不变 |

## 8. 上下文

- **不继承父会话历史**：子会话的 `message.user` 就是 `task` 文本；父会话的对话、工具结果、压缩记录一律不进入子上下文。
- **系统提示**：`BuildContextInput` 新增可选 `basePrompt`（缺省即现有 `BASE_SYSTEM_PROMPT`），子会话传入子代理提示：身份（父代理派生的任务会话）、`finish` 提交协议（含 `outputSchema` 要求）、不能向用户提问的约束、其余工作约定。工具规格、项目指令、环境信息段的组装不变。
- **继承**：项目指令（用户级与各级 `AGENTS.md`——它们是项目事实）、环境信息、同一 `ResolvedModel`（模型清单与 Provider 由会话级注册表解析，子会话不另建）。
- **预算与压缩**：同一模型同一窗口，子会话独立计算；L1/L2 压缩机制照常（它就是一次普通 Turn）。子会话通常短命，压缩很少触发，但机制不需要例外。
- **token 成本**：子会话的用量记在子日志的 `turn.completed.usage`，并随 `task` 结果的 `output.usage` 汇总给父侧。

## 9. 与 Turn / Agent Loop 的关系

`runTurn` 的改动仅限两个注入点，都不含工具名/角色分支：

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

**不新增事件类型。** `task` 在父会话就是一格普通工具条目（`tool.started`/`tool.completed`）；运行期间 launcher 订阅子会话事件并把**一行式摘要**经 `ctx.progress` 转发为父会话的 `tool.progress(stream:"info")`：子 Turn 开始/结束、每个子工具调用的 `<name> → <status>` 结算行、最终结果摘要。CLI 按既有 `tool.progress` 渲染（缩进整行）；TUI 走 `liveOutput` 尾部展示；reducer 不需要任何扩展（view.md）。

**为什么不流式转发子会话内部内容**：子代理的文本与工具明细全量复制到父时间线会淹没父会话视图，且这些信息已经完整、可审计地写在子日志里（`output.childLogPath` 指路）。一行一结算的进度在"知道它在干活"与"不打扰"之间取平衡；要看全程，打开子日志。

`--sessions` 与 `/resume` 默认不列出子会话（第 5 节）；子代理调用本身在父会话的权限确认提示中显示为 `subagent <preset>` 主体，文案与其他主体一致。

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
- **后台/异步子任务**：`task` 是同步工具调用，父 Turn 等待结果；没有"提交后返回句柄"的形态；
- **子代理常驻与唤醒**：`finish` 后子会话关闭，不存在再次唤起的入口；
- **隔离工作区**（worktree/overlay）：子代理与父会话共享同一工作区视图；
- **子会话权限冒泡**：见 7.1；
- **并行 task 数组**：一次调用一个子会话；批量并行等并行调度存在后再评估；
- **子代理独立模型选择**：子会话继承父会话模型；
- **配置文件 `subagent` 段**：默认值已覆盖本阶段；开关走 `RuntimeOptions.subagent.enabled` 或权限规则 `subagent * → deny`。
