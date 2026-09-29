/**
 * Nocturne 像素 Logo（theme.ts 的双色像素字）：左半 accent、右半 accentAlt。
 * NOCTURNE_ASCII 时 █ 退回 #（env.ascii）；字符集只用两端终端实测可显示的符号。
 */
import { Box, Text } from "ink";

import { useTuiEnv } from "../env.js";
import { LOGO_ROWS, LOGO_SPLIT, useTheme } from "../theme.js";

export function PixelLogo(): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const block = env.ascii ? "#" : "█";
  return (
    <Box flexDirection="column">
      {LOGO_ROWS.map((row, i) => {
        const line = env.ascii ? row.replaceAll("█", block) : row;
        return (
          <Text key={i} wrap="truncate">
            <Text color={theme.accent}>{line.slice(0, LOGO_SPLIT)}</Text>
            <Text color={theme.accentAlt}>{line.slice(LOGO_SPLIT)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
