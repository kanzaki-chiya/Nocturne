/**
 * 执行方式的说明块正文（ADR-0076）：英文，追加在用户消息末尾的 `<work-mode>` 块里。
 * 正文随 message.user.workMode 快照落盘，改这里不影响已有会话。
 */
import { GOAL_MAX_MINUTES, GOAL_MAX_ROUNDS, type WorkModeName } from "../protocol/index.js";

export interface WorkModeContext {
  /** 宿主声明的每会话后台子代理上限（/boost） */
  maxBackground?: number | undefined;
  /** 工作区是否在 git 仓库内（/boost 能否用工作树隔离） */
  gitRepository?: boolean | undefined;
}

const GRILL_ME = [
  "Interview the user about the request above before doing any work.",
  "- First read the relevant code and docs. Never ask something you can find out yourself.",
  "- Use the ask_user tool with exactly one question per call. Wait for the answer before asking the next one.",
  "- When you have a recommendation, put it first and mark its label with （推荐）, as the tool description says. Do not mark a recommendation when the question is about the user's own intent or preference.",
  "- Keep asking until the remaining uncertainty is minor. Then summarize the agreed requirements as a short checklist and confirm with one more ask_user call before you start implementing.",
  "- If ask_user is not available, proceed with the most reasonable defaults and state your assumptions in the reply.",
].join("\n");

const GOAL = [
  "Treat the request above as a goal to finish on your own.",
  "- Before starting, write a short checklist of verifiable deliverables for this goal.",
  "- Keep working without asking for confirmation unless a decision genuinely belongs to the user.",
  '- When you believe you are done, check every deliverable against concrete evidence (command output, test results, file contents), then call update_goal with status "met" and the checklist with evidence.',
  '- If you cannot continue without the user, call update_goal with status "blocked" and the reason.',
  `- If you end a reply without calling update_goal, the runtime asks you to verify the checklist and continue. This repeats at most ${GOAL_MAX_ROUNDS} times or for ${GOAL_MAX_MINUTES} minutes of work.`,
].join("\n");

const BODIES: Record<WorkModeName, (context: WorkModeContext) => string> = {
  "grill-me": () => GRILL_ME,
  goal: () => GOAL,
};

export function workModeBody(name: WorkModeName, context: WorkModeContext = {}): string {
  return BODIES[name](context);
}

/** 目标核对说明（ADR-0076 §4.3 第 5 步） */
export function goalCheckBody(objective: string, round: number, maxRounds: number): string {
  return [
    `Goal check ${round}/${maxRounds}. The goal:`,
    objective,
    "",
    "Before ending, verify each deliverable on your checklist against concrete evidence.",
    '- If every item is met, call update_goal with status "met" and the checklist with evidence, then give a short summary.',
    "- If anything is unmet, keep working on it now.",
    '- If you cannot continue without the user, call update_goal with status "blocked" and explain why.',
  ].join("\n");
}

/** 用户继续目标、会话空闲时开新 Turn 的说明（ADR-0076 §4.5） */
export function goalResumeBody(objective: string): string {
  return [
    "Resume working on this goal:",
    objective,
    "",
    "Re-check your deliverable checklist against the current state of the workspace, then continue with whatever is unmet.",
    '- When every item is verified, call update_goal with status "met" and the checklist with evidence.',
    '- If you cannot continue without the user, call update_goal with status "blocked" and explain why.',
  ].join("\n");
}

/** 到达上限后的收尾说明（ADR-0076 §4.3 第 4 步） */
export function goalLimitBody(rounds: number, minutes: number): string {
  return [
    `The goal limit was reached (${rounds} checks, ${minutes} minutes of work). Stop working now.`,
    "Reply with a short summary: which deliverables are done (with evidence), which are not, and what is left to do.",
  ].join("\n");
}

/** 追加给模型的说明块（与技能块同形） */
export function workModeBlock(name: string, body: string): string {
  return `<work-mode name="${name}">\n${body}\n</work-mode>`;
}
