import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const runFile = promisify(execFile);

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
  try {
    return resolve((await git(workspace, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
}

export async function gitCurrentBranch(workspace: string): Promise<string | null> {
  try {
    const name = (await git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    return name || null;
  } catch {
    try {
      const hash = (await git(workspace, ["rev-parse", "--verify", "HEAD"])).trim();
      return /^[0-9a-f]{40,64}$/i.test(hash) ? hash.slice(0, 8) : null;
    } catch {
      return null;
    }
  }
}

export async function gitWorkspaceBranches(workspace: string): Promise<{
  current: string | null;
  branches: { name: string; worktree?: string }[];
}> {
  const [current, names, worktrees] = await Promise.all([
    gitCurrentBranch(workspace),
    git(workspace, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(workspace, ["worktree", "list", "--porcelain"]),
  ]);
  const occupied = new Map<string, string>();
  let path: string | undefined;
  for (const line of worktrees.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (line.startsWith("branch refs/heads/") && path !== undefined)
      occupied.set(line.slice(18), path);
  }
  return {
    current,
    branches: names
      .split(/\r?\n/)
      .filter(Boolean)
      .map((name) => {
        const worktree = occupied.get(name);
        return { name, ...(worktree !== undefined ? { worktree } : {}) };
      }),
  };
}

export async function gitSwitchBranch(
  workspace: string,
  branch: string,
  create: boolean,
): Promise<void> {
  // check-ref-format accepts @{-1} as a previous-checkout expression: reject expansion explicitly.
  if (!branch || branch.startsWith("-") || /@\{-[0-9]+\}/.test(branch))
    throw new Error("Invalid branch name");
  await git(workspace, ["check-ref-format", "--branch", branch]);
  await git(workspace, create ? ["switch", "-c", branch, "--"] : ["switch", "--", branch], 60000);
}
