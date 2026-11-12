/**
 * `/swarm board` 全屏留言板（tui.md §2「Swarm 留言板」）：头部标题与帖子数，左列成员、右列帖子，
 * 底部选中帖子详情与一行发帖输入框。复用 PageShell 的布局函数与配色（ADR-0045），
 * 焦点在成员、帖子、输入框三处之间切换；已结束的 Swarm 只读、没有输入框。
 */
import { Box, Text, useInput, usePaste, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";

import type { SwarmPostView, SwarmView } from "@nocturne/core/protocol";

import { glyphs, useTuiEnv } from "../env.js";
import { wrap } from "../lines.js";
import {
  filterSwarmPosts,
  formatSwarmTime,
  swarmAuthorLabel,
  swarmCoordinatorDot,
  swarmMemberDot,
  swarmMentionLabel,
  swarmPostHead,
  splitSwarmMentions,
  type SwarmDot,
} from "../text-format-swarm.js";
import { useTheme } from "../theme.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { InputCursor } from "./input-cursor.js";
import {
  LEFT_W,
  clipSpans,
  planColumns,
  rowSpans,
  scrollTop,
  sideSpans,
  spansWidth,
  type RenderSpan,
  type ShellRow,
  type ShellSideItem,
} from "./page/layout.js";

export type BoardFocus = "members" | "posts" | "input";

export interface SwarmBoardProps {
  swarm: SwarmView;
  width: number;
  height: number;
  active: boolean;
  onClose: () => void;
  /** 发帖；拒绝时页面显示 Runtime 返回的原文 */
  onPost: (text: string) => Promise<void>;
  /** 成员行 Enter：进入该成员会话 */
  onOpenMember: (childSessionId: string) => void;
  /** 「协调者」行 Enter：回到协调者会话 */
  onOpenCoordinator: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}

interface SideEntry extends ShellSideItem {
  /** 成员会话 id；「全部」「协调者」没有 */
  childSessionId?: string | undefined;
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

function dotOf(dot: SwarmDot, ascii: boolean): ShellSideItem["dot"] {
  const solid = ascii ? "*" : "●";
  const hollow = ascii ? "o" : "○";
  switch (dot) {
    case "work":
      return { text: solid, tone: "accent" };
    case "attention":
      return { text: solid, tone: "warning" };
    case "wait":
      return { text: hollow, tone: "muted" };
    case "removed":
      return { text: hollow, tone: "muted" };
  }
}

/** 左列：全部、各成员（已移除的淡色排在成员末尾）、协调者 */
export function boardSideItems(swarm: SwarmView, ascii: boolean): SideEntry[] {
  const present = swarm.members.filter((m) => m.status !== "removed");
  const removed = swarm.members.filter((m) => m.status === "removed");
  return [
    { id: "all", label: "全部" },
    ...present.map((m) => ({
      id: m.name,
      label: m.name,
      dot: dotOf(swarmMemberDot(m, swarm.status), ascii),
      childSessionId: m.childSessionId,
    })),
    ...removed.map((m) => ({
      id: m.name,
      label: m.name,
      tone: "muted" as const,
      dot: dotOf("removed", ascii),
      childSessionId: m.childSessionId,
    })),
    { id: "coordinator", label: "协调者", dot: dotOf(swarmCoordinatorDot(swarm), ascii) },
  ];
}

export function SwarmBoard(props: SwarmBoardProps): React.JSX.Element {
  const { swarm, width, height, active } = props;
  const env = useTuiEnv();
  const palette = useTheme();
  const g = glyphs(env);
  const glyph = { ascii: env.ascii };
  const ended = swarm.status !== "active";

  const [focus, setFocus] = useState<BoardFocus>("posts");
  const [sideIndex, setSideIndex] = useState(0);
  const [following, setFollowing] = useState(true);
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [posting, setPosting] = useState(false);
  const sideTop = useRef(0);
  const postTop = useRef(0);

  const sideItems = boardSideItems(swarm, env.ascii);
  const side = Math.min(sideIndex, sideItems.length - 1);
  const target = sideItems[side]?.id ?? "all";
  const posts = filterSwarmPosts(swarm.posts, target);
  const pickedIndex = picked === undefined ? -1 : posts.findIndex((p) => p.number === picked);
  const postIndex = following || pickedIndex < 0 ? posts.length - 1 : pickedIndex;
  const selected: SwarmPostView | undefined = posts[postIndex];

  // 已结束：输入框撤去，焦点不能停在那里
  useEffect(() => {
    if (ended && focus === "input") setFocus("posts");
  }, [ended, focus]);

  // 最新状态给按键与鼠标回调读（一次 data 突发里的多个按键可能在提交前到达）
  const live = useRef({ sideItems, posts, postIndex, side, focus, draft, posting, ended });
  live.current = { sideItems, posts, postIndex, side, focus, draft, posting, ended };
  const latest = useRef(props);
  latest.current = props;

  const selectPost = (index: number): void => {
    const list = live.current.posts;
    if (list.length === 0) return;
    const to = Math.max(0, Math.min(list.length - 1, index));
    const post = list[to];
    if (post === undefined) return;
    setPicked(post.number);
    // 往上移动选择退出跟随；End 才恢复
    if (to < list.length - 1 || index < live.current.postIndex) setFollowing(false);
  };
  const jumpLatest = (): void => {
    setFollowing(true);
    setPicked(undefined);
  };
  const cycleFocus = (dir: 1 | -1): void => {
    const order: BoardFocus[] = live.current.ended
      ? ["members", "posts"]
      : ["members", "posts", "input"];
    const at = Math.max(0, order.indexOf(live.current.focus));
    setFocus(order[(at + dir + order.length) % order.length] ?? "posts");
  };
  const enterSide = (): void => {
    const item = live.current.sideItems[live.current.side];
    if (item === undefined) return;
    if (item.id === "coordinator") latest.current.onOpenCoordinator();
    else if (item.childSessionId !== undefined) latest.current.onOpenMember(item.childSessionId);
  };
  const submit = (): void => {
    const text = live.current.draft.trim();
    if (text === "" || live.current.posting) return;
    setPosting(true);
    setError(undefined);
    latest.current
      .onPost(text)
      .then(() => {
        setDraft("");
        jumpLatest();
      })
      .catch((e: unknown) => {
        setError(`! ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        setPosting(false);
      });
  };

  useInput(
    (input, key) => {
      const now = live.current;
      if (key.escape) {
        latest.current.onClose();
        return;
      }
      if (key.tab) {
        cycleFocus(key.shift ? -1 : 1);
        return;
      }
      if (key.end) {
        jumpLatest();
        return;
      }
      if (now.focus === "members") {
        if (key.upArrow || key.downArrow) {
          const n = now.sideItems.length;
          setSideIndex((now.side + (key.upArrow ? -1 : 1) + n) % n);
          return;
        }
        if (key.return) enterSide();
        return;
      }
      if (now.focus === "posts") {
        if (key.upArrow) selectPost(now.postIndex - 1);
        else if (key.downArrow) selectPost(now.postIndex + 1);
        return;
      }
      // 输入框
      if (key.return) {
        submit();
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.replace(/.$/u, ""));
        setError(undefined);
        return;
      }
      if (input !== "" && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/u.test(input)) {
        setDraft((d) => d + input);
        setError(undefined);
      }
    },
    { isActive: active },
  );
  usePaste(
    (pasted) => {
      if (live.current.focus !== "input") return;
      const clean = pasted.replace(/[\r\n\t]+/gu, " ").replace(/[\x00-\x1f\x7f]/gu, "");
      if (clean !== "") setDraft((d) => d + clean);
    },
    { isActive: active && focus === "input" },
  );

  // 垂直预算：头部、细线、列表区、细线、详情、（错误行）、（细线 + 输入框）
  const inputRows = ended ? 0 : 2;
  const errorRows = error !== undefined ? 1 : 0;
  const avail = Math.max(2, height - 3 - inputRows - errorRows);
  const listH = Math.max(1, Math.ceil(avail / 2));
  const detailH = Math.max(1, avail - listH);
  const paneW = Math.max(10, width - LEFT_W);

  // 鼠标：单击选中（tui.md §11），不加双击；滚轮在帖子列移动
  const sideBoxes = useRef(new Map<string, DOMElement>());
  const postBoxes = useRef(new Map<number, DOMElement>());
  const inputBox = useRef<DOMElement | null>(null);
  const listBox = useRef<DOMElement | null>(null);
  useEffect(() => {
    const report = latest.current.onMouseFrame;
    if (!active || report === undefined) return;
    const hit = (node: DOMElement) => {
      const r = screenRect(node);
      return { row: r.row, colStart: r.col, colEnd: r.col + r.width - 1 };
    };
    report({
      layer: "swarm-board",
      boxes: [
        ...[...sideBoxes.current].map(([id, node]) => ({ id: `side:${id}`, ...hit(node) })),
        ...[...postBoxes.current].map(([n, node]) => ({ id: `post:${n}`, ...hit(node) })),
        ...(inputBox.current !== null ? [{ id: "input", ...hit(inputBox.current) }] : []),
      ],
      click: (id) => {
        const now = live.current;
        if (id.startsWith("side:")) {
          const at = now.sideItems.findIndex((item) => item.id === id.slice(5));
          if (at >= 0) setSideIndex(at);
          setFocus("members");
        } else if (id.startsWith("post:")) {
          const at = now.posts.findIndex((p) => String(p.number) === id.slice(5));
          if (at >= 0) selectPost(at);
          setFocus("posts");
        } else if (id === "input" && !now.ended) setFocus("input");
      },
      wheel: (event) => {
        const r = screenRect(listBox.current ?? undefined);
        if (event.y < r.row || event.y >= r.row + r.height || event.x < r.col + LEFT_W) return;
        selectPost(live.current.postIndex + (event.dir === "up" ? -3 : 3));
      },
    });
    return () => {
      report(undefined);
    };
  });

  // 头部
  const countText = `  ${swarm.posts.length} 条${following ? " · 跟随" : ""}`;
  const header: RenderSpan[] = [
    { text: swarm.title, color: palette.accent, bold: true },
    { text: countText, color: palette.muted },
  ];
  const rule = (junction: boolean): RenderSpan[] => {
    const ch = env.ascii ? "-" : "─";
    const n = Math.max(0, width - 1);
    if (!junction) return [{ text: ch.repeat(n), color: palette.border }];
    const left = Math.min(n, LEFT_W - 1);
    return [
      { text: ch.repeat(left), color: palette.border },
      { text: env.ascii ? "+" : "┴", color: palette.border },
      { text: ch.repeat(Math.max(0, n - left - 1)), color: palette.border },
    ];
  };

  // 左列
  sideTop.current = scrollTop(sideTop.current, side, undefined, listH, sideItems.length);
  sideBoxes.current.clear();
  const leftLines: React.JSX.Element[] = sideItems
    .slice(sideTop.current, sideTop.current + listH)
    .map((item) => {
      const isCur = item.id === sideItems[side]?.id;
      return (
        <Box
          key={item.id}
          flexShrink={0}
          ref={(node) => {
            if (node) sideBoxes.current.set(item.id, node);
          }}
        >
          <Line
            spans={sideSpans(
              item,
              isCur && focus === "members" ? "selected" : "none",
              isCur && focus !== "members",
              palette,
              glyph,
            )}
          />
        </Box>
      );
    });
  while (leftLines.length < listH)
    leftLines.push(
      <Line
        key={`pad${leftLines.length}`}
        spans={[
          { text: " ".repeat(LEFT_W - 1) },
          { text: env.ascii ? "|" : "│", color: palette.border },
        ]}
      />,
    );

  // 右列
  const rows: ShellRow[] = posts.map((p) => ({
    id: String(p.number),
    cells: [
      { text: `#${p.number}`, tone: "muted" },
      { text: swarmPostHead(p).slice(`#${p.number} `.length) },
    ],
  }));
  const plan = planColumns(rows, paneW - 4, env.ascii);
  postTop.current = scrollTop(
    postTop.current,
    Math.max(0, postIndex),
    undefined,
    listH,
    rows.length,
  );
  postBoxes.current.clear();
  const rightLines: React.JSX.Element[] = rows
    .slice(postTop.current, postTop.current + listH)
    .map((row, i) => {
      const index = postTop.current + i;
      const isCur = index === postIndex;
      const number = posts[index]?.number ?? 0;
      return (
        <Box
          key={row.id}
          flexShrink={0}
          ref={(node) => {
            if (node) postBoxes.current.set(number, node);
          }}
        >
          <Line
            spans={rowSpans(
              row,
              plan,
              paneW,
              isCur ? (focus === "posts" ? "selected" : "marked") : "none",
              palette,
              glyph,
              " ",
            )}
          />
        </Box>
      );
    });
  while (rightLines.length < listH)
    rightLines.push(<Line key={`e${rightLines.length}`} spans={[{ text: " " }]} />);

  // 详情
  const detail: RenderSpan[][] = [];
  if (selected !== undefined) {
    detail.push([
      { text: `#${selected.number} `, color: palette.muted },
      { text: swarmAuthorLabel(selected.from, selected.fromKind), color: palette.accent },
      ...(selected.mentions.length > 0
        ? [{ text: ` → ${selected.mentions.map(swarmMentionLabel).join(" ")}` }]
        : []),
      { text: `  ${formatSwarmTime(selected.time)}`, color: palette.muted },
    ]);
    const charter =
      selected.charterOf !== undefined
        ? swarm.members.find((m) => m.name === selected.charterOf)?.charter
        : undefined;
    const textW = Math.max(1, width - 1);
    const bodyLines = (text: string, indent: string): RenderSpan[][] =>
      wrap(text, textW - stringWidth(indent) + 4).map((line) => [
        ...(indent !== "" ? [{ text: indent }] : []),
        ...splitSwarmMentions(line.text, selected.mentions).map((f) =>
          f.mention ? { text: f.text, color: palette.accent } : { text: f.text },
        ),
      ]);
    if (charter !== undefined) {
      for (const [label, value] of [
        ["负责", charter.owns],
        ["不碰", charter.handsOff],
        ["完成", charter.doneWhen],
      ] as const) {
        detail.push([{ text: label, color: palette.secondary, bold: true }]);
        detail.push(...bodyLines(value, "  "));
      }
    } else detail.push(...bodyLines(selected.text, ""));
  }
  const detailLines = detail.slice(0, detailH);
  while (detailLines.length < detailH) detailLines.push([]);

  const prompt = `${g.prompt} `;
  const draftShown = clipSpans([{ text: draft }], Math.max(1, width - 1 - stringWidth(prompt)));
  const inputY = -1;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {!ended ? (
        <InputCursor
          active={active && focus === "input"}
          prefix={prompt}
          text={draft}
          width={width - 1}
          y={inputY}
        />
      ) : null}
      <Line spans={clipSpans(header, width - 1)} />
      <Line spans={rule(false)} />
      <Box ref={listBox} flexDirection="row" height={listH} flexShrink={0}>
        <Box flexDirection="column" width={LEFT_W} flexShrink={0}>
          {leftLines}
        </Box>
        <Box flexDirection="column" width={paneW} flexShrink={0}>
          {rightLines}
        </Box>
      </Box>
      <Line spans={rule(true)} />
      <Box flexDirection="column" height={detailH} flexShrink={0}>
        {detailLines.map((spans, i) => (
          <Line key={i} spans={clipSpans(spans, width - 1)} />
        ))}
      </Box>
      {error !== undefined ? (
        <Line spans={clipSpans([{ text: error, color: palette.error }], width - 1)} />
      ) : null}
      {!ended ? (
        <>
          <Line spans={rule(false)} />
          <Box
            ref={(node) => {
              inputBox.current = node;
            }}
            flexShrink={0}
          >
            <Line
              spans={[
                { text: prompt, color: focus === "input" ? palette.accent : palette.muted },
                ...draftShown,
                ...(spansWidth(draftShown) === 0 ? [{ text: " " }] : []),
              ]}
            />
          </Box>
        </>
      ) : null}
    </Box>
  );
}
