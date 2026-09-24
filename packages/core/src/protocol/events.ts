/**
 * 事件信封与事件类型（docs/protocols/events.md 第 2、3 节）。
 * 持久化事件构成会话日志的唯一事实来源；临时事件只发布不写日志。
 */
import type {
  ContentBlock,
  FinishReason,
  ModelRef,
  PermissionAction,
  PermissionOption,
  PermissionSource,
  PermissionSubject,
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
}

export interface SessionConfigChangedPayload {
  model?: ModelRef | undefined;
  permissionPreset?: string | undefined;
}

export interface TurnStartedPayload {
  turnIndex: number;
}

export interface MessageUserPayload {
  messageId: string;
  content: ContentBlock[];
}

export interface MessageAssistantPayload {
  messageId: string;
  model: ModelRef;
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
}

export interface PermissionRequestedPayload {
  requestId: string;
  callId: string;
  subjects: PermissionSubject[];
  reason: string;
  options: PermissionOption[];
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
  | "retrying"
  | "compacting"
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

// ── 类型映射与信封 ─────────────────────────────────────────

export interface DurablePayloadMap {
  "session.created": SessionCreatedPayload;
  "session.config_changed": SessionConfigChangedPayload;
  "turn.started": TurnStartedPayload;
  "message.user": MessageUserPayload;
  "message.assistant": MessageAssistantPayload;
  "tool.started": ToolStartedPayload;
  "permission.requested": PermissionRequestedPayload;
  "permission.resolved": PermissionResolvedPayload;
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
  "session.created",
  "session.config_changed",
  "turn.started",
  "message.user",
  "message.assistant",
  "tool.started",
  "permission.requested",
  "permission.resolved",
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
