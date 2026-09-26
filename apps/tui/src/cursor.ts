/**
 * 硬件光标列（ADR-0020）：IME 预编辑跟着硬件光标，不跟着绘制位置。
 * 按显示宽度计算，中文占 2 列。超出可视宽度时停在最后一个可见字符之后。
 */
import stringWidth from "string-width";

export function cursorColumn(prompt: string, textBefore: string, width: number): number {
  if (width <= 1) return 0;
  const limit = Math.max(0, width - 2);
  let used = 0;
  let out = "";
  const raw = `${prompt}${textBefore}`;
  for (const ch of raw) {
    const w = stringWidth(ch);
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return Math.min(limit, stringWidth(out));
}
