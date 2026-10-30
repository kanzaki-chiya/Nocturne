# ADR-0073：后台子代理

- 状态：已接受
- 日期：2026-10-30
- 修订：[ADR-0013](ADR-0013-subagent.md)（取消「不做后台子任务」）、[ADR-0070](ADR-0070-steer-and-queue-input.md)（待发输入增加子代理结果）、[subagent.md](../architecture/subagent.md)、[agent-loop.md](../architecture/agent-loop.md)、[events.md](../protocols/events.md)、[rpc.md](../protocols/rpc.md)

## 背景

`task` 是同步工具：父 Turn 等子会话收束才拿到一个 `tool.completed`，执行管线又是串行的（[agent-loop.md](../architecture/agent-loop.md) 3.2）。子代理现在的用处只有三个：探索过程不进主上下文、可以换模型或档位、可以收窄工具。它不省时间，用户在子代理跑完之前也只能等。

想要的用法是「让一个子代理去查 A、另一个去查 B，主代理接着跟用户讨论 C，查完了自己回来汇报」。[subagent.md](../architecture/subagent.md) 第 16 节把后台子任务列为不做，理由是没有工作区隔离时并发写文件会冲突，以及结果交付和生命周期没想清楚。本 ADR 给出这两件事的答案：第一版只放行只读子代理，结果作为待发输入交给主会话。

参照：Claude Code 的后台 Agent 与 `run_in_background`：启动后立即返回，完成时主会话收到通知并被唤起新的一轮，模型不需要轮询。

## 决定

### 1. 启动：`task.background`

- `task` 输入增加可选 `background: boolean`，缺省 `false`，同步行为完全不变。
- `background: true` 时，权限求值、limiter 占位、子会话创建与同步调用相同；子会话创建成功后 `task` **立即返回** `status: "ok"`，`output` 为 `{ childSessionId, childLogPath, model, background: true }`，`modelContent` 一行英文：

```text
Background subagent started (id: <childSessionId>). Its result will arrive as a separate message when it finishes. Do not wait or poll; continue with other work or end your turn.
```

- 父日志里这次调用照常是一个 `tool.started` → `tool.completed`，结果交付另走第 3 节，不改写已完成的工具结果。
- 后台调用不发 `tool.progress`（工具已结算）；进度由第 6 节的观察入口提供。

### 2. 第一版只放行只读子代理

- 只有只读的组合可以后台：`preset: "explore"`、只读档位（[ADR-0058](ADR-0058-subagent-profiles.md) 的只读标记）、或 `tools` 白名单里的工具全部 `traits.mutates === false`。其他组合带 `background: true` 报 `invalid_input`，说明「后台子代理只能只读；需要写入请同步调用」。
- 外部 agent 档位（ACP）不能后台：它们会改文件且不受检查点追踪（subagent.md 第 17 节）。
- 理由：主代理在前台继续改文件时，后台写入会与之冲突，检查点和回退也无法区分两边的改动。可写的后台子代理等工作区隔离（worktree）另立 ADR。
- 只读的判断与 `explore` 预设相同（subagent.md 第 6 节），`shell`、`write`、`edit`、`task` 都不在内。

### 3. 交付：子代理结果是一种待发输入

子代理收束时（`finish`、失败、超时、取消，结算规则同同步调用，subagent.md 第 4 节），Runtime 把结果作为**待发输入**加入父会话，复用 [ADR-0070](ADR-0070-steer-and-queue-input.md) 的消费路径：

- **父会话正在运行 Turn**：按插话处理，在下一个安全点写入，模型在当前 Turn 里就能看到。
- **父会话空闲**：立即开启新 Turn（与空闲时提交待发输入相同），主代理被唤起、处理结果。这一轮是普通 Turn：交互式、权限照常，用户可以随时中断。
- **待发输入处于暂停**（上一轮非 `done` 结束）：结果追加为暂停条目，不自动唤起；用户「继续发送」或提交新消息时一起送达。
- 多个子代理同时收束时按收束顺序排列，同一安全点一次取出。

写入的事件是 `message.user`，新增可选字段：

```ts
subagent?: {
  childSessionId: string
  callId: string          // 启动它的那次 task 调用
  status: "ok" | "error" | "timeout" | "cancelled" | "interrupted"
  code?: string           // error 时的错误码，同同步调用
}
```

- `content` 是给模型的文本：一行英文头 `<subagent-result id="…" call="…" status="…">`，接结果正文（`modelContent` 同等内容，超预算走同样的截断落盘），以 `</subagent-result>` 结束。失败、超时附已有产出清单（同同步调用的 `partialOutputOf`）。
- 兼容扩展：旧版本按普通用户消息处理，模型照样看得懂，不提升 `formatVersion`（events.md 第 8 节）。
- 这条消息不触发 `UserPromptSubmit` Hook（不是用户输入）；它开启的 Turn 照常触发 `TurnStart`。
- 待发条目在 `input.pending` 快照里以 `mode: "subagent"` 出现，可以撤回（等于丢弃结果），不能编辑。

### 4. 生命周期：不跟父 Turn 走，跟父会话走

- 后台子 Turn 的中止信号是 `AbortSignal.any([后台取消, 超时计时器, 父会话关闭, 父/子会话 failedSignal])`，**不含父 Turn 的 signal**：用户中断主对话（Esc）不取消后台子代理。
- 超时沿用 `timeoutMs`（默认 600 秒，上限 3600 秒）。
- **取消**：新增 `Runtime.cancelSubagent({ parentSessionId, childSessionId })` 与同名 RPC；只对运行中的后台子代理有效，否则 `invalid_command`。取消后照常交付 `status: "cancelled"` 的结果（附已有产出）。模型侧第一版不提供取消工具。
- **父会话关闭、删除或 Runtime 退出**：取消所有后台子代理，等子日志写下收束后再释放；结果不交付（父会话已不在运行）。
- **重启**：不复活子代理（与现状相同）。父会话加载时，对「启动过后台子代理、日志里却没有对应 `subagent` 消息」的调用，各补一条 `status: "interrupted"` 的暂停待发条目，随用户下一次提交送达，不自动唤起。判断依据是父日志里的 `task` 结果 `output.background` 与 `message.user.subagent.callId`，不读子日志。待发输入不落盘：尚未送达或已撤回的结果，重启后同样补报为 `interrupted`。
- **回退**：回退到启动调用之前时，取消该子代理且不交付；已交付的结果随回退移除，与其他消息一致。分叉出的新会话不继承运行中的后台子代理。
- **嵌套**：子会话里 `background` 不可用（字段不出现在子会话的 `task` 描述里）。子会话结束时它不能留下孤儿。

### 5. 并发与开关

- 后台子代理占用同一个 Runtime 级 `maxConcurrent` 槽（默认 4），占到收束为止。槽满时后台与同步调用都立即 `subagent_concurrency`。
- 另设每个父会话至多 `maxBackground`（默认 3）个运行中的后台子代理，超出报 `subagent_concurrency`，给同步调用留余地。
- `RuntimeOptions.subagent.background: boolean`，由宿主决定是否开启：TUI、桌面端后台、`nctrn rpc` 开启；`nctrn -p` 与定时任务（非交互会话，[ADR-0064](ADR-0064-scheduled-tasks.md)）关闭——它们在 Turn 结束后就退出或不再有人接收。关闭时 `task` 的 schema 和描述里不出现 `background`。

### 6. 界面

- **桌面端**：子代理概览（subagent.md 12.1）里运行中的后台子代理带「后台」标记与取消按钮，可在面板里观察；收束后的结果消息在对话里显示为可折叠卡片（档位、状态、耗时），点击打开子会话面板，不显示 `<subagent-result>` 原文。
- **TUI**：状态栏显示运行中的后台子代理数；结果消息显示为一行 `子代理结果 · explore · 完成`，展开看正文。新增 `/subagents` 列出本会话运行中的后台子代理，可选中取消（`/agents` 管外部 agent，不混用）。
- 待发区的子代理条目显示为「子代理结果 · 等待送达」，可撤回。

### 7. 权限与上下文不变

- 权限主体仍是 `subagent <preset>`，启动时求值；子会话非交互、只读共享会话 Grant，与同步调用相同。
- Builder 不改：结果就是一条用户消息。父模型的系统提示里 `task` 描述补一句后台用法（适合独立、只读、耗时的调研；不要为了等结果而轮询）。

### 8. 与后续工作树隔离的衔接

可写的后台子代理由后续 ADR 引入工作树隔离。本 ADR 的实现预留以下接缝，届时只在接缝上扩展，不改动第 1、3–7 节：

- 第 2 节的只读限制实现为一个独立的准入判断（输入：子代理的工具集与隔离方式），不散落在 `task` 执行路径里。后续 ADR 只给它加一条「隔离方式为工作树时放行可写组合」。
- 子代理结果消息（第 3 节）的结算结构预留可选的改动摘要位置，本 ADR 不填写；后续 ADR 用它带回工作树里的改动以及并回方式。
- 生命周期（第 4 节）的收束、取消与重启处理集中在一处，后续 ADR 在这里追加工作树的清理与保留规则。

## 后果

- 主代理可以同时派出几个只读调研，继续和用户讨论，结果回来时自动接着处理；子代理开始省时间，而不只是省上下文。
- 空闲唤起意味着用户不在场时也会开新 Turn、产生费用；但只在用户自己触发的后台任务收束时发生一次，且这一轮可以被中断。
- 结果作为用户消息进入上下文，前缀稳定，缓存不受影响；比改写已完成的工具结果简单，也不需要新事件类型。
- 写入型后台子代理仍做不到，要等工作区隔离。
- 旧版本打开含后台结果的会话：结果显示为普通用户消息，内容完整。

## 备选方案

- **结果写回原工具调用**（让 `tool.completed` 晚到）：父 Turn 必须等它才能结束，等于同步；或者允许 Turn 在工具未结算时结束，破坏「每个调用恰好一个 `tool.completed`」的不变量。不采用。
- **模型主动取结果**（`task_wait` / `task_status` 工具）：模型要轮询，浪费步数；空闲时也没人来取。可以以后作为补充，第一版不做。
- **新事件类型 `subagent.result`**：Builder 要新增分支，旧版本不认识会丢内容。用 `message.user` 的可选字段已经够用。
- **第一版就放行写入型**：与主代理同时改文件会冲突，检查点也分不清；先做只读。
- **只做同一 Step 内多个只读工具并行**（agent-loop.md 3.2 已规划）：能省一点时间，但主代理仍要等，解决不了「边查边聊」。它是独立的小改动，可以另做，不在本 ADR 范围。

修订（2026-10-30）：澄清第 4 节重启补报的范围与待发结果未持久化的已知限制。

修订（2026-10-31）：[ADR-0075](ADR-0075-worktree-isolation.md) 扩展工作树隔离、可写后台准入、改动交付与保留清理。
