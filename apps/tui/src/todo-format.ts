/**
 * 任务清单的共享样式（ADR-0028）：对话流里的快照与全屏固定区共用同一套
 * 状态符号与配色。状态靠符号区分，颜色只做辅助：
 * emoji 方块 ✅ 完成、🟦 进行中、⬜ 待办（均为双宽，Windows Terminal 彩色显示）；
 * ASCII 模式退回 [x] / [>] / [ ]。
 */
import stringWidth from "string-width";

import type { TodoItem, TodoStatus } from "@nocturne/core/protocol";

import { palettes, type ThemePalette } from "./theme.js";
import type { LineSegment } from "./viewport.js";

export function todoMark(status: TodoStatus, ascii: boolean): string {
  if (ascii) return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
  return status === "completed" ? "✅" : status === "in_progress" ? "🟦" : "⬜";
}

/** 标题图标；ASCII 模式不显示。 */
export function todoIcon(ascii: boolean): string {
  return ascii ? "" : "📋 ";
}

/** 正文样式：完成为弱化加删除线，进行中强调色加粗，待办保持常规。 */
export function todoTextStyle(
  status: TodoStatus,
  theme: ThemePalette = palettes.dark,
): Omit<LineSegment, "text"> {
  if (status === "completed") return { dim: true, strikethrough: true };
  if (status === "in_progress") return { color: theme.accent, bold: true };
  return {};
}

export function todoDone(items: readonly TodoItem[]): number {
  return items.filter((item) => item.status === "completed").length;
}

/** 「全部完成」标记：成功色加粗文字，不加背景。 */
export function todoDoneBadge(theme: ThemePalette = palettes.dark): LineSegment {
  return { text: "全部完成", color: theme.success, bold: true };
}

/**
 * 单项清单的行段：`indent 符号 正文`，正文按 width 折行，续行与正文对齐。
 */
export function todoItemRows(
  item: TodoItem,
  ascii: boolean,
  width: number,
  indent = "  ",
  theme: ThemePalette = palettes.dark,
): LineSegment[][] {
  const mark = todoMark(item.status, ascii);
  const style = todoTextStyle(item.status, theme);
  const lead = `${indent}${mark} `;
  const room = Math.max(4, width - stringWidth(lead));
  const chunks: string[] = [];
  let line = "";
  let used = 0;
  for (const ch of item.text) {
    const w = Math.max(1, stringWidth(ch));
    if (used + w > room && line !== "") {
      chunks.push(line);
      line = "";
      used = 0;
    }
    line += ch;
    used += w;
  }
  chunks.push(line);
  return chunks.map((chunk, i) =>
    i === 0
      ? [{ text: lead }, { ...style, text: chunk }]
      : [{ text: " ".repeat(stringWidth(lead)) }, { ...style, text: chunk }],
  );
}

/** 对话流快照最多显示的项数；完整清单在全屏固定区。 */
export const TODO_SNAPSHOT_ITEMS = 3;

/**
 * 清单显示窗口（对话流快照与全屏固定区共用）：从第一项未完成项的前一项
 * （即最近完成的一项）开始；窗口碰到末尾时改为显示最后 capacity 项，
 * 全部完成时即为最后几项。after 只数窗口之后尚未显示的项——之前的项都已
 * 完成，进度由标题 N/M 表示。moreTakesRow 为真时「另有 N 项」占用 capacity 中的一行。
 */
export function todoWindow(
  items: readonly TodoItem[],
  capacity: number,
  moreTakesRow: boolean,
): { shown: readonly TodoItem[]; after: number } {
  const n = items.length;
  if (n <= capacity) return { shown: items, after: 0 };
  const firstOpen = items.findIndex((item) => item.status !== "completed");
  const from = Math.max(0, (firstOpen < 0 ? n : firstOpen) - 1);
  if (from + capacity >= n) return { shown: items.slice(n - capacity), after: 0 };
  const count = Math.max(0, moreTakesRow ? capacity - 1 : capacity);
  return { shown: items.slice(from, from + count), after: n - from - count };
}

/** 对话流快照：最多 TODO_SNAPSHOT_ITEMS 项，「另有」单独成行。 */
export function todoSnapshotWindow(items: readonly TodoItem[]): {
  shown: readonly TodoItem[];
  after: number;
} {
  return todoWindow(items, TODO_SNAPSHOT_ITEMS, false);
}

/** 对话流里 todo_write 成功结果的标题行，替代通用的「工具名 摘要 状态」。 */
export function todoHeadline(
  items: readonly TodoItem[],
  ascii: boolean,
  theme: ThemePalette = palettes.dark,
): LineSegment[] {
  const icon = todoIcon(ascii);
  if (items.length === 0) return [{ text: `${icon}清空任务清单`, color: theme.accent, bold: true }];
  const done = todoDone(items);
  const title: LineSegment = { text: `${icon}任务清单`, color: theme.accent, bold: true };
  const tally: LineSegment = { text: `  ${done}/${items.length}`, bold: true };
  return done === items.length
    ? [title, tally, { text: "  " }, todoDoneBadge(theme)]
    : [title, tally];
}

export function segmentsWidth(segments: readonly LineSegment[]): number {
  return segments.reduce((n, seg) => n + stringWidth(seg.text), 0);
}

/** 按显示宽度截断分段，末尾补省略号。 */
export function truncateSegments(
  segments: readonly LineSegment[],
  width: number,
  ellipsis: string,
): LineSegment[] {
  if (segmentsWidth(segments) <= width) return [...segments];
  const room = Math.max(0, width - stringWidth(ellipsis));
  const out: LineSegment[] = [];
  let used = 0;
  for (const seg of segments) {
    let text = "";
    for (const ch of seg.text) {
      const w = stringWidth(ch);
      if (used + w > room) break;
      text += ch;
      used += w;
    }
    if (text !== "") out.push({ ...seg, text });
    if (text !== seg.text) {
      out.push({ ...seg, strikethrough: false, text: ellipsis });
      break;
    }
  }
  return out;
}
