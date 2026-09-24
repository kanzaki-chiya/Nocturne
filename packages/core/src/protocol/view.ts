/**
 * 派生视图（docs/protocols/view.md）：把事件流折叠成 SessionView 的纯函数
 * reducer，供 TUI 与后续客户端共享（ADR-0002 第 5 条）。
 * 无 I/O、无 Node 内置依赖；entries 只由持久事件创建，live/notices 只由
 * 临时事件创建，收敛点上除 revision/notices 外重放等价（V1）。
 */
import type {
  DurableEvent,
  EphemeralEvent,
  PermissionResolvedPayload,
  ProviderRetryPayload,
  RuntimeEvent,
  RuntimeStatus,
  TurnEndReason,
} from "./events.js";
import { isDurableEvent, isDurableEventType, isEphemeralEventType } from "./events.js";
import type {
  ContentBlock,
  FinishReason,
  ModelRef,
  PermissionAction,
  PermissionOption,
  PermissionSource,
  PermissionSubject,
  ToolCallRef,
  ToolCallStatus,
  Usage,
} from "./types.js";

// ── 视图类型 ────────────────────────────────────────────────

export interface SessionView {
  /** 每次归约 +1；不参与重放等价 */
  revision: number;
  meta:
    | { cwd: string; workspaceRoot: string; formatVersion: number; nocturneVersion: string }
    | undefined;
  config: { model: ModelRef | undefined; permissionPreset: string | undefined };
  status: RuntimeStatus;
  retry: ProviderRetryPayload | undefined;
  currentTurn: { turnId: string; turnIndex: number } | undefined;
  lastTurn:
    | {
        turnIndex: number;
        reason: TurnEndReason;
        steps: number;
        usage: Usage;
        recovered: boolean;
      }
    | undefined;
  turnCount: number;
  usage: Usage;
  pendingPermission: PendingPermission | undefined;
  /** 只由持久事件创建（可重放） */
  entries: ViewEntry[];
  /** 只由临时事件创建；对应持久事件到达时晋升入 entries */
  live: { assistants: LiveAssistant[]; tools: LiveTool[] };
  /** 只由临时事件产生（不可重放） */
  notices: SessionNotice[];
  lastSeq: number;
}

export type ViewEntry = UserEntry | AssistantEntry | ToolEntry | NoticeEntry;

export interface UserEntry {
  kind: "user";
  key: string;
  seq: number;
  turnId: string;
  content: ContentBlock[];
}

export interface AssistantEntry {
  kind: "assistant";
  key: string;
  turnId: string;
  messageId: string;
  seq: number;
  text: string;
  reasoning: string;
  toolCalls: ToolCallRef[];
  model: ModelRef;
  usage: Usage | undefined;
  finishReason: FinishReason | "aborted";
}

export type ToolEntryStatus = "awaiting_permission" | "running" | ToolCallStatus;

export interface ToolEntry {
  kind: "tool";
  key: string;
  turnId: string;
  callId: string;
  name: string | undefined;
  seq: number;
  status: ToolEntryStatus;
  input: unknown;
  subjects: PermissionSubject[];
  permission:
    { action: PermissionAction; source: PermissionSource; rule: string | undefined } | undefined;
  resolution: PermissionResolvedPayload | undefined;
  /** tool.progress 累计；completed 时清空，收敛点上必为空 */
  liveOutput: string;
  result:
    | {
        status: ToolCallStatus;
        modelContent: string;
        output: unknown;
        error: { code: string; message: string } | undefined;
        truncated: boolean;
        spillPath: string | undefined;
        durationMs: number | undefined;
      }
    | undefined;
}

export interface NoticeEntry {
  kind: "notice";
  key: string;
  seq: number;
  subtype: "permission" | "turn_end" | "compacted" | "config";
  /** 已格式化的单行摘要（与 CLI 同文案口径） */
  message: string;
  payload: unknown;
}

export interface LiveAssistant {
  kind: "assistant";
  messageId: string;
  turnId: string | undefined;
  text: string;
  reasoning: string;
}

export interface LiveTool {
  kind: "tool";
  callId: string;
  name: string;
  turnId: string | undefined;
  inputText: string;
}

export interface PendingPermission {
  requestId: string;
  callId: string;
  toolName: string | undefined;
  subjects: PermissionSubject[];
  reason: string;
  options: PermissionOption[];
}

export interface SessionNotice {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

// ── 归约器内部簿记（不进 JSON；符号键 + 不可枚举） ──────────

interface Bookkeeping {
  /** callId → entries 中的工具条目（O(1) 查找） */
  tools: Map<string, ToolEntry>;
  /** callId → 最近的 permission.resolved payload（供晚到的 started/completed 回填） */
  resolved: Map<string, PermissionResolvedPayload>;
}

const BOOKKEEPING = Symbol("nocturne.view.bookkeeping");

type InternalView = SessionView & { [BOOKKEEPING]?: Bookkeeping };

function book(view: SessionView): Bookkeeping {
  const iv = view as InternalView;
  let b = iv[BOOKKEEPING];
  if (b === undefined) {
    b = { tools: new Map(), resolved: new Map() };
    Object.defineProperty(iv, BOOKKEEPING, { value: b, enumerable: false });
  }
  return b;
}

// ── API ────────────────────────────────────────────────────

export function createSessionView(): SessionView {
  return {
    revision: 0,
    meta: undefined,
    config: { model: undefined, permissionPreset: undefined },
    status: "idle",
    retry: undefined,
    currentTurn: undefined,
    lastTurn: undefined,
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    pendingPermission: undefined,
    entries: [],
    live: { assistants: [], tools: [] },
    notices: [],
    lastSeq: 0,
  };
}

export function reduceSessionView(view: SessionView, event: RuntimeEvent): void {
  view.revision += 1;
  if (isDurableEvent(event)) {
    view.lastSeq = event.seq;
    if (isDurableEventType(event.type)) reduceDurable(view, event);
  } else if (isEphemeralEventType(event.type)) {
    reduceEphemeral(view, event);
  }
  // 未知类型：忽略（events.md §8）
}

export function replaySessionView(events: readonly DurableEvent[]): SessionView {
  const view = createSessionView();
  for (const ev of events) reduceSessionView(view, ev);
  return view;
}

// ── 持久事件 ────────────────────────────────────────────────

function reduceDurable(view: SessionView, event: DurableEvent): void {
  const b = book(view);
  const turnId = event.turnId;
  switch (event.type) {
    case "session.created": {
      const p = event.payload;
      view.meta = {
        cwd: p.cwd,
        workspaceRoot: p.workspaceRoot,
        formatVersion: p.formatVersion,
        nocturneVersion: p.nocturneVersion,
      };
      view.config = { model: p.model, permissionPreset: p.permissionPreset };
      break;
    }
    case "session.config_changed": {
      const p = event.payload;
      if (p.model !== undefined) view.config.model = p.model;
      if (p.permissionPreset !== undefined) view.config.permissionPreset = p.permissionPreset;
      const lines: string[] = [];
      if (p.model !== undefined) lines.push(`模型已切换为 ${p.model.provider}/${p.model.model}`);
      if (p.permissionPreset !== undefined) lines.push(`权限预设已切换为 ${p.permissionPreset}`);
      pushNotice(view, event.seq, "config", lines.join("\n"), p);
      break;
    }
    case "turn.started": {
      view.currentTurn = { turnId: turnId ?? "", turnIndex: event.payload.turnIndex };
      view.turnCount = Math.max(view.turnCount, event.payload.turnIndex);
      break;
    }
    case "message.user": {
      view.entries.push({
        kind: "user",
        key: `u:${event.payload.messageId}`,
        seq: event.seq,
        turnId: turnId ?? "",
        content: event.payload.content,
      });
      break;
    }
    case "message.assistant": {
      const p = event.payload;
      view.live.assistants = view.live.assistants.filter((a) => a.messageId !== p.messageId);
      view.entries.push({
        kind: "assistant",
        key: `a:${p.messageId}`,
        turnId: turnId ?? "",
        messageId: p.messageId,
        seq: event.seq,
        text: p.content
          .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join(""),
        reasoning: p.content
          .filter((c): c is Extract<ContentBlock, { type: "reasoning" }> => c.type === "reasoning")
          .map((c) => c.text)
          .join(""),
        toolCalls: p.toolCalls,
        model: p.model,
        usage: p.usage,
        finishReason: p.finishReason,
      });
      break;
    }
    case "permission.requested": {
      const p = event.payload;
      const liveTool = view.live.tools.find((t) => t.callId === p.callId);
      const entry = promoteTool(view, b, p.callId, turnId ?? "", event.seq);
      entry.status = "awaiting_permission";
      entry.subjects = p.subjects;
      view.pendingPermission = {
        requestId: p.requestId,
        callId: p.callId,
        toolName: entry.name ?? liveTool?.name,
        subjects: p.subjects,
        reason: p.reason,
        options: p.options,
      };
      break;
    }
    case "permission.resolved": {
      const p = event.payload;
      b.resolved.set(p.callId, p);
      const entry = b.tools.get(p.callId);
      if (entry !== undefined) entry.resolution = p;
      if (
        view.pendingPermission !== undefined &&
        ((p.requestId !== undefined && view.pendingPermission.requestId === p.requestId) ||
          view.pendingPermission.callId === p.callId)
      ) {
        view.pendingPermission = undefined;
      }
      const detail = p.rule !== undefined ? `${p.source}：${p.rule}` : p.source;
      const remembered =
        p.remember === "project"
          ? "，已写入项目授权"
          : p.remember === "session"
            ? "，本会话内有效"
            : "";
      const fb = p.feedback !== undefined && p.feedback !== "" ? `（反馈：${p.feedback}）` : "";
      pushNotice(
        view,
        event.seq,
        "permission",
        `权限：${p.action}（${detail}）${remembered}${fb}`,
        p,
      );
      break;
    }
    case "tool.started": {
      const p = event.payload;
      const entry = promoteTool(view, b, p.callId, turnId ?? "", event.seq);
      entry.status = "running";
      entry.name = p.name;
      entry.input = p.input;
      entry.subjects = p.subjects;
      entry.permission = {
        action: p.permission.action,
        source: p.permission.source,
        rule: p.permission.rule,
      };
      break;
    }
    case "tool.completed": {
      const p = event.payload;
      // 未执行即终态：丢弃 preparing 残片（inputText 不属于可重放视图）
      view.live.tools = view.live.tools.filter((t) => t.callId !== p.callId);
      const entry = promoteTool(view, b, p.callId, turnId ?? "", event.seq);
      entry.name = p.name;
      entry.status = p.status;
      entry.liveOutput = "";
      entry.result = {
        status: p.status,
        modelContent: p.modelContent,
        output: p.output,
        error: p.error,
        truncated: p.truncated === true,
        spillPath: p.spillPath,
        durationMs: p.durationMs,
      };
      break;
    }
    case "context.compacted": {
      const p = event.payload;
      pushNotice(
        view,
        event.seq,
        "compacted",
        `上下文已压缩（${p.kind}，至 seq ${p.throughSeq}）`,
        p,
      );
      break;
    }
    case "turn.completed": {
      const p = event.payload;
      const closing =
        view.currentTurn !== undefined && view.currentTurn.turnId === turnId
          ? view.currentTurn
          : undefined;
      if (closing !== undefined) view.currentTurn = undefined;
      view.turnCount = Math.max(view.turnCount, closing?.turnIndex ?? 0);
      view.lastTurn = {
        turnIndex: closing?.turnIndex ?? view.turnCount,
        reason: p.reason,
        steps: p.steps,
        usage: p.usage,
        recovered: p.recovered === true,
      };
      view.usage = addUsage(view.usage, p.usage);
      view.status = "idle";
      view.retry = undefined;
      view.pendingPermission = undefined;
      // 串行管线同一时刻至多一个 Turn；LiveTool.turnId 可空，
      // 按 turnId 筛会留下无持久落点的孤儿（view.md §3）
      view.live = { assistants: [], tools: [] };
      if (p.reason !== "done") {
        const detail = p.error !== undefined ? `${p.error.code} ${p.error.message}` : "";
        const message =
          p.recovered === true
            ? `上次进程退出，已按 ${p.error?.code ?? "error"} 收束：${p.error?.message ?? ""}`
            : `Turn 结束（${p.reason}）${detail !== "" ? `：${detail}` : ""}`;
        pushNotice(view, event.seq, "turn_end", message, p);
      }
      break;
    }
  }
}

function promoteTool(
  view: SessionView,
  b: Bookkeeping,
  callId: string,
  turnId: string,
  seq: number,
): ToolEntry {
  const liveIdx = view.live.tools.findIndex((t) => t.callId === callId);
  const live = liveIdx >= 0 ? view.live.tools.splice(liveIdx, 1)[0] : undefined;
  let entry = b.tools.get(callId);
  if (entry === undefined) {
    entry = {
      kind: "tool",
      key: `t:${callId}`,
      turnId,
      callId,
      name: live?.name,
      seq,
      status: "running",
      input: undefined,
      subjects: [],
      permission: undefined,
      resolution: b.resolved.get(callId),
      liveOutput: "",
      result: undefined,
    };
    b.tools.set(callId, entry);
    view.entries.push(entry);
  }
  if (entry.name === undefined && live !== undefined) entry.name = live.name;
  return entry;
}

function pushNotice(
  view: SessionView,
  seq: number,
  subtype: NoticeEntry["subtype"],
  message: string,
  payload: unknown,
): void {
  view.entries.push({
    kind: "notice",
    key: `n:${seq}`,
    seq,
    subtype,
    message,
    payload,
  });
}

function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cr = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cw = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  const rt = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  if (cr > 0) out.cacheReadTokens = cr;
  if (cw > 0) out.cacheWriteTokens = cw;
  if (rt > 0) out.reasoningTokens = rt;
  return out;
}

// ── 临时事件 ────────────────────────────────────────────────

function reduceEphemeral(view: SessionView, event: EphemeralEvent): void {
  switch (event.type) {
    case "runtime.status": {
      view.status = event.payload.status;
      if (view.status !== "retrying") view.retry = undefined;
      break;
    }
    case "provider.retry": {
      view.retry = event.payload;
      view.status = "retrying";
      break;
    }
    case "mcp.server": {
      const p = event.payload;
      const tools = p.toolCount !== undefined ? `（${p.toolCount} 个工具）` : "";
      const err = p.error !== undefined ? `：${p.error}` : "";
      view.notices.push({
        level: p.state === "failed" || p.state === "crashed" ? "warning" : "info",
        code: "mcp.server",
        message: `MCP 服务器 ${p.name} → ${p.state}${tools}${err}`,
      });
      break;
    }
    case "runtime.warning": {
      view.notices.push({
        level: "warning",
        code: event.payload.code,
        message: event.payload.message,
      });
      break;
    }
    case "runtime.error": {
      view.notices.push({
        level: "error",
        code: event.payload.code,
        message: event.payload.message,
      });
      if (event.payload.code === "session_failed") view.status = "failed";
      break;
    }
    case "message.assistant.delta": {
      const p = event.payload;
      let a = view.live.assistants.find((x) => x.messageId === p.messageId);
      if (a === undefined) {
        a = {
          kind: "assistant",
          messageId: p.messageId,
          turnId: event.turnId,
          text: "",
          reasoning: "",
        };
        view.live.assistants.push(a);
      }
      if (p.kind === "text") a.text += p.delta;
      else a.reasoning += p.delta;
      break;
    }
    case "tool.input.delta": {
      const p = event.payload;
      let t = view.live.tools.find((x) => x.callId === p.callId);
      if (t === undefined) {
        t = { kind: "tool", callId: p.callId, name: p.name, turnId: event.turnId, inputText: "" };
        view.live.tools.push(t);
      }
      t.inputText += p.delta;
      break;
    }
    case "tool.progress": {
      const b = book(view);
      const entry = b.tools.get(event.payload.callId);
      if (entry !== undefined) {
        const { chunk, stream } = event.payload;
        if (stream === "info") {
          if (entry.liveOutput !== "" && !entry.liveOutput.endsWith("\n")) entry.liveOutput += "\n";
          entry.liveOutput += `${chunk}\n`;
        } else {
          entry.liveOutput += chunk;
        }
      }
      break;
    }
  }
}
