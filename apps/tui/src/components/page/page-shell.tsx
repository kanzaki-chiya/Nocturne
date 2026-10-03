/**
 * 统一全屏页骨架（ADR-0045）：页头、双栏主体、说明区、提示行、打字即过滤、
 * 鼠标与窄屏/矮屏/ASCII 退化。只接收行数据、分组、说明文本和提示键位，
 * 不含任何具体页面的业务逻辑；按键与点击通过回调交给页面。
 */
import { Box, Text, useInput, type DOMElement, type Key } from "ink";
import { useEffect, useRef, useState } from "react";

import { useTuiEnv } from "../../env.js";
import { useTheme } from "../../theme.js";
import { screenRect, type DialogMouseFrame } from "../dialog/mouse.js";
import { InputCursor } from "../input-cursor.js";
import {
  LEFT_W,
  bodyLines,
  clipSpans,
  filterRows,
  hintSpans,
  pageLayout,
  planColumns,
  rowSpans,
  scrollTop,
  sideSeparator,
  sideSpans,
  spansWidth,
  stripSpans,
  toneColor,
  type RenderSpan,
  type ShellGroup,
  type ShellRow,
  type ShellSideItem,
  type ShellSpan,
} from "./layout.js";

export type {
  ShellCell,
  ShellGroup,
  ShellRow,
  ShellSideItem,
  ShellSpan,
  ShellTone,
} from "./layout.js";

export type ShellFocus = "side" | "list";
export type HintPairs = readonly (readonly [string, string])[];

export interface ShellNotice {
  text: string;
  tone: "error" | "warning" | "accent" | "muted";
}

export interface ShellKeyContext {
  rowId: string | undefined;
  focus: ShellFocus;
}

export interface PageShellProps {
  /** 面包屑，层级用 ` › ` 连接 */
  title: readonly string[];
  /** 标题右侧灰色计数；函数形态拿到当前序号与总数 */
  count?: string | ((info: { index: number; total: number }) => string) | undefined;
  subtitle?: string | undefined;
  rows: readonly ShellRow[];
  groups?: readonly ShellGroup[] | undefined;
  sidebar?:
    | {
        items: readonly ShellSideItem[];
        /** jump：左栏移动即滚动右栏到该组首项；filter：Enter 才应用，由页面决定右栏内容 */
        mode: "jump" | "filter";
        /** filter 模式下当前生效的项 */
        activeId?: string | undefined;
      }
    | undefined;
  /** adjust：←→ 改值（Tab 才切栏）；focus：←→ 切栏 */
  arrows: "adjust" | "focus";
  describe?: ((row: ShellRow | undefined, ctx: { focus: ShellFocus }) => ShellSpan[][]) | undefined;
  notice?: ShellNotice | undefined;
  hints: HintPairs | ((ctx: { focus: ShellFocus; query: string }) => HintPairs);
  emptyText?: string | undefined;
  width: number;
  height: number;
  /** 页面叠了对话框时为 false：不收键、不登记鼠标 */
  active: boolean;
  initialFocus?: ShellFocus | undefined;
  /** 变化时右栏光标回到首项（范围切换等） */
  resetToken?: string | number | undefined;
  mouseLayer?: string | undefined;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
  onActivate?: ((rowId: string) => void) | undefined;
  onAdjust?: ((rowId: string, dir: -1 | 1) => void) | undefined;
  /** filter 模式左栏 Enter；返回 "list" 时焦点移到右栏 */
  onSideActivate?: ((id: string) => "list" | undefined) | undefined;
  onSelect?: ((rowId: string | undefined) => void) | undefined;
  onClose: () => void;
  /** 先于内置按键；返回 true 表示已处理 */
  onKey?: ((input: string, key: Key, ctx: ShellKeyContext) => boolean) | undefined;
}

/** 同步镜像状态：一次 data 突发里的多个按键可能在提交前到达，处理器读 ref */
function useMirror<T>(initial: T): [T, React.RefObject<T>, (v: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  return [
    value,
    ref,
    (v: T) => {
      ref.current = v;
      setValue(v);
    },
  ];
}

function Line({ spans }: { spans: readonly RenderSpan[] }): React.JSX.Element {
  return (
    <Text wrap="truncate">
      {spans.map((s, i) => (
        <Text
          key={i}
          {...(s.color !== undefined ? { color: s.color } : {})}
          {...(s.bg !== undefined ? { backgroundColor: s.bg } : {})}
          {...(s.bold ? { bold: true } : {})}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function PageShell(props: PageShellProps): React.JSX.Element {
  const { title, subtitle, rows: allRows, groups = [], sidebar, width, height, active } = props;
  const env = useTuiEnv();
  const palette = useTheme();
  const glyph = { ascii: env.ascii };

  const [query, queryRef, setQuery] = useMirror("");
  const [cursor, cursorRef, setCursor] = useMirror(0);
  const [focus, focusRef, setFocus] = useMirror<ShellFocus>(
    sidebar !== undefined ? (props.initialFocus ?? "list") : "list",
  );
  const [sideCursor, sideCursorRef, setSideCursor] = useMirror(0);
  const topRef = useRef(0);
  const jumpRef = useRef<string | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  const rows = filterRows(allRows, query);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // resetToken 变化：右栏回到首项
  const tokenRef = useRef(props.resetToken);
  if (tokenRef.current !== props.resetToken) {
    tokenRef.current = props.resetToken;
    cursorRef.current = 0;
    topRef.current = 0;
    if (cursor !== 0) setCursor(0);
  }

  const layout = pageLayout({
    width,
    height,
    sidebar: sidebar !== undefined,
    hasQuery: query !== "",
  });
  const { narrow } = layout;
  const wideSide = sidebar !== undefined && !narrow;
  const paneW = wideSide ? width - LEFT_W : width;

  const cur = Math.min(cursor, Math.max(0, rows.length - 1));
  const selectedRow: ShellRow | undefined = rows[cur];
  const { lines, rowLine, headerLine } = bodyLines(rows, groups);
  const cursorLine = selectedRow !== undefined ? (rowLine.get(selectedRow.id) ?? 0) : 0;
  const cursorHeader =
    selectedRow?.group !== undefined ? headerLine.get(selectedRow.group) : undefined;
  let top = scrollTop(topRef.current, cursorLine, cursorHeader, layout.bodyH, lines.length);
  if (jumpRef.current !== undefined) {
    const header = headerLine.get(jumpRef.current);
    if (header !== undefined)
      top = Math.max(0, Math.min(header, Math.max(0, lines.length - layout.bodyH)));
    jumpRef.current = undefined;
  }
  topRef.current = top;

  const sideItems = sidebar?.items ?? [];
  const groupOfRow = selectedRow?.group;
  const activeSideId =
    sidebar === undefined ? undefined : sidebar.mode === "jump" ? groupOfRow : sidebar.activeId;

  // 选中行变化通知（页面可据此清除错误提示）
  const lastSelected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastSelected.current !== selectedRow?.id) {
      lastSelected.current = selectedRow?.id;
      props.onSelect?.(selectedRow?.id);
    }
  });

  const move = (next: number): void => {
    const total = rowsRef.current.length;
    const to = total === 0 ? 0 : ((next % total) + total) % total;
    setCursor(to);
  };
  const clamp = (next: number): void => {
    const total = rowsRef.current.length;
    setCursor(Math.max(0, Math.min(Math.max(0, total - 1), next)));
  };
  const curNow = (): number => Math.min(cursorRef.current, Math.max(0, rowsRef.current.length - 1));

  const jumpToGroup = (id: string): void => {
    const idx = rowsRef.current.findIndex((r) => r.group === id);
    if (idx >= 0) {
      jumpRef.current = id;
      setCursor(idx);
    }
  };
  const sideStep = (dir: -1 | 1): void => {
    const p = latest.current;
    if (p.sidebar === undefined) return;
    const list = p.sidebar.items.filter((item) => item.cyclable !== false);
    if (list.length === 0) return;
    const activeId =
      p.sidebar.mode === "jump" ? rowsRef.current[curNow()]?.group : p.sidebar.activeId;
    const at = Math.max(
      0,
      list.findIndex((item) => item.id === activeId),
    );
    const next = list[(at + dir + list.length) % list.length];
    if (next === undefined) return;
    if (p.sidebar.mode === "jump") jumpToGroup(next.id);
    else p.onSideActivate?.(next.id);
  };
  const sideIndexOf = (id: string | undefined): number =>
    Math.max(
      0,
      (latest.current.sidebar?.items ?? []).findIndex((item) => item.id === id),
    );
  const focusSide = (): void => {
    const p = latest.current;
    if (p.sidebar === undefined) return;
    const id = p.sidebar.mode === "jump" ? rowsRef.current[curNow()]?.group : p.sidebar.activeId;
    setSideCursor(sideIndexOf(id));
    setFocus("side");
  };
  const sideEnter = (id: string): void => {
    const p = latest.current;
    if (p.sidebar?.mode === "jump") {
      jumpToGroup(id);
      setFocus("list");
      return;
    }
    if (p.onSideActivate?.(id) === "list") setFocus("list");
  };

  useInput(
    (input, key) => {
      const p = latest.current;
      const rowNow = rowsRef.current[curNow()];
      const ctx: ShellKeyContext = { rowId: rowNow?.id, focus: focusRef.current };
      if (p.onKey?.(input, key, ctx) === true) return;
      const isNarrow =
        p.sidebar !== undefined && pageLayout({ ...layoutArgs(p), hasQuery: false }).narrow;
      const inSide = focusRef.current === "side" && !isNarrow && p.sidebar !== undefined;

      if (key.escape) {
        if (queryRef.current !== "") {
          setQuery("");
          setCursor(0);
          return;
        }
        p.onClose();
        return;
      }
      if (key.tab && p.sidebar !== undefined) {
        if (isNarrow) sideStep(key.shift ? -1 : 1);
        else if (focusRef.current === "side") setFocus("list");
        else focusSide();
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const dir = key.leftArrow ? -1 : 1;
        if (p.arrows === "adjust" && !inSide) {
          if (rowNow !== undefined) p.onAdjust?.(rowNow.id, dir);
          return;
        }
        if (p.sidebar === undefined) return;
        if (isNarrow) sideStep(dir);
        else if (dir === -1) focusSide();
        else setFocus("list");
        return;
      }
      if (inSide) {
        const items = p.sidebar?.items ?? [];
        if (key.upArrow || key.downArrow) {
          const next =
            (sideCursorRef.current + (key.upArrow ? -1 : 1) + items.length) % items.length;
          setSideCursor(next);
          const item = items[next];
          if (item !== undefined && p.sidebar?.mode === "jump") jumpToGroup(item.id);
          return;
        }
        if (key.return) {
          const item = items[sideCursorRef.current];
          if (item !== undefined) sideEnter(item.id);
          return;
        }
      } else {
        if (key.upArrow) {
          move(curNow() - 1);
          return;
        }
        if (key.downArrow) {
          move(curNow() + 1);
          return;
        }
        if (key.pageUp) {
          clamp(curNow() - layoutBodyH(p));
          return;
        }
        if (key.pageDown) {
          clamp(curNow() + layoutBodyH(p));
          return;
        }
        if (key.home) {
          clamp(0);
          return;
        }
        if (key.end) {
          clamp(rowsRef.current.length - 1);
          return;
        }
        if (key.return) {
          if (rowNow !== undefined) p.onActivate?.(rowNow.id);
          return;
        }
      }
      if (key.backspace) {
        if (queryRef.current !== "") {
          setQuery(queryRef.current.slice(0, -1));
          setCursor(0);
        }
        return;
      }
      if (input !== "" && !key.ctrl && !key.meta && !key.delete && !/[\x00-\x1f\x7f]/.test(input)) {
        setFocus("list");
        setQuery(queryRef.current + input);
        setCursor(0);
      }
    },
    { isActive: active },
  );

  // 鼠标：单击选中、再单击执行（ADR-0030 判定在外层）；滚轮移动光标
  const rowBoxes = useRef(new Map<string, DOMElement>());
  const sideBoxes = useRef(new Map<string, DOMElement>());
  const bodyBox = useRef<DOMElement | null>(null);
  useEffect(() => {
    const { onMouseFrame } = latest.current;
    if (!active || !onMouseFrame) return;
    const boxes = [
      ...[...rowBoxes.current].map(([id, node]) => ({ id: `row:${id}`, ...hit(node) })),
      ...[...sideBoxes.current].map(([id, node]) => ({ id: `side:${id}`, ...hit(node) })),
    ];
    onMouseFrame({
      layer: latest.current.mouseLayer ?? "page",
      boxes,
      click: (id) => {
        const p = latest.current;
        if (id.startsWith("row:")) {
          const rowId = id.slice(4);
          const idx = rowsRef.current.findIndex((r) => r.id === rowId);
          if (idx < 0) return;
          if (idx === curNow() && focusRef.current === "list") p.onActivate?.(rowId);
          else setCursor(idx);
          setFocus("list");
          return;
        }
        if (id.startsWith("side:")) {
          const itemId = id.slice(5);
          const items = p.sidebar?.items ?? [];
          const idx = items.findIndex((item) => item.id === itemId);
          if (idx < 0) return;
          if (focusRef.current === "side" && sideCursorRef.current === idx) sideEnter(itemId);
          else {
            setFocus("side");
            setSideCursor(idx);
            if (p.sidebar?.mode === "jump") jumpToGroup(itemId);
          }
        }
      },
      wheel: (event) => {
        const rect = screenRect(bodyBox.current ?? undefined);
        if (
          event.y < rect.row ||
          event.y >= rect.row + rect.height ||
          event.x < rect.col + (wideSide ? LEFT_W : 0) ||
          event.x >= rect.col + rect.width
        )
          return;
        clamp(curNow() + (event.dir === "up" ? -3 : 3));
      },
    });
    return () => {
      onMouseFrame(undefined);
    };
  });

  // 渲染 ------------------------------------------------------------
  const ascii = env.ascii;
  const crumbSep = ascii ? " > " : " › ";
  const countText =
    typeof props.count === "function"
      ? props.count({ index: rows.length === 0 ? 0 : cur + 1, total: rows.length })
      : props.count;
  const titleSpans: RenderSpan[] = [
    { text: title.join(crumbSep), color: palette.accent, bold: true },
    ...(countText !== undefined && countText !== ""
      ? [{ text: `  ${countText}`, color: palette.muted }]
      : []),
  ];
  const filterSpans: RenderSpan[] = [
    { text: "过滤: ", color: palette.muted },
    { text: query, color: palette.text },
    { text: " ", color: palette.selected, bg: palette.selectionBg },
  ];

  const plan = planColumns(allRows, paneW - 4, ascii);
  const scrollable = lines.length > layout.bodyH;
  const thumbH = Math.max(1, Math.round((layout.bodyH / Math.max(1, lines.length)) * layout.bodyH));
  const thumbStart = scrollable
    ? Math.round((top / Math.max(1, lines.length - layout.bodyH)) * (layout.bodyH - thumbH))
    : 0;
  const bodyFocused = focus === "list" || !wideSide;
  rowBoxes.current.clear();
  sideBoxes.current.clear();

  const visible = lines.slice(top, top + layout.bodyH);
  const rightLine = (line: (typeof lines)[number], i: number): React.JSX.Element => {
    const scrollChar = scrollable
      ? i >= thumbStart && i < thumbStart + thumbH
        ? ascii
          ? "#"
          : "┃"
        : " "
      : " ";
    if (line.kind === "row") {
      const row = rows.find((r) => r.id === line.rowId);
      if (row === undefined) return <Text key={`l${i}`}> </Text>;
      const isCur = row.id === selectedRow?.id;
      const spans = rowSpans(
        row,
        plan,
        paneW,
        isCur ? (bodyFocused ? "selected" : "marked") : "none",
        palette,
        glyph,
        scrollChar,
      );
      return (
        <Box
          key={row.id}
          flexShrink={0}
          ref={(node) => {
            if (node) rowBoxes.current.set(row.id, node);
          }}
        >
          <Line spans={spans} />
        </Box>
      );
    }
    const base: RenderSpan[] =
      line.kind === "header"
        ? [{ text: "  " }, { text: line.label ?? "", color: palette.accent, bold: true }]
        : [];
    const pad = Math.max(0, paneW - 1 - spansWidth(base));
    return (
      <Line
        key={`l${i}`}
        spans={[...base, { text: " ".repeat(pad) }, { text: scrollChar, color: palette.accent }]}
      />
    );
  };
  const rightLines = visible.map((line, i) => rightLine(line, i));
  for (let i = visible.length; i < layout.bodyH; i++)
    rightLines.push(<Line key={`e${i}`} spans={[{ text: " " }]} />);
  if (rows.length === 0)
    rightLines[0] = (
      <Line
        key="empty"
        spans={[{ text: `  ${props.emptyText ?? "（无匹配）"}`, color: palette.muted }]}
      />
    );

  // 左栏
  const leftLines: React.JSX.Element[] = [];
  if (wideSide) {
    sideItems.forEach((item, i) => {
      if (item.separatorBefore === true && i > 0)
        leftLines.push(<Line key={`sep${i}`} spans={sideSeparator(palette, glyph)} />);
      const isCursor = focus === "side" && i === sideCursor;
      const isActive = item.id === activeSideId;
      leftLines.push(
        <Box
          key={item.id}
          flexShrink={0}
          ref={(node) => {
            if (node) sideBoxes.current.set(item.id, node);
          }}
        >
          <Line spans={sideSpans(item, isCursor ? "selected" : "none", isActive, palette, glyph)} />
        </Box>,
      );
    });
    while (leftLines.length < layout.bodyH)
      leftLines.push(
        <Line
          key={`pad${leftLines.length}`}
          spans={[
            { text: " ".repeat(LEFT_W - 1) },
            { text: ascii ? "|" : "│", color: palette.border },
          ]}
        />,
      );
  }

  // 说明区
  const describeLines: ShellSpan[][] = props.describe?.(selectedRow, { focus }) ?? [];
  const explain: RenderSpan[][] = [];
  if (props.notice !== undefined)
    explain.push([
      {
        text: props.notice.text,
        color: toneColor(palette, props.notice.tone === "muted" ? "muted" : props.notice.tone),
      },
    ]);
  for (const line of describeLines)
    explain.push(
      line.map((s) => ({
        text: s.text,
        color: toneColor(palette, s.tone),
        bold: s.bold,
      })),
    );

  const hintPairs = typeof props.hints === "function" ? props.hints({ focus, query }) : props.hints;
  const rule = (junction: boolean): RenderSpan[] => {
    const ch = ascii ? "-" : "─";
    const n = Math.max(0, width - 1);
    const left = junction ? Math.min(n, LEFT_W - 1) : n;
    const spans: RenderSpan[] = [{ text: ch.repeat(left), color: palette.border }];
    if (junction && n > left) {
      spans.push({ text: ascii ? "+" : "┴", color: palette.border });
      spans.push({ text: ch.repeat(Math.max(0, n - left - 1)), color: palette.border });
    }
    return spans;
  };

  const stripLabel =
    sideItems.find((item) => item.id === activeSideId)?.label ?? sideItems[0]?.label ?? "";
  const filterY = layout.filterRow - height;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <InputCursor
        active={active}
        prefix="过滤: "
        text={query}
        width={width - 2}
        x={0}
        y={filterY}
      />
      <Line spans={clipSpans(titleSpans, width - 1)} />
      {layout.showSub ? <Line spans={[{ text: subtitle ?? "", color: palette.muted }]} /> : null}
      {layout.showSub || query !== "" ? (
        query !== "" ? (
          <Line spans={filterSpans} />
        ) : (
          <Text> </Text>
        )
      ) : null}
      {narrow && layout.stripRow !== undefined ? (
        <Line
          spans={stripSpans(stripLabel, focus === "side" || narrow, palette, glyph, width - 1)}
        />
      ) : null}
      <Box ref={bodyBox} flexDirection="row" height={layout.bodyH} flexShrink={0}>
        {wideSide ? (
          <Box flexDirection="column" width={LEFT_W} flexShrink={0}>
            {leftLines}
          </Box>
        ) : null}
        <Box flexDirection="column" width={paneW} flexShrink={0}>
          {rightLines}
        </Box>
      </Box>
      {layout.showExplain ? (
        <>
          <Line spans={rule(wideSide)} />
          {[0, 1].map((i) => (
            <Line key={i} spans={clipSpans(explain[i] ?? [{ text: " " }], width - 2)} />
          ))}
          <Text> </Text>
        </>
      ) : null}
      <Line spans={hintSpans(hintPairs, palette, width - 1)} />
    </Box>
  );
}

function hit(node: DOMElement): { row: number; colStart: number; colEnd: number } {
  const rect = screenRect(node);
  return { row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 };
}

function layoutArgs(p: PageShellProps): { width: number; height: number; sidebar: boolean } {
  return { width: p.width, height: p.height, sidebar: p.sidebar !== undefined };
}

function layoutBodyH(p: PageShellProps): number {
  return pageLayout({ ...layoutArgs(p), hasQuery: false }).bodyH;
}
