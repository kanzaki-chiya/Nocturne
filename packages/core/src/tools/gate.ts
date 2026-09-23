/**
 * 权限闸门（tools.md 第 3 节步骤 5、permissions.md 第 7 节）。
 * Phase 2：求值为 ask 时——
 *   interactive 发出 permission.requested 并等待 respondPermission / 中断，
 *   然后发出 permission.resolved（gate 内部完成，Executor 不再补发）；
 *   非 interactive 直接把 ask 结算为 deny（source: "non_interactive"），不发 requested。
 */
import type { PermissionOption, PermissionSubject, SubjectRequest } from "../protocol/index.js";
import type { PermissionDecision, PermissionPolicy } from "../permission/index.js";
import type { GateOutcome, GateTurnContext, PermissionGate, ToolEventSink } from "./types.js";

export interface PolicyGateOptions {
  /** 是否有能回复权限请求的客户端（permissions.md 第 7 节）；默认 false */
  interactive?: boolean | undefined;
  /** 新会话内请求 id 的分配器（测试可注入确定性序列） */
  newRequestId?: (callId: string) => string;
}

/** Phase 2 提供给客户端的确认选项（permissions.md 第 7 节最小形态） */
const ASK_OPTIONS: PermissionOption[] = ["allow_once", "deny"];

interface PendingRequest {
  callId: string;
  subjects: PermissionSubject[];
  reason: string;
  turn: GateTurnContext;
  resolve(outcome: GateOutcome): void;
  /** 中断监听器的清理（respond 正常结算后移除，避免悬挂引用） */
  cleanup(): void;
}

export function createPolicyGate(
  policy: PermissionPolicy,
  options: PolicyGateOptions = {},
): PermissionGate {
  const pending = new Map<string, PendingRequest>();
  let counter = 0;
  const newRequestId = options.newRequestId ?? ((callId: string) => `perm-${++counter}-${callId}`);

  async function emitResolved(
    req: { requestId?: string; callId: string },
    decision: PermissionDecision,
    askReason: string,
    turn: GateTurnContext | undefined,
    extra?: { feedback?: string | undefined },
  ): Promise<void> {
    if (turn === undefined) return;
    await turn.events.emit(
      "permission.resolved",
      {
        requestId: req.requestId,
        callId: req.callId,
        action: decision.action === "allow" ? "allow" : "deny",
        source: decision.source,
        rule: askReason,
        feedback: extra?.feedback,
      },
      { turnId: turn.turnId },
    );
  }

  function settle(requestId: string, outcome: GateOutcome): PendingRequest | undefined {
    const p = pending.get(requestId);
    if (p === undefined) return undefined;
    pending.delete(requestId);
    p.cleanup();
    p.resolve(outcome);
    return p;
  }

  return {
    async check(subjects, callId, signal, turn): Promise<GateOutcome> {
      const evaluation = policy.evaluate(subjects);
      const { decision } = evaluation;
      if (decision.action !== "ask") {
        return { subjects: evaluation.subjects, decision };
      }
      // 非交互：ask 一律拒绝，不发 permission.requested
      if (options.interactive !== true || turn === undefined) {
        return {
          subjects: evaluation.subjects,
          decision: {
            action: "deny",
            source: "non_interactive",
            reason: `非交互模式：需确认的操作被拒绝（${decision.reason}）`,
          },
        };
      }

      // ask：先登记等待中的请求（客户端可能在 requested 事件回调里同步回复），
      // 再发 permission.requested，然后等待 respond / 中断
      const requestId = newRequestId(callId);
      let resolveWait!: (outcome: GateOutcome) => void;
      const waitPromise = new Promise<GateOutcome>((resolve) => {
        resolveWait = resolve;
      });
      const onAbort = () => {
        settle(requestId, {
          subjects: evaluation.subjects,
          decision: {
            action: "deny",
            source: "cancelled",
            reason: "等待权限回复期间被中断",
          },
          cancelled: true,
        });
      };
      pending.set(requestId, {
        callId,
        subjects: evaluation.subjects,
        reason: decision.reason,
        turn,
        resolve: resolveWait,
        cleanup: () => {
          signal.removeEventListener("abort", onAbort);
        },
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);

      const events: ToolEventSink = turn.events;
      try {
        await events.emit(
          "permission.requested",
          {
            requestId,
            callId,
            subjects: evaluation.subjects,
            reason: decision.reason,
            options: ASK_OPTIONS,
          },
          { turnId: turn.turnId },
        );
      } catch (e) {
        // 持久化失败等：清掉等待项后继续抛出，由 Executor 按异常路径处理
        settle(requestId, {
          subjects: evaluation.subjects,
          decision: {
            action: "deny",
            source: "cancelled",
            reason: "permission.requested 发出失败",
          },
          cancelled: true,
        });
        throw e;
      }

      const outcome = await waitPromise;

      // gate 内部发出 permission.resolved；Executor 不再补发
      await emitResolved({ requestId, callId }, outcome.decision, decision.reason, turn, {
        feedback: outcome.feedback,
      });
      return { ...outcome, resolvedEmitted: true };
    },

    checkLexical(request: SubjectRequest) {
      // permissions.md 4.4：枚举结果位于已解析根目录之下，词法路径即可判定
      const evaluation = policy.evaluate([
        { kind: request.kind, target: request.target, resolved: request.target },
      ]);
      return evaluation.decision.action;
    },

    respond(requestId, reply) {
      const p = pending.get(requestId);
      if (p === undefined) return false;
      // Phase 2：不生成任何持久授权（remember 被忽略，见 permissions.md 第 7 节）
      const decision: PermissionDecision =
        reply.decision === "allow"
          ? { action: "allow", source: "user", reason: "用户允许一次" }
          : {
              action: "deny",
              source: "user",
              reason:
                reply.feedback !== undefined && reply.feedback.length > 0
                  ? `用户拒绝：${reply.feedback}`
                  : "用户拒绝",
            };
      settle(requestId, {
        subjects: p.subjects,
        decision,
        stopTurn: reply.decision === "deny" && reply.stop === true,
        feedback: reply.feedback,
      });
      return true;
    },

    cancelAll() {
      for (const [requestId, p] of [...pending.entries()]) {
        settle(requestId, {
          subjects: p.subjects,
          decision: {
            action: "deny",
            source: "cancelled",
            reason: "会话关闭，等待中的权限请求被取消",
          },
          cancelled: true,
        });
      }
    },
  };
}
