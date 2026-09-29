/**
 * 状态栏：中性色为主，• 分隔。
 * 上下文为「百分比 / 上下文长度」（单位大写）；长度未知只显示已用量。
 * 模型段与 /model 一致（服务商/模型 ID 或简称），整行按显示宽度截断，不换行。
 * Shift+Tab / Alt+M 只短暂高亮对应段，不往对话区插条目。
 */
import { Box, Text } from "ink";
import stringWidth from "string-width";

import { useTuiEnv } from "../env.js";
import { formatContextOccupancy, formatModelLabel } from "../status-format.js";
import { useTheme } from "../theme.js";

import type { ModelInfo } from "@nocturne/core";
import type { RuntimeStatus, SessionView } from "@nocturne/core/protocol";

const STATUS_TEXT: Record<RuntimeStatus, string> = {
  idle: "idle",
  thinking: "思考中",
  running_tool: "工具执行中",
  waiting_permission: "等待确认",
  compacting: "压缩中",
  retrying: "重试中",
  failed: "failed",
};

export interface EffortSegment {
  /** 当前生效档位（Turn 快照） */
  effective: string;
  /** 会话设定档位 */
  current: string;
  /** Turn 进行中且两值不同 → 显示 旧→新 并变色 */
  transition: boolean;
}

export type StatusHighlight = "effort" | "preset";

interface Segment {
  text: string;
  color: string;
  highlight: boolean;
}

export function StatusBar({
  view,
  width,
  effort,
  context,
  models,
  highlight,
  note,
}: {
  view: SessionView;
  width: number;
  /** 思考档位段；undefined = 模型未声明可用档位时不显示 */
  effort?: EffortSegment | undefined;
  /** 上下文占用：已用 token / 声明的上下文长度（undefined = 未知） */
  context: { used: number; limit?: number | undefined };
  /** 与 /model 同一份模型清单，用来取简称 */
  models?: readonly ModelInfo[] | undefined;
  /** 快捷键触发后短暂高亮的段 */
  highlight?: StatusHighlight | undefined;
  /** 短暂提示（复制结果等，由调用方控制时长）；显示为最左段 */
  note?: string | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const sep = env.ascii ? " - " : " • ";
  const status =
    view.status === "retrying" && view.retry !== undefined
      ? `${STATUS_TEXT.retrying} ${view.retry.attempt}/${view.retry.maxAttempts}`
      : STATUS_TEXT[view.status];
  const statusColor = view.status === "idle" ? theme.secondary : theme.warning;
  const ctx = formatContextOccupancy(context.used, context.limit);

  const effortText =
    effort === undefined
      ? undefined
      : effort.transition
        ? `思考:${effort.effective}→${effort.current}`
        : `思考:${effort.current}`;

  const segments: Segment[] = [{ text: status, color: statusColor, highlight: false }];
  let progress: Segment | undefined;
  if (view.todos.length > 0) {
    const done = view.todos.filter((item) => item.status === "completed").length;
    progress = { text: `任务 ${done}/${view.todos.length}`, color: theme.accent, highlight: false };
    segments.push(progress);
  }
  if (note !== undefined) {
    segments.unshift({ text: note, color: theme.secondary, highlight: false });
  }
  const reserved =
    stringWidth(status) +
    stringWidth(sep) +
    stringWidth(ctx) +
    (effortText !== undefined ? stringWidth(sep) + stringWidth(effortText) : 0) +
    stringWidth(sep) +
    stringWidth(view.config.permissionPreset ?? "?") +
    8;
  const modelBudget = Math.max(8, width - reserved);
  segments.push({
    text: formatModelLabel(view.config.model, models ?? [], modelBudget),
    color: theme.text,
    highlight: false,
  });
  if (effort !== undefined && effortText !== undefined) {
    segments.push({
      text: effortText,
      color: effort.transition ? theme.warning : theme.secondary,
      highlight: highlight === "effort",
    });
  }
  segments.push({
    text: view.config.permissionPreset ?? "?",
    color: theme.secondary,
    highlight: highlight === "preset",
  });
  const dir = view.meta?.cwd ?? "";
  const dirSeg: Segment | undefined =
    width >= 80 && dir !== "" ? { text: dir, color: theme.secondary, highlight: false } : undefined;
  if (dirSeg !== undefined) segments.push(dirSeg);
  segments.push({ text: ctx, color: theme.muted, highlight: false });

  const head = segments[0];
  const last = segments.at(-1);
  let shown =
    width < 40 && head !== undefined && last !== undefined
      ? [head, ...(progress === undefined ? [] : [progress]), last]
      : segments;
  if (dirSeg !== undefined) {
    const total = shown.reduce((w, s) => w + stringWidth(s.text), 0) + (shown.length - 1) * 3;
    if (total > width - 4) shown = shown.filter((s) => s !== dirSeg);
  }

  return (
    <Box height={1}>
      <Text wrap="truncate">
        {shown.map((s, i) => (
          <Text key={i}>
            {i > 0 ? <Text color={theme.muted}>{sep}</Text> : null}
            <Text
              color={s.highlight ? theme.selected : s.color}
              {...(s.highlight ? { backgroundColor: theme.selectionBg } : {})}
              bold={s.highlight}
            >
              {s.text}
            </Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
