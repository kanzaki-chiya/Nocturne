/**
 * 权限闸门（tools.md 第 3 节步骤 5、permissions.md 第 7 节）。
 * 求值为 ask 时——
 *   interactive 发出 permission.requested 并等待 respondPermission / 中断，
 *   然后发出 permission.resolved（gate 内部完成，Executor 不再补发）；
 *   非 interactive 直接把 ask 结算为 deny（source: "non_interactive"），不发 requested。
 * Phase 3：完整选项集（允许一次 / 本会话内允许 / 本项目中始终允许 / 拒绝 /
 * 拒绝并停止），remember 生成对应范围的 Grant；项目 Grant 写盘失败时降级为
 * 会话 Grant 并发出 runtime.warning（permissions.md 5.4）。
 */
import type {
  Grant,
  PermissionOption,
  PermissionSubject,
  SubjectRequest,
} from "../protocol/index.js";
import {
  grantFromSubject,
  type PermissionDecision,
  type PermissionPolicy,
} from "../permission/index.js";
import type {
  GateOutcome,
  GateTurnContext,
  HookRunner,
  PermissionGate,
  ToolEventSink,
} from "./types.js";

/** gate 侧的授权落点：session 数组就地追加；project 为持久化存储句柄 */
export interface GateGrantSink {
  session: Grant[];
  /** 项目 Grant 存储；缺省时 allow_project 降级为会话授权 */
  project?: { add(grant: Grant): Promise<void> } | undefined;
}

export interface PolicyGateOptions {
  /** 是否有能回复权限请求的客户端（permissions.md 第 7 节）；默认 false */
  interactive?: boolean | undefined;
  /** 新会话内请求 id 的分配器（测试可注入确定性序列） */
  newRequestId?: (callId: string) => string;
  /** Grant 落点与授权键大小写规则 */
  grants?: GateGrantSink | undefined;
  caseSensitive?: boolean | undefined;
  /** PermissionRequest Hook 执行器（hooks.md）；缺省时与未启用一致 */
  hooks?: HookRunner | undefined;
  /**
   * 非交互拒绝的附加指引（permissions.md 第 7 节）：子会话用它告诉子模型
   * "无法请求用户确认，受阻操作写进 finish 结果"（subagent.md 7.3）。
   */
  nonInteractiveDenyHint?: string | undefined;
}

/** 完整的确认选项集（permissions.md 第 7 节） */
const ASK_OPTIONS: PermissionOption[] = [
  "allow_once",
  "allow_session",
  "allow_project",
  "deny",
  "deny_stop",
];

interface PendingRequest {
  callId: string;
  subjects: PermissionSubject[];
  reason: string;
  /** 命中规则的人读说明（写入 permission.resolved.rule） */
  ruleDesc: string;
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
  const caseSensitive = options.caseSensitive ?? true;

  async function emitResolved(
    req: { requestId?: string; callId: string },
    decision: PermissionDecision,
    ruleDesc: string,
    turn: GateTurnContext | undefined,
    extra?: { feedback?: string | undefined; remember?: "session" | "project" | undefined },
  ): Promise<void> {
    if (turn === undefined) return;
    await turn.events.emit(
      "permission.resolved",
      {
        requestId: req.requestId,
        callId: req.callId,
        action: decision.action === "allow" ? "allow" : "deny",
        source: decision.source,
        rule: ruleDesc,
        remember: extra?.remember,
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
    async check(subjects, callId, signal, turn, hookCtx): Promise<GateOutcome> {
      // Hook 强制 ask（PreToolUse decision:"ask"）：跳过 Grant 与 autoApproveAsk
      // 求值——Hook 要求的确认不能被既有授权或 --yes 自动放行（permissions.md 5.5）
      const forceAsk = hookCtx?.forceAsk === true;
      const evaluation = policy.evaluate(subjects, forceAsk ? { skipApprovals: true } : undefined);
      let decision = evaluation.decision;
      // forceAsk 下规则层的 allow/ask 都走确认流程；deny 不受影响直接返回
      if (forceAsk && decision.action !== "deny") {
        decision = {
          action: "ask",
          source: decision.source,
          reason: `Hook 要求确认${hookCtx.askReason !== undefined ? `（${hookCtx.askReason}）` : ""}：${decision.reason}`,
          matchedRule: decision.matchedRule,
        };
      }
      if (decision.action !== "ask") {
        return { subjects: evaluation.subjects, decision };
      }

      // PermissionRequest Hook（hooks.md 第 3 节）：在交互/非交互分支之前运行——
      // 非交互模式下 Hook 的 allow 同样生效；只能放行 ask，碰不到 deny
      if (options.hooks !== undefined) {
        const out = await options.hooks.run(
          "PermissionRequest",
          {
            turnId: turn?.turnId,
            callId,
            tool: hookCtx?.tool,
            input: hookCtx?.input,
            subjects: evaluation.subjects.map((subject) => {
              const copy = { ...subject };
              delete copy.detail;
              return copy;
            }),
            permission: {
              action: "ask",
              reason: decision.reason,
              rule: decision.matchedRule?.description,
            },
          },
          signal,
        );
        if (out?.action === "allow" || out?.action === "deny") {
          const hookDecision: PermissionDecision = {
            action: out.action,
            source: "hook",
            reason:
              out.action === "allow"
                ? (out.reason ?? "PermissionRequest Hook 放行")
                : (out.reason ?? "PermissionRequest Hook 拒绝"),
          };
          await emitResolved({ callId }, hookDecision, "hook PermissionRequest", turn);
          return {
            subjects: evaluation.subjects,
            decision: hookDecision,
            resolvedEmitted: turn !== undefined,
          };
        }
      }

      // 非交互：ask 一律拒绝，不发 permission.requested
      if (options.interactive !== true || turn === undefined) {
        const hint = options.nonInteractiveDenyHint;
        return {
          subjects: evaluation.subjects,
          decision: {
            action: "deny",
            source: "non_interactive",
            reason:
              `非交互模式：需确认的操作被拒绝（${decision.reason}）` +
              (hint !== undefined ? `；${hint}` : ""),
            matchedRule: decision.matchedRule,
          },
        };
      }

      // ask：先登记等待中的请求（客户端可能在 requested 事件回调里同步回复），
      // 再发 permission.requested，然后等待 respond / 中断
      const requestId = newRequestId(callId);
      const ruleDesc = decision.matchedRule?.description ?? decision.reason;
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
        ruleDesc,
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
      await emitResolved({ requestId, callId }, outcome.decision, ruleDesc, turn, {
        feedback: outcome.feedback,
        remember: outcome.remember,
      });
      return { ...outcome, resolvedEmitted: true };
    },

    checkLexical(request: SubjectRequest) {
      // permissions.md 4.4：枚举结果位于已解析根目录之下，词法路径即可判定
      const evaluation = policy.evaluate([
        {
          kind: request.kind,
          target: request.target,
          resolved: request.target,
          shell: request.shell,
          shellRisk: request.shellRisk,
          shellRiskByDialect: request.shellRiskByDialect,
        },
      ]);
      return evaluation.decision.action;
    },

    async respond(requestId, reply) {
      const p = pending.get(requestId);
      if (p === undefined) return false;
      let remember: "session" | "project" | undefined;
      if (reply.decision === "allow" && reply.remember !== undefined) {
        const grants = p.subjects.map((s) => grantFromSubject(s, caseSensitive));
        const sink = options.grants;
        if (reply.remember === "project" && sink?.project !== undefined) {
          try {
            for (const g of grants) await sink.project.add(g);
            remember = "project";
          } catch (e) {
            // 写盘失败降级为会话 Grant（permissions.md 5.4）
            sink.session.push(...grants);
            remember = "session";
            p.turn.events.emitEphemeral(
              "runtime.warning",
              {
                code: "grant_persist_failed",
                message: `项目授权写入失败，已降级为本会话授权：${e instanceof Error ? e.message : String(e)}`,
              },
              { turnId: p.turn.turnId },
            );
          }
        } else {
          // remember === "session"，或无项目存储时的降级
          sink?.session.push(...grants);
          remember = "session";
        }
      }
      const decision: PermissionDecision =
        reply.decision === "allow"
          ? {
              action: "allow",
              source: "user",
              reason:
                remember === "project"
                  ? "用户允许：本项目始终允许（已写入授权）"
                  : remember === "session"
                    ? "用户允许：本会话内允许"
                    : "用户允许一次",
            }
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
        remember,
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
