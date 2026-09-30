import { Box, Text, type DOMElement } from "ink";
import { useTheme } from "../../theme.js";

export function ConfirmDiscard({
  discard,
  onBox,
}: {
  discard: boolean;
  onBox?: ((id: string, node: DOMElement | null) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Box flexWrap="wrap">
      <Text color={theme.warning}>放弃修改？ </Text>
      <Text color={theme.warning}>{discard ? "" : "> "}</Text>
      <Box ref={(node) => onBox?.("continue", node)}>
        <Text color={theme.warning}>[继续编辑]</Text>
      </Box>
      <Text color={theme.warning}>{discard ? " > " : " "}</Text>
      <Box ref={(node) => onBox?.("discard", node)}>
        <Text color={theme.warning}>[放弃]</Text>
      </Box>
    </Box>
  );
}
