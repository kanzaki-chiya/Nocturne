import { Text } from "ink";
import { useTuiEnv } from "../../env.js";
import { useTheme } from "../../theme.js";

export function Toggle({
  on,
  focused = false,
}: {
  on: boolean;
  focused?: boolean;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  return (
    <Text
      color={focused ? theme.selected : theme.text}
      {...(focused ? { backgroundColor: theme.selectionBg } : {})}
    >
      {focused ? "> " : "  "}
      {env.ascii ? (on ? "[ON ]" : "[OFF]") : on ? "●━━" : "━━○"}
    </Text>
  );
}
