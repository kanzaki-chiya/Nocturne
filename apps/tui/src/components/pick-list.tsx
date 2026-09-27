/**
 * 通用列表选择器（tui.md §3）：/resume 等会话内选择用；
 * /model 已改为全屏模型选择页（tui.md §7）。
 * ↑↓ 移动、Enter 选择、Esc 取消。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { glyphs, useTuiEnv } from "../env.js";
import { boxSafe, truncateLine } from "../format.js";

export interface PickItem<T> {
  label: string;
  hint?: string | undefined;
  value: T;
  /** 不可选项（如未安装的 shell）：灰显，光标跳过，Enter 不生效 */
  disabled?: boolean | undefined;
}

const MAX_VISIBLE = 10;

export function PickList<T>({
  title,
  note,
  items,
  active,
  onPick,
  onCancel,
  width,
  initialValue,
}: {
  title: string;
  /** 标题下方的说明行（如"当前由 config.json 指定"）；缺省不显示 */
  note?: string | undefined;
  items: readonly PickItem<T>[];
  active: boolean;
  onPick: (value: T) => void;
  onCancel: () => void;
  width: number;
  initialValue?: T | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const enabled = (i: number): boolean => items[i]?.disabled !== true;
  const move = (c: number, dir: 1 | -1): number => {
    let next = c;
    let remaining = items.length;
    while (remaining > 0) {
      remaining -= 1;
      next = (next + dir + items.length) % items.length;
      if (enabled(next)) return next;
    }
    return c;
  };
  const [cursor, setCursor] = useState(() => {
    const initial = items.findIndex((item) => item.value === initialValue);
    if (initial >= 0 && enabled(initial)) return initial;
    const first = items.findIndex((item) => item.disabled !== true);
    return Math.max(0, first);
  });

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => move(c, -1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => move(c, 1));
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item !== undefined && item.disabled !== true) onPick(item.value);
      }
    },
    { isActive: active && items.length > 0 },
  );

  const start = Math.min(
    Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2)),
    Math.max(0, items.length - MAX_VISIBLE),
  );
  const visible = items.slice(start, start + MAX_VISIBLE);
  return (
    <Box
      flexDirection="column"
      width={width - 4}
      borderStyle={env.ascii ? "single" : "round"}
      borderColor="cyan"
    >
      <Text bold>{boxSafe(title)}</Text>
      {note !== undefined ? <Text dimColor>{boxSafe(note)}</Text> : null}
      {items.length === 0 ? <Text dimColor>（空）</Text> : null}
      {visible.map((item, i) => {
        const idx = start + i;
        const focused = idx === cursor;
        const dim = item.disabled === true;
        return (
          <Text key={idx} wrap="truncate">
            <Text {...(focused ? { color: "cyan" } : {})}>{focused ? `${g.prompt} ` : "  "}</Text>
            <Text inverse={focused} dimColor={dim}>
              {truncateLine(
                boxSafe(item.label + (item.hint !== undefined ? `  ${item.hint}` : "")),
                width - 6,
                g.ellipsis,
              )}
            </Text>
          </Text>
        );
      })}
      {items.length > MAX_VISIBLE ? (
        <Text dimColor>
          {cursor + 1}/{items.length}
        </Text>
      ) : null}
      <Text dimColor>上下选择，Enter 确认，Esc 取消</Text>
    </Box>
  );
}
