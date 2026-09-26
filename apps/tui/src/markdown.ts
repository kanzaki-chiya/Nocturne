/** Assistant Markdown only. Marked supplies structure; Ink owns terminal output. */
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";

import type { LaidLine, LineSegment } from "./viewport.js";

type Run = LineSegment;
const limitFor = (width: number): number => Math.max(1, width - 4);

/** A token is immutable once the lexer has found the following block (or a blank line). */
export function splitMarkdownBlocks(
  text: string,
  complete: boolean,
): { blocks: string[]; tail: string } {
  const tokens = marked.lexer(text).filter((token) => token.type !== "def");
  const blocks: string[] = [];
  let offset = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];
    // A trailing space token contains the paragraph/list/code boundary, not body text.
    if (token.type === "space") continue;
    const end = text.indexOf(token.raw, offset) + token.raw.length;
    const stable = complete || next !== undefined || /\n[ \t]*\n$/.test(text.slice(end));
    if (!stable) break;
    const through = next?.type === "space" ? end + next.raw.length : end;
    blocks.push(text.slice(offset, through));
    offset = through;
    if (next?.type === "space") i++;
  }
  return { blocks, tail: complete ? "" : text.slice(offset) };
}

function inline(tokens: readonly Token[], style: Partial<Run> = {}): Run[] {
  const out: Run[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "codespan":
        out.push({ text: (token as Tokens.Codespan).text, ...style, color: "cyan" });
        break;
      case "link":
        out.push(...inline((token as Tokens.Link).tokens, style));
        out.push({ text: ` (${(token as Tokens.Link).href})`, ...style, dim: true });
        break;
      case "image":
        out.push({
          text: `${(token as Tokens.Image).text} (${(token as Tokens.Image).href})`,
          ...style,
        });
        break;
      case "br":
        out.push({ text: "\n", ...style });
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          out.push(...inline(token.tokens, style));
        } else if ("text" in token && typeof token.text === "string") {
          out.push({ text: token.text, ...style });
        } else {
          out.push({ text: token.raw, ...style });
        }
    }
  }
  return out;
}

function textOf(tokens: readonly Token[]): string {
  return inline(tokens)
    .map((run) => run.text)
    .join("");
}

export function renderMarkdown(text: string, width: number, key: string): LaidLine[] {
  const lines: LaidLine[] = [];
  const max = limitFor(width);
  const add = (runs: Run[], prefix = "", style: Partial<Run> = {}): void => {
    let segments: Run[] = prefix ? [{ text: prefix, ...style }] : [];
    let used = stringWidth(prefix);
    const flush = (): void => {
      const parts = segments.length > 0 ? segments : [{ text: " " }];
      lines.push({
        key: `${key}:${lines.length}`,
        text: parts.map((p) => p.text).join(""),
        segments: parts,
      });
      segments = [];
      used = 0;
    };
    for (const run of runs) {
      for (const ch of run.text) {
        if (ch === "\n") {
          flush();
          continue;
        }
        const w = stringWidth(ch);
        if (used + w > max && used > 0) flush();
        if (w > max) continue;
        const last = segments.at(-1);
        if (
          last &&
          last.bold === run.bold &&
          last.italic === run.italic &&
          last.dim === run.dim &&
          last.color === run.color
        )
          last.text += ch;
        else segments.push({ ...run, text: ch });
        used += w;
      }
    }
    flush();
  };
  const render = (tokens: readonly Token[], prefix = ""): void => {
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "def":
          break;
        case "heading":
          add(inline((token as Tokens.Heading).tokens, { bold: true, color: "cyan" }), prefix);
          break;
        case "paragraph":
        case "text":
          add(inline((token as Tokens.Paragraph).tokens), prefix);
          break;
        case "code":
          for (const line of (token as Tokens.Code).text.split("\n"))
            add([{ text: line, color: "cyan" }], `${prefix}│ `);
          break;
        case "hr":
          add([{ text: "─".repeat(max), dim: true }]);
          break;
        case "blockquote":
          render((token as Tokens.Blockquote).tokens, `${prefix}│ `);
          break;
        case "list":
          (token as Tokens.List).items.forEach((item, i) => {
            const list = token as Tokens.List;
            const bullet = list.ordered
              ? `${(typeof list.start === "number" ? list.start : 1) + i}. `
              : "• ";
            for (const [index, part] of item.tokens.entries()) {
              render([part], `${prefix}${index === 0 ? bullet : " ".repeat(bullet.length)}`);
            }
          });
          break;
        case "table": {
          const table = token as Tokens.Table;
          const headers = table.header.map((cell) => textOf(cell.tokens));
          const rows = table.rows.map((row) => row.map((cell) => textOf(cell.tokens)));
          const widths = headers.map((head, col) =>
            Math.max(stringWidth(head), ...rows.map((row) => stringWidth(row[col] ?? ""))),
          );
          const total = widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1;
          if (total > max) {
            for (const row of rows) {
              row.forEach((cell, col) => {
                add([{ text: `${headers[col]}：${cell}` }]);
              });
            }
          } else {
            const tableRow = (cells: string[]): string =>
              `│ ${cells.map((cell, col) => cell + " ".repeat((widths[col] ?? 0) - stringWidth(cell))).join(" │ ")} │`;
            add([{ text: tableRow(headers), bold: true }]);
            add([{ text: `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`, dim: true }]);
            rows.forEach((row) => {
              add([{ text: tableRow(row) }]);
            });
          }
          break;
        }
        default:
          if ("text" in token && typeof token.text === "string")
            add([{ text: token.text }], prefix);
          else add([{ text: token.raw }], prefix);
      }
    }
  };
  render(marked.lexer(text));
  return lines;
}
