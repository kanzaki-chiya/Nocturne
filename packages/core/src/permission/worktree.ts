import path from "node:path";
import { realpathSync } from "node:fs";
import type { PermissionSubject } from "../protocol/index.js";

export const WORKTREE_DENY = (root: string): string =>
  `This subagent is isolated in its own worktree; commands must stay inside it. Worktree: ${root}`;

export const SIBLING_WORKTREE_EDIT_DENY = (other: string, current: string): string =>
  `File is in another worktree (${other}); current worktree is ${current}. Switch worktree first or edit files in the current worktree.`;

export const SIBLING_WORKTREE_READ_NOTICE = (other: string, current: string): string =>
  `[Note: This file is in another worktree (${other}); current worktree is ${current}.]`;

export function findSiblingWorktree(
  subject: PermissionSubject,
  worktrees: { current: string; roots: readonly string[] } | undefined,
  caseSensitive: boolean,
): { other: string; current: string } | undefined {
  if (!worktrees || (subject.kind !== "read" && subject.kind !== "edit")) return undefined;
  const candidate = subject.resolved ?? subject.target;
  const norm = (value: string) => {
    const resolved = resolveRealSync(path.resolve(value));
    const text = resolved.replaceAll("\\", "/").replace(/\/$/, "");
    return caseSensitive ? text : text.toLowerCase();
  };
  const inside = (root: string, target: string) => {
    const r = norm(root);
    const t = norm(target);
    return t === r || t.startsWith(`${r}/`);
  };
  const roots = [...worktrees.roots].sort((a, b) => norm(b).length - norm(a).length);
  const currentRoot = roots.find((root) => inside(root, worktrees.current)) ?? worktrees.current;
  const hit = roots.find((root) => inside(root, candidate));
  return hit === undefined || norm(hit) === norm(currentRoot)
    ? undefined
    : { other: hit, current: currentRoot };
}

function resolveRealSync(target: string): string {
  const abs = path.resolve(target);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Text-based guard, like the high-risk command checks; this is not a sandbox. */
export function escapesWorktree(
  subject: PermissionSubject,
  root: string,
  cwd: string,
  caseSensitive: boolean,
): boolean {
  if (subject.kind !== "shell") return false;
  const currentCwd = subject.shellCwd ?? cwd;
  const normalize = (value: string, from = currentCwd) => {
    const resolved = resolveRealSync(path.resolve(from, value));
    const normalized = resolved.replaceAll("\\", "/").replace(/\/$/, "");
    return caseSensitive ? normalized : normalized.toLowerCase();
  };
  const base = normalize(root, cwd);
  const outside = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "-" || trimmed === "~" || /^~[\\/]/.test(trimmed))
      return true;
    const target = normalize(trimmed);
    return target !== base && !target.startsWith(`${base}/`);
  };
  if (outside(currentCwd)) return true;
  const value = `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s;&|)}]+))`;
  const patterns = [
    new RegExp(`\\bgit(?:\\.exe)?\\s+(?:-[cC]\\s+[^\\s]+\\s+)*-C\\s*${value}`, "g"),
    new RegExp(`--(?:git-dir|work-tree)(?:=|\\s+)${value}`, "gi"),
    new RegExp(`(?:\\$env:)?GIT_(?:DIR|WORK_TREE)\\s*=\\s*${value}`, "gi"),
    new RegExp(
      `(?:^|[;&|\\r\\n({])\\s*(?:cd|chdir|pushd|Set-Location|sl|Push-Location)\\b(?:\\s+(?:\\/d|-[LP]|--|-(?:Literal)?Path))*(?:\\s+${value}|\\s*(?=$|[;&|\\r\\n)}]))`,
      "gi",
    ),
  ];
  return patterns.some((pattern) =>
    [...subject.target.matchAll(pattern)].some((match) =>
      outside(match[1] ?? match[2] ?? match[3] ?? ""),
    ),
  );
}
