/**
 * 是/否确认框（/resume 跨目录切换用，tui.md §3）：y/Enter 确认，n/Esc 取消。
 * 语义与 REPL 的 y/N 一致——默认拒绝。
 */
import { Box, Text, useInput } from "ink";

import { useTuiEnv } from "../env.js";

export function ConfirmBox({
  title,
  detail,
  active,
  onConfirm,
  onCancel,
  width,
}: {
  title: string;
  detail?: string | undefined;
  active: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  useInput(
    (input, key) => {
      if (key.escape || input.toLowerCase() === "n") {
        onCancel();
        return;
      }
      if (key.return || input.toLowerCase() === "y") onConfirm();
    },
    { isActive: active },
  );
  return (
    <Box
      flexDirection="column"
      borderStyle={env.ascii ? "single" : "round"}
      borderColor="yellow"
      width={Math.min(width, 72)}
    >
      <Text bold color="yellow" wrap="truncate">
        {title}
      </Text>
      {detail !== undefined ? (
        <Text wrap="truncate" dimColor>
          {detail}
        </Text>
      ) : null}
      <Text dimColor>[y] 确认 / [n] 或 Esc 取消（默认拒绝）</Text>
    </Box>
  );
}
