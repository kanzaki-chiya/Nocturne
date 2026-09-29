import { Box, Text } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../../theme.js";

export function segmentedLines(
  options: readonly string[],
  selected: number,
  width: number,
  maxLines = Infinity,
): string[] {
  const tokens = options.map((option, i) => `[${i === selected ? "* " : "  "}${option}]`);
  const lines: string[] = [""];
  for (const token of tokens) {
    const last = lines.length - 1;
    const joined = lines[last] === "" ? token : `${lines[last]} ${token}`;
    if (stringWidth(joined) > width && lines[last] !== "") lines.push(token);
    else lines[last] = joined;
  }
  if (lines.length > maxLines || lines.some((line) => stringWidth(line) > width))
    return [`< ${options[selected] ?? ""} > / 共 ${options.length} 项`];
  return lines;
}

export function Segmented({
  options,
  selected,
  focused,
  width,
  maxLines,
}: {
  options: readonly string[];
  selected: number;
  focused: boolean;
  width: number;
  maxLines?: number;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {segmentedLines(options, selected, width, maxLines).map((line, i) => (
        <Text
          key={i}
          wrap="truncate"
          color={focused ? theme.selected : theme.text}
          {...(focused ? { backgroundColor: theme.selectionBg } : {})}
        >
          {focused && i === 0 ? "> " : "  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
