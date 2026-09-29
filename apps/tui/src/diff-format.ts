import stringWidth from "string-width";

import { boxSafe, stripControls } from "./format.js";
import { palettes, type ThemePalette } from "./theme.js";
import type { LaidLine, LineSegment } from "./viewport.js";

export interface DiffRow {
  mark: string;
  body: string;
  oldNo?: number;
  newNo?: number;
}

/** 兼容带行号的新头部、旧路径头部与无头部历史结果。 */
export function parseDiff(diff: string): DiffRow[] {
  let oldNo: number | undefined;
  let newNo: number | undefined;
  const rows: DiffRow[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
      oldNo = header === null ? undefined : Number(header[1]);
      newNo = header === null ? undefined : Number(header[3]);
      continue;
    }
    const mark = line[0] ?? " ";
    if (mark === "\\") {
      rows.push({ mark, body: line.slice(1).trimStart() });
      continue;
    }
    const row: DiffRow = { mark, body: line.slice(1) };
    if ((mark === " " || mark === "-") && oldNo !== undefined) row.oldNo = oldNo++;
    if ((mark === " " || mark === "+") && newNo !== undefined) row.newNo = newNo++;
    rows.push(row);
  }
  return rows;
}

export function diffSummary(rows: readonly DiffRow[]): string {
  return `新增 ${rows.filter((r) => r.mark === "+").length} 行，删除 ${rows.filter((r) => r.mark === "-").length} 行`;
}

function pieces(text: string, width: number): string[] {
  const out: string[] = [];
  let part = "";
  let used = 0;
  for (const ch of text) {
    const size = Math.max(1, stringWidth(ch));
    if (used + size > width && part !== "") {
      out.push(part);
      part = "";
      used = 0;
    }
    part += ch;
    used += size;
  }
  out.push(part);
  return out;
}

/** 同一源码行的续行只携带空白行号栏；复制时可拼回原行。 */
export function layoutDiffRow(
  key: string,
  row: DiffRow,
  width: number,
  color: boolean,
  theme: ThemePalette = palettes.dark,
): LaidLine[] {
  const gutter =
    `${row.oldNo ?? ""}`.padStart(4) + ` ${row.newNo ?? ""}`.padStart(4) + ` ${row.mark} `;
  const indent = " ".repeat(gutter.length);
  const backgroundColor =
    color && row.mark === "+"
      ? theme.diffAddBg
      : color && row.mark === "-"
        ? theme.diffRemoveBg
        : undefined;
  return pieces(boxSafe(stripControls(row.body)), Math.max(1, width - gutter.length - 4)).map(
    (piece, i) => {
      const lead = i === 0 ? gutter : indent;
      const visible = `${lead}${piece}`;
      const padding = " ".repeat(Math.max(0, width - stringWidth(visible)));
      const segments: LineSegment[] =
        backgroundColor === undefined
          ? [{ text: lead }, { text: piece }]
          : [
              { text: lead, backgroundColor },
              { text: piece, backgroundColor },
              { text: padding, backgroundColor },
            ];
      return {
        key: `${key}:${i}`,
        text: backgroundColor === undefined ? visible : visible + padding,
        segments,
        continued: i > 0,
        ...(i > 0 ? { copyIndent: indent.length } : {}),
      };
    },
  );
}
