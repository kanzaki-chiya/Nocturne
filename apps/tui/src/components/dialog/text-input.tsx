import { Text } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../../theme.js";

export function inputWindow(
  value: string,
  cursor: number,
  width: number,
): { text: string; column: number; start: number } {
  const chars = Array.from(value);
  const inner = Math.max(1, width - 4);
  let start = 0;
  while (stringWidth(chars.slice(start, cursor).join("")) >= inner && start < cursor) start++;
  let text = "";
  for (const ch of chars.slice(start)) {
    if (stringWidth(text + ch) > inner) break;
    text += ch;
  }
  return { text, column: stringWidth(chars.slice(start, cursor).join("")), start };
}

export function TextInput({
  value,
  cursor,
  focused,
  width,
  invalid = false,
  placeholder = "跟随",
}: {
  value: string;
  cursor: number;
  focused: boolean;
  width: number;
  invalid?: boolean;
  /** 空值时显示的灰字；设置类字段的空值表示跟随低层，向导等输入框传空串。 */
  placeholder?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const window = inputWindow(value, cursor, width);
  return (
    <Text
      wrap="truncate"
      color={invalid ? theme.error : focused ? theme.selected : theme.text}
      backgroundColor={theme.inputBg}
    >
      [{" "}
      <Text {...(value === "" ? { color: theme.muted } : {})}>
        {value === "" ? placeholder : window.text}
      </Text>
      {" ".repeat(Math.max(0, width - 4 - stringWidth(value === "" ? placeholder : window.text)))} ]
    </Text>
  );
}
