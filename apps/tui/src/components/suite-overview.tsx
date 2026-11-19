/**
 * `/suite overview` 全屏组曲总览页（tui.md、ADR-0097）：头部强调色组曲名，
 * 列表按五组排列（空组隐藏，「已完成」默认折叠），每条线程一行（内容同状态块），
 * 最后一行「指挥」。复用 PageShell 的布局函数与配色（page/layout.ts）；
 * 键位只写进文档、界面不显示。
 */
import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import stringWidth from "string-width";

import type { SuiteThreadGroup, SuiteThreadView, SuiteView } from "@nocturne/core/protocol";

import { errText } from "../commands.js";
import { glyphs, useTuiEnv } from "../env.js";
import { padToWidth, truncateLine } from "../format.js";
import {
  groupSuiteThreads,
  suiteDotGlyph,
  suiteThreadDot,
  suiteThreadModelLabel,
  suiteThreadSecondary,
  type SuiteDotTone,
} from "../text-format-suite.js";
import { useTheme } from "../theme.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import {
  clipSpans,
  rowSpans,
  scrollTop,
  type ColumnPlan,
  type RenderSpan,
  type ShellRow,
  type ShellTone,
} from "./page/layout.js";

export interface SuiteOverviewProps {
  suite: SuiteView;
  name?: string | undefined;
  width: number;
  height: number;
  active: boolean;
  onClose: () => void;
  /** 线程行 Enter：打开线程视图 */
  onOpenThread: (thread: SuiteThreadView) => void;
  /** 「指挥」行 Enter：回到指挥会话 */
  onOpenCoordinator: () => void;
  /** Alt+D：标记完成 / 重开，失败时由页面以 `! ` 错误行显示 Runtime 原文 */
  onResolveThread: (threadId: string, reopen: boolean) => Promise<void>;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}

export type SuiteOverviewItem =
  | {
      kind: "group";
      id: string;
      group: SuiteThreadGroup;
      label: string;
      count: number;
      collapsed: boolean;
    }
  | { kind: "thread"; id: string; thread: SuiteThreadView }
  | { kind: "coordinator"; id: "coordinator" };

/** 构造总览页的扁平条目表：按五组排列，空组隐藏，折叠组不展开线程，末行「指挥」 */
export function suiteOverviewItems(
  suite: SuiteView,
  collapsedGroups: ReadonlySet<SuiteThreadGroup>,
): SuiteOverviewItem[] {
  const out: SuiteOverviewItem[] = [];
  for (const section of groupSuiteThreads(suite.threads)) {
    if (section.threads.length === 0) continue;
    const collapsed = collapsedGroups.has(section.key);
    out.push({
      kind: "group",
      id: `group:${section.key}`,
      group: section.key,
      label: section.label,
      count: section.threads.length,
      collapsed,
    });
    if (!collapsed) {
      for (const thread of section.threads) {
        out.push({
          kind: "thread",
          id: `thread:${thread.threadId}`,
          thread,
        });
      }
    }
  }
  out.push({ kind: "coordinator", id: "coordinator" });
  return out;
}

function dotShellTone(tone: SuiteDotTone): ShellTone {
  switch (tone) {
    case "ask":
    case "pause":
      return "warning";
    case "work":
    case "merge":
      return "accent";
    case "ok":
      return "success";
    case "wait":
    case "retired":
      return "muted";
  }
}

function Line({ spans }: { spans: readonly RenderSpan[] }): React.JSX.Element {
  return (
    <Text wrap="truncate">
      {spans.length === 0
        ? " "
        : spans.map((s, i) => (
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

function scrollbarChars(total: number, top: number, bodyH: number, ascii: boolean): string[] {
  if (total <= bodyH || bodyH <= 0) return Array.from({ length: bodyH }, () => " ");
  const thumb = Math.max(1, Math.round((bodyH * bodyH) / total));
  const maxTop = Math.max(1, total - bodyH);
  const start = Math.round((top / maxTop) * (bodyH - thumb));
  const bar = ascii ? "#" : "┃";
  const track = ascii ? "|" : "│";
  return Array.from({ length: bodyH }, (_, i) => (i >= start && i < start + thumb ? bar : track));
}

export function SuiteOverview(props: SuiteOverviewProps): React.JSX.Element {
  const { suite, name, width, height, active } = props;
  const env = useTuiEnv();
  const palette = useTheme();
  const g = glyphs(env);
  const glyph = { ascii: env.ascii };

  const [collapsed, setCollapsed] = useState<ReadonlySet<SuiteThreadGroup>>(
    () => new Set<SuiteThreadGroup>(["resolved"]),
  );
  const [cursorIndex, setCursorIndex] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState(false);

  const items = suiteOverviewItems(suite, collapsed);
  const cursor = items.length === 0 ? 0 : Math.min(cursorIndex, items.length - 1);
  const topRef = useRef(0);
  const listBox = useRef<DOMElement | null>(null);
  const rowBoxes = useRef(new Map<string, DOMElement>());

  useEffect(() => {
    if (cursorIndex >= items.length) {
      setCursorIndex(Math.max(0, items.length - 1));
    }
  }, [cursorIndex, items.length]);

  const live = useRef({ items, cursor, resolving });
  live.current = { items, cursor, resolving };
  const latest = useRef(props);
  latest.current = props;

  const listH = Math.max(1, height - 2 - (error !== undefined ? 1 : 0));

  const toggleGroup = (group: SuiteThreadGroup): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const activate = (item: SuiteOverviewItem | undefined): void => {
    if (item === undefined) return;
    if (item.kind === "group") {
      toggleGroup(item.group);
      return;
    }
    if (item.kind === "thread") {
      latest.current.onOpenThread(item.thread);
      return;
    }
    latest.current.onOpenCoordinator();
  };

  const resolveSelected = (item: SuiteOverviewItem | undefined): void => {
    if (item?.kind !== "thread" || live.current.resolving) return;
    setResolving(true);
    setError(undefined);
    void latest.current
      .onResolveThread(item.thread.threadId, item.thread.resolved)
      .catch((e: unknown) => {
        const msg = errText(e);
        setError(msg.startsWith("! ") ? msg : `! ${msg}`);
      })
      .finally(() => {
        setResolving(false);
      });
  };

  useInput(
    (input, key) => {
      const now = live.current;
      const n = now.items.length;
      if (key.escape) {
        latest.current.onClose();
        return;
      }
      if (n === 0) return;
      if (key.upArrow) {
        setCursorIndex((now.cursor - 1 + n) % n);
        return;
      }
      if (key.downArrow) {
        setCursorIndex((now.cursor + 1) % n);
        return;
      }
      if (key.pageUp) {
        setCursorIndex(Math.max(0, now.cursor - listH));
        return;
      }
      if (key.pageDown) {
        setCursorIndex(Math.min(n - 1, now.cursor + listH));
        return;
      }
      if (key.home) {
        setCursorIndex(0);
        return;
      }
      if (key.end) {
        setCursorIndex(n - 1);
        return;
      }
      if (key.return) {
        activate(now.items[now.cursor]);
        return;
      }
      if (key.meta && !key.ctrl && (input === "d" || input === "D")) {
        resolveSelected(now.items[now.cursor]);
      }
    },
    { isActive: active },
  );

  // 鼠标（沿用 §11 / PageShell 单击选中、再点执行与滚轮规则）
  useLayoutEffect(() => {
    const report = latest.current.onMouseFrame;
    if (report === undefined) return;
    if (!active) {
      report(undefined);
      return;
    }
    const hit = (node: DOMElement) => {
      const r = screenRect(node);
      return { row: r.row, colStart: r.col, colEnd: r.col + r.width - 1 };
    };
    report({
      layer: "suite-overview",
      boxes: [...rowBoxes.current].map(([id, node]) => ({ id: `row:${id}`, ...hit(node) })),
      click: (id) => {
        if (!id.startsWith("row:")) return;
        const rowId = id.slice(4);
        const now = live.current;
        const idx = now.items.findIndex((item) => item.id === rowId);
        if (idx < 0) return;
        if (idx === now.cursor) activate(now.items[idx]);
        else setCursorIndex(idx);
      },
      wheel: (event) => {
        const r = screenRect(listBox.current ?? undefined);
        if (event.y < r.row || event.y >= r.row + r.height) return;
        const now = live.current;
        if (now.items.length === 0) return;
        setCursorIndex(
          Math.max(0, Math.min(now.items.length - 1, now.cursor + (event.dir === "up" ? -3 : 3))),
        );
      },
    });
    return () => {
      report(undefined);
    };
  });

  const paneW = Math.max(8, width);
  const contentW = Math.max(4, paneW - 4);
  const plan: ColumnPlan = { widths: [contentW], aligns: ["left"], trailW: 0 };

  const visibleThreads = items
    .filter(
      (item): item is Extract<SuiteOverviewItem, { kind: "thread" }> => item.kind === "thread",
    )
    .map((item) => item.thread);
  const rawTitleW = Math.max(0, ...visibleThreads.map((t) => stringWidth(t.title)));
  const titleW = Math.min(rawTitleW, Math.max(8, Math.floor(contentW / 3)));
  const modelW = Math.max(0, ...visibleThreads.map((t) => stringWidth(suiteThreadModelLabel(t))));

  const rows: ShellRow[] = items.map((item) => {
    if (item.kind === "group") {
      const arrow = item.collapsed ? (env.ascii ? ">" : "▸") : env.ascii ? "v" : "▾";
      return {
        id: item.id,
        cells: [
          {
            spans: [
              { text: `${arrow} ${item.label}`, tone: "secondary", bold: true },
              { text: `  ${item.count}`, tone: "muted" },
            ],
          },
        ],
      };
    }
    if (item.kind === "coordinator") {
      return {
        id: item.id,
        cells: [{ text: "指挥", tone: "text" }],
      };
    }
    const t = item.thread;
    const dotTone = suiteThreadDot(t);
    const dot = suiteDotGlyph(dotTone, env.ascii);
    const titleCell = padToWidth(truncateLine(t.title, titleW, g.ellipsis), titleW);
    const modelCell = padToWidth(suiteThreadModelLabel(t), modelW);
    const secondary = suiteThreadSecondary(t);
    return {
      id: item.id,
      cells: [
        {
          spans: [
            { text: `  ${dot} `, tone: dotShellTone(dotTone) },
            { text: `${titleCell}  `, tone: t.resolved ? "muted" : "text" },
            { text: modelCell, tone: "muted" },
            ...(secondary.text !== ""
              ? [
                  {
                    text: `  ${secondary.text}`,
                    tone: (secondary.warn ? "warning" : "muted") as ShellTone,
                  },
                ]
              : []),
          ],
        },
      ],
    };
  });

  topRef.current = scrollTop(topRef.current, cursor, undefined, listH, rows.length);
  const bars = scrollbarChars(rows.length, topRef.current, listH, env.ascii);
  rowBoxes.current.clear();
  const visibleRows: React.JSX.Element[] = rows
    .slice(topRef.current, topRef.current + listH)
    .map((row, i) => {
      const actualIndex = topRef.current + i;
      const isCur = actualIndex === cursor;
      return (
        <Box
          key={row.id}
          flexShrink={0}
          ref={(node) => {
            if (node) rowBoxes.current.set(row.id, node);
          }}
        >
          <Line
            spans={rowSpans(
              row,
              plan,
              paneW,
              isCur ? "selected" : "none",
              palette,
              glyph,
              bars[i] ?? " ",
            )}
          />
        </Box>
      );
    });
  while (visibleRows.length < listH) {
    visibleRows.push(<Line key={`pad${visibleRows.length}`} spans={[]} />);
  }

  const trimmedName = name?.trim();
  const headerTitle =
    trimmedName !== undefined && trimmedName !== ""
      ? trimmedName
      : suite.suiteId !== ""
        ? suite.suiteId
        : "组曲";
  const header: RenderSpan[] = [{ text: headerTitle, color: palette.accent, bold: true }];
  const ruleSpan: RenderSpan[] = [
    { text: (env.ascii ? "-" : "─").repeat(Math.max(0, width - 1)), color: palette.border },
  ];

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Line spans={clipSpans(header, Math.max(1, width - 1))} />
      <Line spans={ruleSpan} />
      <Box ref={listBox} flexDirection="column" height={listH} flexShrink={0}>
        {visibleRows}
      </Box>
      {error !== undefined ? (
        <Line spans={clipSpans([{ text: error, color: palette.error }], Math.max(1, width - 1))} />
      ) : null}
    </Box>
  );
}
