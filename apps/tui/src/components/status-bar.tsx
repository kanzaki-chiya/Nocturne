/**
 * 状态栏（tui.md §2，ADR-0019 第 5 条）：彩色分段，· 分隔——
 * 状态 · 模型 · 思考:档位 · 权限预设 · 目录 · 上下文占用（已用/上下文长度）。
 * 上下文长度取 ADR-0016 的声明值，未声明只显示已用量；会话 id 不在此。
 * Turn 中切档：思考段显示 旧档→新档 并以警示色标出。
 * 宽度收缩：<80 隐藏目录段；<40 只留 状态 · 上下文占用。
 */
import { Box, Text } from "ink";
import stringWidth from "string-width";

import { useTuiEnv } from "../env.js";
import { statusSegmentColors, theme } from "../theme.js";

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

/** token 数缩写：12.3k / 128k / 1m */
function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export interface EffortSegment {
  /** 当前生效档位（Turn 快照） */
  effective: string;
  /** 会话设定档位 */
  current: string;
  /** Turn 进行中且两值不同 → 显示 旧→新 并变色 */
  transition: boolean;
}

interface Segment {
  text: string;
  color: string;
}

export function StatusBar({
  view,
  width,
  effort,
  context,
}: {
  view: SessionView;
  width: number;
  /** 思考档位段；undefined = 模型未声明可用档位时不显示 */
  effort?: EffortSegment | undefined;
  /** 上下文占用：已用 token / 声明的上下文长度（undefined = 未知） */
  context: { used: number; limit?: number | undefined };
}): React.JSX.Element {
  const env = useTuiEnv();
  // 分隔符用 •（U+2022，conhost 实宽 1 列）：· 是 2 列歧义宽度字符，会把贴边行顶折
  const sep = env.ascii ? " - " : " • ";
  const status =
    view.status === "retrying" && view.retry !== undefined
      ? `${STATUS_TEXT.retrying} ${view.retry.attempt}/${view.retry.maxAttempts}`
      : STATUS_TEXT[view.status];
  const statusColor = view.status === "idle" ? statusSegmentColors.status : theme.warning;

  const ctx =
    context.limit !== undefined ? `${tok(context.used)}/${tok(context.limit)}` : tok(context.used);

  const segments: Segment[] = [{ text: status, color: statusColor }];
  const model = view.config.model;
  segments.push({
    text: model !== undefined ? `${model.provider}/${model.model}` : "?",
    color: statusSegmentColors.model,
  });
  if (effort !== undefined) {
    segments.push({
      text: effort.transition
        ? `思考:${effort.effective}→${effort.current}`
        : `思考:${effort.current}`,
      color: effort.transition ? statusSegmentColors.effortTransition : statusSegmentColors.effort,
    });
  }
  segments.push({
    text: view.config.permissionPreset ?? "?",
    color: statusSegmentColors.preset,
  });
  const dir = view.meta?.cwd ?? "";
  const dirSeg: Segment | undefined =
    width >= 80 && dir !== "" ? { text: dir, color: statusSegmentColors.dir } : undefined;
  if (dirSeg !== undefined) segments.push(dirSeg);
  segments.push({ text: ctx, color: statusSegmentColors.context });

  // <40 列：只留 状态 · 上下文占用（tui.md §5）
  const head = segments[0];
  const last = segments.at(-1);
  let shown = width < 40 && head !== undefined && last !== undefined ? [head, last] : segments;
  // 目录段是可选段：整行拼不下时先丢它，保证模型/思考/预设/上下文完整
  if (dirSeg !== undefined) {
    const total = shown.reduce((w, s) => w + stringWidth(s.text), 0) + (shown.length - 1) * 3;
    // 思考段的 → 在 conhost 实宽 2 列，贴边截断前留 4 列膨胀余量
    if (total > width - 4) shown = shown.filter((s) => s !== dirSeg);
  }

  return (
    <Box>
      <Text wrap="truncate">
        {shown.map((s, i) => (
          <Text key={i}>
            {i > 0 ? <Text color={theme.muted}>{sep}</Text> : null}
            <Text color={s.color}>{s.text}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
