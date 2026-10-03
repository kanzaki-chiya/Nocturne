import stringWidth from "string-width";

import type { CursorPoint } from "./cursor.js";

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

/** Ink 标准 log-update 在整帧前用 eraseLines(n)；剥掉它，保留帧内 SGR。 */
export function inkFrame(write: string): string | undefined {
  if (write.includes("\x1b[2J")) {
    return write.slice(write.lastIndexOf("\x1b[2J") + 4);
  }
  if (write.includes("\x1b[2K")) {
    const end = write.lastIndexOf("\x1b[G");
    if (end >= 0) return write.slice(end + 3);
  }
  // 初帧没有 eraseLines；纯光标/模式控制不算帧。
  if (!write.includes("\n")) return undefined;
  return write.replace(/^\x1b\[\?25l/, "");
}

/** 比较完整帧；Ink 仍负责 30fps 节流，这里只负责终端写出。 */
export class OutputLayer {
  private previous: string[] = [];
  private dimensions = "";
  private page = "";

  reset(): void {
    this.previous = [];
    this.dimensions = "";
    this.page = "";
  }

  render(
    frame: string,
    columns: number,
    rows: number,
    conversation: number,
    page: string,
    cursor: CursorPoint | undefined,
  ): string {
    const height = Math.max(0, rows - 1);
    const next = frame.replace(/\n$/, "").split("\n").slice(0, height);
    // Ink 缩窄时会先提交旧布局；等新宽度的帧，避免终端折行污染行缓存。
    if (next.some((line) => stringWidth(line) > columns)) return "";
    while (next.length < height) next.push("");
    const full = this.dimensions !== `${columns}x${rows}` || this.page !== page;
    const old = full ? [] : this.previous;
    const viewport = Math.min(conversation, height);
    let scroll = 0;
    // 小位移才划算；大幅翻阅和重排按行覆盖，避免滚动状态误判。
    const limit = Math.min(4, Math.floor(viewport / 3));
    const changed = next.slice(0, viewport).filter((line, i) => line !== old[i]).length;
    if (old.length === height && viewport > 2 && changed >= viewport / 2) {
      for (let k = 1; k <= limit; k++) {
        // 流式尾行的光标标记会随内容移动，允许最多两行同时变化。
        const upChanges = next
          .slice(0, viewport - k)
          .filter((line, i) => line !== old[i + k]).length;
        if (upChanges <= 2 && k + upChanges < viewport / 2) {
          scroll = k;
          break;
        }
        const downChanges = next.slice(k, viewport).filter((line, i) => line !== old[i]).length;
        if (downChanges <= 2 && k + downChanges < viewport / 2) {
          scroll = -k;
          break;
        }
      }
    }

    let output = BEGIN + HIDE;
    const shifted = [...old];
    if (scroll !== 0) {
      output += `\x1b[1;${viewport}r\x1b[1;1H\x1b[${Math.abs(scroll)}${scroll > 0 ? "S" : "T"}\x1b[r`;
      for (let i = 0; i < viewport; i++) shifted[i] = old[i + scroll] ?? "";
    }
    for (let i = 0; i < height; i++) {
      const line = next[i];
      if (line === undefined || line === shifted[i]) continue;
      output += writeRow(i + 1, line, stringWidth(line) >= columns);
    }
    output += cursorSequence(cursor, rows);
    this.previous = next;
    this.dimensions = `${columns}x${rows}`;
    this.page = page;
    return output + END;
  }
}

/**
 * 写一行。Windows Terminal/ConPTY 的增量渲染会丢掉行首以空白开头的行里的空格
 * （缓冲内容正确、显示时缩进消失），因此行首空格不写字面字符：
 * 先擦除对应单元格，再把光标定位到缩进之后写正文。
 */
function writeRow(row: number, line: string, full: boolean): string {
  const head = `\x1b[${row};1H\x1b[0m`;
  const match = /^((?:\x1b\[[0-9;:]*[A-Za-z])*)( *)/.exec(line);
  const prefix = match?.[1] ?? "";
  const n = match?.[2]?.length ?? 0;
  // 写满整行时光标停在待换行状态，此时 EL 会擦掉最后一列，所以只在未写满时补 EL。
  const tail = full ? "\x1b[0m" : "\x1b[0m\x1b[K";
  if (n === 0) return `${head}${line}${tail}`;
  return `${head}${prefix}\x1b[${n}X\x1b[${row};${n + 1}H${line.slice(prefix.length + n)}${tail}`;
}

export function cursorSequence(point: CursorPoint | undefined, rows: number): string {
  if (point === undefined) return HIDE;
  const row = Math.max(1, Math.min(rows, rows + point.y));
  return `\x1b[${row};${point.x + 1}H${SHOW}`;
}
