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
