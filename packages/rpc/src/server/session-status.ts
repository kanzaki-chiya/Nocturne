/**
 * 后台级会话活动状态追踪器：从会话事件流轻量推算 `running` / `pending` / 空闲，
 * 供 `runtime.listSessions` 暴露本后台已打开会话的实时状态，并在状态切换时驱动
 * `runtime.sessionsChanged`（docs/protocols/rpc.md）。不新增 Core 事件。
 */
import type { DurableEvent, RuntimeEvent } from "@nocturne/core";

import type { HubSessionStatus } from "../shared/methods.js";

export interface HubSessionStatusTracker {
  /** 当前活动状态；空闲返回 undefined */
  status(): HubSessionStatus | undefined;
  /** 应用一条实时事件；若对外状态发生变化返回 true */
  apply(event: RuntimeEvent): boolean;
}

export function createSessionStatusTracker(
  durableEvents: readonly DurableEvent[],
): HubSessionStatusTracker {
  let inTurn = false;
  let compacting = false;
  let pendingPermission: { requestId: string; callId: string } | undefined;
  let hasSubagentPermissions = false;
  let pendingQuestionCallId: string | undefined;

  const current = (): HubSessionStatus | undefined => {
    if (
      pendingPermission !== undefined ||
      hasSubagentPermissions ||
      pendingQuestionCallId !== undefined
    ) {
      return "pending";
    }
    return inTurn || compacting ? "running" : undefined;
  };

  const applyEvent = (event: RuntimeEvent): void => {
    switch (event.type) {
      case "turn.started": {
        inTurn = true;
        break;
      }
      case "turn.completed": {
        inTurn = false;
        pendingPermission = undefined;
        pendingQuestionCallId = undefined;
        break;
      }
      case "permission.requested": {
        pendingPermission = {
          requestId: event.payload.requestId,
          callId: event.payload.callId,
        };
        break;
      }
      case "permission.resolved": {
        const p = event.payload;
        if (
          pendingPermission !== undefined &&
          ((p.requestId !== undefined && pendingPermission.requestId === p.requestId) ||
            pendingPermission.callId === p.callId)
        ) {
          pendingPermission = undefined;
        }
        break;
      }
      case "subagent.permissions": {
        hasSubagentPermissions = event.payload.pending.length > 0;
        break;
      }
      case "question.requested": {
        pendingQuestionCallId = event.payload.callId;
        break;
      }
      case "tool.completed": {
        if (pendingQuestionCallId === event.payload.callId) {
          pendingQuestionCallId = undefined;
        }
        break;
      }
      case "session.rewound": {
        if (event.payload.mode !== "files") {
          inTurn = false;
          compacting = false;
          pendingPermission = undefined;
          hasSubagentPermissions = false;
          pendingQuestionCallId = undefined;
        }
        break;
      }
      case "runtime.status": {
        if (event.payload.status === "compacting") compacting = true;
        else if (event.payload.status === "idle" || event.payload.status === "failed") {
          compacting = false;
        }
        break;
      }
    }
  };

  for (const event of durableEvents) applyEvent(event);

  return {
    status: current,
    apply(event: RuntimeEvent): boolean {
      const before = current();
      applyEvent(event);
      return current() !== before;
    },
  };
}
