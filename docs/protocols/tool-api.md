# Tool API

> 状态：已接受 v0.2 ｜ 设计依据：[tools.md](../architecture/tools.md)、[permissions.md](../architecture/permissions.md) ｜ 代码位置（计划）：`packages/core/src/tools/`

本文定义工具的最小接口。所有工具（内置、MCP（Phase 5，见 [mcp.md](../architecture/mcp.md)）与将来的插件）都实现同一接口，经同一执行管线运行。

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
  /** 执行。只在权限允许后被调用 */
  execute(input: Input, ctx: ToolContext): Promise<ToolResult<Output>>
}

interface ToolTraits {
  /** 执行是否可能改变外部状态（文件、进程、远端）。用于崩溃恢复提示与将来的调度 */
  mutates: boolean
  /** 能否与其他 concurrencySafe 调用并行执行 */
  concurrencySafe: boolean
  /** 默认超时；可由输入覆盖时，执行器以 maxTimeoutMs 为上限 */
  timeoutMs: number
  maxTimeoutMs?: number
  /** 模型可见输出的字符上限，默认 30000 */
  maxModelChars?: number
}
```

设计取舍：

- **声明而不是猜测**：权限所需信息来自 `permissionSubjects`，执行特性来自 `traits`。运行时从不根据工具名推断任何东西。
- **没有 `riskLevel` / `needsApproval` 字段**：是否需要确认由权限规则对"主体"求值决定，工具不预先声明结论。这避免同一信息在工具声明、权限配置里各存一份（ZCode 的 `ToolMetadata` 与 `ToolPermissionSpec` 就重复了风险、副作用和审批字段）。
- **`permissionSubjects` 必须是纯函数**：它只做词法层面的规范化（按 `cwd` 把相对路径变成绝对路径）。解析符号链接等需要 I/O 的工作由执行器通过 `platform` 完成，结果再交给权限层（[permissions.md](../architecture/permissions.md) 第 4 节）。

```ts
/** 工具声明的未解析主体（subagent 为 Phase 6 新增，见 subagent.md） */
type SubjectRequest = { kind: "read" | "edit" | "shell" | "network" | "mcp" | "subagent"; target: string }
// 解析后的 PermissionSubject 定义见 events.md 第 4 节
```

## 2. 上下文

```ts
/** 求值权限主体时可用的最少信息 */
interface ToolScope {
  cwd: string              // 会话工作目录（绝对路径）
  workspaceRoot: string
  paths: PathOps           // 来自 platform：词法路径规范化与包含判断；大小写敏感性由 platform 决定
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
  process: ProcessRunner            // 来自 platform；支持超时与进程树终止
  readState: ReadStateStore         // "先读后写"所需的已读记录
  progress(chunk: string, stream?: "stdout" | "stderr" | "info"): void   // 产生 tool.progress 临时事件
}
```

`permissions.check` 对传入路径做词法判定（不解析链接），因此只适用于不跟随符号链接、结果位于已解析根目录之下的枚举场景。

`ToolContext` 不暴露会话对象、事件发布器、Provider 或其他工具。工具之间不能互相调用；需要组合能力时由模型在多个 Step 中完成。

## 3. ToolResult

```ts
type ToolResult<Output = unknown> =
  | { status: "ok";    modelContent: string; output?: Output }
  | { status: "error"; modelContent: string; output?: Output; error: { code: string; message: string } }
```

- `modelContent`：交给模型的文本。执行器会按 `maxModelChars` 截断并标注。
- `output`：结构化结果，供客户端渲染（例如 `edit` 返回 diff，`shell` 返回退出码）。有独立大小上限；不发送给模型。
- 可预期的失败（文件不存在、`old` 字符串不唯一、先读检查失败）返回 `status: "error"` 与工具自定义的 `code`；非预期异常直接抛出，由执行器转换为 `tool_failed`。
- `denied`、`cancelled`、`interrupted` 等状态只由执行器或恢复逻辑产生，工具不会返回它们。

执行器使用的通用错误码：

| code | 含义 |
|---|---|
| `unknown_tool` | 模型调用了不存在的工具 |
| `invalid_input` | 输入不符合 schema（含 `PreToolUse` Hook 修改后的输入未通过重新校验） |
| `permission_denied` | 规则或用户拒绝 |
| `hook_denied` | `PreToolUse` Hook 拒绝（Phase 5，见 [hooks.md](../architecture/hooks.md)） |
| `cancelled` | 被中断 |
| `timeout` | 超时 |
| `tool_failed` | 工具抛出非预期异常 |
| `resource_unavailable` | 执行器无法解析权限主体（例如无权访问父目录） |
| `resource_changed` | 修改类工具发现目标路径的解析结果与批准时不同（工具返回，名称统一） |

## 4. 注册表与执行器

```ts
interface ToolRegistry {
  register(tool: ToolDefinition): void      // 名称重复时抛错，不静默覆盖
  unregister(name: string): void
  get(name: string): ToolDefinition | undefined
  list(): ToolDefinition[]
  specs(): ToolSpec[]                        // 交给 Context Builder / Provider 的模型可见部分
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

## 5. 示例（示意）

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

- 新增可选的 `traits` 字段或 `ToolContext` 能力：兼容变更，更新本文。
- 修改 `ToolResult` 形状或执行管线的保证：不兼容变更，需要 ADR。
