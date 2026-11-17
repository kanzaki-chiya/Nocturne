/**
 * 展示格式化：宽度安全截断（string-width，宽字符不掰断）、
 * token/时长摘要、工具输入摘要。纯函数。
 */
import stringWidth from "string-width";

import type {
  NoteItem,
  PermissionReviewedPayload,
  ToolEntry,
  Usage,
} from "@nocturne/core/protocol";
import { noteItemsFromCompletion, subagentRowInfo } from "@nocturne/core/protocol";

import { ensembleToolSummary, ensembleReadFilterParts } from "./text-format-ensemble.js";

export function subagentModel(entry: ToolEntry): string {
  const info = subagentRowInfo(entry);
  const selection = [info.model, info.effort].filter(Boolean).join(" · ");
  return `${info.profile !== undefined ? ` [${info.profile}]` : ""}${selection ? ` [${selection}]` : ""}`;
}

/**
 * conhost（GBK 代码页）把歧义宽度字符渲染为 2 列，与 string-width 的 1 列不一致：
 * 带边框的行会被 Ink 按 string-width 补齐到整宽，框内每混入一个歧义字符实际
 * 宽度就 +1，超过终端列数即折行——备用屏下表现为整屏滚动、页头被裁。
 * 框内文本（含用户输入回显、外部传入的标题/详情）统一过 boxSafe，
 * 把歧义字符换成实测 1 列的近形字符（conhost 80/120 列实测：
 * 1 列=│ ─ ╭ █ ✓ ✗ ⚠ • › ⠋；2 列=· ● ○ ↑ ↓ ← → … — ｜ ◆ ◇）。
 */
const BOX_AMBIG_MAP: Record<string, string> = {
  "·": "•",
  "●": "•",
  "○": "o",
  "◆": "•",
  "◇": "o",
  "↑": "^",
  "↓": "v",
  "←": "<",
  "→": ">",
  "—": "-",
  "–": "-",
  "｜": "|",
  "…": "...",
};
const BOX_AMBIG_RE = /[·●○◆◇↑↓←→—–｜…]/g;

export function boxSafe(text: string): string {
  return text.replace(BOX_AMBIG_RE, (c) => BOX_AMBIG_MAP[c] ?? c);
}

// CSI / OSC / 其他 ESC 序列，以及除换行、Tab 外的 C0 控制字符与 DEL
const CONTROL_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * 去掉工具输出、文件内容里夹带的终端控制序列（命令自带的颜色码等）。
 * 它们在全屏行里会打乱宽度计算，退出时原样打印到主屏还会让颜色一直漏到
 * 后面的输出（例如整屏变红）。
 */
export function stripControls(text: string): string {
  return text.replace(CONTROL_RE, "");
}

/** 按显示宽度向右补齐空格（宽字符按 string-width 计；超长不截断） */
export function padToWidth(text: string, width: number): string {
  const w = stringWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

/** 按显示宽度截断为单行；超宽时截断并加省略号 */
export function truncateLine(text: string, width: number, ellipsis = "…"): string {
  const oneLine = text.replace(/\r\n?|\n/g, " ");
  if (width <= 0) return "";
  if (stringWidth(oneLine) <= width) return oneLine;
  const budget = Math.max(0, width - stringWidth(ellipsis));
  let out = "";
  let w = 0;
  for (const ch of oneLine) {
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** 按显示宽度截断为单行，截掉头部保留尾部（如长路径保留文件名）；超宽时前缀省略号 */
export function truncateLineHead(text: string, width: number, ellipsis = "…"): string {
  const oneLine = text.replace(/\r\n?|\n/g, " ");
  if (width <= 0) return "";
  if (stringWidth(oneLine) <= width) return oneLine;
  const budget = Math.max(0, width - stringWidth(ellipsis));
  let out = "";
  let w = 0;
  for (const ch of Array.from(oneLine).reverse()) {
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    out = ch + out;
    w += cw;
  }
  return ellipsis + out;
}

export function truncateMiddle(text: string, width: number, ellipsis = "…"): string {
  const safe = boxSafe(stripControls(text).replace(/[\r\n\t]/g, " "));
  if (stringWidth(safe) <= width) return safe;
  const half = Math.max(0, Math.floor((width - stringWidth(ellipsis)) / 2));
  return (
    truncateLine(safe, half, "") +
    ellipsis +
    truncateLineHead(safe, Math.max(0, width - half - stringWidth(ellipsis)), "")
  );
}

/** 多行文本尾部 n 行（liveOutput / 结果摘要展示用） */
export function tailLines(text: string, n: number): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - n));
}

export function formatTokens(usage: Usage): string {
  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `↑${k(usage.inputTokens)} ↓${k(usage.outputTokens)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const inputString = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

export function noteItemsFromOutput(output: unknown): NoteItem[] | undefined {
  const strict = noteItemsFromCompletion({ name: "note_write", status: "ok", output });
  if (strict !== undefined) return strict;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const raw = (output as { notes?: unknown }).notes;
  if (!Array.isArray(raw)) return undefined;
  const out: NoteItem[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const { n, text } = item as { n?: unknown; text?: unknown };
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && typeof text === "string") {
      out.push({ n, text });
    }
  }
  return out;
}

export function noteItemsFromEntry(
  entry: Pick<ToolEntry, "name" | "target" | "status" | "result">,
): NoteItem[] | undefined {
  const name = entry.target?.name ?? entry.name;
  if (name !== "note_write" || entry.status !== "ok") return undefined;
  return noteItemsFromOutput(entry.result?.output);
}

export function noteFirstAddedText(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const add = (input as { add?: unknown }).add;
  if (!Array.isArray(add)) return "";
  for (const item of add) {
    if (typeof item !== "string") continue;
    const singleLine = item.trim().replace(/\r?\n+/g, " ");
    if (singleLine !== "") return singleLine;
  }
  return "";
}

export interface ToolSummaryParts {
  primary: string;
  query: string;
  text: string;
}

export function noteWriteSummaryParts(input: unknown, output?: unknown): ToolSummaryParts {
  const notes = noteItemsFromOutput(output);
  const primary = notes !== undefined ? `${notes.length} 条` : "";
  const query = noteFirstAddedText(input);
  const text = [primary, query].filter(Boolean).join(" ");
  return { primary, query, text };
}

export function noteWriteSummary(input: unknown, output?: unknown): string {
  return noteWriteSummaryParts(input, output).text;
}

export function toolTwoToneSummaryParts(
  name: string | undefined,
  input: unknown,
  output?: unknown,
): ToolSummaryParts | undefined {
  if (name === "note_write") return noteWriteSummaryParts(input, output);
  if (name === "ensemble_read") return ensembleReadFilterParts(input);
  return undefined;
}

export interface ToolHeadlineSegment {
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
}

/**
 * 折叠工具行双色调标题（note_write / ensemble_read 共用）：
 * 工具名、计数或 @filter 保持正常色，首条新增或关键词用淡色；
 * 按可用显示宽度单行省略，优先保留工具名与右侧结果状态/命中数。
 */
export function toolHeadlineSegments(options: {
  mark: string;
  markColor?: string | undefined;
  toolLabel: string;
  primary: string;
  query: string;
  tail: string;
  tailDim?: boolean | undefined;
  width: number;
  ellipsis: string;
}): ToolHeadlineSegment[] {
  const sanitize = (text: string) => stripControls(text.replace(/\r\n?|\n|\t/g, " "));
  const primary = sanitize(options.primary);
  const query = sanitize(options.query);
  const lead = `${options.mark} ${options.toolLabel}`;
  const leadSegs: ToolHeadlineSegment[] =
    options.markColor !== undefined
      ? [{ text: options.mark, color: options.markColor }, { text: ` ${options.toolLabel}` }]
      : [{ text: lead }];
  const tailSegs: ToolHeadlineSegment[] =
    options.tail !== ""
      ? [{ text: options.tail, ...(options.tailDim === true ? { dim: true } : {}) }]
      : [];
  const maxW = Math.max(1, options.width);
  const leadW = stringWidth(lead);
  const tailW = stringWidth(options.tail);
  const avail = maxW - leadW - tailW;
  if (avail < 0) {
    if (tailW < maxW) {
      const room = maxW - tailW;
      const markW = stringWidth(options.mark);
      if (options.markColor !== undefined && room > markW) {
        return [
          { text: options.mark, color: options.markColor },
          { text: truncateLine(` ${options.toolLabel}`, room - markW, options.ellipsis) },
          ...tailSegs,
        ];
      }
      return [{ text: truncateLine(lead, room, options.ellipsis) }, ...tailSegs];
    }
    return [{ text: truncateLine(`${lead}${options.tail}`, maxW, options.ellipsis) }];
  }
  const ellipsisW = stringWidth(options.ellipsis);
  let rem = avail;
  let shownPrimary = "";
  if (primary !== "") {
    const pw = stringWidth(primary);
    if (1 + pw <= rem) {
      shownPrimary = primary;
      rem -= 1 + pw;
    } else if (rem >= 1 + ellipsisW + 1) {
      shownPrimary = truncateLine(primary, rem - 1, options.ellipsis);
      rem = 0;
    } else {
      rem = 0;
    }
  }
  let shownQuery = "";
  if (query !== "" && rem > 0) {
    const qw = stringWidth(query);
    if (1 + qw <= rem) {
      shownQuery = query;
    } else if (rem >= 1 + ellipsisW + 1) {
      shownQuery = truncateLine(query, rem - 1, options.ellipsis);
    }
  }
  return [
    ...leadSegs,
    ...(shownPrimary !== "" ? [{ text: ` ${shownPrimary}` }] : []),
    ...(shownQuery !== "" ? [{ text: ` ${shownQuery}`, dim: true }] : []),
    ...tailSegs,
  ];
}

/** 工具输入单行摘要：shell→command；read/write/edit→path；grep/glob→pattern；apply_patch→文件清单 */
export function summarizeToolInput(
  name: string | undefined,
  input: unknown,
  output?: unknown,
): string {
  const ensemble = name === undefined ? undefined : ensembleToolSummary(name, input);
  if (ensemble !== undefined) return ensemble;
  if (name === "note_write") return noteWriteSummary(input, output);
  if (name === "task") return inputString(input, "task") ?? "";
  if (name === "mcp_search") return inputString(input, "query") ?? "";
  if (name === "render_html") return inputString(input, "title") ?? "";
  if (name === "switch_worktree") {
    const source = inputString(output, "current") ?? inputString(input, "path") ?? "";
    return (
      source
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1) ?? ""
    );
  }
  if (name === "todo_write") {
    const items =
      typeof input === "object" && input !== null && "items" in input ? input.items : undefined;
    return Array.isArray(items) ? `${items.length} 项` : "";
  }
  if (name === "apply_patch") {
    // ADR-0035：摘要列出补丁涉及的文件（不整段回显补丁原文）
    const text = inputString(input, "input");
    if (text === undefined) return "";
    const files = [...text.matchAll(/^\*\*\* (?:Add|Delete|Update) File:\s*(\S+)/gm)].map(
      (m) => m[1] ?? "",
    );
    if (files.length === 0) return "";
    return files.length <= 3
      ? files.join(", ")
      : `${files.slice(0, 3).join(", ")} 等 ${files.length} 个文件`;
  }
  const byKey =
    name === "web_fetch"
      ? inputString(input, "url")
      : name === "shell"
        ? inputString(input, "command")
        : name === "grep" || name === "glob"
          ? inputString(input, "pattern")
          : (inputString(input, "path") ?? inputString(input, "command"));
  return byKey ?? (input === undefined ? "" : JSON.stringify(input));
}

const WRAP_CONTENT = /[\p{L}\p{N}]/u;

/**
 * 下一个字符放不下时，当前行应保留的码元数。
 * 可断位置取最后一个：空白之后（空白留在前一行），以及宽字符与相邻字符之间。
 * 断点之前只有符号或空白（前缀、缩进，不按具体字符串列举）时不当断点。
 * `guard` 以内是调用方已知的前缀，里面的位置同样不当断点。
 * 没有可用断点时返回 -1，调用方硬切。
 */
export function lastWrapBreak(
  text: string,
  options: { nextWide?: boolean; guard?: number } = {},
): number {
  const guard = options.guard ?? 0;
  let last = "";
  let count = 0;
  for (const ch of text) {
    last = ch;
    count += 1;
  }
  if (count === 0) return -1;
  if ((options.nextWide === true || stringWidth(last) >= 2) && text.length > guard)
    return text.length;
  let cut = -1;
  let index = 0;
  let seenContent = false;
  let prevWide = false;
  for (const ch of text) {
    const wide = stringWidth(ch) >= 2;
    if (index > guard && (wide || prevWide)) cut = index;
    if ((ch === " " || ch === "\t") && seenContent && index + ch.length > guard)
      cut = index + ch.length;
    if (wide || WRAP_CONTENT.test(ch)) seenContent = true;
    prevWide = wide;
    index += ch.length;
  }
  return cut > guard && cut < text.length ? cut : -1;
}

/** ADR-0036：审查来源及用量与主模型输出分开标注。 */
export function permissionReviewLine(review: PermissionReviewedPayload): string {
  const label = { allow: "放行", block: "拦截", unsure: "交给你确认" }[review.verdict];
  const usage = review.usage;
  return `审查：${label} — ${review.reason.replace(/\s+/g, " ")}${review.cached ? "（缓存）" : ""}${usage ? `（审查用量：${usage.inputTokens} 输入 / ${usage.outputTokens} 输出）` : ""}`;
}
