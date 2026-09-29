/**
 * 启动警告与通知块（tui.md §2，ADR-0019 第 5 条）：欢迎框下方、输入框上方，
 * 随 <Static> 只写一次。warning 黄块、error 红块、info 蓝块，逐行 ! 前缀。
 */
import { Box, Text } from "ink";

import { truncateLine } from "../format.js";
import { useTheme } from "../theme.js";

export type NoticeLevel = "info" | "warning" | "error";

export function NoticeBlock({
  notes,
  width,
}: {
  notes: readonly { level: NoticeLevel; text: string }[];
  width: number;
}): React.JSX.Element | null {
  const theme = useTheme();
  const levelStyle: Record<NoticeLevel, { tag: string; fg: string; bg: string }> = {
    info: { tag: " i ", fg: theme.onStatus, bg: theme.info },
    warning: { tag: " ! ", fg: theme.onStatus, bg: theme.warning },
    error: { tag: " ! ", fg: theme.onStatus, bg: theme.error },
  };
  if (notes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {notes.map((n, i) => {
        const style = levelStyle[n.level];
        return (
          <Text key={i} wrap="truncate">
            <Text backgroundColor={style.bg} color={style.fg}>
              {style.tag}
            </Text>
            <Text color={theme.text}> {truncateLine(n.text, Math.max(1, width - 4))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
