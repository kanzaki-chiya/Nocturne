import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SubagentChanges } from "../protocol/index.js";
import { compileGitignore, matchGitignore } from "../tools/builtin/gitignore.js";

/** Git is invoked directly: patch bytes never pass through a shell. */
export function worktreeGit(
  cwd: string,
  args: readonly string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
        ...(env ? { env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

export interface WorktreeRecord {
  childSessionId: string;
  parentSessionId: string;
  repository: string;
  worktree: string;
  branch: string;
  base: string;
  snapshot: boolean;
  cwd: string;
  workspaceRoot: string;
  task: string;
  includeSkipped: boolean;
  skippedSymlinks?: string[] | undefined;
  applied?: boolean | undefined;
  changes?: SubagentChanges | undefined;
}

export async function listWorktreeRecords(
  sessionsDir: string,
  parentSessionId: string,
): Promise<WorktreeRecord[]> {
  const directory = path.join(sessionsDir, "worktrees");
  const canonicalDirectory = await realpath(directory).catch(() => path.resolve(directory));
  const files = await readdir(directory).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  const records: WorktreeRecord[] = [];
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    let record: WorktreeRecord;
    try {
      record = JSON.parse(await readFile(path.join(directory, file), "utf8")) as WorktreeRecord;
    } catch {
      continue;
    }
    if (
      typeof record.childSessionId !== "string" ||
      typeof record.worktree !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(record.childSessionId)
    )
      continue;
    if (
      record.parentSessionId === parentSessionId &&
      record.branch === `nocturne/${record.childSessionId}` &&
      path.resolve(
        await realpath(path.dirname(record.worktree)),
        path.basename(record.worktree),
      ) === path.resolve(canonicalDirectory, record.childSessionId)
    )
      records.push(record);
  }
  return records;
}

export async function inspectWorktreeRepository(cwd: string): Promise<string> {
  let bare: string;
  try {
    bare = (await worktreeGit(cwd, ["rev-parse", "--is-bare-repository"])).trim();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("not a git repository"))
      throw new Error(
        "This directory is not a git repository, so a worktree cannot be created. Use a read-only subagent, or complete the task directly in the main agent.",
      );
    throw new Error(
      `Unable to inspect the git repository for worktree isolation: ${message}. Use a read-only subagent, or complete the task directly in the main agent.`,
    );
  }
  if (bare === "true")
    throw new Error(
      "This is a bare git repository, so an isolated subagent worktree cannot be created. Use a read-only subagent, or complete the task directly in the main agent.",
    );
  const repository = (await worktreeGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  try {
    await worktreeGit(repository, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(
      "This git repository has no commit at HEAD, so a worktree cannot be created. Use a read-only subagent, or complete the task directly in the main agent.",
    );
  }
  return repository;
}

export function safeWorktreePath(repository: string, file: string): string {
  if (path.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
    throw new Error(`Unsafe change path: ${file}`);
  return path.resolve(repository, file);
}

async function commit(cwd: string, message: string): Promise<void> {
  await worktreeGit(cwd, [
    "-c",
    "user.name=Nocturne",
    "-c",
    "user.email=nocturne@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "-m",
    message,
  ]);
}

export async function removeWorktree(
  record: Pick<WorktreeRecord, "repository" | "worktree" | "branch">,
  removeBranch: boolean,
): Promise<void> {
  try {
    await worktreeGit(record.repository, ["worktree", "remove", "--force", record.worktree]);
  } catch {
    await rm(record.worktree, { recursive: true, force: true });
    await worktreeGit(record.repository, ["worktree", "prune"]);
  }
  if (removeBranch) {
    if (!record.branch.startsWith("nocturne/"))
      throw new Error("Refusing to delete an unregistered branch namespace");
    await worktreeGit(record.repository, ["branch", "-D", record.branch]).catch(() => undefined);
    await rm(`${record.worktree}.json`, { force: true });
  }
}

export async function createWorktree(input: {
  childSessionId: string;
  parentSessionId: string;
  repository: string;
  sessionsDir: string;
  cwd: string;
  workspaceRoot: string;
  task: string;
  trusted: boolean;
  /** 可选起始提交（缺省 "HEAD"） */
  commit?: string | undefined;
  /** true 时以分离头指针创建工作树（用于审查指定提交，不拷贝主工作区未提交脏文件） */
  detach?: boolean | undefined;
}): Promise<WorktreeRecord> {
  if (!/^[A-Za-z0-9_-]+$/.test(input.childSessionId)) throw new Error("Invalid child session ID");
  const repositoryReal = await realpath(input.repository);
  const cwdRelative = path.relative(repositoryReal, await realpath(input.cwd));
  const workspaceRelative = path.relative(repositoryReal, await realpath(input.workspaceRoot));
  safeWorktreePath(input.repository, cwdRelative);
  safeWorktreePath(input.repository, workspaceRelative);
  const worktree = path.join(input.sessionsDir, "worktrees", input.childSessionId);
  const branch = `nocturne/${input.childSessionId}`;
  const startRef = input.commit ?? "HEAD";
  const record: WorktreeRecord = {
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    repository: input.repository,
    worktree,
    branch,
    base: "",
    snapshot: false,
    cwd: path.join(worktree, cwdRelative),
    workspaceRoot: path.join(worktree, workspaceRelative),
    task: input.task,
    includeSkipped: false,
  };
  let created = false;
  try {
    await mkdir(path.dirname(worktree), { recursive: true });
    if (input.detach === true) {
      await worktreeGit(input.repository, ["worktree", "add", "--detach", worktree, startRef]);
    } else {
      await worktreeGit(input.repository, ["worktree", "add", "-b", branch, worktree, startRef]);
    }
    created = true;
    const skippedSymlinks: string[] = [];
    const copy = async (file: string) => {
      const source = safeWorktreePath(input.repository, file);
      const target = safeWorktreePath(worktree, file);
      if ((await lstat(source)).isSymbolicLink()) {
        skippedSymlinks.push(file);
        return;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    };
    if (input.detach !== true && input.commit === undefined) {
      const patch = await worktreeGit(input.repository, ["diff", "--binary", "HEAD"]);
      if (patch) await worktreeGit(worktree, ["apply", "--binary", "-"], patch);
      const untracked = (
        await worktreeGit(input.repository, ["ls-files", "--others", "--exclude-standard", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      for (const file of untracked) await copy(file);
      await worktreeGit(worktree, ["add", "-A"]);
      if ((await worktreeGit(worktree, ["diff", "--cached", "--name-only"])).trim()) {
        await commit(worktree, "Nocturne workspace snapshot");
        record.snapshot = true;
      }
    }
    record.base = (await worktreeGit(worktree, ["rev-parse", "HEAD"])).trim();
    const include = await readFile(path.join(input.repository, ".worktreeinclude"), "utf8").catch(
      (cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      },
    );
    if (include !== undefined && !input.trusted) {
      record.includeSkipped = true;
    } else if (include && input.trusted) {
      const rules = compileGitignore(include);
      if (rules.length) {
        const ignored = (
          await worktreeGit(input.repository, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean);
        for (const file of ignored)
          if (matchGitignore(rules, file, false) === true) await copy(file);
      }
    }
    if (skippedSymlinks.length > 0) record.skippedSymlinks = skippedSymlinks;
    await writeFile(`${worktree}.json`, JSON.stringify(record), "utf8");
    return record;
  } catch (cause) {
    if (created) await removeWorktree(record, true);
    throw cause;
  }
}

async function computeWorktreeChanges(
  record: WorktreeRecord,
  head: string,
): Promise<SubagentChanges> {
  const statuses = new Map(
    (
      await worktreeGit(record.worktree, [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        record.base,
        head,
      ])
    )
      .split("\0")
      .reduce<[string, string][]>((pairs, value, index, all) => {
        if (index % 2 === 0 && value && all[index + 1]) pairs.push([all[index + 1] ?? "", value]);
        return pairs;
      }, []),
  );
  const stats = (
    await worktreeGit(record.worktree, [
      "diff",
      "--numstat",
      "--no-renames",
      "-z",
      record.base,
      head,
    ])
  )
    .split("\0")
    .filter(Boolean);
  return {
    branch: record.branch,
    base: record.base,
    head,
    snapshot: record.snapshot,
    worktree: record.worktree,
    files: stats.map((line) => {
      const [additions, deletions, ...parts] = line.split("\t");
      const file = parts.join("\t");
      safeWorktreePath(record.repository, file);
      return {
        path: file,
        status:
          statuses.get(file) === "A"
            ? "added"
            : statuses.get(file) === "D"
              ? "deleted"
              : "modified",
        ...(additions !== "-"
          ? { additions: Number(additions), deletions: Number(deletions) }
          : {}),
      };
    }),
  };
}

export async function settleWorktree(record: WorktreeRecord): Promise<SubagentChanges | undefined> {
  await worktreeGit(record.worktree, ["add", "-A"]);
  if ((await worktreeGit(record.worktree, ["diff", "--cached", "--name-only"])).trim()) {
    const firstLine = (record.task.split(/\r?\n/)[0] ?? "").trim();
    await commit(
      record.worktree,
      Array.from(firstLine === "" ? "Subagent changes" : firstLine)
        .slice(0, 72)
        .join(""),
    );
  }
  const head = (await worktreeGit(record.worktree, ["rev-parse", "HEAD"])).trim();
  if (head === record.base) {
    await removeWorktree(record, true);
    return undefined;
  }
  const changes = await computeWorktreeChanges(record, head);
  record.changes = changes;
  await writeFile(`${record.worktree}.json`, JSON.stringify(record), "utf8");
  return changes;
}

/**
 * 常驻 Swarm 成员的工作树增量检查点（ADR-0089 §4）：
 * 若有未提交改动则在自身分支上提交一次并刷新 `.json` 记录；无改动时保留工作树不删除。
 */
export async function checkpointWorktreeTurn(
  record: WorktreeRecord,
  commitMessage?: string,
): Promise<SubagentChanges | undefined> {
  const headRef = (
    await worktreeGit(record.worktree, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")
  ).trim();
  // 分离头指针状态（例如验证成员检出了别人的提交）不在成员分支上自动提交
  if (headRef !== "") {
    await worktreeGit(record.worktree, ["add", "-A"]);
    if ((await worktreeGit(record.worktree, ["diff", "--cached", "--name-only"])).trim()) {
      const firstLine = ((commitMessage ?? record.task).split(/\r?\n/)[0] ?? "").trim();
      await commit(
        record.worktree,
        Array.from(firstLine === "" ? "Swarm member changes" : firstLine)
          .slice(0, 72)
          .join(""),
      );
      record.applied = false;
    }
  }
  const head = (await worktreeGit(record.worktree, ["rev-parse", "HEAD"])).trim();
  if (head === record.base || headRef === "") {
    return undefined;
  }
  const changes = await computeWorktreeChanges(record, head);
  record.changes = changes;
  await writeFile(`${record.worktree}.json`, JSON.stringify(record), "utf8");
  return changes;
}

/**
 * 将验证成员的工作树清干净并分离头指针检出指定提交（ADR-0089 §4）。
 */
export async function resetWorktreeToCommit(worktree: string, commitRef: string): Promise<string> {
  await worktreeGit(worktree, ["reset", "--hard"]);
  await worktreeGit(worktree, ["clean", "-fdx"]);
  await worktreeGit(worktree, ["checkout", "--detach", commitRef]);
  await worktreeGit(worktree, ["clean", "-fdx"]);
  return (await worktreeGit(worktree, ["rev-parse", "HEAD"])).trim();
}

export async function markWorktreeApplied(
  record: WorktreeRecord,
  appliedHead: string,
): Promise<void> {
  record.base = appliedHead;
  record.applied = true;
  delete record.changes;
  await writeFile(`${record.worktree}.json`, JSON.stringify(record), "utf8");
}

export async function worktreeCurrentHead(worktree: string): Promise<string> {
  return (await worktreeGit(worktree, ["rev-parse", "HEAD"])).trim();
}

export async function isWorktreeOnBranch(record: WorktreeRecord): Promise<boolean> {
  const ref = (
    await worktreeGit(record.worktree, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")
  ).trim();
  return ref === `refs/heads/${record.branch}`;
}

export async function cleanupMergedWorktrees(
  sessionsDir: string,
  parentSessionId: string,
  preserveChildIds?: ReadonlySet<string>,
): Promise<void> {
  for (const record of await listWorktreeRecords(sessionsDir, parentSessionId)) {
    if (preserveChildIds?.has(record.childSessionId)) continue;
    if (!record.changes) continue;
    let merged = false;
    try {
      await worktreeGit(record.repository, [
        "merge-base",
        "--is-ancestor",
        record.changes.head,
        "HEAD",
      ]);
      merged = true;
    } catch {
      /* Unmerged branches are retained. */
    }
    if (merged) await removeWorktree(record, true);
  }
}

export async function applyWorktreeChanges(
  repository: string,
  changes: SubagentChanges,
  mode: "clean" | "3way",
): Promise<{ conflicts: string[] }> {
  for (const file of changes.files) safeWorktreePath(repository, file.path);
  const patch = await worktreeGit(repository, [
    "diff",
    "--binary",
    "--no-renames",
    changes.base,
    changes.head,
  ]);
  if (mode === "clean") {
    try {
      await worktreeGit(repository, ["apply", "--check", "-"], patch);
    } catch (cause) {
      throw new Error(
        `Changes cannot be applied cleanly: ${changes.files.map((file) => file.path).join(", ")}. Use mode: \"3way\" or merge with git. ${String(cause)}`,
      );
    }
    await worktreeGit(repository, ["apply", "-"], patch);
    return { conflicts: [] };
  }
  const existing = await worktreeGit(repository, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (existing)
    throw new Error(
      `Resolve existing conflicts before applying: ${existing.split("\0").filter(Boolean).join(", ")}`,
    );
  // A temporary index allows dirty working files and leaves the user's index intact.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "nocturne-apply-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index") };
  try {
    await worktreeGit(repository, ["read-tree", "HEAD"], undefined, env);
    const tracked = new Set(
      (await worktreeGit(repository, ["ls-files", "-z"], undefined, env))
        .split("\0")
        .filter(Boolean),
    );
    for (const file of changes.files) {
      const exists = await lstat(safeWorktreePath(repository, file.path)).then(
        () => true,
        () => false,
      );
      if (exists || tracked.has(file.path))
        await worktreeGit(repository, ["add", "-A", "--", file.path], undefined, env);
    }
    let failure: unknown;
    try {
      await worktreeGit(repository, ["apply", "--3way", "-"], patch, env);
    } catch (cause) {
      failure = cause;
    }
    const conflicts = (
      await worktreeGit(
        repository,
        ["diff", "--name-only", "--diff-filter=U", "-z"],
        undefined,
        env,
      )
    )
      .split("\0")
      .filter(Boolean);
    if (failure && conflicts.length === 0)
      throw failure instanceof Error ? failure : new Error("git apply failed");
    return { conflicts };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readWorktreeDiff(
  repository: string,
  changes: SubagentChanges,
  file: string,
): Promise<string> {
  safeWorktreePath(repository, file);
  if (!changes.files.some((entry) => entry.path === file))
    throw new Error("File is not part of this subagent result");
  return worktreeGit(repository, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    changes.base,
    changes.head,
    "--",
    file,
  ]);
}

export function worktreeResultText(changes: SubagentChanges): string {
  return `\n\nChanges (${changes.files.length} files):\n${changes.files
    .slice(0, 50)
    .map((file) => `${file.status}: ${file.path}`)
    .join(
      "\n",
    )}${changes.files.length > 50 ? `\nand ${changes.files.length - 50} more` : ""}\nBranch: ${changes.branch}\nRange: ${changes.base}..${changes.head}\nUse apply_subagent_changes to bring these changes into the main workspace, including uncommitted work, with checkpoint/rewind support. Alternatively use git merge ${changes.branch} or git cherry-pick ${changes.base}..${changes.head}.${changes.snapshot ? " The first branch commit is a snapshot of uncommitted work at launch; merge includes that snapshot. Prefer cherry-picking only the base..head range." : ""}`;
}
