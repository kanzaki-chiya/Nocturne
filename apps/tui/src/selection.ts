/**
 * 对话视口内的拖动选区（ADR-0021 第 1 条）。
 *
 * 选区按「内容行 + 列」记录：abs 是排版后完整行表中的绝对行号
 * （selectVisible 的窗口信息换算），col 是行内 UTF-16 偏移（caret 位）——
 * 滚动与流式追加只改变行表尾部，已有序号不动；宽度变化导致重排时由
 * 调用方清除选区。
 */
import stringWidth from "string-width";

import type { LaidLine, LineSegment } from "./viewport.js";

export interface SelPoint {
  /** 排版行表的绝对行号 */
  abs: number;
  /** 行内 UTF-16 caret 位（0..line.text.length） */
  col: number;
}

export interface Selection {
  anchor: SelPoint;
  head: SelPoint;
}

export function selNormalized(sel: Selection): { from: SelPoint; to: SelPoint } {
  const { anchor, head } = sel;
  return anchor.abs < head.abs || (anchor.abs === head.abs && anchor.col <= head.col)
    ? { from: anchor, to: head }
    : { from: head, to: anchor };
}

export function selIsEmpty(sel: Selection): boolean {
  const { from, to } = selNormalized(sel);
  return from.abs === to.abs && from.col === to.col;
}

/**
 * 视口显示列（0 基）→ 行内 caret 位。落在双宽字符右半格时算作该字符之后
 * （按整个字符选中，不把半个汉字留在选区外）。
 */
export function colFromDisplay(text: string, x: number): number {
  if (x <= 0) return 0;
  let used = 0;
  let i = 0;
  for (const ch of text) {
    const w = Math.max(1, stringWidth(ch));
    if (x < used + w) {
      // 双宽字符的右半格 → caret 收到字符之后
      return w === 2 && x === used + 1 ? i + ch.length : i;
    }
    used += w;
    i += ch.length;
  }
  return text.length;
}

/**
 * 选区在某一行上的字符范围（caret 位区间）；不在选区内返回 undefined。
 * end 为 text.length 表示选到行尾。
 */
export function selRangeOnLine(
  sel: Selection,
  abs: number,
): { start: number; end: number } | undefined {
  const { from, to } = selNormalized(sel);
  if (abs < from.abs || abs > to.abs) return undefined;
  if (from.abs === to.abs) {
    return from.col === to.col ? undefined : { start: from.col, end: to.col };
  }
  if (abs === from.abs) return { start: from.col, end: Number.MAX_SAFE_INTEGER };
  if (abs === to.abs) return { start: 0, end: to.col };
  return { start: 0, end: Number.MAX_SAFE_INTEGER };
}

/**
 * 把一行按选区字符范围拆成分段，选中部分标 `inverse`（渲染为反色）。
 * 供视口行渲染使用；无选区部分保留原分段样式。
 */
export function selSegments(line: LaidLine, range: { start: number; end: number }): LineSegment[] {
  const src = line.segments ?? [{ text: line.text }];
  const out: LineSegment[] = [];
  let at = 0;
  for (const seg of src) {
    let pos = 0;
    while (pos < seg.text.length) {
      const absStart = at + pos;
      const selHere = absStart >= range.start && absStart < range.end;
      const boundary = selHere
        ? range.end
        : absStart < range.start
          ? range.start
          : Number.MAX_SAFE_INTEGER;
      const len = Math.min(seg.text.length - pos, boundary - absStart);
      out.push({
        ...seg,
        text: seg.text.slice(pos, pos + len),
        ...(selHere ? { inverse: true } : {}),
      });
      pos += len;
    }
    at += seg.text.length;
  }
  return out;
}

/**
 * 构造复制文本：取渲染后的可见文字（LaidLine.text）。折行续行
 * （continued）拼回上一行，真换行保留；每个逻辑行行尾空白去掉。
 */
export function selCopyText(lines: readonly LaidLine[], sel: Selection): string {
  const { from, to } = selNormalized(sel);
  const picked: { text: string; continued: boolean }[] = [];
  for (let abs = from.abs; abs <= to.abs && abs < lines.length; abs++) {
    const line = lines[abs];
    if (line === undefined) continue;
    const range = selRangeOnLine(sel, abs);
    if (range === undefined) continue;
    picked.push({
      text: line.text.slice(range.start, Math.min(range.end, line.text.length)),
      continued: line.continued === true,
    });
  }
  let out = "";
  for (const part of picked) {
    if (out === "" || part.continued) out += part.text;
    else out += `\n${part.text}`;
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/u, ""))
    .join("\n");
}
