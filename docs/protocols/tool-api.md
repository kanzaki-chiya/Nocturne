# Tool API

> 状态：已接受 v0.2 ｜ 设计依据：[tools.md](../architecture/tools.md)、[permissions.md](../architecture/permissions.md) ｜ 代码位置：`packages/core/src/tools/`

本文定义工具的最小接口。所有工具（内置、MCP（见 [mcp.md](../architecture/mcp.md)）与将来的插件）都实现同一接口，经同一执行管线运行。

## 1. ToolDefinition

```ts
interface ToolDefinition<Input = unknown, Output = unknown> {
  /** 模型可见的唯一名称：小写字母、数字、下划线。外部来源的工具带命名空间，如 mcp__github__create_issue */
  name: string
  /** 模型可见的说明：做什么、何时使用、关键约束 */
  description: string
  /** 模型可见的输入 schema（JSON Schema），同时用于运行时校验 */
  inputSchema: JsonSchema
  /** 执行特性，由运行时读取 */
  traits: ToolTraits
  /** 纯函数：本次调用会碰到哪些对象（未解析），供执行器解析后交给权限层判定。不得做 I/O */
  permissionSubjects(input: Input, scope: ToolScope): SubjectRequest[]
  /**
   * 可选的输入语义预检（纯函数，无 I/O）：在 schema 校验与 PreToolUse Hook
   *（含 updatedInput 重新校验）之后、permissionSubjects 之前调用；返回非空
   * 错误说明即以 invalid_input 拒绝——不请求权限，execute 不会被调用。
   * 未声明时跳过。用途：schema 表达不了的语义约束（如 shell 拒绝末尾分页）。
   * scope 参数（ADR-0022）携带当前生效 shell，供按种类的检查使用。
   */
  validateInput?(input: Input, scope?: ToolScope): string | undefined
  /** 工具来源标记（ADR-0023）：MCP 连接器包装的声明为 "mcp"；
      缺省视为内置/本地。目前用于标注结果图片附件的来源（ImageAttachment.source） */
  origin?: "mcp"
  /** 执行。只在权限允许后被调用 */
  execute(input: Input, ctx: ToolContext): Promise<ToolResult<Output>>
}

interface ToolTraits {
  /** 结果不参与 L1 修剪；经 tool.started 持久化，L2 摘要与执行时预算不豁免 */
  pinResult?: boolean
  /** 执行是否可能改变外部状态（文件、进程、远端）。用于崩溃恢复提示与将来的调度 */
  mutates: boolean
  /** 能否与其他 concurrencySafe 调用并行执行 */
  concurrencySafe: boolean
  /** 默认超时；可由输入覆盖时，执行器以 maxTimeoutMs 为上限 */
  timeoutMs: number
  maxTimeoutMs?: number
  /** 模型可见输出的字符上限，默认 30000 */
  maxModelChars?: number
  /** 执行时需要与用户交互输入（ADR-0032）：声明后 ToolContext.askUser 可用；
      子代理（非交互）的可选工具池按此特性排除（subagent.md 第 6 节） */
  needsUser?: boolean
  /** 编辑工具族标记（ADR-0035）：edit/write 声明 "edit"，apply_patch 声明
      "apply_patch"；未声明的工具不参与该筛选。携带模型的
      capabilities.editTool 时注册表只暴露同值成员 */
  editTool?: EditToolKind   // "edit" | "apply_patch"，定义在 protocol
}
```

设计取舍：

- **声明而不是猜测**：权限所需信息来自 `permissionSubjects`，执行特性来自 `traits`。运行时从不根据工具名推断任何东西。
- **没有 `riskLevel` / `needsApproval` 字段**：是否需要确认由权限规则对"主体"求值决定，工具不预先声明结论。这避免同一信息在工具声明、权限配置里各存一份（ZCode 的 `ToolMetadata` 与 `ToolPermissionSpec` 就重复了风险、副作用和审批字段）。
- **`permissionSubjects` 必须是纯函数**：它只做词法层面的规范化（按 `cwd` 把相对路径变成绝对路径）。解析符号链接等需要 I/O 的工作由执行器通过 `platform` 完成，结果再交给权限层（[permissions.md](../architecture/permissions.md) 第 4 节）。

```ts
/** 工具声明的未解析主体（subagent 为 Phase 6 新增，见 subagent.md；
    shell 主体的可选 shell/shellRisk 字段记录执行种类与高风险元数据，ADR-0022） */
type SubjectRequest = {
  kind: "read" | "edit" | "shell" | "network" | "mcp" | "subagent"
  target: string
  /** 仅用于显示，不参与规则匹配、Grant 键与 Hook 判定 */
  detail?: string
  shell?: string
  /** 生效 ShellDescriptor 的纯数据高风险元数据（表集中在 platform，
      匹配判定在权限层）；缺省时权限层按 POSIX 基础表保守处理 */
  shellRisk?: ShellRiskProfile
}
// 解析后的 PermissionSubject 定义见 events.md 第 4 节
```

## 2. 上下文

```ts
/** 求值权限主体时可用的最少信息 */
interface ToolScope {
  cwd: string              // 会话工作目录（绝对路径）
  workspaceRoot: string
  paths: PathOps           // 来自 platform：词法路径规范化与包含判断；大小写敏感性由 platform 决定
  shell?: ShellResolution  // 当前生效 shell 的解析结果（ADR-0022）：scope 组装时按次取值，不在 Turn 开始快照；供方言化分词与分页器名单使用
}

/** 执行时可用的能力。刻意保持窄：工具需要新能力时，先在本文增加字段 */
interface ToolContext extends ToolScope {
  sessionId: string
  turnId: string
  callId: string                    // Runtime 分配的调用标识
  signal: AbortSignal               // 中断或超时时触发；工具必须响应
  subjects: PermissionSubject[]     // 已批准的、解析后的主体；修改类工具写入前据此复核路径
  permissions: {                    // 只读的策略查询，供枚举类工具过滤结果；不触发确认
    check(subject: SubjectRequest): "allow" | "ask" | "deny"
  }
  fs: FileSystem                    // 来自 platform
  process: ProcessRunner            // 来自 platform；支持超时与进程树终止；spawnShell 的 exit 结算与输出管道分离见 tools.md 第 6 节
  shell?: ShellResolution           // 本次调用生效 shell 的解析结果（ADR-0022）；descriptor 缺失（显式选择不可用）时 error 给出可选项
  shellEnvStrip?: readonly string[] // shell 子进程环境中要剥离的凭据变量名（provider-setup.md 第 4 节）
  readState: ReadStateStore         // "先读后写"所需的已读记录
  progress(chunk: string, stream?: "stdout" | "stderr" | "info"): void   // 产生 tool.progress 临时事件
  /** 向用户提问（ADR-0032 §3）：发出 question.requested 并等待 respondQuestion
      命令。非交互环境返回 unavailable（不发事件）；中断/超时经 signal 使
      返回的 Promise 拒绝，由执行器统一结算为 cancelled / timeout。
      缺省 = 运行环境未提供提问通道，工具按 not_interactive 结算 */
  askUser?(request: AskUserRequest): Promise<AskUserReply>
}

/** askUser 的入参与返回（ADR-0032 §3）；QuestionItem / QuestionAnswer
    的字段边界见 ADR-0032 §1/§2 与 events.md 第 3 节 */
type AskUserRequest = { questions: QuestionItem[] }
type AskUserReply =
  | { kind: "answered"; answers: QuestionAnswer[] }
  | { kind: "unavailable" }  // 非交互：不发 question.requested
```

`permissions.check` 对传入路径做词法判定（不解析链接），因此只适用于不跟随符号链接、结果位于已解析根目录之下的枚举场景。

`ToolContext` 不暴露会话对象、事件发布器、Provider 或其他工具。工具之间不能互相调用；需要组合能力时由模型在多个 Step 中完成。

`progress` 允许发送半行。`stdout`/`stderr` 的 `chunk` 是原始片段；客户端按同一工具、同一输出流的到达顺序拼接，遇到 `\n` 才结束一行，不在每次调用后自动换行。`info` 用于独立的一行式状态摘要：每次调用传一行内容，不带末尾换行；CLI/TUI 在呈现时结束该行。因此发送方不必为客户端补换行。这只明确了现有 `tool.progress` 的显示约定，没有更改事件字段、`ToolResult` 或执行管线保证，不触发本协议第 6 节的 ADR 条件；也不是 Provider 流式契约或错误语义变更。

## 3. ToolResult

```ts
type ToolResult<Output = unknown> =
  | { status: "ok";    modelContent: string; output?: Output; attachments?: RawImageAttachment[] }
  | { status: "error"; modelContent: string; output?: Output; attachments?: RawImageAttachment[]; error: { code: string; message: string } }

/** 工具结果携带的图片字节（ADR-0023）；执行器负责落盘，
    事件里只出现 ImageAttachment 引用（events.md 第 4 节） */
type RawImageAttachment = {
  mimeType: ImageMimeType    // events.md 第 4 节
  data: Uint8Array
  label?: string
}
```

- `modelContent`：交给模型的文本。执行器会按 `maxModelChars` 截断并标注。
- `output`：结构化结果，供客户端渲染（例如 `edit` 返回 diff，`shell` 返回退出码）。有独立大小上限；不发送给模型。
- `edit` 成功时的 `output` 为 `{ path, replaced, diff }`；`write` 为 `{ path, created, lines, diff? }`，新建与覆盖只要有变化均提供 diff。`diff` 仍是字符串，头部 `@@ -旧起始行,旧行数 +新起始行,新行数 @@`，后续源码行以空格、`-`、`+` 标记；行尾差异用 `\ CRLF` / `\ CR` / `\ No newline at end of file` 标记。路径由 `path` 提供，不嵌入头部。旧日志的 `@@ 路径 @@` 或无头部结果仍可展示，但无可推定的行号。客户端按 `+`/`-` 源码行计算新增/删除数，不计上下文或行尾标记。
- `edit` 的 `old` 未命中返回 `no_match`，提示写入 `error.message` / `modelContent`；只基于通过路径、权限及先读状态检查的目标文本生成有界建议，不改变文件。`not_unique`、`not_read`、`resource_changed` 等语义保持不变。`stale_file` 在有旧文本且 diff 不超过 4000 字符时于 `modelContent` 附带读取时到当前的 diff 并已刷新记录，可直接重试；无旧文本或 diff 过长时需重新 `read`。
- `apply_patch`（[ADR-0035](../decisions/ADR-0035-apply-patch.md)）的输入仅 `{ input: string }`（补丁原文；语法见 [tools.md](../architecture/tools.md) 第 6 节）。成功的 `output` 为 `{ files: [{ path, op, movedTo?, diff? }] }`——按补丁操作顺序逐文件给出 `op`（`add`/`update`/`delete`/`move`）、改名时的 `movedTo` 与该文件的行级 `diff`（格式同上）；`modelContent` 为逐文件摘要。`permissionSubjects` 为每个涉及路径各产出一个 `edit` 主体（Move 含源与目标）。解析错误、目标冲突或先读检查失败时**不写任何文件**，返回 `error`（`invalid_input`/`not_read`/`stale_file` 等）；写盘中途失败回滚已写文件后同样以 `error` 结算。
- `attachments`：图片字节；执行器经会话的 `AttachmentStore` 逐张落盘（tools.md 第 4 节），成功的写入 `tool.completed.attachments` 引用，`source` 取 `origin === "mcp" ? "mcp" : "read"`。某张保存失败不影响其余：成功的照常引用，失败的在 `modelContent` 末尾追加 `[图片附件保存失败：<原因>]` 并记 `tool.attachment_failed` 诊断；无论成败都恰好一个 `tool.completed`。`read` 的图片相关错误码为 `image_too_large`（超 5 MB 或任一边超 8000 px）与 `image_corrupt`（文件头损坏/截断）。
- 可预期的失败（文件不存在、`old` 字符串不唯一、先读检查失败）返回 `status: "error"` 与工具自定义的 `code`；非预期异常直接抛出，由执行器转换为 `tool_failed`。
- `denied`、`cancelled`、`interrupted` 等状态只由执行器或恢复逻辑产生，工具不会返回它们。

执行器使用的通用错误码：

| code | 含义 |
|---|---|
| `unknown_tool` | 模型调用了不存在的工具 |
| `invalid_input` | 输入不符合 schema（含 `PreToolUse` Hook 修改后的输入未通过重新校验），或未通过工具可选的 `validateInput` 语义预检 |
| `permission_denied` | 规则或用户拒绝 |
| `hook_denied` | `PreToolUse` Hook 拒绝（Phase 5，见 [hooks.md](../architecture/hooks.md)） |
| `cancelled` | 被中断 |
| `timeout` | 超时；shell 超时时 `output.timeoutMs` 为本次上限毫秒数，供客户端换算秒数 |
| `tool_failed` | 工具抛出非预期异常 |
| `resource_unavailable` | 执行器无法解析权限主体（例如无权访问父目录） |
| `resource_changed` | 修改类工具发现目标路径的解析结果与批准时不同（工具返回，名称统一） |

`web_fetch` 的工具错误码（请求、响应与结果结构见 [tools.md](../architecture/tools.md) 第 6 节）：

| code | 含义 |
|---|---|
| `unsupported_content` | 内容类型不受支持，说明 MIME 与已读取字节数 |
| `http_error` | HTTP 非成功状态，给出状态码与正文前 2000 字符；重定向缺少 Location 同样报此错误 |
| `network_error` | DNS、连接、TLS、读取失败，或无效目标、超过 5 次重定向；超时仍由执行器结算为 `timeout` |

图片复用 `image_too_large` 与 `image_corrupt`，经既有附件通道返回，source 为 `read`。

## 4. 注册表与执行器

```ts
interface ToolRegistry {
  register(tool: ToolDefinition): void      // 名称重复时抛错，不静默覆盖
  unregister(name: string): void
  /** 携带模型的 capabilities.editTool 时按 traits.editTool 筛选可见性
      （ADR-0035 §5）；缺省不筛，未声明该特性的工具不受筛选影响 */
  get(name: string, editTool?: EditToolKind): ToolDefinition | undefined
  list(): ToolDefinition[]
  /** 同上筛选；返回交给 Context Builder / Provider 的模型可见部分。
      执行器查找走同一筛选——未暴露的名字以 unknown_tool 结算 */
  specs(editTool?: EditToolKind): ToolSpec[]
}

type ToolSpec = { name: string; description: string; inputSchema: JsonSchema }

interface ToolExecutor {
  /** 运行执行管线，保证发出恰好一个 tool.completed */
  execute(call: ToolCallRef, ctx: ExecutionScope): Promise<ToolExecution>
}

type ToolExecution = {
  status: "ok" | "error" | "denied" | "cancelled"
  result: ToolResult
  stopTurn: boolean                          // 用户选择了"拒绝并停止"
}
```

`ExecutionScope` 由 Agent Loop 提供，包含会话、Turn 标识、中断信号、权限闸门与资源解析器；工具看不到它。`call.callId` 由 Agent Loop 在收到 Provider 的工具调用时分配（[agent-loop.md](../architecture/agent-loop.md) 第 3.2 节）。

执行器对可选 `validateInput` 的调用顺序是固定的（[tools.md](../architecture/tools.md) 第 3 节第 2.6 步）：在 `PreToolUse` Hook 处理完成、且 Hook 给出的 `updatedInput` 通过最终 schema 重新校验之后，`permissionSubjects` 计算与权限闸门求值之前调用。返回非空错误说明时，该调用以 `error`/`invalid_input` 结算并发出唯一的 `tool.completed`——不发出 `permission.requested`、不发出 `tool.started`，`execute` 不会被调用；返回 `undefined` 或未声明该字段时管线照常继续。

## 5. 示例（示意）

`todo_write`（[ADR-0028](../decisions/ADR-0028-session-task-list.md)）接受 `{ items: [{ text, status }] }`，每次提交完整清单，`items: []` 清空。最多 20 项；`text` 去首尾空白后非空且至多 200 个字符，拒绝换行、控制字符和未知字段；`status` 只允许 `pending`、`in_progress`、`completed`。校验失败以 `invalid_input` 结算；成功时 `output.items` 是规范化后的完整清单，`modelContent` 是简短确认。工具的 `permissionSubjects` 返回 `[]`，`traits` 为 `mutates: false, concurrencySafe: false`，仍经过普通执行管线和 Hook；它不读写工作区文件、配置或网络。

`ask_user`（[ADR-0032](../decisions/ADR-0032-ask-user-tool.md)）接受 `{ questions: [{ question, header?, options?, multiSelect? }] }`，一次调用 1–4 题。`question` 去首尾空白后非空、至多 300 字符；`header` 至多 12 字符；`options` 省略或为空表示自由文本题、提供时 2–6 项，界面始终额外提供「其他」与「拒绝回答」（模型不得自行添加）；`label` 去首尾空白后非空、至多 60 字符、同题不重复；`description` 至多 200 字符；所有文本字段禁止控制字符（`question`、`description` 允许换行，`label`、`header` 不允许），未知字段一律拒绝。任一不满足即以 `invalid_input` 结算。成功时 `output.answers` 逐题给出 `{ question, selected, text? }` 或 `{ question, declined: true }`（`selected` 是已提供选项中被选中的 label 集，`text` 是「其他」/自由文本回答）。`respondQuestion(requestId, { answers })` 的每项为 `{ selected: string[], text?: string }` 或 `{ declined: true }`，条数必须与题数一致；拒绝项不得同时携带 `selected` 或 `text`。`modelContent` 逐题列出「问/答」，拒绝题写「答：用户拒绝回答」；只要有拒绝项，末尾追加「对用户拒绝回答的问题，请按你的判断继续，不要就同一问题再次提问，并在回复中说明所做的假设。」工具描述同时要求拒绝后不得就同一问题再次调用本工具。非交互环境（`interactive` 为假或 `ctx.askUser` 未装配）返回 `error(code="not_interactive")`、不发 `question.requested`。提问经 `ToolContext.askUser` 实现：发出临时事件 `question.requested`、`runtime.status` 置 `waiting_user`，等待 `respondQuestion`（[events.md](events.md) 第 3、7 节）；回复与问题不匹配时命令以 `invalid_reply` 拒绝且请求保持等待。中断以 `cancelled` 结算、等待超时以 `timeout` 结算（`traits.timeoutMs` 默认 24 小时），进程退出由恢复补 `interrupted`。`traits` 为 `mutates: false, concurrencySafe: false, needsUser: true`，`permissionSubjects` 返回 `[]`——提问不是权限请求，不经权限层；子代理的可选池按 `needsUser` 排除本工具（[subagent.md](../architecture/subagent.md) 第 6 节）。

```ts
const read: ToolDefinition<{ path: string; offset?: number; limit?: number }> = {
  name: "read",
  description: "读取文本文件，返回带行号的内容。修改文件前必须先读取。",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 10_000 },
  permissionSubjects: (input, scope) => [{ kind: "read", target: resolvePath(scope.cwd, input.path) }],
  async execute(input, ctx) { /* 读取、加行号、记录 readState、返回 ok 或 error(file_not_found) */ },
}
```

## 6. 演进规则

执行环境可注入 `checkpoint(phase, callId, resolvedSubjects, sourceSessionId)`，执行器在执行前后调用，工具实现不接触该能力。`tool.started.mutates` 保存工具声明，回退预览按 `mutates=true` 且没有 edit 主体统计未追踪调用，不按工具名猜测；旧日志无该字段时不推断。检查点记录与回退契约见 [ADR-0041](../decisions/ADR-0041-checkpoints-rewind-fork.md)。

- 新增可选的 `traits` 字段、`ToolDefinition` 可选方法（如 `validateInput`）或 `ToolContext` 能力：兼容变更，更新本文。
- 修改 `ToolResult` 形状或执行管线的保证：不兼容变更，需要 ADR。
