import { Box, Text } from "ink";

import type { TodoItem } from "@nocturne/core/protocol";

import { useTuiEnv } from "../env.js";
import { useTheme } from "../theme.js";
import {
  segmentsWidth,
  todoDone,
  todoDoneBadge,
  todoIcon,
  todoItemRows,
  todoSnapshotWindow,
  todoWindow,
  truncateSegments,
} from "../todo-format.js";
import type { LineSegment } from "../viewport.js";

/** 固定区最多占用的行数（含边框）；tui.md §2。 */
export const TODO_PANEL_MAX_ROWS = 10;

/** 固定区想要的行数：边框两行 + 标题一行 + 每项一行，封顶 TODO_PANEL_MAX_ROWS。 */
export function todoPanelRows(count: number): number {
  return count === 0 ? 0 : Math.min(TODO_PANEL_MAX_ROWS, count + 3);
}

/** 一行分段文本；固定区与普通屏幕工具行共用。 */
export function SegmentText({ segments }: { segments: readonly LineSegment[] }): React.JSX.Element {
  return (
    <Text wrap="truncate">
      {segments.map((seg, i) => (
        <Text
          key={i}
          {...(seg.color === undefined ? {} : { color: seg.color })}
          {...(seg.backgroundColor === undefined ? {} : { backgroundColor: seg.backgroundColor })}
          dimColor={seg.dim === true}
          bold={seg.bold === true}
          strikethrough={seg.strikethrough === true}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

/** 普通屏幕工具行里的清单快照：与全屏对话流同一窗口，长文本折行。 */
export function TodoRows({
  items,
  width,
}: {
  items: readonly TodoItem[];
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const { shown, after } = todoSnapshotWindow(items);
  return (
    <Box flexDirection="column">
      {shown.flatMap((item, i) =>
        todoItemRows(item, env.ascii, Math.max(8, width - 1), "  ", theme).map((segments, j) => (
          <SegmentText key={`${i}:${j}`} segments={segments} />
        )),
      )}
      {after > 0 ? <Text dimColor>{`  ${env.ascii ? "..." : "…"} 另有 ${after} 项`}</Text> : null}
    </Box>
  );
}

export function TodoPanel({
  items,
  width,
  height,
}: {
  items: readonly TodoItem[];
  width: number;
  height: number;
}): React.JSX.Element | null {
  const env = useTuiEnv();
  const theme = useTheme();
  if (height === 0 || items.length === 0) return null;
  // 终端太矮（框内放不下标题加两行）时去掉边框，把行留给标题和条目。
  const framed = height >= Math.min(items.length + 3, 6) && width >= 12;
  const rows = framed ? height - 2 : height;
  // 框内首行是标题，其余行给条目与「另有 N 项」
  const { shown, after } = todoWindow(items, Math.max(0, rows - 1), true);
  const done = todoDone(items);
  const finished = done === items.length;
  const ellipsis = env.ascii ? "..." : "…";

  const header: LineSegment[] = [
    { text: `${todoIcon(env.ascii)}任务`, color: theme.accent, bold: true },
    { text: `  ${done}/${items.length}`, bold: true },
    ...(finished ? [{ text: "  " }, todoDoneBadge(theme)] : []),
  ];
  const lines: LineSegment[][] = [
    header,
    ...shown.map(
      (item) => todoItemRows(item, env.ascii, Number.MAX_SAFE_INTEGER, "", theme)[0] ?? [],
    ),
    ...(after > 0
      ? [[{ text: `${ellipsis} 另有 ${after} 项`, dim: true } satisfies LineSegment]]
      : []),
  ];
  // 框宽贴合内容（边框 2 列 + 左右留白各 1 列），不超过终端宽度。
  const inner = framed ? width - 4 : Math.max(1, width - 1);
  const natural = Math.max(...lines.map(segmentsWidth));
  const boxWidth = framed ? Math.min(width, natural + 4) : width;
  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={height}
      overflow="hidden"
      {...(framed
        ? { borderStyle: env.ascii ? "classic" : "round", borderColor: theme.border, paddingX: 1 }
        : {})}
    >
      {lines.map((segments, i) => (
        <SegmentText key={i} segments={truncateSegments(segments, inner, ellipsis)} />
      ))}
    </Box>
  );
}
