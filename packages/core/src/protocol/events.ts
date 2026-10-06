/**
 * 事件信封与事件类型（docs/protocols/events.md 第 2、3 节）。
 * 持久化事件构成会话日志的唯一事实来源；临时事件只发布不写日志。
 */
import type { SkillSnapshot } from "./skills.js";
import type {
  ContentBlock,
  FileRef,
  FinishReason,
  ImageAttachment,
  ModelProtocol,
  ModelRef,
  PermissionAction,
  PermissionOption,
  PermissionSource,
  PermissionSubject,
  QuestionItem,
  ReasoningEffort,
  ToolCallRef,
  Usage,
} from "./types.js";

// ── 持久化事件 payload ─────────────────────────────────────

export interface SessionCreatedPayload {
  /** 整个日志共用的格式版本，见 LOG_FORMAT_VERSION */
  formatVersion: number;
  nocturneVersion: string;
  cwd: string;
  workspaceRoot: string;
  model: ModelRef;
  permissionPreset: string;
  /** 初始思考档位（ADR-0018）；缺省按 off 处理 */
  reasoningEffort?: ReasoningEffort | undefined;
  /** 子会话的父关联（Phase 6，subagent.md 第 5 节）；仅子会话存在 */
  parent?: { sessionId: string; callId: string } | undefined;
  forkedFrom?: { sessionId: string; seq: number } | undefined;
}

export interface SessionConfigChangedPayload {
  model?: ModelRef | undefined;
  permissionPreset?: string | undefined;
  /** 思考档位切换（ADR-0018）；payload 中存在的键覆盖当前值 */
  reasoningEffort?: ReasoningEffort | undefined;
  /**
   * shell 切换（ADR-0022）：记录生效的种类与可执行文件。
   * 只记录实际发生切换的事件（上层 env/config 覆盖时不发）。
   */
  shell?: { kind: string; path: string } | undefined;
}

export interface TurnStartedPayload {
  turnIndex: number;
}

export interface MessageUserPayload {
  messageId: string;
  content: ContentBlock[];
  /** 随消息附带的图片引用（ADR-0023，粘贴/拖入）；无附件时缺省 */
  attachments?: ImageAttachment[] | undefined;
  fileRefs?: FileRef[] | undefined;
  /** 技能调用随消息持久化的正文快照（skills.md 第 2 节）；普通消息缺省 */
  skill?: SkillSnapshot | undefined;
}

export interface AttachmentDescribedPayload {
  attachmentRef: { seq: number; index: number };
  model: string;
  /** 空串记录已失败的描述尝试，恢复后仍不重试。 */
  text: string;
  usage?: Usage | undefined;
}

export interface SessionTitledPayload {
  title: string;
  model: string;
  usage?: Usage | undefined;
}

export interface MessageAssistantPayload {
  messageId: string;
  model: ModelRef;
  /**
   * 产生本条消息的生效协议（ADR-0026 §6）：可选，旧版本读取忽略；
   * 无协议的 Provider（FakeProvider 等）不写。缺省时跨上下文回传
   * providerData 只比较服务商，与 ADR-0026 之前的行为一致。
   */
  protocol?: ModelProtocol | undefined;
  content: ContentBlock[];
  toolCalls: ToolCallRef[];
  usage?: Usage | undefined;
  finishReason: FinishReason | "aborted";
}

export interface ToolStartedPayload {
  callId: string;
  name: string;
  /** 规范化后的输入 */
  input: unknown;
  /** 解析后的权限主体 */
  subjects: PermissionSubject[];
  /** `rule` 为命中规则的人读说明（permissions.md 5.3） */
  permission: { action: PermissionAction; source: PermissionSource; rule?: string | undefined };
  /** 工具声明其结果参与历史折叠（tools.md 第 4 节 pinResult）；缺省同 false */
  pinResult?: boolean | undefined;
  mutates?: boolean | undefined;
}

export interface PermissionRequestedPayload {
  requestId: string;
  callId: string;
  subjects: PermissionSubject[];
  reason: string;
  options: PermissionOption[];
}

export interface PermissionReviewedPayload {
  callId: string;
  requestId?: string | undefined;
  backend: string;
  model?: ModelRef | undefined;
  verdict: "allow" | "block" | "unsure";
  reason: string;
  durationMs: number;
  cached: boolean;
  /** 来源为安全审查的独立用量；不计入上下文。 */
  usage?: Usage | undefined;
}

export interface PermissionResolvedPayload {
  requestId?: string | undefined;
  callId: string;
  action: "allow" | "deny";
  source: PermissionSource;
  rule?: string | undefined;
  remember?: "session" | "project" | undefined;
  feedback?: string | undefined;
}

import type { ToolCallStatus } from "./types.js";

export type { ToolCallStatus };

export interface ToolCompletedPayload {
  callId: string;
  name: string;
  status: ToolCallStatus;
  /** 交给模型的文本，已按大小上限截断 */
  modelContent: string;
  /** 结构化结果，供客户端渲染，不发送给模型 */
  output?: unknown;
  error?: { code: string; message: string } | undefined;
  truncated?: boolean | undefined;
  /** 超预算输出的落盘文件绝对路径（tools.md 第 4 节） */
  spillPath?: string | undefined;
  /** 工具结果附带的图片引用（ADR-0023）；字节已落盘，事件只含引用 */
  attachments?: ImageAttachment[] | undefined;
  durationMs?: number | undefined;
}

export interface ContextCompactedPayload {
  kind: "prune" | "summary";
  throughSeq: number;
  summary?: string | undefined;
}

export type TurnEndReason = "done" | "truncated" | "refused" | "aborted" | "max_steps" | "error";

export interface TurnCompletedPayload {
  reason: TurnEndReason;
  steps: number;
  usage: Usage;
  error?: { code: string; message: string } | undefined;
  /** 恢复修复补写时为 true */
  recovered?: boolean | undefined;
}

// ── 临时事件 payload ───────────────────────────────────────

export interface AssistantDeltaPayload {
  messageId: string;
  kind: "text" | "reasoning";
  delta: string;
}

export interface ToolInputDeltaPayload {
  callId: string;
  name: string;
  /** 参数 JSON 片段，仅供显示 */
  delta: string;
}

export interface ToolProgressPayload {
  callId: string;
  stream: "stdout" | "stderr" | "info";
  chunk: string;
}

export type RuntimeStatus =
  | "idle"
  | "thinking"
  | "running_tool"
  | "waiting_permission"
  /** 等待用户回答 ask_user（ADR-0032 §3） */
  | "waiting_user"
  | "retrying"
  | "compacting"
  | "describing_images"
  | "failed";

export interface RuntimeStatusPayload {
  status: RuntimeStatus;
}

export interface ProviderRetryPayload {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: { kind: string; message: string };
}

export interface RuntimeWarningPayload {
  code: string;
  message: string;
}

export interface RuntimeErrorPayload {
  code: string;
  message: string;
}

/**
 * MCP 服务器状态变化（mcp.md 第 5 节）：临时事件，不持久化。
 * `failed`/`crashed` 同时伴随 runtime.warning 供客户端显示原因。
 */
export interface McpServerPayload {
  name: string;
  state: "starting" | "ready" | "failed" | "crashed" | "stopped";
  toolCount?: number | undefined;
  error?: string | undefined;
}

/**
 * ask_user 待回答的问题（ADR-0032 §3）：临时事件——问题已记录在
 * tool.started.input、回答记录在 tool.completed.output，不持久化。
 */
export interface QuestionRequestedPayload {
  requestId: string;
  callId: string;
  questions: QuestionItem[];
}

// ── 类型映射与信封 ─────────────────────────────────────────

export type CheckpointBefore = { sha256: string; size: number } | null | { untracked: string };
export interface SessionRewoundPayload {
  targetSeq: number;
  mode: "both" | "conversation" | "files";
  files: {
    path: string;
    result: "restored" | "deleted" | "skipped" | "failed";
    reason?: string | undefined;
  }[];
}
export type CheckpointFilePayload = {
  callId: string;
  path: string;
  sessionId?: string;
} & ({ phase: "before"; before: CheckpointBefore } | { phase: "after"; sha256: string | null });

export interface DurablePayloadMap {
  "session.rewound": SessionRewoundPayload;
  "checkpoint.file": CheckpointFilePayload;
  "session.created": SessionCreatedPayload;
  "session.config_changed": SessionConfigChangedPayload;
  "session.titled": SessionTitledPayload;
  "turn.started": TurnStartedPayload;
  "message.user": MessageUserPayload;
  "attachment.described": AttachmentDescribedPayload;
  "message.assistant": MessageAssistantPayload;
  "tool.started": ToolStartedPayload;
  "permission.requested": PermissionRequestedPayload;
  "permission.resolved": PermissionResolvedPayload;
  "permission.reviewed": PermissionReviewedPayload;
  "tool.completed": ToolCompletedPayload;
  "context.compacted": ContextCompactedPayload;
  "turn.completed": TurnCompletedPayload;
}

export interface EphemeralPayloadMap {
  "message.assistant.delta": AssistantDeltaPayload;
  "tool.input.delta": ToolInputDeltaPayload;
  "tool.progress": ToolProgressPayload;
  "runtime.status": RuntimeStatusPayload;
  "provider.retry": ProviderRetryPayload;
  "runtime.warning": RuntimeWarningPayload;
  "runtime.error": RuntimeErrorPayload;
  "mcp.server": McpServerPayload;
  "question.requested": QuestionRequestedPayload;
}

export type DurableType = keyof DurablePayloadMap;
export type EphemeralType = keyof EphemeralPayloadMap;

export type DurablePayload<T extends DurableType = DurableType> = DurablePayloadMap[T];
export type EphemeralPayload<T extends EphemeralType = EphemeralType> = EphemeralPayloadMap[T];

/** 持久化事件：写入日志，seq 从 1 连续递增（events.md 第 2 节） */
export interface DurableEventFor<T extends DurableType> {
  type: T;
  sessionId: string;
  seq: number;
  /** ISO 8601 */
  time: string;
  /** Turn 内的事件必须携带；会话级事件没有 */
  turnId?: string | undefined;
  payload: DurablePayloadMap[T];
}

/** 临时事件：只发布不写日志，不占用 seq */
export interface EphemeralEventFor<T extends EphemeralType> {
  type: T;
  sessionId: string;
  /** 本次打开会话时生成，每次恢复都不同 */
  runId: string;
  /** 运行内从 1 开始递增 */
  eseq: number;
  /** 发出时最后一个持久化事件的 seq，用于对齐顺序 */
  afterSeq: number;
  time: string;
  turnId?: string | undefined;
  payload: EphemeralPayloadMap[T];
}

/** 分布为可判别联合：按 event.type 收窄 payload 类型 */
export type DurableEvent<T extends DurableType = DurableType> = T extends unknown
  ? DurableEventFor<T>
  : never;
export type EphemeralEvent<T extends EphemeralType = EphemeralType> = T extends unknown
  ? EphemeralEventFor<T>
  : never;

export type RuntimeEvent = DurableEvent | EphemeralEvent;

export const DURABLE_EVENT_TYPES: readonly DurableType[] = [
  "session.rewound",
  "checkpoint.file",
  "session.created",
  "session.config_changed",
  "session.titled",
  "turn.started",
  "message.user",
  "attachment.described",
  "message.assistant",
  "tool.started",
  "permission.requested",
  "permission.resolved",
  "permission.reviewed",
  "tool.completed",
  "context.compacted",
  "turn.completed",
];

const DURABLE_TYPE_SET: ReadonlySet<string> = new Set(DURABLE_EVENT_TYPES);

export function isDurableEventType(type: string): type is DurableType {
  return DURABLE_TYPE_SET.has(type);
}

export const EPHEMERAL_EVENT_TYPES: readonly EphemeralType[] = [
  "message.assistant.delta",
  "tool.input.delta",
  "tool.progress",
  "runtime.status",
  "provider.retry",
  "runtime.warning",
  "runtime.error",
  "mcp.server",
  "question.requested",
];

const EPHEMERAL_TYPE_SET: ReadonlySet<string> = new Set(EPHEMERAL_EVENT_TYPES);

export function isEphemeralEventType(type: string): type is EphemeralType {
  return EPHEMERAL_TYPE_SET.has(type);
}

export function isDurableEvent(event: RuntimeEvent): event is DurableEvent {
  return typeof (event as { seq?: unknown }).seq === "number";
}

/** 当前实现支持的日志格式版本（events.md 第 8 节） */
export const LOG_FORMAT_VERSION = 1;
