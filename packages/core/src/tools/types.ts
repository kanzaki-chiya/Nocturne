import type { McpProbeResult } from "../protocol/index.js";
/**
 * 工具契约（docs/protocols/tool-api.md）。
 * 内置工具与将来的 MCP / 插件工具走同一接口与同一执行管线（tools.md 第 1 节）。
 */
import type {
  FileSystem,
  PathOps,
  Platform,
  ProcessRunner,
  ShellResolution,
} from "../platform/index.js";
import type {
  PermissionGate,
  ToolEventSink,
  HookRunner,
  GateTurnContext,
} from "../permission/index.js";
export type {
  ToolDurableType,
  ToolEventSink,
  GateOutcome,
  GateTurnContext,
  GateHookContext,
  PermissionGate,
  HookInput,
  HookOutput,
  HookCallInput,
  HookRunner,
} from "../permission/index.js";
import type {
  Diagnostics,
  EditToolKind,
  ImageMimeType,
  JsonSchema,
  McpServerEntry,
  McpServerPayload,
  PermissionAction,
  PermissionSubject,
  QuestionAnswer,
  QuestionItem,
  QuestionReply,
  SubjectRequest,
  ToolCallRef,
  ToolSpec,
  Usage,
} from "../protocol/index.js";
import type { AttachmentStore } from "./attachments.js";

// ── 工具定义 ──────────────────────────────────────────────

export interface ToolTraits {
  /** 执行是否可能改变外部状态 */
  mutates: boolean;
  /** 能否与其他 concurrencySafe 调用并行执行 */
  concurrencySafe: boolean;
  /** 默认超时（毫秒） */
  timeoutMs: number;
  /** 调用方可指定超时时的上限 */
  maxTimeoutMs?: number | undefined;
  /** 模型可见输出字符上限，默认 30000 */
  maxModelChars?: number | undefined;
  /**
   * 执行时需要与用户交互输入（ADR-0032 §5）：声明后
   * ToolContext.askUser 可用；子代理（非交互）的可选工具池
   * 按此特性排除，不按名字判断。
   */
  needsUser?: boolean | undefined;
  /**
   * 编辑工具归属（ADR-0035 §5）：声明后仅当模型的
   * capabilities.editTool 等于该值时对模型可见（specs 不列出、
   * 执行按 unknown_tool 结算）；未声明始终可见。子代理按子会话
   * 模型的同一能力值筛池。
   */
  editTool?: EditToolKind | undefined;
}

/**
 * 工具结果携带的图片附件（ADR-0023 第 2 节）：原始字节由执行器
 * 经 AttachmentStore 落盘，事件与历史里只保留引用；字节不得进入
 * 事件、HistoryEntry 或 Hook 输入。
 */
export interface ToolResultAttachment {
  mimeType: ImageMimeType;
  data: Uint8Array;
  label?: string | undefined;
}

export type ToolResult<Output = unknown> =
  | {
      status: "ok";
      modelContent: string;
      output?: Output;
      attachments?: ToolResultAttachment[] | undefined;
    }
  | {
      status: "error";
      modelContent: string;
      output?: Output;
      attachments?: ToolResultAttachment[] | undefined;
      error: { code: string; message: string };
    };

/** 求值权限主体时可用的最少信息（tool-api.md 第 2 节） */
export interface ToolScope {
  /** 会话工作目录（绝对路径） */
  cwd: string;
  /** 已解析为真实路径的工作区根目录 */
  workspaceRoot: string;
  /** 词法路径操作（无 I/O），供 permissionSubjects 规范化目标 */
  paths: PathOps;
  /**
   * 当前生效 shell 的解析结果（ADR-0022）：scope 组装时按次取值，
   * permissionSubjects / validateInput 用它选择分词方言与分页器名单；
   * 缺省（未装配 provider）按 POSIX 保守处理。
   */
  shell?: ShellResolution | undefined;
}

/** "先读后写"所需的已读记录（tools.md 第 6 节；read 与用户 @文件 文本引用记录） */
export interface ReadStateStore {
  record(path: string, stat: { mtimeMs: number; size: number }): void;
  get(path: string): { mtimeMs: number; size: number } | undefined;
}

/** 执行时可用的能力（tool-api.md 第 2 节） */
export interface ToolContext extends ToolScope {
  sessionId: string;
  turnId: string;
  /** Runtime 分配的调用标识 */
  callId: string;
  /** 中断或超时触发；工具必须响应 */
  signal: AbortSignal;
  /** 已批准的、解析后的主体 */
  subjects: PermissionSubject[];
  /** 只读策略查询：枚举类工具逐条过滤结果；词法判定，不触发确认 */
  permissions: { check(subject: SubjectRequest): PermissionAction };
  fs: FileSystem;
  process: ProcessRunner;
  readState: ReadStateStore;
  /**
   * shell 子进程环境中要剥离的变量名（provider-setup.md 第 4 节：
   * 凭据变量不进模型驱动的子进程环境）
   */
  shellEnvStrip?: readonly string[] | undefined;
  /** 产生 tool.progress 临时事件；stdout/stderr 可为半行，info 是无末尾换行的独立行 */
  progress(chunk: string, stream?: "stdout" | "stderr" | "info"): void;
  /**
   * 向用户提问的能力（ADR-0032 §3）：发出 question.requested 并等待
   * respondQuestion 命令。非交互环境返回 unavailable（不发事件）；
   * 中断/超时经 signal 使返回的 Promise 拒绝，由执行器统一结算。
   * 缺省 = 运行环境未提供提问通道，工具按 not_interactive 结算。
   */
  askUser?(request: AskUserRequest): Promise<AskUserReply>;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  /** 模型可见的唯一名称：小写字母、数字、下划线 */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  traits: ToolTraits;
  /**
   * 工具来源标记（ADR-0023）：MCP 连接器包装的工具为 "mcp"，
   * 用于给结果附件标注 ImageAttachment.source；缺省为内置/本地来源。
   */
  origin?: "mcp" | undefined;
  /** 纯函数：本次调用会碰到什么；不得做 I/O */
  permissionSubjects(input: Input, scope: ToolScope): SubjectRequest[];
  /**
   * 可选的额外输入预检（纯函数，无 I/O）：在 schema 校验与 PreToolUse Hook
   * （含 updatedInput 重新校验）之后、权限主体求值之前调用；返回非空的
   * 错误说明即以 invalid_input 拒绝该调用——不请求权限，不执行工具。
   * scope 参数（ADR-0022）携带当前生效 shell，供分页器等按种类的检查使用。
   */
  validateInput?(input: Input, scope?: ToolScope): string | undefined;
  /** 只在权限允许后被调用 */
  execute(input: Input, ctx: ToolContext): Promise<ToolResult<Output>>;
}

// ── 注册表 ────────────────────────────────────────────────

export interface ToolRegistry {
  /** 名称重复时抛错，不静默覆盖 */
  register(tool: ToolDefinition): void;
  unregister(name: string): void;
  /**
   * 按名称取工具；携带 editTool 时同时按 ADR-0035 §5 的可见性
   * 筛选——未对当前模型暴露的工具返回 undefined（执行按
   * unknown_tool 结算）。不带能力值时不筛选。
   */
  get(name: string, editTool?: EditToolKind): ToolDefinition | undefined;
  /** 全部已注册工具（不经可见性筛选） */
  list(): ToolDefinition[];
  /**
   * 交给 Context Builder / Provider 的模型可见部分（ADR-0035 §5）：
   * 携带 editTool 时只列出对当前模型暴露的工具。
   */
  specs(editTool?: EditToolKind): ToolSpec[];
}

// ── 执行管线 ──────────────────────────────────────────────

// ── 向用户提问（ADR-0032）─────────────────────────────────

/** ToolContext.askUser 的入参：按 ADR-0032 §1 规范化的问题集（1–4 题） */
export interface AskUserRequest {
  questions: QuestionItem[];
}

/**
 * ToolContext.askUser 的返回（ADR-0032 §3）：answered 包含逐题回答或拒绝
 * 提问；unavailable 表示当前环境不可提问（非交互——不发 question.requested）。
 * 中断与超时不经返回值表达：实现按 signal 拒绝返回的 Promise，
 * 由执行器统一结算为 cancelled / timeout。
 */
export type AskUserReply =
  { kind: "answered"; answers: QuestionAnswer[] } | { kind: "unavailable" };

/**
 * 提问请求的路由（ADR-0032 §3）：等待中的请求与会话命令
 * respondQuestion 按 requestId 配对。经 ExecutionEnvironment
 * 注入执行器（与 PermissionGate 同一手法），工具侧只见 askUser 能力，
 * 不接触会话或事件发布器。
 */
export interface QuestionBroker {
  /** 登记并等待回复；signal 中断时拒绝返回的 Promise */
  ask(
    callId: string,
    request: AskUserRequest,
    turn: GateTurnContext,
    signal: AbortSignal,
  ): Promise<AskUserReply>;
  /**
   * 客户端命令侧：回复等待中的请求。回复校验不通过返回
   * "invalid_reply" 且请求保持等待；未知或已结算返回 "unknown_request"。
   */
  respond(requestId: string, reply: QuestionReply): "ok" | "invalid_reply" | "unknown_request";
  /** 会话关闭：取消全部等待中的请求（ask 返回的 Promise 拒绝） */
  cancelAll(): void;
}

// ── Hooks（hooks.md）──────────────────────────────────────

// ── MCP 装配点（mcp.md 第 8 节）──────────────────────────

/** 合并配置层后交给装配点的单服务器配置 */
export interface McpServerConfig extends McpServerEntry {
  name: string;
  origin: "app" | "user" | "project";
  /** 定义该条目的配置文件所在目录；相对 cwd 按 workspaceRoot 解析 */
  dir?: string | undefined;
}

/** 会话内服务器状态（mcp.md 第 5 节；status() 返回值） */
export interface McpServerStatus {
  name: string;
  state: "starting" | "ready" | "failed" | "crashed" | "stopped";
  toolCount: number;
  /** failed / crashed 的人读原因 */
  error?: string | undefined;
  /** 已发生的惰性重连次数 */
  restarts: number;
}

/** open() 的运行环境：由 index.ts（Runtime 装配处）构造 */
export interface McpOpenScope {
  servers: readonly McpServerConfig[];
  cwd: string;
  workspaceRoot: string;
  sessionId: string;
  platform: Platform;
  credentials?:
    | { get(id: string, options?: { fresh?: boolean | undefined }): Promise<string | undefined> }
    | undefined;
  /** 发出 mcp.server 临时事件 */
  emitServer(payload: McpServerPayload): void;
  /** 发出 runtime.warning 临时事件 */
  warn(code: string, message: string): void;
  diagnostics?: Diagnostics | undefined;
}

/** Turn 边界应用暂存的工具集变化（mcp.md 第 5 节 list_changed / 重连暂存） */
export interface McpToolDiff {
  add: ToolDefinition[];
  remove: string[];
}

/**
 * 会话级 MCP 连接集合。tools() 返回当前生效的包装工具；
 * list_changed 与惰性重连刷新的工具集先暂存，applyPendingTools()
 * 在 Turn 边界由 Runtime 调用并应用到会话注册表。
 */
export interface McpSession {
  reconcile(servers: readonly McpServerConfig[]): Promise<void>;
  tools(): readonly ToolDefinition[];
  status(): McpServerStatus[];
  applyPendingTools(): McpToolDiff;
  close(): Promise<void>;
}

/**
 * RuntimeOptions.mcp 注入点（modules.md：Core 不依赖 mcp 模块）：
 * packages/mcp 提供实现，CLI/TUI 装配时传入。
 */
export interface McpConnector {
  probe(scope: McpOpenScope): Promise<McpProbeResult>;
  open(scope: McpOpenScope): Promise<McpSession>;
}

/** Agent Loop 提供给 Executor 的运行环境；工具看不到它 */
export interface ExecutionScope extends ToolScope {
  checkpoint?: ExecutionEnvironment["checkpoint"];
  sessionId: string;
  turnId: string;
  /** Turn 级中断信号 */
  signal: AbortSignal;
  platform: Platform;
  gate: PermissionGate;
  readState: ReadStateStore;
  events: ToolEventSink;
  /** 超预算输出落盘根目录：<sessionsDir>/attachments（tools.md 第 4 节） */
  attachmentsDir?: string | undefined;
  /** 会话级图片附件存储（ADR-0023）；缺省时附件保存按失败降级并注明 */
  attachments?: AttachmentStore | undefined;
  /** 会话级 Hook 执行器；缺省时执行管线与未启用一致（hooks.md 第 8 节） */
  hooks?: HookRunner | undefined;
  /** 诊断通道；缺省为 no-op（observability.md） */
  diagnostics?: Diagnostics | undefined;
  /** shell 子进程环境中要剥离的变量名（凭据变量；provider-setup.md 第 4 节） */
  shellEnvStrip?: readonly string[] | undefined;
  /** 提问通道（ADR-0032）：缺省时声明 needsUser 的工具按 not_interactive 结算 */
  askUser?: QuestionBroker | undefined;
  /**
   * 当前会话模型的编辑工具能力（ADR-0035 §5）：Agent Loop 每次调用
   * 按当时模型取值，模型切换后下一次调用即生效；缺省不筛选。
   */
  editTool?: EditToolKind | undefined;
}

/**
 * 当前生效 shell 的延迟解析（ADR-0022）：每次工具调用组装 scope 时
 * 求值，运行中经 /shell 切换从下一次调用起生效，不在 Turn 开始快照。
 */
export interface ShellProvider {
  current(): ShellResolution;
}

/**
 * 会话级执行环境：Agent Loop 只持有本类型（tools 的公开类型），
 * 不直接接触 Platform——平台能力经 ExecutionScope 进入工具。
 */
export interface ExecutionEnvironment {
  /** ADR-0041: root-session recorder; executors supply resolved subjects. */
  checkpoint?:
    | ((
        phase: "before" | "after",
        callId: string,
        subjects: readonly PermissionSubject[],
        sessionId: string,
      ) => Promise<void>)
    | undefined;
  platform: Platform;
  gate: PermissionGate;
  readState: ReadStateStore;
  /** 超预算输出落盘根目录；缺省时不落盘（只截断） */
  attachmentsDir?: string | undefined;
  /** 会话级图片附件存储（ADR-0023）；缺省时结果附件按保存失败降级 */
  attachments?: AttachmentStore | undefined;
  hooks?: HookRunner | undefined;
  diagnostics?: Diagnostics | undefined;
  /** shell 子进程环境中要剥离的变量名（凭据变量；provider-setup.md 第 4 节） */
  shellEnvStrip?: readonly string[] | undefined;
  /** 生效 shell 的延迟解析（ADR-0022）；缺省时工具按平台默认 shell 执行 */
  shell?: ShellProvider | undefined;
  /** 提问通道（ADR-0032）：缺省时声明 needsUser 的工具按 not_interactive 结算 */
  askUser?: QuestionBroker | undefined;
}
export interface TurnCallScope {
  cwd: string;
  workspaceRoot: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  events: ToolEventSink;
  /** 当前模型的编辑工具能力（ADR-0035 §5）；缺省不筛选 */
  editTool?: EditToolKind | undefined;
}

export type ToolExecutionStatus = "ok" | "error" | "denied" | "cancelled";

export interface ToolExecution {
  status: ToolExecutionStatus;
  result: ToolResult;
  /** 用户选择了"拒绝并停止" */
  stopTurn: boolean;
}

export interface ToolExecutor {
  /** 运行执行管线，保证发出恰好一个 tool.completed（tools.md 第 3 节） */
  execute(call: ToolCallRef, scope: ExecutionScope): Promise<ToolExecution>;
}

// ── Subagent 装配点（subagent.md 第 3 节）─────────────────

/**
 * 启动子会话的请求（subagent.md 第 1、3 节）。`preset`/`tools` 互斥，
 * 具体工具集由 launcher 在可选池上解析（explore 按 traits 筛选需要池
 * 的可见性）；task 工具只做输入预检与结果映射。
 */
export interface SubagentRequest {
  /** 交给子代理的完整任务描述（子会话看不到父会话历史，必须自包含） */
  task: string;
  /** 工具集预设：general（可选池全部）/ explore（只读工具）；缺省 general */
  preset?: "general" | "explore" | undefined;
  /** 显式工具名白名单（与 preset 互斥）；未知名 → invalid_input */
  tools?: readonly string[] | undefined;
  /** 结构化结果 schema；缺省时 finish 提交字符串结果 */
  outputSchema?: JsonSchema | undefined;
  /** 本次调用的超时上限（毫秒）；缺省由 launcher 的默认值接管 */
  timeoutMs?: number | undefined;
}

/** task 工具结果的 output 形状（subagent.md 第 1 节） */
export interface SubagentStats {
  model: string;
  childSessionId: string;
  childLogPath: string;
  turns: number;
  steps: number;
  usage?: Usage | undefined;
  /** outputSchema 生效时子代理提交的结构化结果原文 */
  structured?: unknown;
}

export type SubagentOutcome =
  | { status: "ok"; resultText: string; stats: SubagentStats }
  | {
      status: "error";
      error: { code: string; message: string };
      /** 子会话最后的文本尾部（subagent_no_result 时供父模型利用） */
      tailText?: string | undefined;
      stats?: SubagentStats | undefined;
    };

/**
 * 子会话启动器接口（subagent.md 第 3 节）。与 HookRunner 同一注入手法：
 * tools 只持有接口，实现在 agent（createSubagentLauncher），由 core/index
 * 装配注入——tools 不 import agent，无循环依赖。
 * launch 只受 ctx.signal 约束返回；取消/超时由执行器统一结算。
 */
export interface SubagentLauncher {
  launch(request: SubagentRequest, ctx: ToolContext): Promise<SubagentOutcome>;
}
