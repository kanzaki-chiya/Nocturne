/**
 * 执行方式模块（ADR-0076）：说明块正文与模式状态的判定。不进 Agent Loop，
 * 由 core/index 在提交准备与 Turn 边界接入；只依赖 protocol。
 */
export {
  goalResumeBody,
  planApprovedBody,
  workModeBlock,
  workModeBody,
  type WorkModeContext,
} from "./prompts.js";
export { goalContinuation, type GoalContinuation } from "./goal.js";
