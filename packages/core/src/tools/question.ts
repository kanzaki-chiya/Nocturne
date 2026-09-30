/**
 * 提问请求的路由（ADR-0032 §3）：声明 needsUser 的工具经 ToolContext.askUser
 * 调用 ask——登记等待中的请求、发出 question.requested 与
 * runtime.status(waiting_user) 临时事件、等待 respondQuestion 命令或中断。
 * 回复校验不通过时该请求保持等待；非交互环境不发事件直接返回不可用。
 * 与权限闸门（permission/gate.ts）同构但完全独立：提问回答「怎么做」，
 * 不接触权限层；等待中断的信号语义沿用同一约定（signal 中止 → Promise 拒绝）。
 */
import type { QuestionAnswer, QuestionItem } from "../protocol/index.js";
import type { AskUserReply, GateTurnContext, QuestionBroker } from "./types.js";

/** 「其他」/自由文本回答的上限（ADR-0032 §2）：去首尾空白后至多 2000 字符 */
const MAX_ANSWER_TEXT_CHARS = 2_000;

interface PendingQuestion {
  requestId: string;
  callId: string;
  questions: QuestionItem[];
  turn: GateTurnContext;
  resolve(reply: AskUserReply): void;
  reject(error: unknown): void;
  cleanup(): void;
}

/**
 * 校验客户端回复（ADR-0032 §3）：条数与顺序须与问题一一对应；
 * selected 逐项须为已提供选项的 label；单选题至多一项；
 * text 去首尾空白后至多 2000 字符。不通过返回 undefined（调用方
 * 以 invalid_reply 拒绝且请求保持等待）。通过时返回规范化结果。
 */
function checkReply(questions: QuestionItem[], reply: unknown): AskUserReply | undefined {
  if (typeof reply !== "object" || reply === null) return undefined;
  const answers = (reply as { answers?: unknown }).answers;
  if (!Array.isArray(answers) || answers.length !== questions.length) return undefined;
  const normalized: QuestionAnswer[] = [];
  for (const [i, raw] of answers.entries()) {
    const question = questions[i];
    if (question === undefined || typeof raw !== "object" || raw === null) return undefined;
    if ("declined" in raw) {
      if ((raw as { declined: unknown }).declined !== true || "selected" in raw || "text" in raw)
        return undefined;
      normalized.push({ declined: true });
      continue;
    }
    const selected = (raw as { selected?: unknown }).selected;
    const text = (raw as { text?: unknown }).text;
    if (!Array.isArray(selected) || selected.some((s) => typeof s !== "string")) return undefined;
    const labels = new Set((question.options ?? []).map((o) => o.label));
    if ((selected as string[]).some((s) => !labels.has(s))) return undefined;
    // 单选题「选了多项」按原始数组判断：重复 label 也算多项
    if (question.multiSelect !== true && selected.length > 1) return undefined;
    if (text !== undefined && typeof text !== "string") return undefined;
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (Array.from(trimmed).length > MAX_ANSWER_TEXT_CHARS) return undefined;
    normalized.push({
      selected: [...new Set(selected as string[])],
      ...(trimmed !== "" ? { text: trimmed } : {}),
    });
  }
  return { kind: "answered", answers: normalized };
}

export interface QuestionBrokerOptions {
  /** 是否有能回答的客户端（ADR-0032 §4；与权限闸门同一开关） */
  interactive?: boolean | undefined;
  /** 测试可注入确定性的 requestId 序列 */
  newRequestId?: ((callId: string) => string) | undefined;
}

export function createQuestionBroker(options: QuestionBrokerOptions = {}): QuestionBroker {
  const pending = new Map<string, PendingQuestion>();
  let counter = 0;
  const newRequestId =
    options.newRequestId ?? ((callId: string) => `q-${String(++counter)}-${callId}`);

  /** 结算并摘除等待中的请求：摘出后恢复 running_tool 状态（等待结束） */
  function settle(requestId: string): PendingQuestion | undefined {
    const p = pending.get(requestId);
    if (p === undefined) return undefined;
    pending.delete(requestId);
    p.cleanup();
    p.turn.events.emitEphemeral(
      "runtime.status",
      { status: "running_tool" },
      { turnId: p.turn.turnId },
    );
    return p;
  }

  return {
    ask(callId, request, turn, signal) {
      // 非交互环境（ADR-0032 §4）：不发 question.requested，立即不可用
      if (options.interactive !== true) return Promise.resolve({ kind: "unavailable" });
      if (signal.aborted) return Promise.reject(new Error("调用已被中断"));

      const requestId = newRequestId(callId);
      let resolveWait!: (reply: AskUserReply) => void;
      let rejectWait!: (error: unknown) => void;
      const waitPromise = new Promise<AskUserReply>((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
      });
      const onAbort = (): void => {
        settle(requestId)?.reject(new Error("等待用户回答期间被中断"));
      };
      pending.set(requestId, {
        requestId,
        callId,
        questions: request.questions,
        turn,
        resolve: resolveWait,
        reject: rejectWait,
        cleanup: () => {
          signal.removeEventListener("abort", onAbort);
        },
      });
      signal.addEventListener("abort", onAbort);
      // 先登记再发事件：客户端可能在 requested 回调里同步回复——
      // 已结算就不再发 waiting_user，避免状态滞留（settle 已发 running_tool）
      turn.events.emitEphemeral(
        "question.requested",
        { requestId, callId, questions: request.questions },
        { turnId: turn.turnId },
      );
      if (pending.has(requestId)) {
        turn.events.emitEphemeral(
          "runtime.status",
          { status: "waiting_user" },
          { turnId: turn.turnId },
        );
      }
      return waitPromise;
    },

    respond(requestId, reply) {
      const p = pending.get(requestId);
      if (p === undefined) return "unknown_request";
      const checked = checkReply(p.questions, reply);
      // 回复不合法：请求保持等待（ADR-0032 §3），客户端可重新提交
      if (checked === undefined) return "invalid_reply";
      settle(requestId)?.resolve(checked);
      return "ok";
    },

    cancelAll() {
      for (const requestId of [...pending.keys()]) {
        settle(requestId)?.reject(new Error("会话关闭，等待中的提问被取消"));
      }
    },
  };
}
