/**
 * 客户端本地提示行（命令反馈、错误，tui.md §4）：不进 SessionView，
 * 但按推入时的条目数定位，随对话向上滚走，而不是永远钉在末尾。
 */
export interface ClientLine {
  /** 单调递增，做渲染键 */
  id: number;
  text: string;
  /** 推入时会话已有的条目数：显示在第 after 条之前 */
  after: number;
}

/**
 * 把提示行按 after 插进条目序列：after <= base + i 的行排在第 i 条之前，
 * 余下的排在最后。调用方先按区域筛好 lines。
 */
export function interleaveClient<T, R>(
  entries: readonly T[],
  base: number,
  lines: readonly ClientLine[],
  mapEntry: (entry: T) => readonly R[],
  mapLine: (line: ClientLine) => R,
): R[] {
  const sorted = [...lines].sort((a, b) => a.after - b.after || a.id - b.id);
  const out: R[] = [];
  entries.forEach((entry, i) => {
    while (sorted.length > 0 && (sorted[0]?.after ?? Infinity) <= base + i) {
      const line = sorted.shift();
      if (line !== undefined) out.push(mapLine(line));
    }
    out.push(...mapEntry(entry));
  });
  for (const line of sorted) out.push(mapLine(line));
  return out;
}
