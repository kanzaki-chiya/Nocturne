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

const GOAL = [
  "Treat the request above as a goal to finish on your own.",
  "- Before starting, write a short checklist of verifiable deliverables for this goal.",
  "- Keep working without asking for confirmation unless a decision genuinely belongs to the user.",
  '- When you believe you are done, check every deliverable against concrete evidence (command output, test results, file contents), then call update_goal with status "met" and the checklist with evidence.',
  '- If you cannot continue without the user, call update_goal with status "blocked" and the reason.',
  "- If you end a reply without calling update_goal, the runtime asks you to verify the checklist and continue.",
].join("\n");

const PLAN = [
  "Plan mode: produce an implementation plan for the request above. Do not change anything.",
  "- The session is switched to the read-only permission preset. Explore by reading code, docs and configuration; do not edit files or run commands that change state.",
  "- If a decision genuinely belongs to the user, ask with ask_user. Do not ask what you can find out yourself.",
  "- End this reply with the complete plan in Markdown: the goal, the changes by file or module, the order of steps, how you will verify the result, and risks or open questions.",
  "- The user will either comment on the plan or approve it. When they comment, revise the plan and give the complete updated plan again. Implementation starts only after approval.",
].join("\n");

function boostBody(context: WorkModeContext): string {
  const max = context.maxBackground ?? 3;
  const git = context.gitRepository !== false;
  const apply =
    'As each writable subagent finishes, review its result and apply its changes with apply_subagent_changes (use mode "clean" first, then "3way" and resolve conflict markers if needed).';
  return [
    "Boost mode: the user explicitly chose parallel execution for the request above. Decompose it, run independent work in parallel with background subagents, then integrate and run regression checks.",
    "- Delegate by default: when the request splits into two or more independent slices, give each one to a background subagent, even if you could finish them yourself. If it does not split, do it yourself and say why in one sentence.",
    `- You can run at most ${max} background subagents at the same time in this session. Never poll or sleep waiting for them. After launching a batch, end your turn without starting the integration work; their results will arrive as messages.`,
    git
      ? '- For read-only investigation, call task with preset "explore" and background: true. For independent code changes, call task with background: true and isolation: "worktree" so each subagent edits an isolated git worktree. Worktrees start from the latest commit, so uncommitted changes are not in them.'
      : `- This workspace is not a git repository with a commit, so worktree isolation is unavailable until it has one. If the request has writable slices, use ask_user to ask whether to set that up. If the user agrees, run git init when needed, make sure .gitignore covers dependencies, build output and secrets, commit the current files, then call task with background: true and isolation: "worktree" for each slice. ${apply} If the user declines or ask_user is not available, use background subagents (preset "explore", background: true) only for parallel investigation, and make all file changes yourself in the main workspace.`,
    "- Give every subagent a self-contained task description: the exact files or module it owns, the constraints, and how to verify its slice. Keep writable slices on disjoint files to avoid conflicts.",
    "- Subagents are non-interactive and cannot ask the user for approval. Actions that still need approval under the current permissions are denied; when a subagent reports a permission denial, complete that slice yourself.",
    ...(git ? [`- ${apply}`] : []),
    "- After all slices are integrated, run the project's tests or typechecks in the main workspace to catch regressions, then summarize the outcome by subtask.",
  ].join("\n");
}

function ensembleBody(context: WorkModeContext): string {
  const git = context.gitRepository !== false;
  return [
    "Ensemble mode: you are Maestro (`@maestro`). File-editing tools are disabled while the ensemble is active; decompose the task, manage named members, review outcomes, integrate changes, and report to the user.",
    "- Start by calling `ensemble_init` with a concise title for the ensemble.",
    "- Split work by file, package, or problem so each file belongs to at most one member. Never assign two members to edit the same file.",
    "- Add each member with `ensemble_add_member` and fill in all three charter sections clearly (`owns`, `handsOff`, `doneWhen`). Use `<prefix>-1`, `<prefix>-2`, ... for peer groups so `@<prefix>` addresses the whole group.",
    '- Add one verifier member per two to four implementation members; when the user asks for cross-model verification or names specific models, set `model` or `profile` from the enabled list in the tool description. Use `preset: "explore"` for read-only investigation members.',
    git
      ? "- Members share the main workspace by default; set `isolated: true` when parallel edits or builds would interfere (give the verifier `isolated: true` too when reviewing isolated authors)."
      : "- This workspace is not a git repository with a commit, so `isolated: true` worktrees are unavailable; keep members on disjoint files in the main workspace.",
    "- Dispatch tasks on the board with `ensemble_post` using `@name`, `@group`, or `@all`, then end your turn without polling or sleeping; replies arrive as `<ensemble-post>` messages.",
    "- When a member is waiting for user permission approval, tell the user which member needs confirmation so they can approve it.",
    "- After verifiers pass all slices, apply isolated members' commits with `apply_subagent_changes`, run the project's checks in the main workspace via `shell`, call `ensemble_end`, and report results by member along with any unmerged branches.",
  ].join("\n");
}

const BODIES: Record<WorkModeName, (context: WorkModeContext) => string> = {
  "grill-me": () => GRILL_ME,
  goal: () => GOAL,
  plan: () => PLAN,
  boost: boostBody,
  ensemble: ensembleBody,
};

/** 用户批准计划后开新 Turn 的说明（ADR-0076 §5） */
export function planApprovedBody(): string {
  return [
    "The user approved the latest plan in this conversation. Implement it now.",
    "- Follow the plan; if you must deviate, say why in the final reply.",
    "- Verify the result as the plan describes, and report what you changed and how it was verified.",
  ].join("\n");
}

export function workModeBody(name: WorkModeName, context: WorkModeContext = {}): string {
  return BODIES[name](context);
}

/** 目标核对说明（ADR-0076 §4.3 第 5 步） */
export function goalCheckBody(objective: string, round: number): string {
  return [
    `Goal check ${round}. The goal:`,
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

/** 追加给模型的说明块（与技能块同形） */
export function workModeBlock(name: string, body: string): string {
  return `<work-mode name="${name}">\n${body}\n</work-mode>`;
}
