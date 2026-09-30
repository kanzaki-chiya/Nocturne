import { parseFileRefs } from "@nocturne/core";
import type { FileRef, UserEntry } from "@nocturne/core/protocol";

export function userText(entry: UserEntry): string {
  const snapshots = entry.fileRefs?.filter((ref) => ref.kind !== "image").length ?? 0;
  const content = snapshots === 0 ? entry.content : entry.content.slice(0, -snapshots);
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function fileRefLine(ref: FileRef): string {
  return `附带 @${ref.path}${ref.kind === "file" ? `（${ref.lines ?? 0}/${ref.totalLines ?? 0} 行）` : ref.kind === "directory" ? "（目录）" : "（图片）"}`;
}

/** 保留原文位置；输入窗口切片仍能给光标后的引用部分着色。 */
export function splitInputTokens(
  text: string,
  fullText = text,
  offset = 0,
): { text: string; image: boolean }[] {
  const spans = [
    ...parseFileRefs(fullText),
    ...Array.from(fullText.matchAll(/\[Image #\d+\]/g), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  ].sort((a, b) => a.start - b.start);
  const parts: { text: string; image: boolean }[] = [];
  let at = 0;
  for (const span of spans) {
    const start = Math.max(0, span.start - offset);
    const end = Math.min(text.length, span.end - offset);
    if (end <= start || start < at) continue;
    if (start > at) parts.push({ text: text.slice(at, start), image: false });
    parts.push({ text: text.slice(start, end), image: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), image: false });
  return parts;
}
