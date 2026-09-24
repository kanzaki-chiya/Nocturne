/**
 * 可滚动信息面板（/context、/help 的弹层）：↑↓ 滚动，Esc/Enter 关闭。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";

const MAX_VISIBLE = 12;

export function Panel({
  title,
  lines,
  active,
  onClose,
  width,
}: {
  title: string;
  lines: readonly string[];
  active: boolean;
  onClose: () => void;
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, lines.length - MAX_VISIBLE);

  useInput(
    (_input, key) => {
      if (key.escape || key.return) {
        onClose();
        return;
      }
      if (key.upArrow) setOffset((o) => Math.max(0, o - 1));
      else if (key.downArrow) setOffset((o) => Math.min(maxOffset, o + 1));
    },
    { isActive: active },
  );

  const visible = lines.slice(offset, offset + MAX_VISIBLE);
  return (
    <Box flexDirection="column" borderStyle={env.ascii ? "single" : "round"} borderColor="cyan">
      <Text bold>{title}</Text>
      {visible.map((l, i) => (
        <Text key={offset + i} wrap="truncate">
          {truncateLine(l, width - 4)}
        </Text>
      ))}
      {lines.length > MAX_VISIBLE ? (
        <Text dimColor>
          {offset + 1}–{Math.min(lines.length, offset + MAX_VISIBLE)}/{lines.length}
        </Text>
      ) : null}
      <Text dimColor>Esc / Enter 关闭{maxOffset > 0 ? "，↑↓ 滚动" : ""}</Text>
    </Box>
  );
}
