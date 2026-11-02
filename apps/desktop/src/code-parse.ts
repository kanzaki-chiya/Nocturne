import { highlightTree } from "@lezer/highlight";
import { languageFor } from "./code-language";
import { codeHighlighter } from "./code-tags";
import { diffRows, type CodeLine, type CodeRequest } from "./code-lines";

const SLICE_MS = 4;

function pause(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(signal?.aborted !== true);
    }, 0);
  });
}

/** 分片增量解析，整段旧/新侧分别解析后按偏移映射回可见行。 */
export async function parseCode(
  request: CodeRequest,
  signal?: AbortSignal,
): Promise<CodeLine[] | undefined> {
  const support = await languageFor(request.path)?.();
  if (support === undefined || signal?.aborted === true) return undefined;
  const parser = support.language.parser;
  async function parseTree(text: string): Promise<ReturnType<typeof parser.parse> | undefined> {
    const ongoing = parser.startParse(text);
    let until = performance.now() + SLICE_MS;
    for (;;) {
      if (signal?.aborted === true) return undefined;
      const tree = ongoing.advance();
      if (tree !== null) return tree;
      if (performance.now() >= until) {
        if (!(await pause(signal))) return undefined;
        until = performance.now() + SLICE_MS;
      }
    }
  }
  async function parse(lines: string[], prefixes: number[] = []): Promise<CodeLine[] | undefined> {
    const result = lines.map((text): CodeLine => ({ text, spans: [] }));
    const text = lines.map((line, i) => line.slice(prefixes[i] ?? 0)).join("\n");
    const tree = await parseTree(text);
    if (tree === undefined) return undefined;
    const starts: number[] = [];
    let at = 0;
    for (const [i, line] of lines.entries()) {
      starts.push(at);
      at += line.length - (prefixes[i] ?? 0) + 1;
    }
    const tokens: { from: number; to: number; classes: string }[] = [];
    highlightTree(tree, codeHighlighter, (from, to, classes) => {
      tokens.push({ from, to, classes });
    });
    let index = 0;
    let until = performance.now() + SLICE_MS;
    for (const { from, to, classes } of tokens) {
      if (signal?.aborted === true) return undefined;
      while (index + 1 < starts.length && (starts[index + 1] ?? Infinity) <= from) index++;
      for (let i = index; i < lines.length && (starts[i] ?? Infinity) < to; i++) {
        const lineStart = starts[i] ?? 0;
        const lineText = lines[i] ?? "";
        const prefix = prefixes[i] ?? 0;
        const start = Math.max(from - lineStart, 0) + prefix;
        const end = Math.min(to - lineStart + prefix, lineText.length);
        if (start < end) result[i]?.spans.push({ from: start, to: end, classes });
      }
      if (performance.now() >= until) {
        if (!(await pause(signal))) return undefined;
        until = performance.now() + SLICE_MS;
      }
    }
    return result;
  }
  if (request.kind !== "diff") {
    const lines = request.text.split("\n");
    return parse(
      lines,
      request.kind === "numbered"
        ? lines.map((line) => /^\d+\|/.exec(line)?.[0].length ?? line.length)
        : [],
    );
  }
  const rows = diffRows(request.text);
  const result = rows.map((row): CodeLine => ({ text: row.code ?? "", spans: [] }));
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end < rows.length && rows[end]?.kind !== "sep") end++;
    for (const side of ["old", "new"] as const) {
      const indices: number[] = [];
      for (let i = start; i < end; i++) {
        if (rows[i]?.kind !== (side === "old" ? "add" : "delete")) indices.push(i);
      }
      const parsed = await parse(indices.map((i) => rows[i]?.code ?? ""));
      if (parsed === undefined) return undefined;
      indices.forEach((row, i) => {
        const line = parsed[i];
        if (line !== undefined && (side === "new" || rows[row]?.kind === "delete")) {
          result[row] = line;
        }
      });
    }
    start = end + 1;
  }
  return result;
}
