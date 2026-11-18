/**
 * 组曲（Suite）协议契约、`<thread-report>` 编解码与派生视图纯函数（ADR-0097）。
 * 纯类型与纯函数，无 I/O、无 Node 内置依赖。
 */
import type { DurableEvent } from "./events.js";
import type { ModelRef, PermissionOption, PermissionSubject, ReasoningEffort } from "./types.js";

export type SuiteThreadStatus = "working" | "idle" | "paused";

/** 总览五个分组（ADR-0097 §3.5） */
export type SuiteThreadGroup = "needs_attention" | "running" | "unmerged" | "idle" | "resolved";

export type SuiteThreadReportStatus = "idle" | "paused";

export type SuiteActionSource = "coordinator" | "user";

export interface SuiteThreadDefaults {
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  preset?: string | undefined;
  isolated?: boolean | undefined;
}

export interface SuiteRecord {
  version: 1;
  id: string;
  name: string;
  goal?: string | undefined;
  workspaces: string[];
  instructions: string;
  coordinatorSessionId: string;
  threadDefaults: SuiteThreadDefaults;
  createdAt: string;
  archivedAt?: string | undefined;
}

export interface CreateSuiteInput {
  name: string;
  goal?: string | undefined;
  workspaces: string[];
  instructions?: string | undefined;
  threadDefaults?: SuiteThreadDefaults | undefined;
  model?: string | ModelRef | undefined;
  permissionPreset?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
}

export interface UpdateSuiteInput {
  id: string;
  name?: string | undefined;
  goal?: string | null | undefined;
  workspaces?: string[] | undefined;
  instructions?: string | undefined;
  threadDefaults?: SuiteThreadDefaults | undefined;
}

export interface SuiteWorktreeRef {
  path: string;
  branch: string;
  base: string;
}

export interface SuiteThreadPermission {
  requestId: string;
  callId: string;
  reason: string;
  subjects: PermissionSubject[];
  options: PermissionOption[];
}

export interface SuiteToolActivity {
  tool: string;
  detail?: string | undefined;
}

/** 投递给指挥的 `message.user.suiteReport` 扩展标记（ADR-0097 §3.4） */
export interface SuiteReportDelivery {
  threadId: string;
  turnId: string;
  status: SuiteThreadReportStatus;
}

// ── 指挥会话持久事件 payload ──────────────────────────────

export interface SuiteThreadStartedPayload {
  threadId: string;
  childSessionId: string;
  title: string;
  task: string;
  workspace: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktree?: SuiteWorktreeRef | undefined;
}

export interface SuiteThreadReportedPayload {
  threadId: string;
  childSessionId: string;
  turnId: string;
  status: SuiteThreadReportStatus;
  report: string;
  summaryLine?: string | undefined;
  error?: { code: string; message: string } | undefined;
  hasUnmergedWorktree?: boolean | undefined;
}

export interface SuiteThreadResolvedPayload {
  threadId: string;
  source: SuiteActionSource;
}

export interface SuiteThreadReopenedPayload {
  threadId: string;
  source: SuiteActionSource;
}

export interface SuiteThreadModelChangedPayload {
  threadId: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
}

// ── 指挥会话临时事件 payload ──────────────────────────────

export interface SuiteThreadUpdatedPayload {
  threadId: string;
  status: SuiteThreadStatus;
  toolActivity?: SuiteToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions?: SuiteThreadPermission[] | undefined;
  hasPendingQuestion?: boolean | undefined;
  hasUnmergedWorktree?: boolean | undefined;
}

// ── 共享派生视图（SessionView.suite，view.md §4） ────────────

export interface SuiteThreadView {
  threadId: string;
  childSessionId: string;
  title: string;
  task: string;
  workspace: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktree?: SuiteWorktreeRef | undefined;
  status: SuiteThreadStatus;
  group: SuiteThreadGroup;
  resolved: boolean;
  hasUnmergedWorktree: boolean;
  hasPendingQuestion: boolean;
  lastReportLine?: string | undefined;
  lastReportTurnId?: string | undefined;
  toolActivity?: SuiteToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions: SuiteThreadPermission[];
}

export interface SuiteView {
  suiteId: string;
  threads: SuiteThreadView[];
  /** 需要用户介入（待确认权限/提问或出错暂停）的线程 ID */
  needsAttentionThreads: string[];
}

// ── 纯函数工具 ────────────────────────────────────────────

export function firstSuiteLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 构造送往指挥的 `<thread-report>` 文本（ADR-0097 §3.4） */
export function formatSuiteThreadReport(input: {
  threadId: string;
  title: string;
  status: SuiteThreadReportStatus;
  body: string;
}): string {
  const attrs = [
    `thread="${escapeXmlAttr(input.threadId)}"`,
    `title="${escapeXmlAttr(input.title)}"`,
    `status="${input.status}"`,
  ].join(" ");
  return `<thread-report ${attrs}>\n${input.body}\n</thread-report>`;
}

/** 根据线程当前运行态计算总览五个分组之一（ADR-0097 §3.5） */
export function computeSuiteThreadGroup(thread: {
  status: SuiteThreadStatus;
  pendingPermissions: readonly SuiteThreadPermission[];
  hasPendingQuestion: boolean;
  hasUnmergedWorktree: boolean;
  resolved: boolean;
}): SuiteThreadGroup {
  if (
    thread.pendingPermissions.length > 0 ||
    thread.hasPendingQuestion ||
    thread.status === "paused"
  ) {
    return "needs_attention";
  }
  if (thread.status === "working") {
    return "running";
  }
  if (thread.hasUnmergedWorktree) {
    return "unmerged";
  }
  if (thread.resolved) {
    return "resolved";
  }
  return "idle";
}

function recomputeNeedsAttention(suite: SuiteView): void {
  suite.needsAttentionThreads = suite.threads
    .filter((t) => t.group === "needs_attention")
    .map((t) => t.threadId);
}

/** 从工具调用提炼一行摘要（仅供 `suite.thread_updated.toolActivity` 展示） */
export function summarizeSuiteToolCall(tool: string, input: unknown): SuiteToolActivity {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { tool };
  }
  const obj = input as Record<string, unknown>;
  const detailKeys = ["command", "path", "pattern", "query", "url", "thread", "title", "name"];
  for (const key of detailKeys) {
    const val = obj[key];
    if (typeof val === "string") {
      const line = firstSuiteLine(val);
      if (line !== undefined) {
        const clipped = Array.from(line).slice(0, 80).join("");
        return { tool, detail: line.length > clipped.length ? `${clipped}…` : clipped };
      }
    }
  }
  return { tool };
}

/**
 * 将指挥日志中的持久事件归约到 `SessionView.suite`。
 * 组曲线程与线程事件不随指挥对话回退撤销（ADR-0097 §3.5），故按全量持久事件推进。
 */
export function reduceSuiteDurable(
  current: SuiteView | undefined,
  event: DurableEvent,
): SuiteView | undefined {
  let suite = current;
  switch (event.type) {
    case "session.created": {
      const meta = event.payload.suite;
      if (meta?.role === "coordinator" && event.payload.forkedFrom === undefined) {
        return {
          suiteId: meta.id,
          threads: [],
          needsAttentionThreads: [],
        };
      }
      return suite;
    }
    case "suite.thread_started": {
      const p = event.payload;
      suite ??= { suiteId: "", threads: [], needsAttentionThreads: [] };
      const next: SuiteThreadView = {
        threadId: p.threadId,
        childSessionId: p.childSessionId,
        title: p.title,
        task: p.task,
        workspace: p.workspace,
        model: p.model,
        ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
        ...(p.profile !== undefined ? { profile: p.profile } : {}),
        preset: p.preset,
        isolated: p.isolated,
        ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
        status: "idle",
        group: "idle",
        resolved: false,
        hasUnmergedWorktree: false,
        hasPendingQuestion: false,
        pendingPermissions: [],
      };
      const idx = suite.threads.findIndex((t) => t.threadId === p.threadId);
      if (idx >= 0) suite.threads[idx] = next;
      else suite.threads.push(next);
      recomputeNeedsAttention(suite);
      return suite;
    }
    case "suite.thread_reported": {
      if (suite === undefined) return undefined;
      const p = event.payload;
      const thread = suite.threads.find((t) => t.threadId === p.threadId);
      if (thread === undefined) return suite;
      thread.status = p.status;
      thread.pauseError = p.status === "paused" ? p.error : undefined;
      thread.lastReportTurnId = p.turnId;
      const line = p.summaryLine ?? firstSuiteLine(p.report);
      if (line !== undefined) thread.lastReportLine = line;
      if (p.hasUnmergedWorktree !== undefined) {
        thread.hasUnmergedWorktree = p.hasUnmergedWorktree;
      }
      thread.group = computeSuiteThreadGroup(thread);
      recomputeNeedsAttention(suite);
      return suite;
    }
    case "suite.thread_resolved": {
      if (suite === undefined) return undefined;
      const thread = suite.threads.find((t) => t.threadId === event.payload.threadId);
      if (thread !== undefined) {
        thread.resolved = true;
        thread.group = computeSuiteThreadGroup(thread);
        recomputeNeedsAttention(suite);
      }
      return suite;
    }
    case "suite.thread_reopened": {
      if (suite === undefined) return undefined;
      const thread = suite.threads.find((t) => t.threadId === event.payload.threadId);
      if (thread !== undefined) {
        thread.resolved = false;
        thread.group = computeSuiteThreadGroup(thread);
        recomputeNeedsAttention(suite);
      }
      return suite;
    }
    case "suite.thread_model_changed": {
      if (suite === undefined) return undefined;
      const p = event.payload;
      const thread = suite.threads.find((t) => t.threadId === p.threadId);
      if (thread !== undefined) {
        thread.model = p.model;
        thread.reasoningEffort = p.reasoningEffort;
        thread.profile = p.profile;
      }
      return suite;
    }
    case "tool.completed": {
      if (suite === undefined) return undefined;
      if (event.payload.name === "apply_subagent_changes" && event.payload.status === "ok") {
        const appliedId = (event.payload.output as { id?: unknown } | undefined)?.id;
        if (typeof appliedId === "string") {
          const thread = suite.threads.find(
            (t) => t.childSessionId === appliedId || t.threadId === appliedId,
          );
          if (thread?.hasUnmergedWorktree) {
            thread.hasUnmergedWorktree = false;
            thread.group = computeSuiteThreadGroup(thread);
            recomputeNeedsAttention(suite);
          }
        }
      }
      return suite;
    }
    default:
      return suite;
  }
}

export function applySuiteThreadUpdated(
  suite: SuiteView | undefined,
  payload: SuiteThreadUpdatedPayload,
): void {
  if (suite === undefined) return;
  const thread = suite.threads.find((t) => t.threadId === payload.threadId);
  if (thread === undefined) return;
  thread.status = payload.status;
  thread.toolActivity = payload.toolActivity;
  thread.pauseError = payload.status === "paused" ? payload.pauseError : undefined;
  thread.pendingPermissions = payload.pendingPermissions ? [...payload.pendingPermissions] : [];
  thread.hasPendingQuestion = payload.hasPendingQuestion === true;
  if (payload.hasUnmergedWorktree !== undefined) {
    thread.hasUnmergedWorktree = payload.hasUnmergedWorktree;
  }
  thread.group = computeSuiteThreadGroup(thread);
  recomputeNeedsAttention(suite);
}
