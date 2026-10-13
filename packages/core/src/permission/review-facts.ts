/**
 * 审查的补充事实（ADR-0057 §7）：权限层预先查好、审查器只消费。
 * - `git reset --hard` / `git clean` / `git checkout -- .`：附 `git status --porcelain` 的行数；
 * - 推送类命令：附目标 remote、分支以及是否在可信列表里。
 * 查询失败就不给，不影响审查。git 的实际调用由 runtime 注入（`GitRunner`）。
 */
import type { ReviewFacts, ReviewSubject } from "./types.js";
import { shellDialect, shellSegments } from "./pattern.js";

/** 运行一次 git 并返回 stdout；失败返回 undefined。 */
export type GitRunner = (args: string[], signal: AbortSignal) => Promise<string | undefined>;

/** 审查前异步取事实：由 runtime 注入，权限层只消费结果。 */
export type ReviewFactsProvider = (
  subjects: readonly ReviewSubject[],
  signal: AbortSignal,
) => Promise<ReviewFacts | undefined>;

interface PushTarget {
  remote?: string | undefined;
  branch?: string | undefined;
}

interface FactNeeds {
  status: boolean;
  push?: PushTarget | undefined;
}

function words(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
}

/** git 全局选项（-C dir、-c k=v）要跳过，找到子命令的位置。 */
function gitSubcommand(args: string[]): { sub: string; rest: string[] } | undefined {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") i += 2;
    else if (arg.startsWith("-")) i += 1;
    else break;
  }
  const sub = args[i];
  return sub === undefined ? undefined : { sub, rest: args.slice(i + 1) };
}

/** 从 shell 命令里找出需要补充事实的 git 调用。 */
export function detectFactNeeds(subjects: readonly ReviewSubject[]): FactNeeds {
  const needs: FactNeeds = { status: false };
  for (const subject of subjects) {
    if (subject.kind !== "shell") continue;
    for (const segment of shellSegments(subject.target, shellDialect(undefined))) {
      const parts = words(segment);
      if ((parts[0] ?? "").replace(/\.exe$/i, "").toLowerCase() !== "git") continue;
      const found = gitSubcommand(parts.slice(1));
      if (found === undefined) continue;
      const { sub, rest } = found;
      if (sub === "reset" && rest.includes("--hard")) needs.status = true;
      else if (sub === "clean") needs.status = true;
      else if (sub === "checkout" && rest.includes("--") && rest.includes(".")) needs.status = true;
      else if (sub === "push") {
        const positional = rest.filter((arg) => !arg.startsWith("-"));
        const destination = positional[1]?.split(":").at(-1);
        needs.push ??= {
          remote: positional[0],
          // `src:dst` 取 dst；`:dst`（删除）取 dst；HEAD 不是分支名，交给查询
          branch: destination === undefined || destination === "" ? undefined : destination,
        };
      }
    }
  }
  return needs;
}

/** 解析 `git remote -v`：每个 remote 一行 `name url`，fetch / push 去重。 */
export function parseGitRemotes(output: string): string[] {
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)(?:\s+\((?:fetch|push)\))?\s*$/.exec(line.trim());
    if (match !== null) seen.add(`${match[1]} ${match[2]}`);
  }
  return [...seen];
}

/** remote 实参（名称或 URL）是否出现在可信列表（`name url`）里。 */
export function isTrustedRemote(remote: string, trusted: readonly string[]): boolean {
  return trusted.some((entry) => {
    const [name, url] = entry.split(/\s+/);
    return remote === name || remote === url;
  });
}

/** 会话创建时读一次 git remote；拿不到就是空列表。 */
export async function readTrustedRemotes(git: GitRunner, signal: AbortSignal): Promise<string[]> {
  try {
    const output = await git(["remote", "-v"], signal);
    return output === undefined ? [] : parseGitRemotes(output);
  } catch {
    return [];
  }
}

/** 构造事实提供函数：查询失败的项不给，整体失败返回 undefined。 */
export function createReviewFacts(options: {
  git: GitRunner;
  trustedRemotes: () => readonly string[] | Promise<readonly string[]>;
}): ReviewFactsProvider {
  return async (subjects, signal) => {
    const needs = detectFactNeeds(subjects);
    if (!needs.status && needs.push === undefined) return undefined;
    const facts: ReviewFacts = {};
    try {
      if (needs.status) {
        const output = await options.git(["status", "--porcelain"], signal);
        if (output !== undefined) {
          facts.uncommittedChanges = output
            .split(/\r?\n/)
            .filter((line) => line.trim() !== "").length;
        }
      }
      if (needs.push !== undefined) {
        let remote = needs.push.remote;
        let branch = needs.push.branch;
        if (remote === undefined || branch === undefined || branch === "HEAD") {
          if (branch === undefined || branch === "HEAD") {
            const current = (
              await options.git(["rev-parse", "--abbrev-ref", "HEAD"], signal)
            )?.trim();
            if (current !== undefined && current !== "" && current !== "HEAD") branch = current;
          }
          if (remote === undefined) {
            const upstream = (
              await options.git(
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
                signal,
              )
            )?.trim();
            if (upstream?.includes("/") === true) remote = upstream.split("/")[0];
          }
        }
        if (remote !== undefined || branch !== undefined) {
          facts.push = {
            ...(remote !== undefined ? { remote } : {}),
            ...(branch !== undefined ? { branch } : {}),
            trusted:
              remote !== undefined && isTrustedRemote(remote, await options.trustedRemotes()),
          };
        }
      }
    } catch {
      return undefined;
    }
    return facts.uncommittedChanges === undefined && facts.push === undefined ? undefined : facts;
  };
}
