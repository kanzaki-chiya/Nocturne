/**
 * Git 与工作树设置、偏好格式化、托管工作树视图与恢复快照契约（客户端与 Core 共用）。
 * 纯类型与纯函数，不依赖任何 Node 内置模块。
 */

export const GIT_MERGE_METHODS = ["merge", "squash"] as const;
export type GitMergeMethod = (typeof GIT_MERGE_METHODS)[number];

export const GIT_REVIEW_VIEWS = ["inline", "separate"] as const;
export type GitReviewView = (typeof GIT_REVIEW_VIEWS)[number];

export interface GitInstructionsConfig {
  commit?: string | undefined;
  prTitle?: string | undefined;
  prBody?: string | undefined;
}

export interface GitConfig {
  branchPrefix?: string | undefined;
  forcePush?: boolean | undefined;
  mergeMethod?: GitMergeMethod | undefined;
  draftPr?: boolean | undefined;
  reviewView?: GitReviewView | undefined;
  instructions?: GitInstructionsConfig | undefined;
}

export interface ResolvedGitConfig {
  branchPrefix: string;
  forcePush: boolean;
  mergeMethod: GitMergeMethod;
  draftPr: boolean;
  reviewView: GitReviewView;
  instructions: {
    commit: string;
    prTitle: string;
    prBody: string;
  };
}

export const DEFAULT_GIT_CONFIG: ResolvedGitConfig = {
  branchPrefix: "nocturne/",
  forcePush: false,
  mergeMethod: "merge",
  draftPr: true,
  reviewView: "inline",
  instructions: {
    commit: "",
    prTitle: "",
    prBody: "",
  },
};

export interface WorktreeConfig {
  sessionRoot?: string | undefined;
  subagentRoot?: string | undefined;
  fetchBeforeCreate?: boolean | undefined;
  autoDelete?: boolean | undefined;
  keepCount?: number | undefined;
  askBeforeDelete?: boolean | undefined;
}

export interface ResolvedWorktreeConfig {
  sessionRoot: string;
  subagentRoot: string;
  fetchBeforeCreate: boolean;
  autoDelete: boolean;
  keepCount: number;
  askBeforeDelete: boolean;
}

export const DEFAULT_WORKTREE_CONFIG: ResolvedWorktreeConfig = {
  sessionRoot: "",
  subagentRoot: "",
  fetchBeforeCreate: false,
  autoDelete: true,
  keepCount: 15,
  askBeforeDelete: true,
};

export const GIT_SETTING_KEYS = [
  "git.branchPrefix",
  "git.forcePush",
  "git.mergeMethod",
  "git.draftPr",
  "git.reviewView",
  "git.instructions.commit",
  "git.instructions.prTitle",
  "git.instructions.prBody",
] as const;

export const WORKTREE_SETTING_KEYS = [
  "worktree.sessionRoot",
  "worktree.subagentRoot",
  "worktree.fetchBeforeCreate",
  "worktree.autoDelete",
  "worktree.keepCount",
  "worktree.askBeforeDelete",
] as const;

export type ManagedWorktreeKind = "session" | "subagent";
export type ManagedWorktreeState = "active" | "merged" | "ahead";

export interface ManagedWorktreeItem {
  /** 稳定唯一标识（注册表键） */
  id: string;
  kind: ManagedWorktreeKind;
  projectPath: string;
  projectName: string;
  branch: string;
  path: string;
  sourceSessionId: string;
  sourceTitle: string;
  sourceExists: boolean;
  childSessionId?: string | undefined;
  state: ManagedWorktreeState;
  /** 相对主仓库基准的独有提交数（active 时为 0） */
  aheadCount: number;
  /** 工作树内存在未提交改动（含未跟踪文件） */
  dirty: boolean;
  /** 是否由 Nocturne 创建该分支（false 时删除仅移目录、保留既有分支） */
  ownsBranch: boolean;
  pinned: boolean;
  /** 按当前 autoDelete + keepCount 计算是否位于待自动删除集合 */
  autoDeleteCandidate: boolean;
  createdAt: number;
  lastUsedAt: number;
}

export interface WorktreeRecoverySnapshot {
  version: 1;
  id: string;
  createdAt: string;
  reason: "auto" | "manual";
  kind: ManagedWorktreeKind;
  repository: string;
  projectName: string;
  originalPath: string;
  branch: string;
  ownsBranch: boolean;
  headSha: string;
  baseSha?: string | undefined;
  sessionId: string;
  childSessionId?: string | undefined;
  sourceTitle?: string | undefined;
  aheadCount: number;
  dirty: boolean;
  hasBundle: boolean;
  bundlePath?: string | undefined;
  hasWorkingPatch: boolean;
  workingPatchPath?: string | undefined;
  workingPatchSha256?: string | undefined;
  untrackedFiles: { path: string; sha256: string; size: number }[];
  untrackedSymlinks: { path: string; target: string }[];
  snapshotDir: string;
  restoreSteps: string[];
}

export interface ManagedWorktreesDescription {
  defaultSubagentRoot: string;
  effectiveSubagentRoot: string;
  worktrees: ManagedWorktreeItem[];
  snapshots: WorktreeRecoverySnapshot[];
}

export interface WorktreeDeleteOutcome {
  id: string;
  branch: string;
  path: string;
  status: "deleted" | "skipped_protected" | "skipped_snapshot_failed" | "not_found" | "failed";
  removedBranch?: boolean | undefined;
  snapshot?: WorktreeRecoverySnapshot | undefined;
  error?: string | undefined;
}

export interface WorktreeCleanupResult {
  deleted: WorktreeDeleteOutcome[];
  skipped: WorktreeDeleteOutcome[];
  failed: WorktreeDeleteOutcome[];
}

export interface WorktreeRestoreResult {
  snapshotId: string;
  worktreeId: string;
  worktreePath: string;
  branch: string;
  headSha: string;
  appliedPatch: boolean;
  restoredUntrackedCount: number;
}

export interface StartReviewInput {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  prompt?: string | undefined;
  presentation?: GitReviewView | undefined;
  model?: string | undefined;
}

export interface StartReviewResult {
  presentation: GitReviewView;
  sessionId: string;
  createdSession: boolean;
  prompt: string;
}

/** 校验自动分支前缀：不允许空白或非法 Git 引用字符；允许以 / 结尾作为命名空间前缀。 */
export function validateGitBranchPrefix(raw: string): string | null {
  if (raw === "") return "不能为空";
  if (/\s/.test(raw)) return "不能包含空格";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return "不是有效的分支名前缀";
  }
  if (
    raw === "@" ||
    raw.startsWith("-") ||
    raw.startsWith(".") ||
    raw.startsWith("/") ||
    raw.endsWith(".") ||
    raw.includes("..") ||
    raw.includes("//") ||
    raw.includes("@{") ||
    raw.includes("\\") ||
    /[~^:?*[]/.test(raw) ||
    /\.lock\/?$/.test(raw)
  ) {
    return "不是有效的分支名前缀";
  }
  const segments = raw.endsWith("/") ? raw.slice(0, -1).split("/") : raw.split("/");
  for (const part of segments) {
    if (part === "" || part.startsWith(".") || part.endsWith(".lock")) {
      return "不是有效的分支名前缀";
    }
  }
  return null;
}

/** 仅用于自动分支命名：将已校验前缀拼接到名称前，不改写用户手输的完整分支名。 */
export function formatAutoBranchName(prefix: string, name: string): string {
  const effectivePrefix =
    validateGitBranchPrefix(prefix) === null ? prefix : DEFAULT_GIT_CONFIG.branchPrefix;
  const trimmedName = name.trim().replace(/^\/+/, "");
  return `${effectivePrefix}${trimmedName}`;
}

export function normalizeWorktreeRootInput(
  raw: string,
  platform: string = typeof process !== "undefined" ? process.platform : "win32",
): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (platform === "win32") {
    const unified = trimmed.replace(/\//g, "\\");
    // 保留盘符根（如 C:\）和 UNC 根（\\server\share），去除其他末尾反斜杠
    if (/^[A-Za-z]:\\+$/.test(unified)) return `${unified.slice(0, 2)}\\`;
    if (/^\\\\[^\\]+\\[^\\]+\\+$/.test(unified)) return unified.replace(/\\+$/, "");
    return unified.replace(/\\+$/, "");
  }
  if (/^\/+$/.test(trimmed)) return "/";
  return trimmed.replace(/\/+$/, "");
}

/** 校验工作树根目录：空串表示沿用默认；非空时须为当前平台合法的绝对路径或 ~ 路径。 */
export function validateWorktreeRoot(
  raw: string,
  platform: string = typeof process !== "undefined" ? process.platform : "win32",
): string | null {
  if (raw === "") return null;
  if (/[\0\r\n]/.test(raw)) return "路径包含非法控制字符";
  if (platform === "win32") {
    // 去掉盘符前缀后的路径段不得包含 Windows 非法字符
    const withoutDrive = /^[A-Za-z]:/.test(raw) ? raw.slice(2) : raw;
    if (/[<>"|?*:]/.test(withoutDrive)) return '路径不能包含 < > " | ? *';
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|~(?:[\\/]|$))/.test(raw)) {
      return "需要绝对路径，例如 D:\\worktrees";
    }
    return null;
  }
  if (!/^(?:\/|~(?:\/|$))/.test(raw)) {
    return "需要绝对路径，例如 /path/to/worktrees";
  }
  return null;
}

export function validateWorktreeKeepCount(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return "需为正整数";
  }
  return null;
}

/** 计算处于自动删除候选集合的工作树 id：置顶与使用中不计入保留数量、永不选中。 */
export function computeAutoDeleteCandidateIds(
  items: readonly Pick<
    ManagedWorktreeItem,
    "id" | "state" | "pinned" | "lastUsedAt" | "createdAt"
  >[],
  autoDelete: boolean,
  keepCount: number,
): Set<string> {
  if (!autoDelete || !Number.isSafeInteger(keepCount) || keepCount < 1) return new Set();
  const eligible = items
    .filter((item) => item.state !== "active" && !item.pinned)
    .sort(
      (a, b) =>
        a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  const excess = Math.max(0, eligible.length - keepCount);
  return new Set(eligible.slice(0, excess).map((item) => item.id));
}

/** 构造推送参数：forcePush=true 恒使用 --force-with-lease，绝不使用裸 --force。 */
export function buildGitPushArgs(
  prefs: Pick<ResolvedGitConfig, "forcePush">,
  opts: {
    remote?: string | undefined;
    branch?: string | undefined;
    setUpstream?: boolean | undefined;
  } = {},
): string[] {
  const args = ["push"];
  if (prefs.forcePush) args.push("--force-with-lease");
  if (opts.setUpstream) args.push("-u");
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);
  return args;
}

/** 构造创建 PR 参数（gh pr create）：按 draftPr 决定是否附带 --draft。 */
export function buildPrCreateArgs(
  prefs: Pick<ResolvedGitConfig, "draftPr">,
  opts: {
    title?: string | undefined;
    body?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  } = {},
): string[] {
  const args = ["pr", "create"];
  if (prefs.draftPr) args.push("--draft");
  if (opts.base) args.push("--base", opts.base);
  if (opts.head) args.push("--head", opts.head);
  if (opts.title !== undefined) args.push("--title", opts.title);
  if (opts.body !== undefined) args.push("--body", opts.body);
  return args;
}

/** 构造合并 PR 参数（gh pr merge）：按 mergeMethod 选用 --merge 或 --squash。 */
export function buildPrMergeArgs(
  prefs: Pick<ResolvedGitConfig, "mergeMethod">,
  opts: { pr?: string | undefined } = {},
): string[] {
  const args = ["pr", "merge"];
  if (opts.pr) args.push(opts.pr);
  args.push(prefs.mergeMethod === "squash" ? "--squash" : "--merge");
  return args;
}

/** 生成提交 / PR 文案指引摘要（仅返回非空指引段）。 */
export function buildGitTextGuidance(
  prefs: Pick<ResolvedGitConfig, "instructions">,
  kind: "commit" | "pr",
): string {
  if (kind === "commit") {
    return prefs.instructions.commit.trim();
  }
  const parts: string[] = [];
  const title = prefs.instructions.prTitle.trim();
  const body = prefs.instructions.prBody.trim();
  if (title !== "") parts.push(`PR title instructions:\n${title}`);
  if (body !== "") parts.push(`PR description instructions:\n${body}`);
  return parts.join("\n\n");
}

/** 生成代码审查任务提示词（用于内联或独立审查会话）。 */
export function buildReviewPrompt(
  target?: string,
  prefs?: Pick<ResolvedGitConfig, "reviewView">,
): string {
  const scope = target?.trim();
  const lines = [
    scope
      ? `Review the following changes and report concrete findings, risks, and verification gaps:\n${scope}`
      : "Review the current git changes (staged, unstaged, and branch diff against the base branch) and report concrete findings, risks, and verification gaps.",
    "- Inspect the actual diff and surrounding code before commenting; cite file paths and line numbers.",
    "- Do not modify files, commit, push, or perform remote writes unless explicitly asked.",
  ];
  if (prefs?.reviewView === "separate") {
    lines.push(
      "- This review is running in a dedicated review session; provide a self-contained report.",
    );
  }
  return lines.join("\n");
}

/** 将生效的 Git 偏好格式化为传递给 Agent 上下文的确定性说明块。 */
export function formatGitPreferencesContext(prefs: ResolvedGitConfig): string {
  const lines = [
    "Git preferences (apply only when the user asks for git/PR/review operations; never perform network writes or push/merge automatically without user request and normal permission checks):",
    `- Automatic branch prefix: \`${prefs.branchPrefix}\` (use only when automatically naming a new branch; keep branch names explicitly specified by the user unchanged).`,
    prefs.forcePush
      ? "- Push: when pushing a branch, use `git push --force-with-lease` (never use bare `--force`)."
      : "- Push: use normal `git push` without forcing (if force push is explicitly requested, use `--force-with-lease`, never bare `--force`).",
    prefs.mergeMethod === "squash"
      ? "- PR merge method: squash merge (`gh pr merge --squash`) by default."
      : "- PR merge method: merge commit (`gh pr merge --merge`) by default.",
    prefs.draftPr
      ? "- Pull requests: create as draft (`gh pr create --draft`) by default unless asked otherwise."
      : "- Pull requests: create as ready for review (omit `--draft`) by default unless asked otherwise.",
    prefs.reviewView === "separate"
      ? "- Code review presentation: prefer a separate review session when starting a review."
      : "- Code review presentation: present review results inline in the current session.",
  ];
  const commitIns = prefs.instructions.commit.trim();
  const prTitleIns = prefs.instructions.prTitle.trim();
  const prBodyIns = prefs.instructions.prBody.trim();
  if (commitIns !== "") {
    lines.push("- Commit message instructions:", indentMultiline(commitIns));
  }
  if (prTitleIns !== "") {
    lines.push("- PR title instructions:", indentMultiline(prTitleIns));
  }
  if (prBodyIns !== "") {
    lines.push("- PR description instructions:", indentMultiline(prBodyIns));
  }
  return lines.join("\n");
}

function indentMultiline(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
