/**
 * 思考进行中的轮换文案表（桌面端、手机网页与 TUI 共用）。
 * 第 1 条仅在开头显示，之后按固定时间间隔在第 2 条到最后一条之间确定性轮换。
 */
export const THINKING_PHRASES: readonly string[] = [
  "思考中",
  "推理中",
  "梳理思路",
  "分析问题",
  "斟酌中",
  "理清头绪",
  "推敲细节",
  "权衡方案",
  "整理信息",
  "理解上下文",
  "寻找思路",
  "考虑其他可能",
];

/** 思考文案轮换间隔（毫秒）。 */
export const THINKING_PHRASE_INTERVAL_MS = 4000;

/**
 * 根据思考开始时刻与当前时刻返回应显示的进行中文案。
 * `startedMs` 未定义或已过时间不足一个间隔时返回第 1 条；之后在第 2 条到末条间循环。
 */
export function thinkingPhrase(startedMs: number | undefined, nowMs: number): string {
  const first = THINKING_PHRASES[0] ?? "思考中";
  if (startedMs === undefined || !Number.isFinite(startedMs) || !Number.isFinite(nowMs)) {
    return first;
  }
  const elapsed = Math.max(0, nowMs - startedMs);
  const step = Math.floor(elapsed / THINKING_PHRASE_INTERVAL_MS);
  if (step <= 0 || THINKING_PHRASES.length <= 1) return first;
  const cycleLength = THINKING_PHRASES.length - 1;
  return THINKING_PHRASES[1 + ((step - 1) % cycleLength)] ?? first;
}
