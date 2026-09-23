/**
 * SessionState = fold(durableEvents)（sessions.md 第 2 节）。
 * 唯一事实来源是持久化事件序列；这里没有第二份状态。
 */
import type { DurableEvent, Usage } from "../protocol/index.js";
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

export function foldEvents(events: readonly DurableEvent[]): SessionState {
  let meta: SessionMeta | undefined;
  let config: SessionConfig = {
    model: { provider: "", model: "" },
    permissionPreset: "",
  };
  const history: HistoryEntry[] = [];
  const usage = { ...ZERO_USAGE };
  let openTurn: SessionState["openTurn"];
  const unsettled = new Map<string, UnsettledCall>();

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
        };
        config = { model: p.model, permissionPreset: p.permissionPreset };
        break;
      }
      case "session.config_changed": {
        const p = event.payload;
        config = {
          model: p.model ?? config.model,
          permissionPreset: p.permissionPreset ?? config.permissionPreset,
        };
        break;
      }
      case "turn.started": {
        if (turnId !== undefined) {
          openTurn = { turnId, turnIndex: event.payload.turnIndex };
        }
        break;
      }
      case "message.user": {
        history.push({
          kind: "user",
          seq: event.seq,
          turnId: turnId ?? "",
          messageId: event.payload.messageId,
          content: event.payload.content,
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
        break;
      }
      case "tool.completed": {
        const p = event.payload;
        history.push({
          kind: "tool",
          seq: event.seq,
          turnId: turnId ?? "",
          callId: p.callId,
          name: p.name,
          status: p.status,
          modelContent: p.modelContent,
        });
        unsettled.delete(p.callId);
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
    usage,
    lastSeq,
    openTurn,
    unsettledCalls: unsettled,
  };
}
