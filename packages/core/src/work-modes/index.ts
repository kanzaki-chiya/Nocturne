/** 执行方式的说明、续跑判定与目标独立核对。由 Core 装配并接入会话。 */
export {
  goalResumeBody,
  planApprovedBody,
  workModeBlock,
  workModeBody,
  type WorkModeContext,
} from "./prompts.js";
export { createGoalReporter, goalContinuation, type GoalContinuation } from "./goal.js";
export { checkGoalWithDecision, checkGoalWithSmol, goalCheckUnavailable } from "./goal-check.js";
