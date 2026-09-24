/**
 * Grant 匹配（permissions.md 5.4）：只精确匹配。
 * 授权键：路径类取 resolved（缺失时取规范化 target），
 * shell 取完整命令字符串，network / mcp 取 target 原值。
 */
import type { Grant, PermissionSubject } from "../protocol/index.js";
import { normalizePathText } from "./pattern.js";

const PATH_KINDS = new Set(["read", "edit"]);

/** 主体的授权键（Grant.target 的规范化形式） */
export function grantKey(subject: PermissionSubject, caseSensitive: boolean): string {
  if (PATH_KINDS.has(subject.kind)) {
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

/** 精确匹配：kind 相同且授权键相等 */
export function matchGrant(
  grants: readonly Grant[],
  subject: PermissionSubject,
  caseSensitive: boolean,
): Grant | undefined {
  const key = grantKey(subject, caseSensitive);
  return grants.find((g) => g.kind === subject.kind && g.target === key);
}
