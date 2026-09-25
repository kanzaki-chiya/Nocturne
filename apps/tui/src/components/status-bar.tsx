/**
 * 状态栏（tui.md §2）：preset | model | effort? | status(+retry) | tokens | cwd | sessionId。
 * effort = 思考强度段（ADR-0018）：模型未声明可用档位时不显示。
 * 宽度收缩：<80 隐藏 cwd/sessionId；<40 只留 status | tokens。
 */
import { Box, Text } from "ink";

import { glyphs, useTuiEnv } from "../env.js";
import { formatTokens, truncateLine } from "../format.js";

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

export function StatusBar({
  view,
  sessionId,
  width,
  effort,
}: {
  view: SessionView;
  sessionId: string;
  width: number;
  /** 当前思考强度（模型声明了可用档位时传入）；undefined = 不显示档位段 */
  effort?: string | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const status =
    view.status === "retrying" && view.retry !== undefined
      ? `${STATUS_TEXT.retrying} ${view.retry.attempt}/${view.retry.maxAttempts}`
      : STATUS_TEXT[view.status];
  const tokens = formatTokens(view.usage);
  const model = view.config.model;
  const minimal = width < 40;
  const compact = width < 80;
  const effortSeg = effort !== undefined ? `思考:${effort}` : "";
  const parts: string[] = minimal
    ? [status, tokens]
    : compact
      ? [
          view.config.permissionPreset ?? "?",
          model !== undefined ? `${model.provider}/${model.model}` : "?",
          effortSeg,
          status,
          tokens,
        ]
      : [
          view.config.permissionPreset ?? "?",
          model !== undefined ? `${model.provider}/${model.model}` : "?",
          effortSeg,
          status,
          tokens,
          view.meta?.cwd ?? "",
          sessionId,
        ];
  const line = parts.filter((p) => p !== "").join(` ${g.notice === "-" ? "|" : "│"} `);
  return (
    <Box>
      <Text dimColor wrap="truncate">
        {truncateLine(line, width, g.ellipsis)}
      </Text>
    </Box>
  );
}
