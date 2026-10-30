import path from "node:path";
import { realpathSync } from "node:fs";
import type { PermissionSubject } from "../protocol/index.js";

export const WORKTREE_DENY =
  "This subagent is isolated in its own worktree; commands must stay inside it.";

/** Text-based guard, like the high-risk command checks; this is not a sandbox. */
export function escapesWorktree(
  subject: PermissionSubject,
  root: string,
  cwd: string,
  caseSensitive: boolean,
): boolean {
  if (subject.kind !== "shell") return false;
  const normalize = (value: string) => {
    let resolved = path.resolve(cwd, value);
    try {
      resolved = realpathSync(resolved);
    } catch {
      /* Missing paths still have a lexical location. */
    }
    const normalized = resolved.replaceAll("\\", "/").replace(/\/$/, "");
    return caseSensitive ? normalized : normalized.toLowerCase();
  };
  const base = normalize(root);
  const outside = (value: string) => {
    const target = normalize(value);
    return target !== base && !target.startsWith(`${base}/`);
  };
  if (outside(subject.shellCwd ?? cwd)) return true;
  const value = `(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s;&|]+))`;
  const patterns = [
    new RegExp(`\\bgit(?:\\.exe)?\\s+(?:-[cC]\\s+[^\\s]+\\s+)*-C\\s*${value}`, "g"),
    new RegExp(`--(?:git-dir|work-tree)(?:=|\\s+)${value}`, "gi"),
    new RegExp(`(?:\\$env:)?GIT_(?:DIR|WORK_TREE)\\s*=\\s*${value}`, "gi"),
  ];
  return patterns.some((pattern) =>
    [...subject.target.matchAll(pattern)].some((match) =>
      outside(match[1] ?? match[2] ?? match[3] ?? ""),
    ),
  );
}
