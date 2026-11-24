/**
 * 目标模式的续跑判断（ADR-0076 §4.3）：纯函数，Runtime 在安全点 2 调用。
 */
import {
  GOAL_NO_PROGRESS_REASON,
  effectiveEvents,
  type DurableEvent,
  type GoalState,
  type PermissionSubject,
} from "../protocol/index.js";
import {
  assembleGoalCheckInput,
  type GoalCheckInput,
  type GoalChecklistItem,
} from "./goal-check-input.js";
import { goalCheckFailures, repeatedGoalFailure, type GoalCheckRun } from "./goal-check.js";
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

interface GoalReport {
  status: "met" | "blocked";
  checklist?: GoalChecklistItem[] | undefined;
  reason?: string | undefined;
}

export function createGoalReporter(options: {
  goal: () => GoalState | undefined;
  events: () => readonly DurableEvent[];
  sensitive: (subjects: readonly PermissionSubject[]) => boolean;
  check: () => ((input: GoalCheckInput, signal: AbortSignal) => Promise<GoalCheckRun>) | undefined;
  write: (status: GoalReport["status"], reason?: string) => Promise<void>;
  toolName: string;
}) {
  let running: AbortController | undefined;
  return {
    stop: () => running?.abort(),
    async report(input: GoalReport, callId: string, signal: AbortSignal) {
      const goal = options.goal();
      if (goal?.status !== "active" || signal.aborted) return undefined;
      const check = input.status === "met" ? options.check() : undefined;
      if (!check) {
        await options.write(input.status, input.reason);
        return { output: input };
      }
      const events = effectiveEvents(options.events());
      const repeated = repeatedGoalFailure(events, goal.since, callId, options.toolName);
      if (repeated !== undefined) {
        await options.write("blocked", repeated);
        return { output: { status: "blocked" as const, reason: repeated } };
      }
      const checklist = input.checklist ?? [];
      const controller = new AbortController();
      running = controller;
      const checkSignal = AbortSignal.any([signal, controller.signal]);
      try {
        const result = await check(
          assembleGoalCheckInput(goal.objective, checklist, events, goal.since, options.sensitive),
          checkSignal,
        );
        const current = options.goal();
        if (checkSignal.aborted || current?.status !== "active" || current.since !== goal.since)
          return undefined;
        const output = { ...input, check: result.check };
        const { usage, usageModel } = result;
        if (result.check.result === "rejected") {
          const failures = goalCheckFailures(result.check, checklist);
          return {
            output,
            usage,
            usageModel,
            rejected: `Goal verification did not pass:\n${failures.map((line) => `- ${line}`).join("\n")}\nUse tools to gather the missing evidence, then call update_goal again.`,
          };
        }
        await options.write("met");
        return { output, usage, usageModel };
      } catch (error) {
        if (checkSignal.aborted) return undefined;
        throw error;
      } finally {
        if (running === controller) running = undefined;
      }
    },
  };
}
