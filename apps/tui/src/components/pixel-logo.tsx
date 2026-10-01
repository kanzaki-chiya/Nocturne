/**
 * Nocturne 像素 Logo（theme.ts 的双色像素字）：左半 accent、右半 accentAlt。
 * NOCTURNE_ASCII 时 █ 退回 #（env.ascii）；字符集只用两端终端实测可显示的符号。
 */
import { Box, Text } from "ink";

import { useTuiEnv } from "../env.js";
import { LOGO_ROWS, LOGO_SPLIT, useTheme, type ThemePalette } from "../theme.js";
import type { LaidLine } from "../viewport.js";

export function pixelLogoLines(ascii: boolean, theme: ThemePalette): LaidLine[] {
  return LOGO_ROWS.map((row, i) => {
    const text = ascii ? row.replaceAll("█", "#") : row;
    return {
      key: `logo:${i}`,
      text,
      segments: [
        { text: text.slice(0, LOGO_SPLIT), color: theme.accent },
        { text: text.slice(LOGO_SPLIT), color: theme.accentAlt },
      ],
    };
  });
}

export function PixelLogo(): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {pixelLogoLines(env.ascii, theme).map((line) => (
        <Text key={line.key} wrap="truncate">
          {line.segments?.map((segment, i) => (
            <Text key={i} {...(segment.color !== undefined ? { color: segment.color } : {})}>
              {segment.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
