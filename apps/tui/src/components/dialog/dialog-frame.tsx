import { Box, Text } from "ink";
import { useTuiEnv } from "../../env.js";
import { useTheme } from "../../theme.js";

export function DialogFrame({
  title,
  width,
  height,
  framed,
  children,
}: {
  title: string;
  width: number;
  height: number;
  framed: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={framed ? 1 : 0}
      {...(framed
        ? { borderStyle: env.ascii ? "classic" : "round", borderColor: theme.border }
        : {})}
      backgroundColor={theme.overlayBg}
      overflow="hidden"
    >
      <Text bold color={theme.accent} wrap="truncate">
        {title}
      </Text>
      {children}
    </Box>
  );
}
