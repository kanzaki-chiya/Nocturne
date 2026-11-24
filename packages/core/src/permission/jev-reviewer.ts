import { createDecisionReviewer, type DecisionReviewerOptions } from "./decision-reviewer.js";
import type { SecurityReviewer } from "./types.js";

export type JevReviewerOptions = DecisionReviewerOptions;

/** Jev 的 systemone 审查后端（ADR-0057）。 */
export function createJevSecurityReviewer(options: JevReviewerOptions): SecurityReviewer {
  return createDecisionReviewer("jev", options);
}
