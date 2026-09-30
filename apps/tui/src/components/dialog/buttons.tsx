import { Box, Text, type DOMElement } from "ink";
import { useTheme } from "../../theme.js";

export function Buttons({
  focused,
  readonly,
  width,
  items: customItems,
  onBox,
}: {
  focused: string;
  readonly: boolean;
  width: number;
  items?: readonly (readonly [string, string])[];
  onBox?: ((id: string, node: DOMElement | null) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const items =
    customItems ??
    (readonly
      ? [["return", "返回"]]
      : [
          ["cancel", "取消"],
          ["save", "保存"],
        ]);
  return (
    <Box flexDirection={width < 21 ? "column" : "row"}>
      {items.map(([key, label]) => (
        <Box key={key} flexShrink={0}>
          <Text>{focused === key ? "> " : "  "}</Text>
          <Box ref={(node) => onBox?.(key, node)}>
            <Text
              color={focused === key ? theme.selected : theme.text}
              {...(focused === key ? { backgroundColor: theme.selectionBg } : {})}
            >
              [ {label} ]
            </Text>
          </Box>
          <Text>{"  "}</Text>
        </Box>
      ))}
    </Box>
  );
}
