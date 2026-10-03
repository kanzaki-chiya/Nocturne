/**
 * PageShell 的纯布局函数（ADR-0045）：垂直预算、列宽对齐、行与侧栏的带色片段。
 * 不依赖 React/Ink，组件只负责把片段画出来，测试直接断言这里的输出。
 */
import stringWidth from "string-width";

import { truncateLine } from "../../format.js";
import type { ThemePalette } from "../../theme.js";

/** 左栏总宽（含竖线）与窄屏阈值，见 ADR-0045 第 3、8 节 */
export const LEFT_W = 18;
export const NARROW_W = 72;
/** 列表区至少保留的行数；低于它就依次去掉说明行、说明区 */
const MIN_BODY = 4;

export type ShellTone =
  | "text"
  | "secondary"
  | "muted"
  | "accent"
  | "accentAlt"
  | "success"
  | "warning"
  | "error"
  | "info";

export interface ShellSpan {
  text: string;
  tone?: ShellTone | undefined;
  bold?: boolean | undefined;
}

/** 列单元：纯文本、带色片段，或 `‹ 值 ›` 形态的可调值 */
export interface ShellCell {
  text?: string | undefined;
  spans?: readonly ShellSpan[] | undefined;
  tone?: ShellTone | undefined;
  bold?: boolean | undefined;
  /** 显示为 `‹ 值 ›`（ASCII 为 `< 值 >`） */
  arrows?: boolean | undefined;
  align?: "left" | "right" | undefined;
}

export interface ShellRow {
  id: string;
  group?: string | undefined;
  /** 左对齐列；每列宽度取全页最大值，保证滚动时不跳动 */
  cells: readonly ShellCell[];
  /** 右对齐尾部（来源、模型数等），之间空两格 */
  trail?: readonly ShellCell[] | undefined;
  /** 过滤用文本；缺省取所有单元文字 */
  search?: string | undefined;
}

export interface ShellGroup {
  id: string;
  label: string;
}

export interface ShellSideItem {
  id: string;
  label: string;
  count?: string | number | undefined;
  dot?: { text: string; tone: ShellTone } | undefined;
  tone?: ShellTone | undefined;
  /** 前面画一条细线 */
  separatorBefore?: boolean | undefined;
  /** 窄屏循环切换时是否参与（未配置预设不参与） */
  cyclable?: boolean | undefined;
}

export interface RenderSpan {
  text: string;
  color?: string | undefined;
  bg?: string | undefined;
  bold?: boolean | undefined;
}

export interface Glyph {
  ascii: boolean;
}

export function toneColor(palette: ThemePalette, tone: ShellTone | undefined): string {
  return tone === undefined ? palette.text : palette[tone];
}

export function spansWidth(spans: readonly { text: string }[]): number {
  return spans.reduce((n, s) => n + stringWidth(s.text), 0);
}

/** 按显示宽度把片段截断到 width（超出加 …）；不足不补 */
export function clipSpans<T extends { text: string }>(spans: readonly T[], width: number): T[] {
  if (width <= 0) return [];
  if (spansWidth(spans) <= width) return [...spans];
  const out: T[] = [];
  let used = 0;
  for (const span of spans) {
    const w = stringWidth(span.text);
    if (used + w <= width - 1) {
      out.push(span);
      used += w;
      continue;
    }
    const left = width - used;
    if (left > 0) out.push({ ...span, text: truncateLine(span.text, left) });
    return out;
  }
  return out;
}

export interface PageLayout {
  narrow: boolean;
  showSub: boolean;
  showExplain: boolean;
  /** 第二行（说明）所在行号，showSub 为 false 时无 */
  subRow: number | undefined;
  /** 过滤行所在行号（有查询时画，没有查询时是页头空行或不存在） */
  filterRow: number;
  /** 窄屏分组条所在行号 */
  stripRow: number | undefined;
  bodyRow: number;
  bodyH: number;
  ruleRow: number | undefined;
  explainRow: number | undefined;
  hintRow: number;
}

/**
 * 垂直预算。完整形态：标题、说明、空行（有查询时画过滤行）、列表、细线、两行说明区、空行、提示行。
 * 高度不足时依次去掉说明行（含其下空行）、说明区；标题、列表、提示行始终保留。
 */
export function pageLayout(opts: {
  width: number;
  height: number;
  sidebar: boolean;
  hasQuery: boolean;
}): PageLayout {
  const { width, height } = opts;
  const narrow = opts.sidebar && width < NARROW_W;
  const strip = narrow ? 1 : 0;
  const plan = (showSub: boolean, showExplain: boolean) => {
    const header = showSub ? 3 : opts.hasQuery ? 2 : 1;
    const footer = showExplain ? 5 : 1;
    return { header, footer, body: height - header - strip - footer };
  };
  let showSub = true;
  let showExplain = true;
  if (plan(true, true).body < MIN_BODY) showSub = false;
  if (plan(showSub, true).body < MIN_BODY) showExplain = false;
  const p = plan(showSub, showExplain);
  const bodyH = Math.max(1, p.body);
  const stripRow = narrow ? p.header : undefined;
  const bodyRow = p.header + strip;
  const hintRow = Math.max(0, height - 1);
  return {
    narrow,
    showSub,
    showExplain,
    subRow: showSub ? 1 : undefined,
    filterRow: showSub ? 2 : 1,
    stripRow,
    bodyRow,
    bodyH,
    ruleRow: showExplain ? bodyRow + bodyH : undefined,
    explainRow: showExplain ? bodyRow + bodyH + 1 : undefined,
    hintRow,
  };
}

function cellSpans(cell: ShellCell, ascii: boolean): ShellSpan[] {
  const base = cell.spans ?? [{ text: cell.text ?? "", tone: cell.tone, bold: cell.bold }];
  if (!cell.arrows) return [...base];
  return [
    { text: ascii ? "< " : "‹ ", tone: "muted" },
    ...base,
    { text: ascii ? " >" : " ›", tone: "muted" },
  ];
}

function cellWidth(cell: ShellCell, ascii: boolean): number {
  return spansWidth(cellSpans(cell, ascii));
}

export interface ColumnPlan {
  widths: number[];
  aligns: ("left" | "right")[];
  trailW: number;
}

const GAP = 2;

/** 全页统一的列宽：名称列按最长名称对齐，放不下时只压缩第一列 */
export function planColumns(
  rows: readonly ShellRow[],
  contentW: number,
  ascii: boolean,
): ColumnPlan {
  const count = rows.reduce((n, r) => Math.max(n, r.cells.length), 0);
  const widths = Array.from({ length: count }, () => 0);
  const aligns: ("left" | "right")[] = Array.from({ length: count }, () => "left");
  let trailW = 0;
  for (const row of rows) {
    row.cells.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cellWidth(cell, ascii));
      if (cell.align === "right") aligns[i] = "right";
    });
    if (row.trail !== undefined && row.trail.length > 0) {
      const w =
        row.trail.reduce((n, c) => n + cellWidth(c, ascii), 0) + GAP * (row.trail.length - 1);
      trailW = Math.max(trailW, w);
    }
  }
  const avail = contentW - (trailW > 0 ? trailW + GAP : 0);
  const total = widths.reduce((n, w) => n + w, 0) + GAP * Math.max(0, count - 1);
  if (total > avail && count > 0) {
    const others = total - (widths[0] ?? 0);
    widths[0] = Math.max(6, avail - others);
  }
  return { widths, aligns, trailW };
}

export type RowEmphasis = "selected" | "marked" | "none";

/** 一行条目的带色片段，宽度恰为 paneW（含行首标记、右侧留白与滚动条位） */
export function rowSpans(
  row: ShellRow,
  plan: ColumnPlan,
  paneW: number,
  emphasis: RowEmphasis,
  palette: ThemePalette,
  glyph: Glyph,
  scrollChar: string,
): RenderSpan[] {
  const contentW = paneW - 4;
  const sel = emphasis === "selected";
  const bg = sel ? palette.selectionBg : undefined;
  const toneOf = (tone: ShellTone | undefined, first: boolean): string => {
    if (sel && (tone === undefined || tone === "text" || tone === "secondary"))
      return palette.selected;
    if (emphasis === "marked" && first) return palette.accent;
    return toneColor(palette, tone);
  };
  const toRender = (spans: readonly ShellSpan[], first: boolean, arrowsOn: boolean): RenderSpan[] =>
    spans.map((s) => ({
      text: s.text,
      color:
        arrowsOn && (s.text === "‹ " || s.text === " ›" || s.text === "< " || s.text === " >")
          ? sel
            ? palette.accent
            : palette.muted
          : toneOf(s.tone, first),
      bg,
      bold: (s.bold ?? false) || (sel && first) || undefined,
    }));
  const out: RenderSpan[] = [];
  const marker = sel ? (glyph.ascii ? ">" : "▌") : " ";
  out.push({ text: marker, color: palette.accent, bg });
  out.push({ text: " ", bg });
  let line: RenderSpan[] = [];
  row.cells.forEach((cell, i) => {
    const spans = cellSpans(cell, glyph.ascii);
    const w = plan.widths[i] ?? 0;
    let rendered = toRender(spans, i === 0, cell.arrows === true);
    const cw = spansWidth(rendered);
    if (cw > w) rendered = clipSpans(rendered, w);
    const pad = Math.max(0, w - spansWidth(rendered));
    if (plan.aligns[i] === "right") line.push({ text: " ".repeat(pad), bg }, ...rendered);
    else line.push(...rendered, { text: " ".repeat(pad), bg });
    if (i < row.cells.length - 1) line.push({ text: " ".repeat(GAP), bg });
  });
  const trail: RenderSpan[] = [];
  (row.trail ?? []).forEach((cell, i) => {
    if (i > 0) trail.push({ text: " ".repeat(GAP), bg });
    trail.push(...toRender(cellSpans(cell, glyph.ascii), false, false));
  });
  const trailW = spansWidth(trail);
  const room = contentW - trailW - (trailW > 0 ? GAP : 0);
  line = clipSpans(line, Math.max(0, room));
  const gap = Math.max(0, contentW - spansWidth(line) - trailW);
  out.push(...line, { text: " ".repeat(gap), bg }, ...trail);
  // 右侧留白与滚动条位
  out.push({ text: " ", bg });
  out.push({ text: scrollChar, color: palette.accent });
  return out;
}

export interface BodyLine {
  kind: "header" | "row" | "blank" | "empty";
  rowId?: string;
  groupId?: string;
  label?: string;
}

/** 右栏全部行（组名、条目、组间空行），滚动在此之上取窗口 */
export function bodyLines(
  rows: readonly ShellRow[],
  groups: readonly ShellGroup[],
): { lines: BodyLine[]; rowLine: Map<string, number>; headerLine: Map<string, number> } {
  const lines: BodyLine[] = [];
  const rowLine = new Map<string, number>();
  const headerLine = new Map<string, number>();
  const ungrouped = rows.filter(
    (r) => r.group === undefined || !groups.some((g) => g.id === r.group),
  );
  for (const row of ungrouped) {
    rowLine.set(row.id, lines.length);
    lines.push({ kind: "row", rowId: row.id });
  }
  let first = ungrouped.length === 0;
  for (const group of groups) {
    const members = rows.filter((r) => r.group === group.id);
    if (members.length === 0) continue;
    if (!first) lines.push({ kind: "blank" });
    first = false;
    headerLine.set(group.id, lines.length);
    lines.push({ kind: "header", groupId: group.id, label: group.label });
    for (const row of members) {
      rowLine.set(row.id, lines.length);
      lines.push({ kind: "row", rowId: row.id, groupId: group.id });
    }
  }
  return { lines, rowLine, headerLine };
}

/** 滚动窗口：光标行可见；光标是组内第一项时连组名一起露出 */
export function scrollTop(
  prev: number,
  cursorLine: number,
  headerLine: number | undefined,
  bodyH: number,
  total: number,
): number {
  let top = prev;
  const want = headerLine !== undefined && headerLine === cursorLine - 1 ? headerLine : cursorLine;
  if (want < top) top = want;
  if (cursorLine >= top + bodyH) top = cursorLine - bodyH + 1;
  return Math.max(0, Math.min(top, Math.max(0, total - bodyH)));
}

export function filterRows(rows: readonly ShellRow[], query: string): ShellRow[] {
  if (query === "") return [...rows];
  const needle = query.toLowerCase();
  return rows.filter((row) => {
    const hay =
      row.search ??
      [...row.cells, ...(row.trail ?? [])]
        .map((c) => c.text ?? c.spans?.map((s) => s.text).join("") ?? "")
        .join(" ");
    return hay.toLowerCase().includes(needle);
  });
}

/** 侧栏一行的片段，宽度恰为 LEFT_W（含竖线） */
export function sideSpans(
  item: ShellSideItem,
  emphasis: RowEmphasis,
  active: boolean,
  palette: ThemePalette,
  glyph: Glyph,
): RenderSpan[] {
  const sel = emphasis === "selected";
  const bg = sel ? palette.selectionBg : undefined;
  const inner = LEFT_W - 1;
  const dot = item.dot !== undefined ? `${item.dot.text} ` : "";
  const count = item.count !== undefined ? ` ${item.count}` : "";
  const nameW = Math.max(1, inner - 2 - 1 - stringWidth(dot) - stringWidth(count));
  const name = truncateLine(item.label, nameW);
  const baseColor = sel
    ? palette.selected
    : active
      ? palette.accent
      : toneColor(palette, item.tone ?? "text");
  const bold = sel || active || undefined;
  const spans: RenderSpan[] = [
    { text: sel ? (glyph.ascii ? ">" : "▌") : " ", color: palette.accent, bg },
    { text: " ", bg },
  ];
  if (item.dot !== undefined)
    spans.push({ text: dot, color: toneColor(palette, item.dot.tone), bg });
  spans.push({ text: name, color: baseColor, bg, bold });
  if (count !== "") spans.push({ text: count, color: sel ? palette.selected : palette.muted, bg });
  const pad = Math.max(0, inner - spansWidth(spans));
  spans.push({ text: " ".repeat(pad), bg });
  spans.push({ text: glyph.ascii ? "|" : "│", color: palette.border });
  return spans;
}

export function sideSeparator(palette: ThemePalette, glyph: Glyph): RenderSpan[] {
  const line = glyph.ascii ? "-" : "─";
  return [
    { text: "  ", bg: undefined },
    { text: line.repeat(LEFT_W - 5), color: palette.border },
    { text: "  ", bg: undefined },
    { text: glyph.ascii ? "|" : "│", color: palette.border },
  ];
}

/** 提示行：键 secondary、动作 muted，对与对之间空两格 */
export function hintSpans(
  pairs: readonly (readonly [string, string])[],
  palette: ThemePalette,
  width: number,
): RenderSpan[] {
  const spans: RenderSpan[] = [];
  pairs.forEach(([key, action], i) => {
    if (i > 0) spans.push({ text: "  " });
    spans.push({ text: key, color: palette.secondary });
    if (action !== "") spans.push({ text: ` ${action}`, color: palette.muted });
  });
  return clipSpans(spans, width);
}

/** 窄屏分组条：`‹ 分组 ›` */
export function stripSpans(
  label: string,
  focused: boolean,
  palette: ThemePalette,
  glyph: Glyph,
  width: number,
): RenderSpan[] {
  const arrow = (s: string): RenderSpan => ({
    text: s,
    color: focused ? palette.accent : palette.muted,
  });
  return clipSpans(
    [
      arrow(glyph.ascii ? "< " : "‹ "),
      { text: label, color: palette.accent, bold: true },
      arrow(glyph.ascii ? " >" : " ›"),
    ],
    width,
  );
}
