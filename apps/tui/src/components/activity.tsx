/**
 * 活动区（tui.md §2）：动态重绘区——流式助手文本、参数准备中的工具、
 * 未完结的 entries 后缀、重试/压缩状态、运行期 notices。
 * 串行管线保证同一时刻内容有限。
 */
import { Box, Text } from "ink";

import { glyphs, useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";
import { EntryRow } from "./transcript.js";
import { LiveToolRow } from "./tool-row.js";

import type { SessionView, ViewEntry } from "@nocturne/core/protocol";

const NOTICE_TAIL = 3;

export function Activity({
  view,
  pendingEntries,
  clientLines,
  width,
}: {
  view: SessionView;
  /** 完结前缀之后的条目（含未完结工具与其后的完结条目） */
  pendingEntries: readonly ViewEntry[];
  /** 客户端本地消息（命令反馈、错误）——不进 SessionView */
  clientLines: readonly string[];
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const notices = view.notices.slice(-NOTICE_TAIL);
  const empty =
    pendingEntries.length === 0 &&
    view.live.assistants.length === 0 &&
    view.live.tools.length === 0 &&
    view.retry === undefined &&
    notices.length === 0 &&
    clientLines.length === 0 &&
    view.status !== "compacting";
  if (empty) return <></>;
  return (
    <Box flexDirection="column">
      {pendingEntries.map((e) => (
        <EntryRow key={e.key} entry={e} width={width} />
      ))}
      {view.live.tools.map((t) => (
        <LiveToolRow key={t.callId} tool={t} width={width} />
      ))}
      {view.live.assistants.map((a) => (
        <Box key={a.messageId} flexDirection="column">
          {a.reasoning !== "" ? (
            <Text dimColor italic>
              {a.reasoning}
            </Text>
          ) : null}
          {a.text !== "" ? <Text>{a.text}</Text> : null}
          <Text dimColor>{env.ascii ? "_" : "▌"}</Text>
        </Box>
      ))}
      {view.retry !== undefined ? (
        <Text color="yellow" wrap="truncate">
          {truncateLine(
            `重试 ${view.retry.attempt}/${view.retry.maxAttempts}：${view.retry.error.message}（${view.retry.delayMs}ms 后重试）`,
            width,
            g.ellipsis,
          )}
        </Text>
      ) : null}
      {view.status === "compacting" ? <Text dimColor>正在压缩上下文…</Text> : null}
      {notices.map((n, i) => (
        <Text
          key={i}
          color={n.level === "error" ? "red" : n.level === "warning" ? "yellow" : "gray"}
          wrap="truncate"
        >
          {truncateLine(`! ${n.message}`, width, g.ellipsis)}
        </Text>
      ))}
      {clientLines.map((l, i) => (
        <Text key={`c${i}`} dimColor wrap="truncate">
          {truncateLine(l, width, g.ellipsis)}
        </Text>
      ))}
    </Box>
  );
}
