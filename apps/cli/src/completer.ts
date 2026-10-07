import { completeFileRefs, type FileIndexEntry } from "@nocturne/core";
import {
  completeSlash,
  readlineCompleter,
  type CompletionContext,
} from "@nocturne/tui/slash-catalog";
import { stripControls } from "@nocturne/tui/text-format";

/** readline 只能把候选字符串原样插入；说明分组另行显示，不写进草稿。 */
export function skillCompletionLines(line: string, context: CompletionContext): string[] {
  const hits = completeSlash(line, context, false);
  if (hits.length < 2 || !hits.some((hit) => hit.group === "skills" || hit.group === "agents"))
    return [];
  return hits.flatMap((hit, i) => [
    ...(hit.group && (i === 0 || hits[i - 1]?.group !== hit.group)
      ? [hit.group === "commands" ? "命令" : hit.group === "skills" ? "技能" : "外部 agent"]
      : []),
    `  ${stripControls(hit.label)}`,
  ]);
}

export function completeLine(
  line: string,
  context: CompletionContext,
  entries: readonly FileIndexEntry[],
): [string[], string] {
  const completion = completeFileRefs(line, line.length, entries);
  if (completion === undefined) return readlineCompleter(line, context);
  return [completion.candidates.map((item) => line.slice(0, completion.start) + item.insert), line];
}
