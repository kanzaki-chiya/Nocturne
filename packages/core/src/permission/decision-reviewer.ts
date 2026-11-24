import {
  requestDecisions,
  type DecisionConnection,
  type DecisionFailure,
} from "../provider/index.js";
import {
  REVIEW_QUESTIONS,
  buildJevQuestions,
  decideFromAnswers,
  formatAskReason,
  isReviewCacheable,
  promptContextFromInput,
  stateForReview,
  applyReviewConfidence,
} from "./reviewer-questions.js";
import type { SecurityReviewer } from "./types.js";

export interface DecisionReviewerOptions extends Omit<DecisionConnection, "source"> {
  endpoint: string;
  minConfidence: number;
}

function failureReason(failure: DecisionFailure): string {
  switch (failure.kind) {
    case "missing_key":
      return "安全审查失败：未配置密钥";
    case "blocked":
      return "决策模型拒绝了这次输入";
    case "invalid_answers":
      return "安全审查响应格式错误";
    case "timeout":
      return "安全审查超时（20 秒）";
    case "request_failed":
      return "安全审查失败：连接或响应解析错误";
    case "auth":
      return `安全审查失败：密钥无效或无权限（${failure.status}）`;
    case "unsupported":
      return `安全审查失败：模型不可用或请求不受支持（${failure.status}）`;
    case "rate_limit":
      return `安全审查失败：审查服务限流（${failure.status}）`;
    case "http":
      return `安全审查失败：审查服务 HTTP 错误（${failure.status}）`;
  }
}

export function createDecisionReviewer(
  source: DecisionConnection["source"],
  options: DecisionReviewerOptions,
): SecurityReviewer {
  return {
    backend: source,
    model: { provider: options.endpoint, model: options.model },
    async review(input, signal) {
      const response = await requestDecisions(
        { ...options, source },
        JSON.stringify(stateForReview(input)),
        buildJevQuestions(promptContextFromInput(input)),
        signal,
      );
      const { usage } = response;
      if (!response.ok) {
        return {
          verdict: "unsure",
          reason: failureReason(response.failure),
          ...(response.failure.kind === "invalid_answers" ||
          (response.failure.kind === "blocked" && usage !== undefined)
            ? { usage }
            : {}),
        };
      }
      const { answers, lowConfidenceKeys } = applyReviewConfidence(
        response.answers,
        options.minConfidence,
      );
      if (decideFromAnswers(answers) === "allow") {
        return {
          verdict: "allow",
          reason: "七题审查通过",
          cacheable: isReviewCacheable(answers),
          usage,
        };
      }
      const detail =
        source === "jev"
          ? REVIEW_QUESTIONS.map(({ number }) => response.answers[String(number)]?.reason?.trim())
              .filter(Boolean)
              .join("；")
          : undefined;
      let reason = formatAskReason(answers, detail);
      if (lowConfidenceKeys.length > 0) {
        reason = `审查置信度低于阈值 ${options.minConfidence}（Q${lowConfidenceKeys.join("、Q")}按保守取值），需要用户确认：${reason}`;
      }
      return { verdict: "unsure", reason, usage };
    },
  };
}
