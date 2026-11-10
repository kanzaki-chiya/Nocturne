/**
 * 通用单选列表（/resume 会话选择、/search 会话搜索、设置项选择）：
 * ↑↓ 移动（跳过 disabled 项），Enter 确认，Esc 取消。可见窗口最多 MAX_VISIBLE 项。
 */
import { Box, Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { glyphs, useTuiEnv } from "../env.js";
import { boxSafe, truncateLine } from "../format.js";
import { useTheme } from "../theme.js";
import { InputCursor } from "./input-cursor.js";

const MAX_VISIBLE = 10;

export interface PickSpan {
  text: string;
  accent?: boolean | undefined;
}

export interface PickItem<T> {
  key?: string | undefined;
  label: string;
  hint?: string | undefined;
  /** 可选第二行（如搜索命中片段）；accent 段以主题强调色渲染 */
  detail?: readonly PickSpan[] | undefined;
  value: T;
  /** 不可选项（如未安装的 shell）：灰显，光标跳过，Enter 不生效 */
  disabled?: boolean | undefined;
}

export interface PickQueryProps {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onCursor?: ((cursor: number) => void) | undefined;
  /** 硬件光标在终端中的相对行差 */
  cursorY?: number | undefined;
}

function resolveInitial<T>(
  items: readonly PickItem<T>[],
  initialValue?: T,
  initialIndex = 0,
): number {
  if (items.length === 0) return 0;
  if (initialValue !== undefined) {
    const found = items.findIndex((item) => item.value === initialValue);
    if (found >= 0 && !items[found]?.disabled) return found;
  }
  const start = Math.min(Math.max(0, initialIndex), items.length - 1);
  if (!items[start]?.disabled) return start;
  const idx = items.findIndex((i) => !i.disabled);
  return idx >= 0 ? idx : 0;
}

function stepEnabled<T>(items: readonly PickItem<T>[], from: number, dir: -1 | 1): number {
  const n = items.length;
  if (n === 0) return 0;
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

function prevCharIndex(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const chars = Array.from(value.slice(0, cursor));
  const last = chars.at(-1);
  return last !== undefined ? cursor - last.length : 0;
}

function nextCharIndex(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const first = Array.from(value.slice(cursor))[0];
  return first !== undefined ? cursor + first.length : value.length;
}

function querySlice(
  value: string,
  cursor: number,
  innerWidth: number,
): { before: string; at: string; after: string } {
  const safeBefore = boxSafe(value.slice(0, cursor));
  const restChars = Array.from(boxSafe(value.slice(cursor)));
  const at = restChars[0] ?? " ";
  const safeAfter = restChars.slice(1).join("");
  const budget = Math.max(1, innerWidth - 1);
  const beforeChars = Array.from(safeBefore);
  let start = 0;
  while (stringWidth(beforeChars.slice(start).join("")) > budget && start < beforeChars.length) {
    start++;
  }
  const visibleBefore = beforeChars.slice(start).join("");
  const used = stringWidth(visibleBefore) + stringWidth(at);
  let visibleAfter = "";
  let afterWidth = 0;
  for (const ch of Array.from(safeAfter)) {
    const cw = stringWidth(ch);
    if (used + afterWidth + cw > innerWidth) break;
    visibleAfter += ch;
    afterWidth += cw;
  }
  return { before: visibleBefore, at, after: visibleAfter };
}

function truncateSpans(spans: readonly PickSpan[], maxWidth: number, ellipsis: string): PickSpan[] {
  if (maxWidth <= 0) return [];
  const safe = spans.map((s) => ({
    text: boxSafe(s.text.replace(/\r\n?|\n/g, " ")),
    accent: s.accent,
  }));
  const total = safe.reduce((sum, s) => sum + stringWidth(s.text), 0);
  if (total <= maxWidth) return safe;
  const limit = Math.max(0, maxWidth - stringWidth(ellipsis));
  const out: PickSpan[] = [];
  let used = 0;
  for (const seg of safe) {
    let chunk = "";
    for (const ch of seg.text) {
      const cw = stringWidth(ch);
      if (used + cw > limit) {
        if (chunk !== "") out.push({ text: chunk, accent: seg.accent });
        out.push({ text: ellipsis });
        return out;
      }
      chunk += ch;
      used += cw;
    }
    if (chunk !== "") out.push({ text: chunk, accent: seg.accent });
  }
  out.push({ text: ellipsis });
  return out;
}

function itemRows<T>(item: PickItem<T>): number {
  return item.detail !== undefined && item.detail.length > 0 ? 2 : 1;
}

function selectWindow<T>(
  items: readonly PickItem<T>[],
  cursor: number,
  maxItems: number,
  maxLineBudget?: number,
): { start: number; visible: readonly PickItem<T>[] } {
  if (items.length === 0) return { start: 0, visible: [] };
  const baseStart = Math.min(
    Math.max(0, cursor - Math.floor(maxItems / 2)),
    Math.max(0, items.length - maxItems),
  );
  const sliced = items.slice(baseStart, baseStart + maxItems);
  if (maxLineBudget === undefined) return { start: baseStart, visible: sliced };

  const budget = Math.max(2, maxLineBudget);
  let start = Math.min(cursor, baseStart);
  let end = start;
  let rows = 0;
  while (end < items.length && end - start < maxItems) {
    const nextItem = items[end];
    if (nextItem === undefined) break;
    const h = itemRows(nextItem);
    if (rows + h > budget && end > cursor) break;
    rows += h;
    end++;
    while (rows > budget && start < cursor) {
      const head = items[start];
      rows -= head !== undefined ? itemRows(head) : 1;
      start++;
    }
  }
  return { start, visible: items.slice(start, end) };
}

export function PickList<T>({
  title,
  note,
  items,
  initialValue,
  initialIndex = 0,
  selectedIndex,
  onSelectIndex,
  query,
  emptyText = "（空）",
  showFooter = true,
  maxRows,
  onPick,
  onCancel,
  width,
  active = true,
}: {
  title?: string | undefined;
  /** 标题下方的说明行（如"当前由 config.json 指定"）；缺省不显示 */
  note?: string | undefined;
  items: readonly PickItem<T>[];
  initialValue?: T | undefined;
  initialIndex?: number;
  selectedIndex?: number | undefined;
  onSelectIndex?: ((index: number) => void) | undefined;
  query?: PickQueryProps | undefined;
  /** items 为空时的文案；传 null 则不渲染空状态行（如扫描进行中） */
  emptyText?: string | null | undefined;
  /** 是否显示底部计数与快捷键提示 */
  showFooter?: boolean | undefined;
  /** 浮层整体可用行数上限（含上下边框） */
  maxRows?: number | undefined;
  onPick: (value: T) => void;
  onCancel: () => void;
  width: number;
  active?: boolean;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const [internalIndex, setInternalIndex] = useState(() =>
    resolveInitial(items, initialValue, initialIndex),
  );

  const controlled = selectedIndex !== undefined;
  const rawIndex = controlled ? selectedIndex : internalIndex;

  useEffect(() => {
    if (!controlled) {
      setInternalIndex((prev) => {
        if (prev >= 0 && prev < items.length && !items[prev]?.disabled) return prev;
        return resolveInitial(items, initialValue, initialIndex);
      });
    }
  }, [controlled, items, initialValue, initialIndex]);

  const cursor = items.length === 0 ? 0 : Math.min(Math.max(0, rawIndex), items.length - 1);

  const valRef = useRef(query?.value ?? "");
  const curRef = useRef(query?.cursor ?? 0);
  useLayoutEffect(() => {
    if (query !== undefined) {
      valRef.current = query.value;
      curRef.current = Math.min(Math.max(0, query.cursor), query.value.length);
    }
  }, [query]);

  const moveSelection = (dir: -1 | 1): void => {
    if (items.length === 0) return;
    const next = stepEnabled(items, cursor, dir);
    if (onSelectIndex !== undefined) onSelectIndex(next);
    if (!controlled) setInternalIndex(next);
  };

  usePaste(
    (pasted) => {
      if (query === undefined) return;
      const clean = pasted.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
      if (clean === "") return;
      const v = valRef.current;
      const c = Math.min(Math.max(0, curRef.current), v.length);
      const next = v.slice(0, c) + clean + v.slice(c);
      const nextCur = c + clean.length;
      valRef.current = next;
      curRef.current = nextCur;
      query.onChange(next, nextCur);
    },
    { isActive: active && query !== undefined },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        moveSelection(-1);
        return;
      }
      if (key.downArrow) {
        moveSelection(1);
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item !== undefined && !item.disabled) onPick(item.value);
        return;
      }
      if (query === undefined) return;

      const v = valRef.current;
      const c = Math.min(Math.max(0, curRef.current), v.length);
      const setCur = (nextCur: number): void => {
        curRef.current = nextCur;
        query.onCursor?.(nextCur);
      };
      const setVal = (next: string, nextCur: number): void => {
        valRef.current = next;
        curRef.current = nextCur;
        query.onChange(next, nextCur);
      };

      if (key.home || (key.ctrl && input === "a")) {
        setCur(0);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setCur(v.length);
        return;
      }
      if (key.ctrl && input === "u") {
        if (c > 0) setVal(v.slice(c), 0);
        return;
      }
      if (key.ctrl && input === "k") {
        if (c < v.length) setVal(v.slice(0, c), c);
        return;
      }
      if (key.leftArrow) {
        setCur(prevCharIndex(v, c));
        return;
      }
      if (key.rightArrow) {
        setCur(nextCharIndex(v, c));
        return;
      }
      if (key.backspace) {
        if (c > 0) {
          const prev = prevCharIndex(v, c);
          setVal(v.slice(0, prev) + v.slice(c), prev);
        }
        return;
      }
      if (key.delete) {
        if (c < v.length) {
          const next = nextCharIndex(v, c);
          setVal(v.slice(0, c) + v.slice(next), c);
        }
        return;
      }
      if (
        input !== "" &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !key.pageUp &&
        !key.pageDown &&
        !/[\x00-\x1f\x7f]/.test(input)
      ) {
        const next = v.slice(0, c) + input + v.slice(c);
        setVal(next, c + input.length);
      }
    },
    { isActive: active && (items.length > 0 || query !== undefined) },
  );

  const chromeRows =
    2 +
    (title !== undefined ? 1 : 0) +
    (query !== undefined ? 1 : 0) +
    (note !== undefined ? 1 : 0) +
    (showFooter ? 2 : 0);
  const maxBodyRows = maxRows !== undefined ? Math.max(2, maxRows - chromeRows) : undefined;
  const { start, visible } = selectWindow(items, cursor, MAX_VISIBLE, maxBodyRows);

  const queryPrompt = `${g.prompt} `;
  const queryInnerWidth = Math.max(2, width - 6 - stringWidth(queryPrompt));
  const queryView =
    query !== undefined ? querySlice(query.value, query.cursor, queryInnerWidth) : undefined;

  return (
    <Box
      flexDirection="column"
      width={width - 4}
      borderStyle={env.ascii ? "single" : "round"}
      borderColor={theme.border}
    >
      {query?.cursorY !== undefined ? (
        <InputCursor
          active={active}
          prefix={queryPrompt}
          text={boxSafe(query.value.slice(0, query.cursor))}
          width={Math.max(2, width - 6)}
          x={1}
          y={query.cursorY}
        />
      ) : null}
      {title !== undefined ? <Text bold>{boxSafe(title)}</Text> : null}
      {query !== undefined && queryView !== undefined ? (
        <Text wrap="truncate">
          <Text color={theme.accent}>{queryPrompt}</Text>
          {queryView.before}
          {active ? <Text inverse>{queryView.at}</Text> : queryView.at.trimEnd()}
          {queryView.after}
        </Text>
      ) : null}
      {note !== undefined ? <Text dimColor>{boxSafe(note)}</Text> : null}
      {items.length === 0 && emptyText !== null ? <Text dimColor>{emptyText}</Text> : null}
      {visible.map((item, idx) => {
        const focused = start + idx === cursor;
        const dim = item.disabled === true;
        return (
          <Box key={item.key ?? start + idx} flexDirection="column">
            <Text wrap="truncate">
              <Text {...(focused ? { color: theme.accent } : {})}>
                {focused ? `${g.prompt} ` : "  "}
              </Text>
              <Text
                {...(focused ? { color: theme.selected, backgroundColor: theme.selectionBg } : {})}
                dimColor={dim}
              >
                {truncateLine(
                  boxSafe(item.label + (item.hint !== undefined ? `  ${item.hint}` : "")),
                  Math.max(4, width - 8),
                  g.ellipsis,
                )}
              </Text>
            </Text>
            {item.detail !== undefined && item.detail.length > 0 ? (
              <Text wrap="truncate">
                {"  "}
                {truncateSpans(item.detail, Math.max(1, width - 8), g.ellipsis).map((span, si) =>
                  span.accent === true ? (
                    <Text key={si} color={theme.accent} bold>
                      {span.text}
                    </Text>
                  ) : (
                    <Text key={si} dimColor>
                      {span.text}
                    </Text>
                  ),
                )}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {showFooter && items.length > MAX_VISIBLE ? (
        <Text dimColor>
          {cursor + 1}/{items.length}
        </Text>
      ) : null}
      {showFooter ? <Text dimColor>上下选择，Enter 确认，Esc 取消</Text> : null}
    </Box>
  );
}
