import { Text } from "ink";
import { truncateLineHead } from "../../format.js";
import { useTheme } from "../../theme.js";

export function SourceLine({
  source,
  width,
}: {
  source: string;
  width: number;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text color={theme.muted} wrap="truncate">
      来源：{truncateLineHead(source, width - 6)}
    </Text>
  );
}
