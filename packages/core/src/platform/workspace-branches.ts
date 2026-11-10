import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve } from "node:path";

const runFile = promisify(execFile);

function hasGitMarker(workspace: string): boolean {
  let current = resolve(workspace);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function git(cwd: string, args: string[], timeout = 4000): Promise<string> {
  try {
    const { stdout } = await runFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (stderr) throw new Error(stderr);
    throw error;
  }
}

export async function gitRepository(workspace: string): Promise<string | null> {
  if (!hasGitMarker(workspace)) return null;
  try {
    return resolve((await git(workspace, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
}

export async function gitCurrentBranch(workspace: string): Promise<string | null> {
  if (!hasGitMarker(workspace)) return null;
  try {
    const name = (await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (name !== "HEAD") return name || null;
    const hash = (await git(workspace, ["rev-parse", "--verify", "HEAD"])).trim();
    return /^[0-9a-f]{40,64}$/i.test(hash) ? hash.slice(0, 8) : null;
  } catch {
    return null;
  }
}

function resolveDefaultBaseRef(
  localBranches: ReadonlySet<string>,
  originHeadRaw: string | null,
): string | null {
  if (localBranches.has("main")) return "main";
  const trimmed = originHeadRaw?.trim() ?? "";
  if (trimmed.startsWith("refs/remotes/origin/")) {
    const target = trimmed.slice("refs/remotes/origin/".length);
    if (target && target !== "HEAD") {
      return localBranches.has(target) ? target : `origin/${target}`;
    }
  }
  if (localBranches.has("master")) return "master";
  return null;
}

export async function gitWorkspaceBranches(
  workspace: string,
  repository: string,
): Promise<{
  current: string | null;
  branches: { name: string; worktree?: string }[];
  defaultBranch: string | null;
}> {
  const [current, names, worktrees, originHead] = await Promise.all([
    gitCurrentBranch(workspace),
    git(workspace, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(workspace, ["worktree", "list", "--porcelain", "-z"]),
    git(workspace, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => null),
  ]);
  const occupied = new Map<string, string>();
  let path: string | undefined;
  for (const line of worktrees.split("\0")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (line.startsWith("branch refs/heads/") && path !== undefined)
      occupied.set(line.slice(18), path);
  }
  const branchList = names.split(/\r?\n/).filter(Boolean);
  const localSet = new Set(branchList);
  return {
    current,
    defaultBranch: resolveDefaultBaseRef(localSet, originHead),
    branches: branchList.map((name) => {
      const worktree = occupied.get(name);
      const key = (value: string) =>
        process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
      return {
        name,
        ...(worktree !== undefined && key(worktree) !== key(repository) ? { worktree } : {}),
      };
    }),
  };
}

export async function validateGitBranchName(workspace: string, branch: string): Promise<void> {
  await git(workspace, ["check-ref-format", "--branch", branch]);
  // Prefixing the ref makes checkout-history expressions literal so Git rejects them itself.
  if (/@\{-[0-9]+\}/.test(branch))
    await git(workspace, ["check-ref-format", "--branch", `refs/heads/${branch}`]);
}

export async function gitSwitchBranch(
  workspace: string,
  branch: string,
  create: boolean,
): Promise<void> {
  await validateGitBranchName(workspace, branch);
  await git(workspace, create ? ["switch", "-c", branch, "--"] : ["switch", "--", branch], 60000);
}

/**
 * 新会话分支解析与工作树准备（ADR-0085）：
 * - 选当前分支：返回 undefined（不建工作树，留在项目目录）
 * - 选已在某个工作树检出的分支：返回该工作树（含子目录映射）
 * - 选已有未检出分支：在 `<repoParent>/<repoName>-wt/<branchWithHyphen>` 建工作树检出该分支
 * - 新建分支（create = true）：从基准分支（main → origin/HEAD → master）开出并在上述位置建工作树
 */
export async function prepareSessionBranchWorktree(input: {
  projectCwd: string;
  branch: string;
  create: boolean;
}): Promise<{ targetCwd: string; branch: string } | undefined> {
  const repoRoot = await gitRepository(input.projectCwd);
  if (repoRoot === null) throw new Error("Project directory is not a git repository");
  await validateGitBranchName(repoRoot, input.branch);

  const repoReal = await realpath(repoRoot).catch(() => resolve(repoRoot));
  const projectReal = await realpath(input.projectCwd).catch(() => resolve(input.projectCwd));
  const subRel = relative(repoReal, projectReal);
  const pathKey = (value: string) =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);

  const info = await gitWorkspaceBranches(projectReal, repoReal);
  const localBranches = new Set(info.branches.map((b) => b.name));

  let worktreeRoot: string;
  if (input.create) {
    if (localBranches.has(input.branch)) {
      throw new Error(`分支已存在：${input.branch}`);
    }
    const baseRef = info.defaultBranch;
    if (baseRef === null) {
      throw new Error("无法确定新建分支的基准分支（未找到 main、origin/HEAD 或 master）");
    }
    const dirName = input.branch.replaceAll("/", "-");
    if (!dirName || dirName === "." || dirName === "..") {
      throw new Error(`无效的分支目录名：${input.branch}`);
    }
    worktreeRoot = resolve(dirname(repoReal), `${basename(repoReal)}-wt`, dirName);
    if (existsSync(worktreeRoot)) {
      throw new Error(`目标工作树目录已存在：${worktreeRoot}`);
    }
    await mkdir(dirname(worktreeRoot), { recursive: true });
    await git(repoReal, ["worktree", "add", "-b", input.branch, worktreeRoot, baseRef], 60000);
  } else {
    if (info.current === input.branch) {
      return undefined;
    }
    const matched = info.branches.find((b) => b.name === input.branch);
    if (matched === undefined) {
      throw new Error(`分支不存在：${input.branch}`);
    }
    if (matched.worktree !== undefined) {
      worktreeRoot = matched.worktree;
    } else {
      const dirName = input.branch.replaceAll("/", "-");
      if (!dirName || dirName === "." || dirName === "..") {
        throw new Error(`无效的分支目录名：${input.branch}`);
      }
      worktreeRoot = resolve(dirname(repoReal), `${basename(repoReal)}-wt`, dirName);
      if (existsSync(worktreeRoot)) {
        throw new Error(`目标工作树目录已存在且不是分支 ${input.branch} 的工作树：${worktreeRoot}`);
      }
      await mkdir(dirname(worktreeRoot), { recursive: true });
      await git(repoReal, ["worktree", "add", worktreeRoot, input.branch], 60000);
    }
  }

  const realWorktreeRoot = await realpath(worktreeRoot).catch(() => resolve(worktreeRoot));
  const targetCwd = subRel ? resolve(realWorktreeRoot, subRel) : realWorktreeRoot;
  const targetStat = await stat(targetCwd).catch(() => undefined);
  if (!targetStat?.isDirectory()) {
    throw new Error(`Target worktree is missing subdirectory ${subRel}: ${targetCwd}`);
  }
  const realTargetCwd = await realpath(targetCwd).catch(() => resolve(targetCwd));
  if (pathKey(realTargetCwd) === pathKey(projectReal)) {
    return undefined;
  }
  const actualBranch = (await gitCurrentBranch(realTargetCwd)) ?? input.branch;
  return { targetCwd: realTargetCwd, branch: actualBranch };
}

export async function gitWorktrees(workspace: string): Promise<string[]> {
  if (!hasGitMarker(workspace)) return [];
  try {
    const out = await git(workspace, ["worktree", "list", "--porcelain", "-z"]);
    return out
      .split("\0")
      .flatMap((line) => (line.startsWith("worktree ") ? [resolve(line.slice(9))] : []));
  } catch {
    return [];
  }
}
