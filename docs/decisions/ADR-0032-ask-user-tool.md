# ADR-0032：向用户提问工具

- 状态：已接受（维护者 2026-09-30 确认）
- 日期：2026-09-30

## 背景

[v0.5 路线图](../roadmap/roadmap.md)要求：模型遇到需要用户拍板的问题时暂停并提问（可给选项），用户回答后继续；非交互模式下返回「无法提问」，由模型自行取默认。

目前模型只能把问题写进最终回复，结束 Turn，等用户下一条消息。这有两个问题：一是长任务被打断，用户回答后模型要重新拾起上下文；二是模型倾向于自己猜一个答案继续做，猜错了返工更多。

现有机制里最接近的是权限确认：工具执行管线在权限闸门处暂停，客户端显示确认框，用户经 `respondPermission` 回复后继续。但权限确认回答的是「能不能做」，由权限层判定；提问回答的是「怎么做」，答案要作为工具结果交给模型。两者不能合并，否则违反「权限判定只在权限层」的约束。

## 决定

### 1. 工具形态

新增内置工具 `ask_user`。输入：

```ts
{
  questions: Array<{
    question: string          // 问题正文
    header?: string           // 短标签，界面显示为标题前的小标记
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean     // 缺省 false
  }>
}
```

- 一次调用 1–4 个问题。`question` 去首尾空白后非空，至多 300 字符；`header` 至多 12 字符。
- `options` 为空或省略时只收自由文本；提供时 2–6 项，`label` 去首尾空白后非空、至多 60 字符且同一问题内不重复，`description` 至多 200 字符。
- 所有文本不得含控制字符；`question` 与 `description` 允许换行，`label` 与 `header` 不允许。未知字段拒绝。校验失败以 `invalid_input` 结算，不打扰用户。
- 有选项时，界面总是额外提供「其他」一项，允许用户输入自由文本；模型不需要也不应该自己加「其他」。

工具说明（模型可见的 `description`）写清使用边界：只在确实需要用户决定、且无法通过读代码、查文档或合理默认解决时使用；不用来请求执行许可（那是权限层的事）；不用来确认「要不要继续」这类可以直接做的事；把推荐选项放在第一位并在 `label` 末尾标「（推荐）」。

### 2. 结果

```ts
output: {
  answers: Array<{ question: string; selected: string[]; text?: string }>
  skipped?: true
}
```

- `selected` 是用户选中的 `label`（单选时至多一项）；`text` 是「其他」或自由文本的内容，去首尾空白，至多 2000 字符。
- `modelContent` 以人读格式列出每个问题及回答，例如 `问：用哪个数据库？\n答：PostgreSQL（推荐）；补充：要兼容 13 版`。
- 用户选择跳过时 `status: "ok"`、`skipped: true`，`modelContent` 为「用户未回答，请按你的判断继续，并在回复中说明所做的假设」。
- `status` 为 `ok` 时才算得到回答；其他结算状态（取消、超时、非交互）见第 4 节。

### 3. 暂停与回答：新的 ToolContext 能力

- `ToolContext` 新增可选能力 `askUser(request): Promise<AskUserReply>`（[tool-api.md](../protocols/tool-api.md) 第 6 节：新增 `ToolContext` 能力是兼容变更）。工具只调用这个能力，不接触会话或事件发布器。
- Runtime 实现该能力：分配 `requestId`，发出**临时事件** `question.requested`（`requestId`、`callId`、`questions`），`runtime.status` 置为新值 `waiting_user`，然后等待客户端命令。
- 新增客户端命令 `respondQuestion(requestId, reply)`，`reply` 为 `{ answers: Array<{ selected: string[]; text?: string }> }` 或 `{ skipped: true }`。请求不在等待中时返回 `unknown_request`；`answers` 数量与问题数不符、`selected` 含未知 `label`、单选选了多项时返回 `invalid_reply`，请求保持等待。Runtime 校验通过后把回答交回工具。
- **不新增持久化事件**：问题已在 `tool.started.input` 中，回答在 `tool.completed.output` 中，两者都已持久化。这样旧版本 Runtime 仍能恢复包含提问的会话（[events.md](../protocols/events.md) 第 8 节）。
- 客户端视图（[view.md](../protocols/view.md)）从 `question.requested` 派生「待回答的问题」，在对应 `callId` 的 `tool.completed` 或 `turn.completed` 到达时清除。这是瞬态信息，重放日志不会重建。
- Agent Loop 不按工具名处理提问：等待发生在工具的 `execute` 内部，对 Agent Loop 来说只是一次耗时较长的工具调用。

### 4. 中断、超时、非交互与子代理

- **中断**：等待期间 Turn 被中断，`askUser` 以取消结束，调用记为 `cancelled`，Turn 以 `aborted` 结束，与等待权限确认时被中断相同（[agent-loop.md](../architecture/agent-loop.md) 第 3.3 节）。
- **进程退出**：只有 `tool.started` 的提问由现有恢复修复记为 `interrupted`，不在恢复时重新提问；用户在下一条消息里回答即可。
- **超时**：`traits.timeoutMs` 设为 24 小时，实际等同于不限时；超时按执行器现有规则以 `timeout` 结算。
- **非交互**：Runtime 以 `interactive: false` 创建（`nctrn -p` 等，与权限层 `non_interactive` 为同一开关）时，`askUser` 立即返回「不可用」，工具以 `status: "error"`、`code: "not_interactive"` 结算，`modelContent` 为「当前为非交互模式，无法向用户提问；请按最合理的默认继续，并在最终回复中说明所做的假设」。不发出 `question.requested`。
- **子代理**：子会话本来就是非交互的（[subagent.md](../architecture/subagent.md) 第 7 节）。为免浪费步数，`ToolTraits` 新增可选的 `needsUser?: boolean`，`ask_user` 声明为 `true`；子代理的可选池排除声明了 `needsUser` 的工具，按特性筛选而非按名字。

### 5. 执行特性与权限

- `traits`：`mutates: false`、`concurrencySafe: false`、`needsUser: true`、`timeoutMs` 24 小时。
- `permissionSubjects` 返回 `[]`，不产生权限确认；仍经过正常的执行管线与 Hook。
- 同一 Step 里模型发出多个工具调用时照常串行，提问与其他调用按模型给出的顺序执行。

### 6. 界面

- **TUI**（全屏与 `--inline` 相同）：在权限确认框的位置显示提问面板，复用 [ADR-0030](ADR-0030-dialog-settings-pages.md) 的对话框控件与现有主题角色，不新增颜色。
  - 多个问题时分页显示，顶部显示 `header` 与「1/3」；`←`/`→` 或 `Tab`/`Shift+Tab` 切换问题。
  - `↑`/`↓` 移动焦点；单选按 `Enter` 选中并进入下一题；多选按 `Space` 勾选，`Enter` 进入下一题。
  - 焦点落在「其他」时直接输入文本；无选项的问题只有文本框。
  - 最后一题按 `Enter` 进入确认行，显示全部回答，再按 `Enter` 提交。
  - `Esc`：正在输入「其他」时先退出输入；否则跳过整次提问（等同 `{ skipped: true }`）。提问面板打开时 `Esc` 不中断 Turn；中断 Turn 用 `Ctrl+C`，行为与现有一致。
  - 提交后面板关闭，对话中留一条摘要：每个问题一行「问题 → 回答」，跳过时显示「已跳过」。
  - 本轮只做键盘操作；鼠标单击留到对话框推广时一并开放。
  - 窄终端、ASCII、`NO_COLOR` 下以文字和符号区分选中状态，不依赖颜色。
- **逐行 CLI**：逐题打印问题与编号选项（多选提示「可输入多个编号，用逗号分隔」），输入编号或直接输入文字作为「其他」，空行表示跳过整次提问。提交后打印同样的摘要。
- 旧版客户端不认识 `question.requested`，按 events.md 第 8 节忽略；此时提问会一直等待，直到用户中断。这是已知限制，本版本的 CLI 与 TUI 都支持该事件。

## 验收

- **Core 单元与集成测试**（离线）：
  - 输入校验的每条边界；
  - 回答校验（数量不符、未知 `label`、单选多项）返回 `invalid_reply` 且请求仍在等待；
  - 正常回答、跳过、中断、超时、非交互四种结算，各自恰好一个 `tool.completed`；
  - 进程退出后恢复把提问记为 `interrupted`；
  - 子代理可选池不含 `ask_user`；
  - 不新增持久化事件类型，`formatVersion` 不变；
  - Agent Loop 与 Context 中没有按 `ask_user` 名字的分支。
- **TUI 与 CLI 交互测试**：单选、多选、「其他」文本、多问题切换、确认行、`Esc` 跳过、`Ctrl+C` 中断、窄终端与 `NO_COLOR`。
- **维护者手测**：在 Windows Terminal 中让模型提一个带选项的问题，深浅两种主题下检查提问面板。
- **文档同步**：
  - [tool-api.md](../protocols/tool-api.md)：`askUser` 能力、`needsUser` 特性、`ask_user` 示例、错误码 `not_interactive`；
  - [tools.md](../architecture/tools.md)：内置工具列表；
  - [events.md](../protocols/events.md)：`question.requested`、`runtime.status` 的 `waiting_user`、客户端命令 `respondQuestion`；
  - [view.md](../protocols/view.md)：待回答问题的派生规则；
  - [agent-loop.md](../architecture/agent-loop.md)：运行状态图与中断表各补一行；
  - [subagent.md](../architecture/subagent.md)：可选池排除 `needsUser` 工具；
  - [tui.md](../apps/tui.md)、[cli.md](../apps/cli.md)：提问面板与逐行交互；
  - 路线图条目、[decisions/README.md](README.md)。

## 后果

- **正面**：
  - 模型可以在长任务中间停下来问，不必结束 Turn；
  - 问题与回答都在现有事件里，恢复与审计不需要新机制；
  - `askUser` 能力与 `needsUser` 特性以后可以给其他需要用户输入的工具复用（例如 MCP 的 elicitation）。
- **负面**：
  - 旧版客户端遇到提问会一直等待，只能中断；
  - 等待中的问题不持久化，进程退出后不能原样重新弹出，只能由用户在下一条消息里回答；
  - TUI 又多一个会抢键盘焦点的面板，`Esc` 在其中的含义与平时不同（跳过而不是中断）。
- **约束**：
  - 工具不得自行读取终端或 stdin，只能通过 `askUser`；
  - 权限层不参与提问，提问也不能用来绕过权限确认。

## 备选方案

- **复用权限确认流程**：答案需要作为工具结果交给模型，权限回复只有允许/拒绝和反馈，语义不同；把提问塞进权限层也违反「权限判定只在权限层」。
- **新增持久化事件 `question.requested` / `question.resolved`**：能在恢复后重新弹出问题，但旧版本 Runtime 将无法恢复包含提问的会话，而问题与回答本来已经在 `tool.started` 和 `tool.completed` 里。
- **结束 Turn，把问题当作最终回复**：这就是现状，长任务会被打断，也无法给结构化选项。
- **非交互时不注册工具**：模型看不到工具就不会知道「无法提问」，路线图明确要求返回「无法提问」让模型自行取默认。
- **子代理也保留该工具，只返回 `not_interactive`**：每次调用都白白消耗一个步骤，子代理本来就应自主完成任务，把需要用户决定的事写进结果交回父代理。

## 修订

- **2026-10-01**：整次跳过改为逐题「拒绝回答」选项，回复与 output.answers 使用逐题回答/declined 联合形状。被拒绝的题写「答：用户拒绝回答」，只要有拒绝项，modelContent 末尾追加「对用户拒绝回答的问题，请按你的判断继续，不要就同一问题再次提问，并在回复中说明所做的假设。」工具描述要求拒绝后不得就同一问题再次调用本工具。Esc 输入中退出输入，否则恢复与权限确认框一致的全局规则（忙碌中中断 Turn）。提问与权限确认弹窗同步贴在输入框上方，按内容计算并封顶高度，保留上方最新对话；inline 不撑出空白。对话摘要改由 ask_user 工具条目从持久事件专门显示，去掉 JSON 和提交前的重复摘要。
