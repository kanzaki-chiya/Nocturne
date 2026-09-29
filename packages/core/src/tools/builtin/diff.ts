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
export function diffLines(oldText: string, newText: string, _path?: string): string {
  if (oldText === newText) return "";
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
  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...head.flatMap((line) => emit(line, " ")),
    ...removed.flatMap((line) => emit(line, "-")),
    ...added.flatMap((line) => emit(line, "+")),
    ...tail.flatMap((line) => emit(line, " ")),
  ].join("\n");
}
