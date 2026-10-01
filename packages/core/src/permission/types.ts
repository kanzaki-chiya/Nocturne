/**
 * 权限层类型（docs/architecture/permissions.md 第 2 节）。
 * 策略求值与异步权限闸门共享的契约；工具与客户端只消费判定结果。
 * 主体解析（platform.resolve）由 Tool Executor 完成；
 * `where` 由本层在求值时计算（permissions.md 4.1）。
 */

import type {
  DurablePayload,
  HookPoint,
  Usage,
  ToolProgressPayload,
  RuntimeWarningPayload,
  RuntimeStatusPayload,
  QuestionRequestedPayload,
  PermissionReply,
  SubjectRequest,
  ModelRef,
  PermissionAction,
  PermissionSource,
  PermissionSubject,
  RuleHit,
} from "../protocol/index.js";

/** 一次求值的结论（events.md：tool.started.permission / permission.resolved） */
export interface PermissionDecision {
  action: PermissionAction;
  source: PermissionSource;
  /** 可解释的原因说明，写入事件与诊断 */
  reason: string;
  /** 命中的规则及来源（permissions.md 5.3）；Grant / 兜底 ask 等无规则本体时 rule 缺省 */
  matchedRule?: RuleHit | undefined;
}

/** 求值结果：填好 `where` 的主体列表 + 统一决定 */
export interface SubjectEvaluation {
  subjects: PermissionSubject[];
  decision: PermissionDecision;
  /** 最终仍需确认的主体；只由用户确认的主体禁止交给审查器。 */
  reviewSubjects?: ReviewSubject[] | undefined;
  userOnly?: boolean | undefined;
}

/** evaluate 的可选行为开关 */
export interface EvaluateOptions {
  /**
   * Hook 强制 ask 时置真（hooks.md / permissions.md 5.5）：跳过 Grant 与
   * autoApproveAsk——Hook 要求的确认不能被既有授权或 --yes 自动放行；
   * 规则层的 allow/ask/deny 判定不受影响。
   */
  skipApprovals?: boolean | undefined;
}

/**
 * 权限策略接口。Phase 3 将由规则排序 + Grant 实现；
 * Phase 1 为固定策略实现（workspace-read-only）。
 */
export interface PermissionPolicy {
  /**
   * 对已解析主体求值。
   * 输入主体的 `resolved` 由 Executor 经 platform 预先解析；
   * 本函数计算 `where` 并返回统一决定（permissions.md 5.3：
   * 任一主体 deny 则整体 deny）。
   */
  evaluate(subjects: readonly PermissionSubject[], options?: EvaluateOptions): SubjectEvaluation;
}

/** Executor 可发出的持久化事件类型 */
export type ToolDurableType =
  | "tool.started"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "permission.reviewed";

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
  emitEphemeral(
    type: "runtime.status",
    payload: RuntimeStatusPayload,
    options?: { turnId?: string | undefined },
  ): void;
  emitEphemeral(
    type: "question.requested",
    payload: QuestionRequestedPayload,
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

export interface ReviewSubject {
  kind: PermissionSubject["kind"];
  target: string;
  where?: PermissionSubject["where"] | undefined;
  rule?: RuleHit | undefined;
}
export interface ReviewInput {
  subjects: ReviewSubject[];
  cwd: string;
  recentUserMessages: string[];
}
export interface ReviewResult {
  verdict: "allow" | "block" | "unsure";
  reason: string;
  /** 与主模型分开记录，不进入上下文。 */
  usage?: Usage | undefined;
}
export interface SecurityReviewer {
  readonly backend?: string | undefined;
  readonly model?: ModelRef | undefined;
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewResult>;
}
