/**
 * 持久化事件的运行时校验与稳定序列化（events.md 第 5、8 节）。
 * 会话恢复时逐行使用；不认识的持久化事件类型必须拒绝（session_log_newer）。
 * 已知事件中的未知字段按演进规则忽略（Zod object 默认剥离）。
 */
import { z } from "zod";
import { DURABLE_EVENT_TYPES, type DurableEvent, type DurableType } from "./events.js";
import { PROTOCOL_ENDPOINTS, normalizePermissionPreset, type ModelProtocol } from "./types.js";

// ── 公共类型 schema ────────────────────────────────────────

const modelRefSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

const contentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("reasoning"),
    text: z.string(),
    provider: z.string().optional(),
    providerData: z.unknown().optional(),
  }),
]);

const toolCallRefSchema = z.object({
  callId: z.string(),
  providerCallId: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional(),
  rawInput: z.string().optional(),
});

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
});

const permissionSubjectSchema = z.object({
  kind: z.enum(["read", "edit", "shell", "network", "mcp", "subagent"]),
  target: z.string(),
  detail: z.string().optional(),
  resolved: z.string().optional(),
  where: z.enum(["workspace", "outside"]).optional(),
  // ADR-0022：执行该命令的 shell 种类（旧日志无此字段 → 按 POSIX 保守求值）
  shell: z.string().optional(),
});

const permissionActionSchema = z.enum(["allow", "ask", "deny"]);
// "hook" 在 Phase 5 已写入日志（PermissionRequest / PreToolUse 的结算来源）；
// 漏列会让含该来源的会话在恢复时校验失败——补齐是缺陷修复而非演进
const permissionSourceSchema = z.enum([
  "user",
  "rule",
  "grant",
  "hook",
  "reviewer",
  "non_interactive",
  "cancelled",
]);

const finishReasonSchema = z.enum(["stop", "tool_calls", "length", "content_filter", "other"]);

/** ReasoningEffort（types.ts）：七档中性思考档位，ADR-0018 */
const reasoningEffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const errorInfoSchema = z.object({ code: z.string(), message: z.string() });

/** ImageAttachment（ADR-0023 第 2 节）：事件里只有引用，字节在附件目录 */
const imageAttachmentSchema = z.object({
  type: z.literal("image"),
  file: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  label: z.string().optional(),
  source: z.enum(["paste", "read", "mcp"]),
});

const fileRefSchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory", "image"]),
  lines: z.number().int().nonnegative().optional(),
  totalLines: z.number().int().nonnegative().optional(),
  chars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

// ── payload schema ─────────────────────────────────────────

const payloadSchemas = {
  "session.rewound": z.object({
    targetSeq: z.number().int().positive(),
    mode: z.enum(["both", "conversation", "files"]),
    files: z.array(
      z.object({
        path: z.string(),
        result: z.enum(["restored", "deleted", "skipped", "failed"]),
        reason: z.string().optional(),
      }),
    ),
  }),
  "checkpoint.file": z.intersection(
    z.object({ callId: z.string(), path: z.string(), sessionId: z.string().optional() }),
    z.discriminatedUnion("phase", [
      z.object({
        phase: z.literal("before"),
        before: z.union([
          z.object({
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().nonnegative(),
          }),
          z.null(),
          z.object({ untracked: z.string() }),
        ]),
      }),
      z.object({
        phase: z.literal("after"),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    ]),
  ),
  "session.titled": z.object({
    title: z.string().min(1),
    model: z.string(),
    usage: usageSchema.optional(),
  }),
  "attachment.described": z.object({
    attachmentRef: z.object({
      seq: z.number().int().positive(),
      index: z.number().int().nonnegative(),
    }),
    model: z.string(),
    text: z.string(),
    usage: usageSchema.optional(),
  }),
  "session.created": z.object({
    formatVersion: z.number().int(),
    nocturneVersion: z.string(),
    cwd: z.string(),
    workspaceRoot: z.string(),
    model: modelRefSchema,
    permissionPreset: z.string().transform(normalizePermissionPreset),
    reasoningEffort: reasoningEffortSchema.optional(),
    parent: z.object({ sessionId: z.string(), callId: z.string() }).optional(),
  }),
  "session.config_changed": z.object({
    model: modelRefSchema.optional(),
    permissionPreset: z.string().transform(normalizePermissionPreset).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    shell: z.object({ kind: z.string(), path: z.string() }).optional(),
  }),
  "turn.started": z.object({ turnIndex: z.number().int() }),
  "message.user": z.object({
    messageId: z.string(),
    content: z.array(contentBlockSchema),
    attachments: z.array(imageAttachmentSchema).optional(),
    fileRefs: z.array(fileRefSchema).optional(),
  }),
  "message.assistant": z.object({
    messageId: z.string(),
    model: modelRefSchema,
    // ADR-0026 §6：产生该消息的生效协议（可选，旧版本忽略）；取值随 ModelProtocol
    protocol: z
      .enum(Object.keys(PROTOCOL_ENDPOINTS) as [ModelProtocol, ...ModelProtocol[]])
      .optional(),
    content: z.array(contentBlockSchema),
    toolCalls: z.array(toolCallRefSchema),
    usage: usageSchema.optional(),
    finishReason: z.union([finishReasonSchema, z.literal("aborted")]),
  }),
  "tool.started": z.object({
    mutates: z.boolean().optional(),
    callId: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
    subjects: z.array(permissionSubjectSchema),
    permission: z.object({
      action: permissionActionSchema,
      source: permissionSourceSchema,
      rule: z.string().optional(),
    }),
  }),
  "permission.requested": z.object({
    requestId: z.string(),
    callId: z.string(),
    subjects: z.array(permissionSubjectSchema),
    reason: z.string(),
    options: z.array(z.enum(["allow_once", "allow_session", "allow_project", "deny", "deny_stop"])),
  }),
  "permission.reviewed": z.object({
    callId: z.string(),
    requestId: z.string().optional(),
    backend: z.string(),
    model: modelRefSchema.optional(),
    verdict: z.enum(["allow", "block", "unsure"]),
    reason: z.string(),
    durationMs: z.number().nonnegative(),
    cached: z.boolean(),
    usage: usageSchema.optional(),
  }),
  "permission.resolved": z.object({
    requestId: z.string().optional(),
    callId: z.string(),
    action: z.enum(["allow", "deny"]),
    source: permissionSourceSchema,
    rule: z.string().optional(),
    remember: z.enum(["session", "project"]).optional(),
    feedback: z.string().optional(),
  }),
  "tool.completed": z.object({
    callId: z.string(),
    name: z.string(),
    status: z.enum(["ok", "error", "denied", "cancelled", "interrupted"]),
    modelContent: z.string(),
    output: z.unknown().optional(),
    error: errorInfoSchema.optional(),
    truncated: z.boolean().optional(),
    spillPath: z.string().optional(),
    attachments: z.array(imageAttachmentSchema).optional(),
    durationMs: z.number().optional(),
  }),
  "context.compacted": z.object({
    kind: z.enum(["prune", "summary"]),
    throughSeq: z.number().int(),
    summary: z.string().optional(),
  }),
  "turn.completed": z.object({
    reason: z.enum(["done", "truncated", "refused", "aborted", "max_steps", "error"]),
    steps: z.number().int(),
    usage: usageSchema,
    error: errorInfoSchema.optional(),
    recovered: z.boolean().optional(),
  }),
} satisfies Record<DurableType, z.ZodType>;

// ── 事件信封 schema ────────────────────────────────────────

function envelope<T extends DurableType>(type: T, payload: (typeof payloadSchemas)[T]) {
  return z.object({
    type: z.literal(type),
    sessionId: z.string(),
    seq: z.number().int().positive(),
    time: z.string(),
    turnId: z.string().optional(),
    payload,
  });
}

export const durableEventSchema = z.discriminatedUnion("type", [
  envelope("session.rewound", payloadSchemas["session.rewound"]),
  envelope("checkpoint.file", payloadSchemas["checkpoint.file"]),
  envelope("session.created", payloadSchemas["session.created"]),
  envelope("session.config_changed", payloadSchemas["session.config_changed"]),
  envelope("session.titled", payloadSchemas["session.titled"]),
  envelope("turn.started", payloadSchemas["turn.started"]),
  envelope("message.user", payloadSchemas["message.user"]),
  envelope("message.assistant", payloadSchemas["message.assistant"]),
  envelope("tool.started", payloadSchemas["tool.started"]),
  envelope("permission.requested", payloadSchemas["permission.requested"]),
  envelope("permission.resolved", payloadSchemas["permission.resolved"]),
  envelope("permission.reviewed", payloadSchemas["permission.reviewed"]),
  envelope("tool.completed", payloadSchemas["tool.completed"]),
  envelope("attachment.described", payloadSchemas["attachment.described"]),
  envelope("context.compacted", payloadSchemas["context.compacted"]),
  envelope("turn.completed", payloadSchemas["turn.completed"]),
]);

// ── 解析错误 ───────────────────────────────────────────────

export type EventParseErrorCode =
  /** 该行不是合法 JSON 或不是对象 */
  | "invalid_json"
  /** 结构或字段不符合信封 / payload 契约 */
  | "invalid_event"
  /** 不认识的持久化事件类型（恢复时必须拒绝，events.md 第 8 节） */
  | "unknown_event_type";

export class EventParseError extends Error {
  readonly code: EventParseErrorCode;
  constructor(code: EventParseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventParseError";
    this.code = code;
  }
}

const DURABLE_TYPES: ReadonlySet<string> = new Set(DURABLE_EVENT_TYPES);

/**
 * 把一行日志文本解析为持久化事件。
 * 只做解析与校验；seq 连续性、formatVersion 检查由调用方（session）负责。
 */
export function decodeDurableEvent(line: string): DurableEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    throw new EventParseError("invalid_json", "日志行不是合法 JSON", {
      cause,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EventParseError("invalid_event", "日志行不是事件对象");
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type === "string" && !DURABLE_TYPES.has(type)) {
    throw new EventParseError("unknown_event_type", `不认识的持久化事件类型: ${type}`);
  }
  const parsed = durableEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EventParseError(
      "invalid_event",
      `事件不符合契约: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      { cause: parsed.error },
    );
  }
  return parsed.data as DurableEvent;
}

/** 稳定序列化：持久化事件只含 JSON 可表达的数据 */
export function encodeDurableEvent(event: DurableEvent): string {
  return JSON.stringify(event);
}
