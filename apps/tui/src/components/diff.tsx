/** 普通屏幕模式逐行输出完整 diff；与全屏共用解析与折行。 */
import { Box, Text } from "ink";

import { layoutDiffRow, parseDiff } from "../diff-format.js";
import { useTuiEnv } from "../env.js";

export function DiffView({ diff, width }: { diff: string; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  return (
    <Box flexDirection="column">
      {parseDiff(diff).flatMap((row, i) =>
        layoutDiffRow(
          `diff:${i}`,
          row,
          width,
          !env.ascii && process.env.NO_COLOR === undefined,
        ).map((line) => (
          <Text key={line.key} wrap="truncate">
            {line.segments?.map((segment, j) => (
              <Text
                key={j}
                {...(segment.backgroundColor === undefined
                  ? {}
                  : { backgroundColor: segment.backgroundColor })}
              >
                {segment.text}
              </Text>
            ))}
          </Text>
        )),
      )}
    </Box>
  );
}
