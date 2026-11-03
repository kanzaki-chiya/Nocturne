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
    const name = (await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (name !== "HEAD") return name || null;
    const hash = (await git(workspace, ["rev-parse", "--verify", "HEAD"])).trim();
    return /^[0-9a-f]{40,64}$/i.test(hash) ? hash.slice(0, 8) : null;
  } catch {
    return null;
  }
}

export async function gitWorkspaceBranches(
  workspace: string,
  repository: string,
): Promise<{
  current: string | null;
  branches: { name: string; worktree?: string }[];
}> {
  const [current, names, worktrees] = await Promise.all([
    gitCurrentBranch(workspace),
    git(workspace, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(workspace, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  const occupied = new Map<string, string>();
  let path: string | undefined;
  for (const line of worktrees.split("\0")) {
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
        const key = (value: string) =>
          process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
        return {
          name,
          ...(worktree !== undefined && key(worktree) !== key(repository) ? { worktree } : {}),
        };
      }),
  };
}

export async function gitSwitchBranch(
  workspace: string,
  branch: string,
  create: boolean,
): Promise<void> {
  await git(workspace, ["check-ref-format", "--branch", branch]);
  // Prefixing the ref makes checkout-history expressions literal so Git rejects them itself.
  if (/@\{-[0-9]+\}/.test(branch))
    await git(workspace, ["check-ref-format", "--branch", `refs/heads/${branch}`]);
  await git(workspace, create ? ["switch", "-c", branch, "--"] : ["switch", "--", branch], 60000);
}
