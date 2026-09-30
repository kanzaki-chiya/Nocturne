/**
 * SessionState = fold(durableEvents)（sessions.md 第 2 节）。
 * 唯一事实来源是持久化事件序列；这里没有第二份状态。
 */
import { shellSwitchNote } from "../platform/index.js";
import {
  todoItemsFromCompletion,
  type DurableEvent,
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
  const usage = { ...ZERO_USAGE };
  let openTurn: SessionState["openTurn"];
  const unsettled = new Map<string, UnsettledCall>();
  // tool.started 的规范化输入 → 折叠成 tool 条目的 inputSummary
  const startedInputs = new Map<string, string | undefined>();

  for (const event of events) {
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
        };
        // ADR-0022 第 4 节：shell 切换在历史中该位置留一条给模型的说明；
        // 措辞与环境信息同源（platform/shells.ts），恢复后旧说明原样重建
        if (p.shell !== undefined) {
          history.push({
            kind: "note",
            seq: event.seq,
            turnId,
            text: shellSwitchNote(p.shell.kind, p.shell.path),
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
        const p = event.payload;
        history.push({
          kind: "user",
          seq: event.seq,
          turnId: turnId ?? "",
          messageId: p.messageId,
          content: p.content,
          ...(p.fileRefs !== undefined ? { fileRefs: p.fileRefs } : {}),
          // ADR-0023：旧日志无 attachments 字段——有值才带上，缺省不落进历史
          ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
        });
        break;
      }
      case "message.assistant": {
        const p = event.payload;
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
        for (const call of p.toolCalls) {
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
        const existing = unsettled.get(event.payload.callId);
        if (existing !== undefined) existing.started = true;
        startedInputs.set(event.payload.callId, summarizeInput(event.payload.input));
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
          ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
        });
        unsettled.delete(p.callId);
        startedInputs.delete(p.callId);
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
      case "permission.requested":
      case "permission.resolved": {
        // 审计事实，不改变折叠状态
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
    todos,
    usage,
    lastSeq,
    openTurn,
    unsettledCalls: unsettled,
  };
}
