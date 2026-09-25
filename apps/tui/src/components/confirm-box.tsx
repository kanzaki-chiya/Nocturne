/**
 * 确认框（ADR-0019 第 2 条）：全屏页面不用 y/N 打字回答——
 * 是非题渲染为可选择项，左右/上下移动焦点、Enter 执行、Esc 取消。
 * 默认焦点在"取消"（默认拒绝，与 REPL 的 y/N 语义一致）。
 * 框内不用歧义宽度字符（format.ts boxSafe），盒体距右缘留余量。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { useTuiEnv } from "../env.js";
import { boxSafe } from "../format.js";
import { theme } from "../theme.js";

export function ConfirmBox({
  title,
  detail,
  active,
  onConfirm,
  onCancel,
  width,
  confirmLabel = "确认",
  cancelLabel = "取消",
}: {
  title: string;
  detail?: string | undefined;
  active: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  width: number;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  // index 0 = 取消（默认拒绝）；index 1 = 确认
  const [index, setIndex] = useState(0);
  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.tab) {
        setIndex((i) => (i === 0 ? 1 : 0));
        return;
      }
      if (key.return) {
        if (index === 0) onCancel();
        else onConfirm();
      }
    },
    { isActive: active },
  );
  return (
    <Box
      flexDirection="column"
      borderStyle={env.ascii ? "single" : "round"}
      borderColor={theme.warning}
      width={Math.min(width - 2, 72)}
    >
      <Text bold color={theme.warning} wrap="truncate">
        {boxSafe(title)}
      </Text>
      {detail !== undefined ? (
        <Text wrap="truncate" dimColor>
          {boxSafe(detail)}
        </Text>
      ) : null}
      <Text wrap="truncate">
        <Text inverse={index === 0} {...(index === 0 ? { color: theme.accent } : {})}>
          [{cancelLabel}]
        </Text>
        {"  "}
        <Text inverse={index === 1} {...(index === 1 ? { color: theme.warning } : {})}>
          [{confirmLabel}]
        </Text>
        <Text dimColor> 左右选择，Enter 执行，Esc 取消</Text>
      </Text>
    </Box>
  );
}
