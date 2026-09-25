/**
 * 输入行（tui.md §2）：› 提示符 + 光标；忙/权限待决时禁用并提示。
 * 自实现（ADR-0010 不引 ink-text-input）：字符追加、退格、左右移动、
 * Enter 提交；Ctrl 组合键交给全局路由。
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import { glyphs, useTuiEnv } from "../env.js";
import { theme } from "../theme.js";

export function Composer({
  value,
  onChange,
  onSubmit,
  active,
  disabledReason,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (line: string) => void;
  /** false 时输入不接收按键（弹层/权限对话框占用焦点） */
  active: boolean;
  /** 非空时输入禁用并显示原因（如"会话忙"）；已输入内容仍可见 */
  disabledReason?: string | undefined;
  /** 终端宽度：输入行上下各画一条占满宽度的横线（tui.md §2，v0.3） */
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const disabled = disabledReason !== undefined;
  const [cursor, setCursor] = useState(value.length);
  // 同一渲染批次内连续按键（粘贴）时 props/state 是陈旧值，用 ref 即时同步
  const valRef = useRef(value);
  valRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // 外部清空（提交后）时把光标拉回末尾
  useEffect(() => {
    if (value.length < cursorRef.current) {
      cursorRef.current = value.length;
      setCursor(value.length);
    }
  }, [value]);

  const apply = (next: string, nextCursor: number): void => {
    valRef.current = next;
    cursorRef.current = nextCursor;
    onChange(next);
    setCursor(nextCursor);
  };

  useInput(
    (input, key) => {
      if (disabled) return;
      if (key.ctrl || key.meta) return; // Ctrl+C/Ctrl+D 由 App 路由
      const v = valRef.current;
      const c = cursorRef.current;
      if (key.return) {
        onSubmit(v);
        return;
      }
      if (key.leftArrow) {
        if (c > 0) {
          cursorRef.current = c - 1;
          setCursor(c - 1);
        }
        return;
      }
      if (key.rightArrow) {
        if (c < v.length) {
          cursorRef.current = c + 1;
          setCursor(c + 1);
        }
        return;
      }
      if (key.backspace) {
        if (c > 0) apply(v.slice(0, c - 1) + v.slice(c), c - 1);
        return;
      }
      if (key.delete) {
        if (c < v.length) apply(v.slice(0, c) + v.slice(c + 1), c);
        return;
      }
      if (key.escape) return; // Esc 由弹层处理
      if (input !== "") apply(v.slice(0, c) + input + v.slice(c), c + input.length);
    },
    { isActive: active },
  );

  const at = value[cursor];
  const rule = env.ascii ? "-".repeat(width) : "─".repeat(width);
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate">
        {rule}
      </Text>
      <Box>
        <Text color={disabled ? theme.muted : theme.accent}>{`${g.prompt} `}</Text>
        {disabled ? (
          <Text dimColor>
            {value}
            {`（${disabledReason}）`}
          </Text>
        ) : (
          <Text>
            {value.slice(0, cursor)}
            <Text inverse>{at ?? " "}</Text>
            {at !== undefined ? value.slice(cursor + 1) : ""}
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate">
        {rule}
      </Text>
    </Box>
  );
}
