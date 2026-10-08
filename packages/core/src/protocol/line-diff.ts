/** 行级 unified diff。每行的换行符属于该行，避免 CRLF/LF 与末尾换行变化被吞掉。 */
interface SourceLine {
  text: string;
  ending: string;
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (match[0] === "") break;
    lines.push({ text: match[1] ?? "", ending: match[2] ?? "" });
  }
  return lines;
}

function same(a: SourceLine | undefined, b: SourceLine | undefined): boolean {
  return a?.text === b?.text && a?.ending === b?.ending;
}

function emit(line: SourceLine, mark: " " | "-" | "+"): string[] {
  const out = [`${mark}${line.text}`];
  if (line.ending === "") out.push("\\ No newline at end of file");
  else if (line.ending === "\r\n") out.push("\\ CRLF");
  else if (line.ending === "\r") out.push("\\ CR");
  return out;
}

/** 一个有界上下文的差异块；path 由工具结果的 output.path 提供。 */
function singleBlock(oldText: string, newText: string): LineDiff {
  if (oldText === newText) return { diff: "", added: 0, removed: 0 };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const limit = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < limit && same(oldLines[prefix], newLines[prefix])) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    same(oldLines[oldLines.length - suffix - 1], newLines[newLines.length - suffix - 1])
  )
    suffix++;
  const head = oldLines.slice(Math.max(0, prefix - 3), prefix);
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const tail = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 3);
  const oldCount = head.length + removed.length + tail.length;
  const newCount = head.length + added.length + tail.length;
  const oldStart = oldCount === 0 ? prefix : prefix - head.length + 1;
  const newStart = newCount === 0 ? prefix : prefix - head.length + 1;
  const diff = [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...head.flatMap((line) => emit(line, " ")),
    ...removed.flatMap((line) => emit(line, "-")),
    ...added.flatMap((line) => emit(line, "+")),
    ...tail.flatMap((line) => emit(line, " ")),
  ].join("\n");
  return { diff, added: added.length, removed: removed.length };
}

export interface LineDiff {
  diff: string;
  added: number;
  removed: number;
  approximate?: boolean;
}

/** Keep tool output byte-for-byte compatible with the original single-block diff. */
export function diffLines(oldText: string, newText: string, _path?: string): string {
  return singleBlock(oldText, newText).diff;
}

const MAX_DISTANCE = 1000;
interface Operation {
  line: SourceLine;
  mark: " " | "-" | "+";
}

function at<T>(items: ArrayLike<T>, index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error("Invalid diff index");
  return value;
}

/** Bounded Myers shortest edit script, with three context lines per unified hunk. */
export function lineDiff(oldText: string, newText: string): LineDiff {
  if (oldText === newText) return { diff: "", added: 0, removed: 0 };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && same(a[prefix], b[prefix])) prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    same(a[a.length - suffix - 1], b[b.length - suffix - 1])
  )
    suffix++;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const max = Math.min(MAX_DISTANCE, n + m);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let distance: number | undefined;
  if (Math.abs(n - m) <= max) {
    search: for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        const i = offset + k;
        let x =
          k === -d || (k !== d && at(v, i - 1) < at(v, i + 1)) ? at(v, i + 1) : at(v, i - 1) + 1;
        let y = x - k;
        while (x < n && y < m && same(a[prefix + x], b[prefix + y])) {
          x++;
          y++;
        }
        v[i] = x;
        if (x >= n && y >= m) {
          distance = d;
          break search;
        }
      }
    }
  }
  if (distance === undefined) return { ...singleBlock(oldText, newText), approximate: true };
  const reversed: Operation[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d--) {
    const previous = at(trace, d);
    const k = x - y;
    const i = offset + k;
    const previousK =
      k === -d || (k !== d && at(previous, i - 1) < at(previous, i + 1)) ? k + 1 : k - 1;
    const previousX = at(previous, offset + previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push({ line: at(a, prefix + --x), mark: " " });
      y--;
    }
    if (x === previousX) reversed.push({ line: at(b, prefix + --y), mark: "+" });
    else reversed.push({ line: at(a, prefix + --x), mark: "-" });
  }
  while (x > 0 && y > 0) {
    reversed.push({ line: at(a, prefix + --x), mark: " " });
    y--;
  }
  const operations: Operation[] = [
    ...a.slice(0, prefix).map((line): Operation => ({ line, mark: " " })),
    ...reversed.reverse(),
    ...a.slice(a.length - suffix).map((line): Operation => ({ line, mark: " " })),
  ];
  const ranges: { start: number; end: number }[] = [];
  let added = 0;
  let removed = 0;
  for (const [i, op] of operations.entries()) {
    if (op.mark === " ") continue;
    if (op.mark === "+") added++;
    else removed++;
    const start = Math.max(0, i - 3);
    const end = Math.min(operations.length, i + 4);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = end;
    else ranges.push({ start, end });
  }
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const range of ranges) {
    while (cursor < range.start) {
      const op = at(operations, cursor++);
      if (op.mark !== "+") oldLine++;
      if (op.mark !== "-") newLine++;
    }
    const hunk = operations.slice(range.start, range.end);
    const oldCount = hunk.filter((op) => op.mark !== "+").length;
    const newCount = hunk.filter((op) => op.mark !== "-").length;
    out.push(
      `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`,
    );
    for (const op of hunk) {
      out.push(...emit(op.line, op.mark));
      if (op.mark !== "+") oldLine++;
      if (op.mark !== "-") newLine++;
    }
    cursor = range.end;
  }
  return { diff: out.join("\n"), added, removed };
}
