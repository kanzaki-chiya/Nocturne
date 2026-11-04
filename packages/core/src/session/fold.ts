/**
 * SessionState = fold(durableEvents)（sessions.md 第 2 节）。
 * 唯一事实来源是持久化事件序列；这里没有第二份状态。
 */
import { shellSwitchNote } from "../platform/index.js";
import {
  todoItemsFromCompletion,
  effectiveEvents,
  reduceGoal,
  reducePlan,
  rewindNote,
  type DurableEvent,
  type GoalState,
  type PlanConfig,
  type TodoItem,
  type Usage,
} from "../protocol/index.js";
import type {
  HistoryEntry,
  SessionConfig,
  SessionMeta,
  SessionState,
  UnsettledCall,
} from "./types.js";

import { mcpAvailabilityNote } from "./mcp-note.js";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * 参数摘要（context.md 6.5）：工具输入里取原始类型的字段，
 * 每个值截断；供 L1 修剪的占位说明使用。与工具名无关的通用实现。
 */
const INPUT_SUMMARY_VALUE_MAX = 60;
const INPUT_SUMMARY_MAX = 120;

function summarizeInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  if (typeof input === "object" && !Array.isArray(input)) {
    const parts = Object.entries(input)
      .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
      .map(([k, v]) => `${k}=${trunc(String(v), INPUT_SUMMARY_VALUE_MAX)}`);
    if (parts.length === 0) return trunc(JSON.stringify(input), INPUT_SUMMARY_MAX);
    return trunc(parts.join(" "), INPUT_SUMMARY_MAX);
  }
  return trunc(JSON.stringify(input), INPUT_SUMMARY_MAX);
}

export function foldEvents(events: readonly DurableEvent[]): SessionState {
  let meta: SessionMeta | undefined;
  let config: SessionConfig = {
    model: { provider: "", model: "" },
    permissionPreset: "",
  };
  const history: HistoryEntry[] = [];
  let todos: TodoItem[] = [];
  const mcpAvailability: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
  const usage = { ...ZERO_USAGE };
  let openTurn: SessionState["openTurn"];
  const unsettled = new Map<string, UnsettledCall>();
  // tool.started 的规范化输入 → 折叠成 tool 条目的 inputSummary
  const startedInputs = new Map<string, string | undefined>();
  const pinnedResults = new Set<string>();
  const effective = new Set(effectiveEvents(events).map((e) => e.seq));
  // ADR-0076 §2：目标按全部事件推进（回退撤回由 Runtime 另写事件），Turn 是否进行中单独跟踪
  let goal: GoalState | undefined;
  let goalTurnOpen = false;
  let plan: PlanConfig | undefined;

  for (const event of events) {
    goal = reduceGoal(goal, event, goalTurnOpen);
    plan = reducePlan(plan, event);
    if (event.type === "turn.started") goalTurnOpen = true;
    if (event.type === "turn.completed") goalTurnOpen = false;
    const active = effective.has(event.seq);
    if (
      !active &&
      ![
        "session.created",
        "session.config_changed",
        "message.assistant",
        "permission.reviewed",
      ].includes(event.type)
    )
      continue;
    const turnId = event.turnId;
    switch (event.type) {
      case "session.created": {
        const p = event.payload;
        meta = {
          id: event.sessionId,
          cwd: p.cwd,
          workspaceRoot: p.workspaceRoot,
          createdAt: event.time,
          formatVersion: p.formatVersion,
          nocturneVersion: p.nocturneVersion,
          ...(p.parent !== undefined ? { parent: p.parent } : {}),
          ...(p.forkedFrom !== undefined ? { forkedFrom: p.forkedFrom } : {}),
          ...(p.schedule !== undefined ? { schedule: p.schedule } : {}),
          ...(p.client !== undefined ? { client: p.client } : {}),
        };
        config = {
          model: p.model,
          permissionPreset: p.permissionPreset,
          ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
        };
        break;
      }
      case "session.config_changed": {
        const p = event.payload;
        config = {
          model: p.model ?? config.model,
          permissionPreset: p.permissionPreset ?? config.permissionPreset,
          reasoningEffort: p.reasoningEffort ?? config.reasoningEffort,
          ...(p.shell !== undefined || config.shell !== undefined
            ? { shell: p.shell ?? config.shell }
            : {}),
          ...(config.worktree !== undefined ? { worktree: config.worktree } : {}),
          ...(active && p.worktree !== undefined ? { worktree: p.worktree } : {}),
          ...(config.branch !== undefined ? { branch: config.branch } : {}),
          ...(active && p.branch !== undefined ? { branch: p.branch.current } : {}),
        };
        if (active && p.worktree !== undefined) {
          history.push({
            kind: "note",
            seq: event.seq,
            turnId,
            text: `[Environment change] Working directory changed from ${p.worktree.previous} to ${p.worktree.current}. Relative paths now resolve from ${p.worktree.current}. Replace absolute paths under the previous directory in earlier context with paths under the new directory. File contents read earlier may now be outdated.`,
          });
        }
        if (active && p.worktree === undefined && p.branch?.previous !== undefined) {
          history.push({
            kind: "note",
            seq: event.seq,
            turnId,
            text: `[Environment change] Git branch changed from ${p.branch.previous} to ${p.branch.current}. File contents read earlier may now be outdated.`,
          });
        }
        // ADR-0022 第 4 节：shell 切换在历史中该位置留一条给模型的说明；
        // 措辞与环境信息同源（platform/shells.ts），恢复后旧说明原样重建
        if (p.shell !== undefined && active) {
          history.push({
            kind: "note",
            seq: event.seq,
            turnId,
            text: shellSwitchNote(p.shell.kind, p.shell.path),
          });
        }
        if (p.mcp !== undefined && p.mcp.length > 0 && active) {
          for (const change of p.mcp) mcpAvailability[change.server] = change.available;
          history.push({
            kind: "note",
            seq: event.seq,
            turnId,
            text: mcpAvailabilityNote(p.mcp),
          });
        }
        break;
      }
      case "turn.started": {
        if (turnId !== undefined) {
          openTurn = { turnId, turnIndex: event.payload.turnIndex };
        }
        break;
      }
      case "message.user": {
        // ADR-0070 §7：清单归档只由非插话的用户消息触发
        if (
          event.payload.steer !== true &&
          todos.length > 0 &&
          todos.every((item) => item.status === "completed")
        )
          todos = [];
        const p = event.payload;
        history.push({
          kind: "user",
          seq: event.seq,
          turnId: turnId ?? "",
          messageId: p.messageId,
          content: p.content,
          ...(p.fileRefs !== undefined ? { fileRefs: p.fileRefs } : {}),
          ...(p.skill !== undefined ? { skill: p.skill } : {}),
          ...(p.delegate !== undefined ? { delegate: p.delegate } : {}),
          ...(p.steer === true ? { steer: true as const } : {}),
          ...(p.subagent !== undefined ? { subagent: p.subagent } : {}),
          // ADR-0023：旧日志无 attachments 字段——有值才带上，缺省不落进历史
          ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
          ...(p.files !== undefined ? { files: p.files } : {}),
        });
        break;
      }
      case "message.assistant": {
        const p = event.payload;
        if (active)
          history.push({
            kind: "assistant",
            seq: event.seq,
            turnId: turnId ?? "",
            messageId: p.messageId,
            model: p.model,
            // ADR-0026 §6：协议随历史条目保存；旧日志无此字段
            ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
            content: p.content,
            toolCalls: p.toolCalls,
            usage: p.usage,
            finishReason: p.finishReason,
          });
        if (p.usage !== undefined) {
          usage.inputTokens += p.usage.inputTokens;
          usage.outputTokens += p.usage.outputTokens;
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (p.usage.cacheReadTokens ?? 0);
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (p.usage.cacheWriteTokens ?? 0);
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (p.usage.reasoningTokens ?? 0);
        }
        for (const call of active ? p.toolCalls : []) {
          unsettled.set(call.callId, {
            callId: call.callId,
            turnId: turnId ?? "",
            name: call.name,
            started: false,
          });
        }
        break;
      }
      case "tool.started": {
        if (event.payload.pinResult) pinnedResults.add(event.payload.callId);
        const existing = unsettled.get(event.payload.callId);
        if (existing !== undefined) existing.started = true;
        startedInputs.set(
          event.payload.callId,
          summarizeInput(event.payload.target?.input ?? event.payload.input),
        );
        break;
      }
      case "tool.completed": {
        const p = event.payload;
        todos = todoItemsFromCompletion(p) ?? todos;
        history.push({
          kind: "tool",
          seq: event.seq,
          turnId: turnId ?? "",
          callId: p.callId,
          name: p.name,
          status: p.status,
          modelContent: p.modelContent,
          inputSummary: startedInputs.get(p.callId),
          ...(pinnedResults.has(p.callId) ? { pinResult: true } : {}),
          ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
          ...(p.files !== undefined ? { files: p.files } : {}),
        });
        unsettled.delete(p.callId);
        startedInputs.delete(p.callId);
        pinnedResults.delete(p.callId);
        break;
      }
      case "context.compacted": {
        history.push({
          kind: "compaction",
          seq: event.seq,
          turnId,
          compactKind: event.payload.kind,
          throughSeq: event.payload.throughSeq,
          summary: event.payload.summary,
        });
        break;
      }
      case "turn.completed": {
        if (openTurn !== undefined && openTurn.turnId === turnId) {
          openTurn = undefined;
        }
        break;
      }
      case "permission.reviewed": {
        const u = event.payload.usage;
        if (u !== undefined && !event.payload.cached) {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0);
        }
        break;
      }
      case "permission.requested":
      case "permission.resolved": {
        // 审计事实，不改变折叠状态
        break;
      }
      case "session.rewound": {
        const text = rewindNote(event.payload);
        if (text !== undefined) history.push({ kind: "note", seq: event.seq, turnId, text });
        break;
      }
    }
  }

  const lastSeq = events.length === 0 ? 0 : (events.at(-1)?.seq ?? 0);
  // 空日志不可能经 SessionStore 校验得到，这里兜底
  meta ??= {
    id: events[0]?.sessionId ?? "",
    cwd: "",
    workspaceRoot: "",
    createdAt: "",
    formatVersion: 0,
    nocturneVersion: "",
  };
  return {
    meta,
    config,
    history,
    ...(Object.keys(mcpAvailability).length > 0 ? { mcpAvailability } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(plan !== undefined ? { plan } : {}),
    todos,
    usage,
    lastSeq,
    openTurn,
    unsettledCalls: unsettled,
  };
}
