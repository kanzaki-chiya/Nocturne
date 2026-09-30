/**
 * 输入行（tui.md §2）：› 提示符 + 光标；忙/权限待决时禁用并提示。
 * 自实现（ADR-0010 不引 ink-text-input）：字符追加、退格、左右移动、
 * Enter 提交；Ctrl 组合键交给全局路由。
 */
import { Box, Text, useInput, usePaste } from "ink";
import { useLayoutEffect, useRef, useState } from "react";

import { composerWindow, normalizeNewlines, verticalCursor } from "../cursor.js";
import { glyphs, useTuiEnv } from "../env.js";
import { imageTokenAt, imageTokenBefore } from "../images.js";
import { splitInputTokens } from "../file-refs.js";
import { pasteTokenAt, pasteTokenBefore, type PasteStore } from "../paste.js";
import { useTheme } from "../theme.js";

export function Composer({
  value,
  cursor: cursorProp,
  onChange,
  onSubmit,
  active,
  disabledReason,
  width,
  showRule = true,
  suspendNav = false,
  swallowRef,
  onCursor,
  onHistory,
  pastes,
  onPasteImage,
  height = 1,
}: {
  value: string;
  /** 父组件持有光标，浮层开关后不丢 */
  cursor?: number | undefined;
  onChange: (v: string, cursor: number) => void;
  onCursor?: ((cursor: number) => void) | undefined;
  onHistory?: ((direction: -1 | 1) => void) | undefined;
  onSubmit: (line: string) => void;
  /** false 时输入不接收按键（弹层/权限对话框占用焦点） */
  active: boolean;
  /** 非空时输入禁用并显示原因（如"会话忙"）；已输入内容仍可见 */
  disabledReason?: string | undefined;
  /** 终端宽度 */
  width: number;
  height?: number | undefined;
  /** 帧预算允许时在输入行上方画分隔线 */
  showRule?: boolean | undefined;
  /** 补全列表打开时，上下/Tab/Enter/Esc 交给列表，不在这里处理 */
  suspendNav?: boolean | undefined;
  /** conhost 拆开的 Esc+字母：为真时吞掉下一个字母 */
  swallowRef?: { current: boolean } | undefined;
  /** 多行/超长粘贴收成占位（提交时由父组件展开） */
  pastes?: PasteStore | undefined;
  onPasteImage?: ((text: string) => Promise<boolean>) | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const disabled = disabledReason !== undefined;
  const [cursor, setCursor] = useState(cursorProp ?? value.length);
  // 同一渲染批次内连续按键（粘贴）时 props/state 是陈旧值，用 ref 即时同步
  const valRef = useRef(value);
  valRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // 父组件是光标的单一来源（补全、历史回填、提交清空都更新它）。
  useLayoutEffect(() => {
    const next = Math.min(cursorProp ?? value.length, value.length);
    if (next !== cursorRef.current) {
      cursorRef.current = next;
      setCursor(next);
    }
  }, [value, cursorProp]);

  const apply = (next: string, nextCursor: number): void => {
    valRef.current = next;
    cursorRef.current = nextCursor;
    onChange(next, nextCursor);
    setCursor(nextCursor);
  };
  const move = (next: number): void => {
    cursorRef.current = next;
    setCursor(next);
    onCursor?.(next);
  };

  const insert = (raw: string): void => {
    const normalized = normalizeNewlines(raw);
    if (normalized === "") return;
    const text = pastes?.add(normalized) ?? normalized;
    const v = valRef.current;
    const c = cursorRef.current;
    apply(v.slice(0, c) + text + v.slice(c), c + text.length);
  };

  useInput(
    (input, key) => {
      if (swallowRef?.current === true && input.length === 1 && !key.ctrl && !key.meta) {
        swallowRef.current = false;
        return;
      }
      if (disabled) return;
      if (suspendNav && (key.upArrow || key.downArrow || key.tab || key.return || key.escape)) {
        return;
      }
      const v = valRef.current;
      const c = cursorRef.current;
      const lineStart = v.lastIndexOf("\n", c - 1) + 1;
      const lineEnd = v.includes("\n", c) ? v.indexOf("\n", c) : v.length;
      if ((key.ctrl && input === "j") || (!key.return && input === "\n")) {
        apply(v.slice(0, c) + "\n" + v.slice(c), c + 1);
        return;
      }
      if (key.home || (key.ctrl && input === "a")) {
        move(lineStart);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        move(lineEnd);
        return;
      }
      if (key.ctrl && input === "u") {
        apply(v.slice(0, lineStart) + v.slice(c), lineStart);
        return;
      }
      if (key.ctrl && input === "k") {
        apply(v.slice(0, c) + v.slice(lineEnd), c);
        return;
      }
      if (key.ctrl && (key.leftArrow || key.rightArrow || input === "w")) {
        const left = key.leftArrow || input === "w";
        const part = left ? v.slice(0, c) : v.slice(c);
        const token = left
          ? Math.max(pasteTokenBefore(part), imageTokenBefore(part))
          : Math.max(pasteTokenAt(part), imageTokenAt(part));
        const match = left
          ? /(?:\s*\S+|\s+)$/u.exec(part)?.[0].length
          : /^(?:\s*\S+|\s+)/u.exec(part)?.[0].length;
        const count = token > 0 ? token : (match ?? 0);
        const next = left ? c - count : c + count;
        if (input === "w") apply(v.slice(0, next) + v.slice(c), next);
        else move(next);
        return;
      }
      if (key.ctrl || key.meta) return; // Ctrl+C/Ctrl+D / Alt+M 由 App 路由
      if (key.return) {
        if (c > 0 && v[c - 1] === "\\" && (c === v.length || v[c] === "\n")) {
          apply(v.slice(0, c - 1) + "\n" + v.slice(c), c);
          return;
        }
        onSubmit(v);
        return;
      }
      if (key.leftArrow) {
        if (c > 0) {
          move(
            c - (Math.max(pasteTokenBefore(v.slice(0, c)), imageTokenBefore(v.slice(0, c))) || 1),
          );
        }
        return;
      }
      if (key.rightArrow) {
        if (c < v.length) {
          move(c + (Math.max(pasteTokenAt(v.slice(c)), imageTokenAt(v.slice(c))) || 1));
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        const next = verticalCursor(v, c, direction);
        if (next === undefined) onHistory?.(direction);
        else move(next);
        return;
      }
      if (key.backspace) {
        // 占位整块删除，不留半截 [Paste #n
        const n = Math.max(1, pasteTokenBefore(v.slice(0, c)), imageTokenBefore(v.slice(0, c)));
        if (c > 0) apply(v.slice(0, c - n) + v.slice(c), c - n);
        return;
      }
      if (key.delete) {
        if (c < v.length)
          apply(
            v.slice(0, c) +
              v.slice(c + (Math.max(pasteTokenAt(v.slice(c)), imageTokenAt(v.slice(c))) || 1)),
            c,
          );
        return;
      }
      if (key.escape) return; // Esc 由弹层处理
      // 不支持括号粘贴的终端里，粘贴整块经这里到达，同样规范换行、收成占位
      insert(input);
    },
    { isActive: active },
  );

  // 括号粘贴：整段一次到达，内含的换行不会被当成 Enter 提交
  usePaste(
    (pasted) => {
      if (disabled) return;
      if (onPasteImage === undefined) insert(pasted);
      else
        void onPasteImage(pasted).then((attached) => {
          if (!attached) insert(pasted);
        });
    },
    { isActive: active },
  );

  const prompt = `${g.prompt} `;
  const view = composerWindow(prompt, value, cursor, width, height);
  const lineIndex = value.slice(0, cursor).split("\n").length - 1;
  const allLines = value.split("\n");
  const firstLine = Math.min(
    Math.max(0, lineIndex - view.rows.length + 1),
    allLines.length - view.rows.length,
  );
  const lineOffset = (index: number): number =>
    allLines.slice(0, firstLine + index).reduce((sum, line) => sum + line.length + 1, 0);
  // [Image #n] 占位换色，与正文区分（光标只停在占位两端，不会把占位拆开）
  const tinted = (text: string | undefined, offset = 0): React.ReactNode =>
    text === undefined || text === ""
      ? text
      : splitInputTokens(text, value, Math.max(0, offset)).map((part, i) =>
          part.image ? (
            <Text key={i} color={theme.accentAlt}>
              {part.text}
            </Text>
          ) : (
            part.text
          ),
        );
  const rule = env.ascii ? "-".repeat(Math.max(1, width)) : "─".repeat(Math.max(1, width));
  return (
    <Box flexDirection="column">
      {showRule ? (
        <Text dimColor wrap="truncate">
          {rule}
        </Text>
      ) : null}
      {view.rows.map((row, i) => (
        <Box key={i} height={1}>
          <Text color={disabled ? theme.muted : theme.accent}>{row.prefix}</Text>
          <Text dimColor={disabled} wrap="truncate">
            {row.focused && row.before !== value.slice(lineOffset(i), cursor) ? (
              <>
                {"..."}
                {tinted(row.before.slice(3), cursor - row.before.length + 3)}
              </>
            ) : (
              tinted(row.before, lineOffset(i))
            )}
            {row.focused && !disabled ? (
              <Text color={theme.selected} backgroundColor={theme.selectionBg}>
                {row.at ?? " "}
              </Text>
            ) : (
              tinted(row.at, row.focused ? cursor : lineOffset(i))
            )}
            {tinted(row.after, (row.focused ? cursor : lineOffset(i)) + 1)}
            {disabled && i === view.rows.length - 1 ? `（${disabledReason}）` : null}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
