/**
 * 目标模式的续跑判断（ADR-0076 §4.3）：纯函数，Runtime 在安全点 2 调用。
 */
import { GOAL_NO_PROGRESS_REASON, type GoalState } from "../protocol/index.js";
import { goalCheckBody } from "./prompts.js";

export type GoalContinuation =
  { kind: "none" } | { kind: "blocked"; reason: string } | { kind: "check"; body: string };

export function goalContinuation(
  goal: GoalState | undefined,
  context: {
    /** 本会话运行中的后台子代理数 */
    backgroundRunning: number;
    /** 待发列表里有未暂停的排队输入 */
    queued: boolean;
    /** 处于计划模式：计划要等用户评论或批准，目标不续跑（ADR-0076 §4.3 第 2 步） */
    planning: boolean;
    nowMs: number;
  },
): GoalContinuation {
  if (goal?.status !== "active") return { kind: "none" };
  if (context.planning) return { kind: "none" };
  if (context.backgroundRunning > 0) return { kind: "none" };
  if (context.queued) return { kind: "none" };
  if ((goal.noProgressRounds ?? 0) >= 3)
    return { kind: "blocked", reason: GOAL_NO_PROGRESS_REASON };
  return { kind: "check", body: goalCheckBody(goal.objective, goal.rounds + 1) };
}
