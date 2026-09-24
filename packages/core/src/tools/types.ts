/**
 * 工具契约（docs/protocols/tool-api.md）。
 * 内置工具与将来的 MCP / 插件工具走同一接口与同一执行管线（tools.md 第 1 节）。
 */
import type { FileSystem, PathOps, Platform, ProcessRunner } from "../platform/index.js";
import type { PermissionDecision } from "../permission/index.js";
import type {
  Diagnostics,
  DurablePayload,
  HookPoint,
  JsonSchema,
  McpServerEntry,
  McpServerPayload,
  PermissionAction,
  PermissionReply,
  PermissionSubject,
  RuntimeWarningPayload,
  SubjectRequest,
  ToolCallRef,
  ToolProgressPayload,
  ToolSpec,
  Usage,
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
 * check 的 Hook 上下文（hooks.md 第 6 节）：
 * PreToolUse decision:"ask" 经 forceAsk 传入——跳过 Grant/autoApproveAsk 强制确认；
 * tool/input 供 PermissionRequest Hook 的 stdin。
 */
export interface GateHookContext {
  forceAsk?: boolean | undefined;
  askReason?: string | undefined;
  tool?: string | undefined;
  input?: unknown;
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
    hookCtx?: GateHookContext,
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

// ── Hooks（hooks.md）──────────────────────────────────────

/**
 * Hook 的 stdin JSON（hooks.md 第 3 节）：公共字段随点位出现。
 * input/subjects/permission/result 只在工具相关点位存在；
 * text 在 TurnStart（本轮提示词）、SessionStart（无）等处按文档给出。
 */
export interface HookInput {
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  turnId?: string | undefined;
  callId?: string | undefined;
  /** PreToolUse / PostToolUse / PermissionRequest：工具名（含 mcp__ 前缀） */
  tool?: string | undefined;
  /** PreToolUse / PostToolUse：经 schema 校验的规范化输入 */
  input?: unknown;
  /** PermissionRequest：本次求值的主体（已解析） */
  subjects?: PermissionSubject[] | undefined;
  /** PermissionRequest：权限层当前的决定 */
  permission?: { action: PermissionAction; reason: string; rule?: string | undefined } | undefined;
  /** PostToolUse：执行结果摘要（modelContent 截断至约 4000 字符） */
  result?:
    | {
        status: string;
        modelContent: string;
        error?: { code: string; message: string } | undefined;
      }
    | undefined;
  /** TurnStart：本轮用户提示词 */
  text?: string | undefined;
  /** TurnEnd / SessionEnd：结束原因 */
  reason?: string | undefined;
  /** TurnEnd */
  steps?: number | undefined;
  usage?: Usage | undefined;
  /** SessionStart：本次为恢复会话 */
  resumed?: boolean | undefined;
  /** 子会话标记（subagent.md 第 10 节）：仅子会话的 Hook 输入携带 */
  subagent?: { parentSessionId: string; parentCallId: string; depth: number } | undefined;
}

/**
 * Hook 的 stdout JSON（hooks.md 第 3 节）。各点位允许的字段见文档：
 * PreToolUse 只允许 decision/updatedInput（无 allow）；PermissionRequest 只允许 action；
 * PostToolUse 只允许 feedback；生命周期点位允许 block。
 */
export interface HookOutput {
  /** PreToolUse：ask（强制确认，绕过 Grant/--yes）或 deny */
  decision?: "ask" | "deny" | undefined;
  reason?: string | undefined;
  /** PreToolUse：替换输入；执行器收到后重新做 schema 校验与主体解析 */
  updatedInput?: unknown;
  /** PermissionRequest：allow（放行该 ask）或 deny */
  action?: "allow" | "deny" | undefined;
  /** PostToolUse：追加给模型的反馈文本 */
  feedback?: string | undefined;
  /** 生命周期点位：非空时中止对应操作 */
  block?: boolean | undefined;
}

/**
 * 调用方提供的 Hook 输入：sessionId / cwd / workspaceRoot 由 Runner 注入
 *（它由 Runtime 按会话创建，这三个字段对该会话恒定）。
 */
export type HookCallInput = Omit<HookInput, "sessionId" | "cwd" | "workspaceRoot">;

/**
 * Hook 执行器接口（hooks.md）：由 hooks 模块实现、经 RuntimeOptions 注入
 * agent/tools/permission；无配置时字段缺省，行为与未启用完全一致。
 * run 返回 undefined 表示"无意见"（无匹配条目、超时、失败等降级均吞掉）。
 */
export interface HookRunner {
  run(
    point: HookPoint,
    input: HookCallInput,
    signal?: AbortSignal,
  ): Promise<HookOutput | undefined>;
}

// ── MCP 装配点（mcp.md 第 8 节）──────────────────────────

/** 合并配置层后交给装配点的单服务器配置 */
export interface McpServerConfig extends McpServerEntry {
  name: string;
  origin: "user" | "project";
  /** 定义该条目的配置文件所在目录（相对 cwd/env 路径的解析基点） */
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
  open(scope: McpOpenScope): Promise<McpSession>;
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
  /** 超预算输出落盘根目录：<sessionsDir>/attachments（tools.md 第 4 节） */
  attachmentsDir?: string | undefined;
  /** 会话级 Hook 执行器；缺省时执行管线与未启用一致（hooks.md 第 8 节） */
  hooks?: HookRunner | undefined;
  /** 诊断通道；缺省为 no-op（observability.md） */
  diagnostics?: Diagnostics | undefined;
}

/**
 * 会话级执行环境：Agent Loop 只持有本类型（tools 的公开类型），
 * 不直接接触 Platform——平台能力经 ExecutionScope 进入工具。
 */
export interface ExecutionEnvironment {
  platform: Platform;
  gate: PermissionGate;
  readState: ReadStateStore;
  /** 超预算输出落盘根目录；缺省时不落盘（只截断） */
  attachmentsDir?: string | undefined;
  hooks?: HookRunner | undefined;
  diagnostics?: Diagnostics | undefined;
}
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
