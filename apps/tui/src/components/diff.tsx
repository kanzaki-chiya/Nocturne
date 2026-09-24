/**
 * unified 风格 diff 渲染（tui.md §4）：+ 绿 / - 红 / 上下文暗色；
 * NO_COLOR 时仅靠 +/- 前缀区分；大 diff 折叠为头尾若干行 + 省略计数。
 */
import { Box, Text } from "ink";

import { useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";

const HEAD_LINES = 6;
const TAIL_LINES = 4;

export function DiffView({ diff, width }: { diff: string; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  const all = diff.split("\n");
  const cap = width < 40 ? 6 : HEAD_LINES + TAIL_LINES;
  const folded = all.length > cap;
  const head = folded ? all.slice(0, width < 40 ? 3 : HEAD_LINES) : all;
  const tail = folded ? all.slice(all.length - (width < 40 ? 2 : TAIL_LINES)) : [];
  const omitted = all.length - head.length - tail.length;
  const renderLine = (line: string, i: number): React.JSX.Element => {
    const color = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
    return (
      <Text
        key={i}
        {...(color !== undefined ? { color } : {})}
        dimColor={color === undefined && !line.startsWith("@@")}
      >
        {truncateLine(line, width, env.ascii ? "..." : "…")}
      </Text>
    );
  };
  return (
    <Box flexDirection="column">
      {head.map(renderLine)}
      {folded ? (
        <Text dimColor>
          {env.ascii ? "..." : "…"} 省略 {omitted} 行
        </Text>
      ) : null}
      {tail.map((l, i) => renderLine(l, head.length + i))}
    </Box>
  );
}
