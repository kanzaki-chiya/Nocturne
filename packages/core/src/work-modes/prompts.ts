/**
 * 执行方式的说明块正文（ADR-0076）：英文，追加在用户消息末尾的 `<work-mode>` 块里。
 * 正文随 message.user.workMode 快照落盘，改这里不影响已有会话。
 */
import type { WorkModeName } from "../protocol/index.js";

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

const BODIES: Record<WorkModeName, (context: WorkModeContext) => string> = {
  "grill-me": () => GRILL_ME,
};

export function workModeBody(name: WorkModeName, context: WorkModeContext = {}): string {
  return BODIES[name](context);
}

/** 追加给模型的说明块（与技能块同形） */
export function workModeBlock(name: string, body: string): string {
  return `<work-mode name="${name}">\n${body}\n</work-mode>`;
}
