import { inlineFilesOfTool, type ViewEntry } from "@nocturne/core/protocol";

export interface VirtualRange {
  start: number;
  end: number;
}

export type VirtualSegment =
  { kind: "spacer"; key: string; height: number } | { kind: "item"; index: number };

export const DEFAULT_VIEWPORT_HEIGHT = 844;
export const DEFAULT_OVERSCAN_PX = 600;
export const MIN_TAIL_ITEMS = 12;

export function isPinnedInlineHtmlEntry(entry: ViewEntry): boolean {
  return entry.kind === "tool" && inlineFilesOfTool(entry).length > 0;
}

export function estimateEntryHeight(entry: ViewEntry): number {
  switch (entry.kind) {
    case "tool":
      return isPinnedInlineHtmlEntry(entry) ? 220 : 44;
    case "user":
      return 76;
    case "assistant": {
      const textLen = entry.text.length;
      const lines = Math.max(1, Math.ceil(textLen / 42));
      return Math.min(360, 52 + lines * 22);
    }
    default:
      return 48;
  }
}

/**
 * 构建前缀偏移数组：`offsets[i]` 为第 i 条之前的累计高度，`offsets[count]` 为总高度。
 */
export function buildVirtualOffsets(
  entries: readonly ViewEntry[],
  keys: readonly string[],
  measuredHeights: ReadonlyMap<string, number>,
): Float64Array {
  const count = entries.length;
  const offsets = new Float64Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    offsets[i] = total;
    const key = keys[i];
    const entry = entries[i];
    const measured = key !== undefined ? measuredHeights.get(key) : undefined;
    const height =
      measured !== undefined && measured > 0
        ? measured
        : entry !== undefined
          ? estimateEntryHeight(entry)
          : 48;
    total += height;
  }
  offsets[count] = total;
  return offsets;
}

/** 二分查找包含给定纵坐标 offset 的条目索引（0..count-1）。 */
export function findIndexAtOffset(offsets: Float64Array, count: number, offset: number): number {
  if (count <= 0) return 0;
  if (offset <= 0) return 0;
  const total = offsets[count] ?? 0;
  if (offset >= total) return count - 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((offsets[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function computeVirtualRange(input: {
  offsets: Float64Array;
  count: number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number | undefined;
  followBottom: boolean;
}): VirtualRange {
  const { offsets, count, scrollTop, followBottom } = input;
  if (count <= 0) return { start: 0, end: -1 };
  const viewportHeight = input.viewportHeight > 0 ? input.viewportHeight : DEFAULT_VIEWPORT_HEIGHT;
  const overscanPx = input.overscanPx ?? DEFAULT_OVERSCAN_PX;

  if (followBottom) {
    const total = offsets[count] ?? 0;
    const targetTop = Math.max(0, total - (viewportHeight + overscanPx));
    let start = findIndexAtOffset(offsets, count, targetTop);
    const minStart = Math.max(0, count - MIN_TAIL_ITEMS);
    if (start > minStart) start = minStart;
    return { start, end: count - 1 };
  }

  const topBound = Math.max(0, scrollTop - overscanPx);
  const bottomBound = Math.max(0, scrollTop) + viewportHeight + overscanPx;
  const start = findIndexAtOffset(offsets, count, topBound);
  const end = Math.min(count - 1, findIndexAtOffset(offsets, count, bottomBound) + 1);
  return { start, end };
}

/**
 * 将当前视口窗口与需要常驻不回收的条目（例如已挂载的 `render_html` 页面、跳转目标）
 * 合并为按索引严格升序排列的片段列表：空白占位与真实条目交替出现。
 * 严格升序保证 React 协调时不会对常驻节点执行 `insertBefore`，从而避免 iframe 重载。
 */
export function buildVirtualSegments(input: {
  count: number;
  range: VirtualRange;
  pinnedIndices: readonly number[];
  offsets: Float64Array;
}): VirtualSegment[] {
  const { count, range, pinnedIndices, offsets } = input;
  if (count <= 0) return [];

  const mountedSet = new Set<number>();
  if (range.end >= range.start) {
    const lo = Math.max(0, range.start);
    const hi = Math.min(count - 1, range.end);
    for (let i = lo; i <= hi; i += 1) mountedSet.add(i);
  }
  for (const idx of pinnedIndices) {
    if (idx >= 0 && idx < count) mountedSet.add(idx);
  }

  if (mountedSet.size === 0) {
    const total = offsets[count] ?? 0;
    return total > 0 ? [{ kind: "spacer", key: "sp-tail", height: total }] : [];
  }

  const mounted = [...mountedSet].sort((a, b) => a - b);
  const segments: VirtualSegment[] = [];
  let cursor = 0;

  for (const idx of mounted) {
    if (idx > cursor) {
      const gapHeight = (offsets[idx] ?? 0) - (offsets[cursor] ?? 0);
      if (gapHeight > 0) {
        segments.push({ kind: "spacer", key: `sp-before:${idx}`, height: gapHeight });
      }
    }
    segments.push({ kind: "item", index: idx });
    cursor = idx + 1;
  }

  if (cursor < count) {
    const tailHeight = (offsets[count] ?? 0) - (offsets[cursor] ?? 0);
    if (tailHeight > 0) {
      segments.push({ kind: "spacer", key: "sp-tail", height: tailHeight });
    }
  }

  return segments;
}
