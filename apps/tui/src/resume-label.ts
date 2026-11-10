/** /resume 与 /search 列表共用首句与相对时间格式；/resume 后列标识、模型和路径。 */
import path from "node:path";
import type { SessionSummary } from "@nocturne/core";

import { boxSafe, truncateLine } from "./format.js";

export function relativeTime(ms: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/\\/g, "/");
    return resolved.length > 1 && resolved.endsWith("/") && !/^[a-zA-Z]:\/$/.test(resolved)
      ? resolved.slice(0, -1)
      : resolved;
  };
  const left = norm(a);
  const right = norm(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function sessionTitleAndTime(
  summary: SessionSummary,
  width: number,
  now = Date.now(),
): string {
  const first = truncateLine(
    boxSafe(summary.firstText ?? "（暂无用户消息）"),
    Math.max(8, width - 34),
  );
  const clientMark = summary.client !== undefined ? "⇄ " : "";
  return `${clientMark}${summary.forkedFrom ? "分叉  " : ""}${first}  ${relativeTime(summary.mtimeMs, now)}`;
}

export function resumeLabel(summary: SessionSummary, width: number, now = Date.now()): string {
  const detail = `${summary.id}  ${summary.model.provider}/${summary.model.model}  ${summary.workspaceRoot}`;
  return truncateLine(
    `${sessionTitleAndTime(summary, width, now)}  ${boxSafe(detail)}`,
    Math.max(1, width),
  );
}

export function searchSessionLabel(
  summary: SessionSummary,
  currentCwd: string,
  width: number,
  now = Date.now(),
): string {
  const head = sessionTitleAndTime(summary, width, now);
  const tail = sameDirectory(summary.cwd, currentCwd) ? "" : `  ${boxSafe(summary.workspaceRoot)}`;
  return truncateLine(`${head}${tail}`, Math.max(1, width));
}
