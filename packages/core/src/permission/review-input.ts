/**
 * 审查输入的用户消息预算（ADR-0057 §7）：全部用户消息按时间顺序给出，
 * 总预算 8000 字、单条最多 2000 字；超出时保留第一条和尽量多的最近几条，
 * 中间插入「（省略 N 条）」。
 */

export const USER_MESSAGES_BUDGET = 8000;
export const USER_MESSAGE_LIMIT = 2000;

/** 省略标记自身占用的预留字数。 */
const MARKER_RESERVE = 16;

export function omittedMarker(count: number): string {
  return `（省略 ${count} 条）`;
}

export function budgetUserMessages(
  messages: readonly string[],
  budget = USER_MESSAGES_BUDGET,
  perMessage = USER_MESSAGE_LIMIT,
): string[] {
  const clipped = messages
    .filter((text) => text.trim() !== "")
    .map((text) => text.slice(0, perMessage));
  const total = clipped.reduce((sum, text) => sum + text.length, 0);
  const first = clipped[0];
  if (first === undefined || total <= budget) return clipped;
  let remaining = budget - first.length - MARKER_RESERVE;
  const tail: string[] = [];
  for (let i = clipped.length - 1; i >= 1; i--) {
    const text = clipped[i] ?? "";
    if (text.length > remaining) break;
    tail.unshift(text);
    remaining -= text.length;
  }
  const omitted = clipped.length - 1 - tail.length;
  return omitted > 0 ? [first, omittedMarker(omitted), ...tail] : clipped;
}

/** 项目指令前 N 字（拼接已加载的指令文件）。 */
export const PROJECT_NOTES_LIMIT = 2000;

export function projectNotesFrom(
  files: readonly { source: string; content: string }[],
  limit = PROJECT_NOTES_LIMIT,
): string | undefined {
  const text = files
    .map((file) => file.content.trim())
    .filter((content) => content !== "")
    .join("\n\n");
  return text === "" ? undefined : text.slice(0, limit);
}
