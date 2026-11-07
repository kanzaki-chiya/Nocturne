# ADR-0083：后台命令

- 状态：已接受
- 日期：2026-11-07
- 修订：[tools.md](../architecture/tools.md)（shell 一节与「暂不做」列表）、[agent-loop.md](../architecture/agent-loop.md)、[events.md](../protocols/events.md)、[view.md](../protocols/view.md)、[rpc.md](../protocols/rpc.md)、[desktop.md](../apps/desktop.md)、[tui.md](../apps/tui.md)、[roadmap.md](../roadmap/roadmap.md)（「之后」里的后台任务）

- 修订：2026-11-08：RPC 观察者按偏移读取、运行中节流推送 `shell.task_updated`；客户端需要首读全量和增量追加，不能共用模型游标。

## 背景

`shell` 是同步的：模型调用后一直等到命令结束，默认 2 分钟、上限 30 分钟（`shell.ts:36-37`）。这带来三类问题：

- 跑全量检查、构建、长测试时，模型只能干等，用户也不能和它讨论别的。
- 开发服务器、监听编译这类不会退出的命令没法正常用。模型只能自己写 `start`、`nohup` 让它脱离，Nocturne 读不到之后的输出，命令什么时候崩了也不知道（tools.md「孤儿进程遗留」）。
- 想「过 10 分钟再看一眼」没有办法。

[tools.md](../architecture/tools.md) 把「后台运行的 shell」列为暂不做，roadmap「之后」里有「后台任务」，要求先写设计。后台子代理（[ADR-0073](ADR-0073-background-subagents.md)）已经解决了结果怎么交回、空闲时怎么唤起、生命周期跟谁走，后台命令沿用同一套。

参照：Claude Code 的 `run_in_background` 与 `BashOutput` / `KillShell`；Codex、Antigravity 的后台任务列表。

## 决定

### 1. 启动：`shell.background`

- `shell` 输入增加可选 `background: boolean`，缺省 `false`，同步行为完全不变。
- 同时增加可选 `name: string`：后台任务的短名（如「全量检查」「10 分钟计时」），用于列表和结果卡片；省略时取命令首行。只在 `background: true` 时出现在描述里。
- `background: true` 时，校验、权限求值与同步调用相同（主体仍是命令文本），进程启动成功后 `shell` **立即返回** `status: "ok"`，`output` 为 `{ taskId, logPath, background: true }`，`modelContent` 一行英文：

```
Background command started (id: <taskId>). Its exit status and last output will arrive as a separate message when it ends. Use shell_output to read output so far; do not poll in a loop.
```

- 后台命令不设默认超时，只在模型显式给了 `timeoutMs` 时计时，到时终止进程树并按结束交付（第 3 节）。长跑和常驻正是这个功能的用途，与目标模式、子代理取消固定上限的做法一致（ADR-0076、ADR-0013 的 2026-11-02 修订）。
- 不另设每会话数量上限。防失控靠第 6 节的列表和停止按钮，以及会话关闭时全部结束。

### 2. 输出：落盘，按需读取

- stdout、stderr 按到达顺序合并，按 shell 现有的解码规则（tools.md「输出解码」）解码后追加写入 `<会话数据目录>/<sessionId>.tasks/<taskId>.log`。`tool.progress` 不再上报（工具已结算）。
- 日志不截断、不轮转；会话删除时一起删除。
- 新增只读工具 `shell_output({ id?, since? })`：
  - 带 `id`：返回该任务的状态（运行中 / 已结束及退出码）、已运行时长，以及上次读取之后的新输出；`since: "start"` 从头读。超过 `maxModelChars` 时按 shell 现有规则截断，并给出日志路径供 `read`/`grep`。
  - 不带 `id`：列出本会话所有后台命令（id、命令首行、状态、时长）。
  - 不声明 `mutates`，不产生权限主体。
- 新增工具 `shell_kill({ id })`：终止该任务的进程树，按结束交付（`status: "killed"`）。只能停本会话自己启动的任务，不产生权限主体；声明 `mutates`（未追踪调用计数照 shell）。

### 3. 交付：结束时作为待发输入

命令结束（自己退出、超时、被 `shell_kill` 或用户停止）时，Runtime 把结果作为待发输入加入会话，消费路径与 [ADR-0073 §3](ADR-0073-background-subagents.md#3-交付子代理结果是一种待发输入) 完全相同：运行中按插话在安全点送达，空闲时开启新 Turn，暂停时追加为暂停条目。

写入的事件是 `message.user`，新增可选字段：

```ts
backgroundShell?: {
  taskId: string
  callId: string          // 启动它的那次 shell 调用
  status: "exited" | "timeout" | "killed" | "interrupted"
  exitCode?: number
  signal?: string
}
```

- `content`：一行英文头 `<shell-result id="…" status="…" exit="…">`，接最后一段输出（尚未经 `shell_output` 读过的部分，超预算从头部截掉并附日志路径），以 `</shell-result>` 结束。
- 兼容扩展：旧版本按普通用户消息显示，不提升 `formatVersion`。
- 不触发 `UserPromptSubmit` Hook；它开启的 Turn 照常触发 `TurnStart`。
- 待发条目在 `input.pending` 里以 `mode: "shell"` 出现，可以撤回（等于丢弃这条结果，任务本身已结束），不能编辑。
- 用途示例：「10 分钟后再看」就是后台跑 `sleep 600`（PowerShell 用 `Start-Sleep 600`），结束时唤起模型。工具描述里写这一用法。

### 4. 生命周期：不跟 Turn 走，跟会话走

- 用户中断 Turn（Esc、停止按钮、`Ctrl+Alt+Esc`）**不**停后台命令。
- **会话关闭、删除、Runtime 退出**：终止该会话所有后台命令的进程树，结果不交付。桌面端关窗口等同 Runtime 退出。
- **重启**：不复活。会话加载时，对「启动过后台命令、日志里却没有对应 `backgroundShell` 消息」的调用，各补一条 `status: "interrupted"` 的暂停待发条目，随用户下一次提交送达，不自动唤起。依据是会话日志里 `shell` 结果的 `output.background` 与 `message.user.backgroundShell.callId`。
- **回退**到启动调用之前：终止该任务，不交付；已交付的结果随回退移除。**分叉**不继承运行中的任务。
- **子会话**：子代理里 `background` 不可用（字段不出现在子会话的 `shell` 描述里），避免子会话结束留下孤儿。
- 进程树终止沿用 `ProcessRunner.kill()`，已知遗留（脱离进程树的孙进程）同 tools.md「孤儿进程遗留」。

### 5. 宿主开关

- `RuntimeOptions.shell.background: boolean`，由宿主决定：TUI、桌面端后台、`nctrn rpc` 开启；`nctrn -p` 与定时任务关闭（Turn 结束后没人接收）。关闭时 `shell` 的 schema 和描述里不出现 `background`，`shell_output` / `shell_kill` 不注册。
- 目标模式（[ADR-0076](ADR-0076-work-modes.md)）：后台命令运行中**不**阻止目标续跑（开发服务器永远不会结束）；只有后台子代理阻止，规则不变。

### 6. 界面

不新增说明文字；名称只用「后台任务」。

- **工具行**：后台启动的 `shell` 行状态位显示「后台」，结束后变为退出码；点击展开显示命令和到目前为止的输出（读日志尾部，实时追加）。
- **结果消息**：`backgroundShell` 消息在对话里显示为一行可折叠卡片：命令首行、状态、退出码、时长；展开看输出尾部。不显示 `<shell-result>` 原文。
- **桌面端**：会话概览浮层（右上角，desktop.md「会话概览」）在有后台任务时增加「后台任务」分组，位置在「子代理」之后。每行只有三样：终端图标、任务名、已运行时长（结束后定格为总时长，图标和名字转淡色）。运行中在前；已结束的任务在结束 5 分钟后从列表移除（结果消息仍在对话里）。运行中的行悬停或获得焦点时，时长换成「停止」按钮。点一行在面板里打开输出标签：只读、实时追加、可复制，标签头也有停止按钮。输出标签和工具行各持有独立观察者偏移，首读尾部、收到任务更新后请求增量，不通过轮询更新时间；仅显示时读取。输出在底部才跟随追加，用户上滚时保持位置；断线保留已读内容，切换任务后旧响应无效。
- **手机网页**：概览里同样的分组，点开看输出、可停止。
- **TUI**：状态栏显示运行中任务数；新增 `/tasks` 列出本会话后台任务，选中可看输出尾部或停止。
- 待发区的条目显示为「后台任务 · 等待送达」，可撤回。
- 新增 RPC：`shell.tasks({ sessionId })`、`shell.output({ sessionId, taskId, offset?: number }) → { task, text, start, end, durationMs }`、`shell.kill({ sessionId, taskId })`。观察者按独立字符偏移读末尾最多 200000 字符，不共用模型游标或预算；无偏移首读尾部，后续以 `end` 读取，`start` 等于本地 `end` 时追加，否则替换。`BackgroundShellTask.outputChars` 为当前日志字符数；运行中输出增长以同任务最多每 500ms 一次的临时 `shell.task_updated` 推送，启动和结束各发送一次。`SessionView.backgroundShells` 由持久工具与结果事件派生，并由临时事件更新；`outputChars` 不落盘，不参与重放等价。精确契约见 [rpc.md](../protocols/rpc.md#321-shelladr-0083)。

### 7. 权限与上下文不变

- 权限只在启动时求值，主体是命令文本，与同步 shell 相同；预设、规则、智能审查都照旧。`shell_output` 只读本会话自己的任务；`shell_kill` 只能停本会话自己的任务，都不需要确认。
- 检查点：后台命令计入「未追踪调用」，同同步 shell。
- Builder 不改：结果就是一条用户消息。

## 不做

- 交互式输入（往后台进程的 stdin 写）。
- 跨会话共享后台任务、会话关闭后让命令继续跑。
- 重启后重新接管仍在运行的进程。
- 输出里的端口自动识别、自动打开预览。

## 后果

- 模型可以边跑检查边干别的，长任务结束时自动接着处理；开发服务器有了正式用法，崩溃会通知到模型。
- 空闲唤起意味着用户不在场时也会开新 Turn、产生费用；和后台子代理一样，只在模型自己启动的任务结束时发生，这一轮可以中断。
- 不设数量和时长上限，靠列表和停止按钮兜底；忘记停的服务器在会话关闭时一起结束。
- 旧版本打开含后台结果的会话：结果显示为普通用户消息，内容完整。

## 备选方案

- **另起一个 `background_shell` 工具**：权限规则、校验、描述要复制一份，模型也要多认一个工具。用 `shell` 的一个字段更省。
- **只给 `shell_output`、不主动交付**：模型要轮询，空闲时没人来取，做不到「10 分钟后再看」。不采用；`shell_output` 只作为补充。
- **结束时写回原工具调用**：同 ADR-0073 备选，破坏「每个调用恰好一个 `tool.completed`」。不采用。
- **复用桌面端终端面板跑后台命令**：终端是给人用的伪终端，模型读不到结构化的结束状态，TUI 和手机也没有。不采用。
