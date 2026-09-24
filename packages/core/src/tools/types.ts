/**
 * 工具契约（docs/protocols/tool-api.md）。
 * 内置工具与将来的 MCP / 插件工具走同一接口与同一执行管线（tools.md 第 1 节）。
 */
import type { FileSystem, PathOps, Platform, ProcessRunner } from "../platform/index.js";
import type { PermissionDecision } from "../permission/index.js";
import type {
  DurablePayload,
  JsonSchema,
  PermissionAction,
  PermissionReply,
  PermissionSubject,
  RuntimeWarningPayload,
  SubjectRequest,
  ToolCallRef,
  ToolProgressPayload,
  ToolSpec,
} from "../protocol/index.js";

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
}

export type ToolResult<Output = unknown> =
  | { status: "ok"; modelContent: string; output?: Output }
  | {
      status: "error";
      modelContent: string;
      output?: Output;
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
}

/** "先读后写"所需的已读记录（tools.md 第 6 节；Phase 1 仅 read 记录） */
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
  /** 产生 tool.progress 临时事件 */
  progress(chunk: string, stream?: "stdout" | "stderr" | "info"): void;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  /** 模型可见的唯一名称：小写字母、数字、下划线 */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  traits: ToolTraits;
  /** 纯函数：本次调用会碰到什么；不得做 I/O */
  permissionSubjects(input: Input, scope: ToolScope): SubjectRequest[];
  /** 只在权限允许后被调用 */
  execute(input: Input, ctx: ToolContext): Promise<ToolResult<Output>>;
}

// ── 注册表 ────────────────────────────────────────────────

export interface ToolRegistry {
  /** 名称重复时抛错，不静默覆盖 */
  register(tool: ToolDefinition): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  /** 交给 Context Builder / Provider 的模型可见部分 */
  specs(): ToolSpec[];
}

// ── 执行管线 ──────────────────────────────────────────────

/** Executor 可发出的持久化事件类型 */
export type ToolDurableType =
  "tool.started" | "tool.completed" | "permission.requested" | "permission.resolved";

/** Executor 的事件出口；由 Agent Loop 用 session.emit 适配（tools 不依赖 session） */
export interface ToolEventSink {
  /** 持久化事件：先写后发（tool.started 必须在执行前写入成功） */
  emit<T extends ToolDurableType>(
    type: T,
    payload: DurablePayload<T>,
    options?: { turnId?: string | undefined },
  ): Promise<void>;
  emitEphemeral(
    type: "tool.progress",
    payload: ToolProgressPayload,
    options?: { turnId?: string | undefined },
  ): void;
  emitEphemeral(
    type: "runtime.warning",
    payload: RuntimeWarningPayload,
    options?: { turnId?: string | undefined },
  ): void;
}

/** gate.check 的返回：权限决定 + 填好 where 的主体 */
export interface GateOutcome {
  subjects: PermissionSubject[];
  decision: PermissionDecision;
  /** 用户在确认中选择"拒绝并停止"（ask 流程的 deny_stop） */
  stopTurn?: boolean | undefined;
  /** gate 内部已发出 permission.resolved（ask 流程），Executor 不再补发 */
  resolvedEmitted?: boolean | undefined;
  /** 等待 ask 回复期间被中断：Executor 按 cancelled 结算该调用 */
  cancelled?: boolean | undefined;
  /** 用户拒绝时附带给模型的反馈（PermissionReply.feedback） */
  feedback?: string | undefined;
  /** 本次应答生成的 Grant 范围（permission.resolved.remember） */
  remember?: "session" | "project" | undefined;
}

/** check 的 Turn 级上下文：ask 流程发出 permission.requested / resolved 需要它 */
export interface GateTurnContext {
  turnId: string;
  events: ToolEventSink;
}

/**
 * 权限闸门（tools.md 第 3 步 5）：Executor 只调用 check，
 * ask 的等待与取消封装在 gate 内部；checkLexical 供枚举工具过滤结果。
 */
export interface PermissionGate {
  check(
    subjects: PermissionSubject[],
    callId: string,
    signal: AbortSignal,
    turn?: GateTurnContext,
  ): Promise<GateOutcome>;
  /** 同步词法求值：结果路径位于已解析根目录之下（permissions.md 4.4） */
  checkLexical(request: SubjectRequest): PermissionAction;
  /**
   * 回复等待中的权限请求；未知或已结算的 requestId 返回 false。
   * 异步：remember="project" 时要先完成 Grant 落盘（失败降级为会话授权）。
   */
  respond?(requestId: string, reply: PermissionReply): Promise<boolean>;
  /** 会话关闭时把全部等待中的请求结算为 cancelled */
  cancelAll?(): void;
}

/** Agent Loop 提供给 Executor 的运行环境；工具看不到它 */
export interface ExecutionScope extends ToolScope {
  sessionId: string;
  turnId: string;
  /** Turn 级中断信号 */
  signal: AbortSignal;
  platform: Platform;
  gate: PermissionGate;
  readState: ReadStateStore;
  events: ToolEventSink;
}

/**
 * 会话级执行环境：Agent Loop 只持有本类型（tools 的公开类型），
 * 不直接接触 Platform——平台能力经 ExecutionScope 进入工具。
 */
export interface ExecutionEnvironment {
  platform: Platform;
  gate: PermissionGate;
  readState: ReadStateStore;
}

/** 每次调用变化的 Turn 级参数 */
export interface TurnCallScope {
  cwd: string;
  workspaceRoot: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  events: ToolEventSink;
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
