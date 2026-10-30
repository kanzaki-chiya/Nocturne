/**
 * 待发输入（ADR-0070 §6）：输入框上方逐条显示还没发出的插话与排队输入。
 * ↑/↓ 选中（输入框为空时），Alt+E 编辑、Alt+X 撤回、Alt+T 切换、Alt+R 继续发送。
 */
import { Box, Text } from "ink";

import { truncateLine } from "../format.js";
import type { PendingInputItem } from "@nocturne/core/protocol";
import { useTheme } from "../theme.js";

export function pendingPanelRows(items: number, paused: boolean): number {
  if (items === 0) return 0;
  // 标题/提示占一行，条目最多 3 行，超出的折成「还有 N 条」
  return (paused ? 1 : 0) + Math.min(items, 3) + 1;
}

export function PendingInputsPanel({
  items,
  paused,
  selected,
  editing,
  width,
  height,
}: {
  items: readonly PendingInputItem[];
  paused: boolean;
  /** 选中下标（Alt+E/X/T 作用于它） */
  selected: number;
  /** 正在编辑的条目 id */
  editing?: string | undefined;
  width: number;
  height: number;
}): React.JSX.Element {
  const theme = useTheme();
  const rows: React.JSX.Element[] = [];
  let used = 0;
  if (paused && used < height) {
    rows.push(
      <Text key="paused" color={theme.warning} wrap="truncate">
        {"已暂停  Alt+R 继续发送"}
      </Text>,
    );
    used += 1;
  }
  const show = Math.min(items.length, Math.max(0, height - used - 1));
  for (let i = 0; i < show; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    const active = i === selected;
    const label =
      item.mode === "subagent" ? "子代理结果 · 等待送达" : item.mode === "steer" ? "插话" : "排队";
    const attachments = item.attachments > 0 ? `  ${item.attachments} 张图` : "";
    const hint = active ? `  ${item.id === editing ? "编辑中" : ""}` : "";
    const prefix = `${active ? "›" : " "} ${i + 1} ${label} `;
    const tail = `${attachments}${hint}`;
    const text = truncateLine(
      item.mode === "subagent" ? "" : item.text.replace(/\n/gu, " "),
      Math.max(4, width - prefix.length - tail.length - 1),
      "…",
    );
    rows.push(
      <Text key={item.id} {...(active ? { color: theme.accent } : {})} wrap="truncate">
        {prefix}
        {text}
        {tail}
      </Text>,
    );
    used += 1;
  }
  if (items.length > show && used < height) {
    rows.push(
      <Text key="more" dimColor wrap="truncate">
        {`… 还有 ${items.length - show} 条`}
      </Text>,
    );
    used += 1;
  }
  if (used < height) {
    rows.push(
      <Text key="keys" dimColor wrap="truncate">
        {/* 子代理结果只能撤回（ADR-0073 §3） */}
        {items[selected]?.mode === "subagent"
          ? "Alt+X 撤回"
          : "Alt+E 编辑  Alt+X 撤回  Alt+T 切换插话/排队"}
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" height={height}>
      {rows}
    </Box>
  );
}
