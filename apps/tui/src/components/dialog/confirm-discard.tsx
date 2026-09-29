import { Text } from "ink";
import { useTheme } from "../../theme.js";

export function ConfirmDiscard({ discard }: { discard: boolean }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text color={theme.warning}>
      放弃修改？ {discard ? "" : "> "}[继续编辑] {discard ? "> " : ""}[放弃]
    </Text>
  );
}
