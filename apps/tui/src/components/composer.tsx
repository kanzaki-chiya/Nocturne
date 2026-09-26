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
}: {
  value: string;
  /** 父组件持有光标，浮层开关后不丢 */
  cursor?: number | undefined;
  onChange: (v: string, cursor: number) => void;
  onCursor?: ((cursor: number) => void) | undefined;
  onSubmit: (line: string) => void;
  /** false 时输入不接收按键（弹层/权限对话框占用焦点） */
  active: boolean;
  /** 非空时输入禁用并显示原因（如"会话忙"）；已输入内容仍可见 */
  disabledReason?: string | undefined;
  /** 终端宽度 */
  width: number;
  /** 帧预算允许时在输入行上方画分隔线 */
  showRule?: boolean | undefined;
  /** 补全列表打开时，上下/Tab/Enter/Esc 交给列表，不在这里处理 */
  suspendNav?: boolean | undefined;
  /** conhost 拆开的 Esc+字母：为真时吞掉下一个字母 */
  swallowRef?: { current: boolean } | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const disabled = disabledReason !== undefined;
  const [cursor, setCursor] = useState(cursorProp ?? value.length);
  // 同一渲染批次内连续按键（粘贴）时 props/state 是陈旧值，用 ref 即时同步
  const valRef = useRef(value);
  valRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // 父组件是光标的单一来源（补全、历史回填、提交清空都更新它）。
  useEffect(() => {
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

  useInput(
    (input, key) => {
      if (swallowRef?.current === true && input.length === 1 && !key.ctrl && !key.meta) {
        swallowRef.current = false;
        return;
      }
      if (disabled) return;
      if (key.ctrl || key.meta) return; // Ctrl+C/Ctrl+D / Alt+M 由 App 路由
      if (suspendNav && (key.upArrow || key.downArrow || key.tab || key.return || key.escape)) {
        return;
      }
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
          onCursor?.(c - 1);
        }
        return;
      }
      if (key.rightArrow) {
        if (c < v.length) {
          cursorRef.current = c + 1;
          setCursor(c + 1);
          onCursor?.(c + 1);
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
  const rule = env.ascii ? "-".repeat(Math.max(1, width)) : "─".repeat(Math.max(1, width));
  return (
    <Box flexDirection="column">
      {showRule ? (
        <Text dimColor wrap="truncate">
          {rule}
        </Text>
      ) : null}
      <Box height={1}>
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
    </Box>
  );
}
