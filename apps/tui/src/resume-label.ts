/** /resume 列表以首句与相对时间为主，标识、模型和路径保留为次要信息。 */
import type { SessionSummary } from "@nocturne/core";

import { boxSafe, truncateLine } from "./format.js";

function relativeTime(ms: number, now: number): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

export function resumeLabel(summary: SessionSummary, width: number, now = Date.now()): string {
  const first = truncateLine(
    boxSafe(summary.firstText ?? "（暂无用户消息）"),
    Math.max(8, width - 34),
  );
  const detail = `${summary.id}  ${summary.model.provider}/${summary.model.model}  ${summary.workspaceRoot}`;
  return truncateLine(
    `${first}  ${relativeTime(summary.mtimeMs, now)}  ${boxSafe(detail)}`,
    Math.max(1, width),
  );
}
