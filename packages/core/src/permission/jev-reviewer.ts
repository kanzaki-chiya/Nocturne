import type { SecurityReviewer } from "./types.js";
import type { Usage } from "../protocol/index.js";
import {
  REVIEW_QUESTIONS,
  buildJevQuestions,
  decideFromAnswers,
  formatAskReason,
  promptContextFromInput,
  resolveJevAnswers,
  stateForReview,
} from "./reviewer-questions.js";

export interface JevReviewerOptions {
  baseURL: string;
  model: string;
  endpoint: string;
  minConfidence: number;
  key: () => Promise<string | undefined>;
  sessionHeader?: string | undefined;
  sessionId?: string | undefined;
}

/** Jev 的 systemone 接口：数据视为不可信上下文，结论仅在权限层消费。 */
export function createJevSecurityReviewer(options: JevReviewerOptions): SecurityReviewer {
  return {
    backend: "jev",
    model: { provider: options.endpoint, model: options.model },
    async review(input, signal) {
      const timeout = AbortSignal.timeout(20_000);
      let usage: Usage | undefined;
      try {
        const key = await options.key();
        if (!key) return { verdict: "unsure", reason: "安全审查失败：未配置密钥" };
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        };
        if (options.sessionHeader && options.sessionId)
          headers[options.sessionHeader] = options.sessionId;
        const response = await fetch(`${options.baseURL.replace(/\/+$/, "")}/systemone`, {
          method: "POST",
          headers,
          signal: AbortSignal.any([signal, timeout]),
          body: JSON.stringify({
            model: options.model,
            state: stateForReview(input),
            questions: buildJevQuestions(promptContextFromInput(input)),
          }),
        });
        if (!response.ok) {
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
          usage?: { input_tokens?: unknown; output_tokens?: unknown };
        };
        const counts = data.usage;
        if (
          typeof counts?.input_tokens === "number" &&
          Number.isFinite(counts.input_tokens) &&
          counts.input_tokens >= 0 &&
          typeof counts.output_tokens === "number" &&
          Number.isFinite(counts.output_tokens) &&
          counts.output_tokens >= 0
        )
          usage = { inputTokens: counts.input_tokens, outputTokens: counts.output_tokens };
        const resolved = resolveJevAnswers(data.answers, options.minConfidence);
        if (!resolved.ok) return { verdict: "unsure", reason: "安全审查响应格式错误", usage };
        const { answers, lowConfidenceKeys } = resolved.resolved;
        if (decideFromAnswers(answers) === "allow")
          return { verdict: "allow", reason: "七题审查通过", usage };
        const details: string[] = [];
        for (const question of REVIEW_QUESTIONS) {
          const raw: unknown = data.answers;
          const entry: unknown = Array.isArray(raw)
            ? raw[question.number - 1]
            : (raw as Record<string, unknown>)[String(question.number)];
          if (entry !== null && typeof entry === "object") {
            const entryReason: unknown = (entry as Record<string, unknown>).reason;
            if (typeof entryReason === "string" && entryReason.trim().length > 0)
              details.push(entryReason.trim());
          }
        }
        let reason = formatAskReason(answers, details.length > 0 ? details.join("；") : undefined);
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
