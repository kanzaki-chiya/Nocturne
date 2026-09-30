import { completeFileRefs, type FileIndexEntry } from "@nocturne/core";
import { readlineCompleter, type CompletionContext } from "@nocturne/tui/slash-catalog";

export function completeLine(
  line: string,
  context: CompletionContext,
  entries: readonly FileIndexEntry[],
): [string[], string] {
  const completion = completeFileRefs(line, line.length, entries);
  if (completion === undefined) return readlineCompleter(line, context);
  return [completion.candidates.map((item) => line.slice(0, completion.start) + item.insert), line];
}
