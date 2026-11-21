import stringWidth from "string-width";

import { stripControls } from "./format.js";

export const HISTORY_SEARCH_LIMIT = 50;

export interface MatchRange {
  start: number;
  end: number;
}

export interface HistorySearchMatch {
  /** 原始输入历史字符串（回填时保持原样） */
  text: string;
  /** 换行压成空格后的单行展示文本 */
  label: string;
  /** 在 label 中命中的字符区间（不区分大小写，非重叠升序） */
  ranges: MatchRange[];
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export function collapseHistoryLine(text: string): string {
  return text.replace(/(?:\r\n?|\n)+/g, " ");
}

export function findMatchRanges(text: string, query: string): MatchRange[] {
  const needle = collapseHistoryLine(query).toLowerCase();
  if (needle === "" || text === "") return [];

  const lower = text.toLowerCase();
  const ranges: MatchRange[] = [];
  if (lower.length === text.length) {
    let from = 0;
    while (from <= lower.length - needle.length) {
      const start = lower.indexOf(needle, from);
      if (start < 0) break;
      ranges.push({ start, end: start + needle.length });
      from = start + needle.length;
    }
    return ranges;
  }

  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    const low = ch.toLowerCase();
    for (let k = low.length; k > 0; k--) map.push(i);
    norm += low;
    i += ch.length;
  }
  map.push(text.length);

  let from = 0;
  while (from <= norm.length - needle.length) {
    const start = norm.indexOf(needle, from);
    if (start < 0) break;
    const origStart = map[start] ?? 0;
    const origEnd = map[start + needle.length] ?? text.length;
    if (origEnd > origStart) ranges.push({ start: origStart, end: origEnd });
    from = start + needle.length;
  }
  return ranges;
}

/**
 * 过滤、去重、按最新在前排序并截断输入历史列表。
 * `history` 约定按时间从旧到新排列（末尾最新，与 readInputHistory 一致）。
 */
export function searchInputHistory(
  history: readonly string[],
  query: string,
  limit = HISTORY_SEARCH_LIMIT,
): HistorySearchMatch[] {
  if (limit <= 0 || history.length === 0) return [];
  const needle = collapseHistoryLine(query);
  const hasQuery = needle !== "";
  const seen = new Set<string>();
  const matches: HistorySearchMatch[] = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const text = history[i];
    if (text === undefined || text === "" || seen.has(text)) continue;
    seen.add(text);

    const label = collapseHistoryLine(text);
    if (!hasQuery) {
      matches.push({ text, label, ranges: [] });
    } else {
      const ranges = findMatchRanges(label, needle);
      if (ranges.length === 0) continue;
      matches.push({ text, label, ranges });
    }

    if (matches.length >= limit) break;
  }

  return matches;
}

export function splitHighlightSegments(
  text: string,
  ranges: readonly MatchRange[],
): HighlightSegment[] {
  if (text === "") return [];
  if (ranges.length === 0) return [{ text, hit: false }];

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/** 按终端可见宽度单行截断高亮片段，过滤控制字符并压平制表符 */
export function truncateHighlightSegments(
  segments: readonly HighlightSegment[],
  maxWidth: number,
  ellipsis = "…",
): HighlightSegment[] {
  if (maxWidth <= 0) return [];
  const cleaned = segments
    .map((seg) => ({
      text: stripControls(seg.text).replace(/\t/g, " "),
      hit: seg.hit,
    }))
    .filter((seg) => seg.text !== "");
  const total = cleaned.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
  if (total <= maxWidth) return cleaned;

  const ellipsisWidth = stringWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) {
    let tail = "";
    let w = 0;
    for (const ch of ellipsis) {
      const cw = stringWidth(ch);
      if (w + cw > maxWidth) break;
      tail += ch;
      w += cw;
    }
    return tail === "" ? [] : [{ text: tail, hit: false }];
  }

  const budget = maxWidth - ellipsisWidth;
  const out: HighlightSegment[] = [];
  let used = 0;
  for (const seg of cleaned) {
    let chunk = "";
    for (const ch of seg.text) {
      const cw = stringWidth(ch);
      if (used + cw > budget) {
        if (chunk !== "") out.push({ text: chunk, hit: seg.hit });
        out.push({ text: ellipsis, hit: false });
        return out;
      }
      chunk += ch;
      used += cw;
    }
    if (chunk !== "") out.push({ text: chunk, hit: seg.hit });
  }
  out.push({ text: ellipsis, hit: false });
  return out;
}
