export interface DiffRow {
  kind: "add" | "delete" | "context" | "sep";
  num?: number;
  mark?: string;
  code?: string;
}

/** 行号：新增与上下文用新号、删除用旧号。 */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (rows.length > 0) rows.push({ kind: "sep" });
      continue;
    }
    if (
      /^(?:--- |\+\+\+ |diff |index |new file mode |deleted file mode |old mode |new mode |@@|\\)/.test(
        line,
      )
    )
      continue;
    const mark = line[0];
    if (mark === "+") {
      rows.push({ kind: "add", num: newLine++, mark: "+", code: line.slice(1) });
    } else if (mark === "-") {
      rows.push({ kind: "delete", num: oldLine++, mark: "−", code: line.slice(1) });
    } else {
      rows.push({
        kind: "context",
        num: newLine++,
        mark: " ",
        code: mark === " " ? line.slice(1) : line,
      });
      oldLine++;
    }
  }
  return rows;
}

export interface CodeSpan {
  from: number;
  to: number;
  classes: string;
}
export interface CodeLine {
  text: string;
  spans: CodeSpan[];
}
export interface CodeRequest {
  path: string;
  text: string;
  kind: "text" | "numbered" | "diff";
}

/**
 * 可视区对应的行范围（前后各多留 margin 行）。行高不固定：长行会折行，字号也能调，
 * 所以按每行的实际位置二分，不能用滚动距离除以行高。
 */
export function visibleLineWindow(
  count: number,
  topOf: (line: number) => number,
  viewTop: number,
  viewBottom: number,
  margin = 40,
): { start: number; end: number } {
  /** 第一个顶边到达 y 的行 */
  const firstAtOrBelow = (y: number): number => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (topOf(middle) < y) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    start: Math.max(0, firstAtOrBelow(viewTop) - 1 - margin),
    end: Math.min(count, firstAtOrBelow(viewBottom) + margin),
  };
}
