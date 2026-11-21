/**
 * Grant 匹配（permissions.md 5.4、ADR-0106）：
 * - `matchGrant` 只做精确匹配（`g.match === undefined`）；
 * - `matchPatternGrant` 匹配项目级 shell 模式 Grant（`g.match === "pattern"`）。
 * 授权键：路径类取 resolved（缺失时取规范化 target），
 * shell 取完整命令字符串，network / mcp 取 target 原值。
 */
import type { Grant, PermissionSubject } from "../protocol/index.js";
import { isPathKind, matchShellPattern, normalizePathText } from "./pattern.js";

/** 主体的授权键（Grant.target 的规范化形式） */
export function grantKey(subject: PermissionSubject, caseSensitive: boolean): string {
  if (isPathKind(subject.kind)) {
    return normalizePathText(subject.resolved ?? subject.target, caseSensitive);
  }
  return subject.target;
}

/** 由确认通过的主体生成 Grant 记录 */
export function grantFromSubject(
  subject: PermissionSubject,
  caseSensitive: boolean,
  now: string = new Date().toISOString(),
): Grant {
  return { kind: subject.kind, target: grantKey(subject, caseSensitive), createdAt: now };
}

/** 精确匹配：只匹配精确 Grant（g.match === undefined），kind 相同且授权键相等 */
export function matchGrant(
  grants: readonly Grant[],
  subject: PermissionSubject,
  caseSensitive: boolean,
): Grant | undefined {
  const key = grantKey(subject, caseSensitive);
  return grants.find((g) => g.match === undefined && g.kind === subject.kind && g.target === key);
}

/** 模式匹配：只匹配项目级 shell 模式 Grant（g.match === "pattern"） */
export function matchPatternGrant(
  grants: readonly Grant[],
  subject: PermissionSubject,
): Grant | undefined {
  if (subject.kind !== "shell") return undefined;
  return grants.find(
    (g) =>
      g.match === "pattern" && g.kind === "shell" && matchShellPattern(g.target, subject.target),
  );
}
