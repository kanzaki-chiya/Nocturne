import type { ResolvedModel } from "../provider/index.js";
import type { Usage } from "../protocol/index.js";
import type { ReviewResult, SecurityReviewer } from "./types.js";
import {
  buildReviewSystemPrompt,
  parseModelReview,
  promptContextFromInput,
  stateForReview,
} from "./reviewer-questions.js";

/**
 * 模型输出解析：JSON 七布尔 + reason，容忍代码块包裹。
 * 任一字段缺失或非布尔值即交人；只产出 allow / unsure，不产生 block。
 */
export function parseReview(text: string): ReviewResult {
  return parseModelReview(text);
}

/** 只经 Provider 的公开流接口发请求，思考档位沿用模型默认。 */
export function createModelSecurityReviewer(
  resolved: ResolvedModel,
  sessionId?: string,
): SecurityReviewer {
  return {
    backend: "model",
    model: resolved.model.ref,
    async review(input, signal) {
      let text = "";
      let usage: Usage | undefined;
      let sawReasoning = false;
      let lengthLimited = false;
      const system = buildReviewSystemPrompt(promptContextFromInput(input));
      try {
        for await (const event of resolved.provider.stream(
          {
            model: resolved.model.ref.model,
            protocol: resolved.model.protocol,
            system: [{ text: system }],
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: JSON.stringify(stateForReview(input)) }],
              },
            ],
            tools: [],
            // 主流模型默认思考且多数关不掉；思考和回答共用输出上限，留足预算以保证审查质量。
            maxOutputTokens: 8192,
            sessionId,
          },
          signal,
        )) {
          if (event.type === "text_delta") text += event.text;
          if (event.type === "usage") usage = event.usage;
          if (event.type === "reasoning_delta" || event.type === "reasoning_block") {
            sawReasoning ||= event.text.trim().length > 0;
          }
          if (event.type === "finish" && event.reason === "length") lengthLimited = true;
        }
        if (
          lengthLimited ||
          (text.trim().length === 0 && (sawReasoning || (usage?.reasoningTokens ?? 0) > 0))
        ) {
          return { verdict: "unsure", reason: "安全审查输出被截断", usage };
        }
        return { ...parseModelReview(text), usage };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          verdict: "unsure",
          reason: `安全审查失败：${error instanceof Error ? error.message : String(error)}`,
          usage,
        };
      }
    },
  };
}
