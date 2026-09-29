import { Box, Text } from "ink";
import { useTheme } from "../../theme.js";

export function Buttons({
  focused,
  readonly,
  width,
}: {
  focused: string;
  readonly: boolean;
  width: number;
}): React.JSX.Element {
  const theme = useTheme();
  const items = readonly
    ? [["return", "返回"]]
    : [
        ["cancel", "取消"],
        ["save", "保存"],
      ];
  return (
    <Box flexDirection={width < 21 ? "column" : "row"}>
      {items.map(([key, label]) => (
        <Text
          key={key}
          color={focused === key ? theme.selected : theme.text}
          {...(focused === key ? { backgroundColor: theme.selectionBg } : {})}
        >
          {focused === key ? "> " : "  "}[ {label} ]{"  "}
        </Text>
      ))}
    </Box>
  );
}
