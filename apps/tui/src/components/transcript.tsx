/**
 * 会话时间线条目渲染 + 回放区（Ink <Static>，tui.md §4）。
 * <Static> 只接收"完结前缀"——遇到第一个未完结工具条目即停（App 负责切段）。
 */
import { Box, Static, Text } from "ink";

import { glyphs, useTuiEnv } from "../env.js";
import { tailLines } from "../format.js";
import { ToolRow } from "./tool-row.js";

import type { ViewEntry } from "@nocturne/core/protocol";

const REASONING_TAIL = 4;

function UserRow({ entry }: { entry: Extract<ViewEntry, { kind: "user" }> }): React.JSX.Element {
  const text = entry.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return (
    <Box marginTop={1}>
      <Text color="cyan" bold>
        › {text}
      </Text>
    </Box>
  );
}

function AssistantRow({
  entry,
}: {
  entry: Extract<ViewEntry, { kind: "assistant" }>;
}): React.JSX.Element {
  const reasoning = tailLines(entry.reasoning, REASONING_TAIL);
  return (
    <Box flexDirection="column" marginTop={1}>
      {entry.reasoning !== "" ? (
        <Box flexDirection="column">
          {reasoning.map((l, i) => (
            <Text key={i} dimColor italic>
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
      {entry.text !== "" ? <Text>{entry.text}</Text> : null}
      {entry.finishReason === "aborted" ? <Text dimColor>（中断）</Text> : null}
    </Box>
  );
}

function NoticeRow({
  entry,
}: {
  entry: Extract<ViewEntry, { kind: "notice" }>;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const color =
    entry.subtype === "permission" ? "yellow" : entry.subtype === "turn_end" ? "red" : "gray";
  return <Text color={color}>{`${g.notice} ${entry.message}`}</Text>;
}

export function EntryRow({ entry, width }: { entry: ViewEntry; width: number }): React.JSX.Element {
  switch (entry.kind) {
    case "user":
      return <UserRow entry={entry} />;
    case "assistant":
      return <AssistantRow entry={entry} />;
    case "tool":
      return <ToolRow entry={entry} width={width} />;
    case "notice":
      return <NoticeRow entry={entry} />;
  }
}

/**
 * 回放区：<Static> 逐项只写一次。entries 必须是"完结前缀"
 * （第一个未完结条目及其后条目由活动区渲染，App 负责切分）。
 */
export function Transcript({
  entries,
  width,
}: {
  entries: readonly ViewEntry[];
  width: number;
}): React.JSX.Element {
  return (
    <Static items={[...entries]}>
      {(entry) => <EntryRow key={entry.key} entry={entry} width={width} />}
    </Static>
  );
}
