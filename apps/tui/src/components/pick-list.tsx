/**
 * 通用列表选择器（tui.md §3）：/resume 等会话内选择用；
 * /model 已改为全屏模型选择页（tui.md §7）。
 * ↑↓ 移动、Enter 选择、Esc 取消。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { glyphs, useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";

export interface PickItem<T> {
  label: string;
  hint?: string | undefined;
  value: T;
}

const MAX_VISIBLE = 10;

export function PickList<T>({
  title,
  items,
  active,
  onPick,
  onCancel,
  width,
}: {
  title: string;
  items: readonly PickItem<T>[];
  active: boolean;
  onPick: (value: T) => void;
  onCancel: () => void;
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const [cursor, setCursor] = useState(0);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => (c + items.length - 1) % items.length);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % items.length);
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item !== undefined) onPick(item.value);
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
    <Box flexDirection="column" borderStyle={env.ascii ? "single" : "round"} borderColor="cyan">
      <Text bold>{title}</Text>
      {items.length === 0 ? <Text dimColor>（空）</Text> : null}
      {visible.map((item, i) => {
        const idx = start + i;
        const focused = idx === cursor;
        return (
          <Text key={idx} wrap="truncate">
            <Text {...(focused ? { color: "cyan" } : {})}>{focused ? `${g.prompt} ` : "  "}</Text>
            <Text inverse={focused}>
              {truncateLine(
                item.label + (item.hint !== undefined ? `  ${item.hint}` : ""),
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
      <Text dimColor>↑↓ 选择，Enter 确认，Esc 取消</Text>
    </Box>
  );
}
