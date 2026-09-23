/**
 * `where` 的纯计算（permissions.md 4.2）。
 * 只比较字符串：两个参数都必须是已经过 realpath 解析的真实路径。
 * 大小写敏感性以数据传入，由 platform 按文件系统提供，权限层不硬编码。
 */

import type { SubjectWhere } from "../protocol/index.js";

function normalizeComparable(path: string, caseSensitive: boolean): string {
  let p = path.replaceAll("\\", "/");
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return caseSensitive ? p : p.toLowerCase();
}

/**
 * `resolved` 等于 `workspaceRoot` 或位于其下 → "workspace"，否则 "outside"。
 * 边界判定带分隔符，`C:\workspace2` 不会误判为 `C:\workspace` 内部。
 */
export function computeWhere(
  resolved: string,
  workspaceRoot: string,
  caseSensitive: boolean,
): SubjectWhere {
  const target = normalizeComparable(resolved, caseSensitive);
  const root = normalizeComparable(workspaceRoot, caseSensitive);
  if (target === root || target.startsWith(`${root}/`)) return "workspace";
  return "outside";
}
