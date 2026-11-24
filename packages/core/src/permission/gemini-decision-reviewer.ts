import { createDecisionReviewer, type DecisionReviewerOptions } from "./decision-reviewer.js";
import type { SecurityReviewer } from "./types.js";

export type GeminiDecisionReviewerOptions = DecisionReviewerOptions;

/** Gemini Decisions API 审查后端（ADR-0117 §4）。 */
export function createGeminiDecisionReviewer(
  options: GeminiDecisionReviewerOptions,
): SecurityReviewer {
  return createDecisionReviewer("gemini", options);
}
