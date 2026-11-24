import type { SecurityReviewer } from "./types.js";
import type { Usage } from "../protocol/index.js";
import {
  buildJevQuestions,
  decideFromAnswers,
  formatAskReason,
  isReviewCacheable,
  promptContextFromInput,
  resolveJevAnswers,
  stateForReview,
} from "./reviewer-questions.js";

export interface GeminiDecisionReviewerOptions {
  baseURL: string;
  model: string;
  endpoint: string;
  minConfidence: number;
  key: () => Promise<string | undefined>;
}

const SAFETY_ERROR_CODES = new Set([
  "safety",
  "prohibited_content",
  "blocklist",
  "image_safety",
  "content_blocked",
]);

/** Gemini Decisions API 审查后端（ADR-0117 §4）：共用七道题与纯函数判定。 */
export function createGeminiDecisionReviewer(
  options: GeminiDecisionReviewerOptions,
): SecurityReviewer {
  return {
    backend: "gemini",
    model: { provider: options.endpoint, model: options.model },
    async review(input, signal) {
      const timeout = AbortSignal.timeout(20_000);
      let usage: Usage | undefined;
      try {
        const key = await options.key();
        if (!key) return { verdict: "unsure", reason: "安全审查失败：未配置密钥" };
        const response = await fetch(`${options.baseURL.replace(/\/+$/, "")}/decisions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          signal: AbortSignal.any([signal, timeout]),
          body: JSON.stringify({
            model: options.model,
            input: JSON.stringify(stateForReview(input)),
            questions: buildJevQuestions(promptContextFromInput(input)),
          }),
        });
        if (!response.ok) {
          if (response.status === 400) {
            try {
              const errBody: unknown = await response.json();
              const code = (errBody as { error?: { code?: unknown } } | null)?.error?.code;
              if (typeof code === "string" && SAFETY_ERROR_CODES.has(code)) {
                return { verdict: "unsure", reason: "决策模型拒绝了这次输入" };
              }
            } catch {
              /* 无法解析错误体，回落到通用 400 映射 */
            }
          }
          const reason =
            response.status === 401 || response.status === 403
              ? "密钥无效或无权限"
              : response.status === 400 || response.status === 404
                ? "模型不可用或请求不受支持"
                : response.status === 429
                  ? "审查服务限流"
                  : "审查服务 HTTP 错误";
          return { verdict: "unsure", reason: `安全审查失败：${reason}（${response.status}）` };
        }
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null) throw new Error("格式");
        const data = body as {
          answers?: unknown;
          usage?: { total_input_tokens?: unknown };
          prompt_feedback?: { block_reason?: unknown };
        };
        const totalInput = data.usage?.total_input_tokens;
        if (typeof totalInput === "number" && Number.isFinite(totalInput) && totalInput >= 0) {
          usage = { inputTokens: totalInput, outputTokens: 0 };
        }
        const blockReason = data.prompt_feedback?.block_reason;
        if (typeof blockReason === "string" && blockReason.length > 0) {
          return { verdict: "unsure", reason: "决策模型拒绝了这次输入", usage };
        }
        const resolved = resolveJevAnswers(data.answers, options.minConfidence);
        if (!resolved.ok) return { verdict: "unsure", reason: "安全审查响应格式错误", usage };
        const { answers, lowConfidenceKeys } = resolved.resolved;
        if (decideFromAnswers(answers) === "allow") {
          return {
            verdict: "allow",
            reason: "七题审查通过",
            cacheable: isReviewCacheable(answers),
            usage,
          };
        }
        let reason = formatAskReason(answers);
        if (lowConfidenceKeys.length > 0) {
          reason = `审查置信度低于阈值 ${options.minConfidence}（Q${lowConfidenceKeys.join("、Q")}按保守取值），需要用户确认：${reason}`;
        }
        return { verdict: "unsure", reason, usage };
      } catch {
        if (signal.aborted) throw signal.reason;
        return {
          verdict: "unsure",
          reason: timeout.aborted ? "安全审查超时（20 秒）" : "安全审查失败：连接或响应解析错误",
          usage,
        };
      }
    },
  };
}
