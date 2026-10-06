/**
 * 会话时间线条目渲染 + 回放区（Ink <Static>，tui.md §4）。
 * <Static> 只接收"完结前缀"——遇到第一个未完结工具条目即停（App 负责切段）。
 */
import { Box, Static, Text } from "ink";

import { attachmentLine, descriptionLine } from "../attachment-line.js";
import { glyphs, useTuiEnv } from "../env.js";
import { splitInputTokens, userText, fileRefLine } from "../file-refs.js";
import { layoutEntry } from "../lines.js";
import type { ReasoningMap } from "../reasoning.js";
import { renderAssistant } from "../markdown.js";
import { useTheme } from "../theme.js";
import type { LaidLine } from "../viewport.js";
import { ToolRow } from "./tool-row.js";

import type { ViewEntry } from "@nocturne/core/protocol";

/** 回放区条目：会话视图条目 + 客户端本地分隔线（/resume 切换标记） */
export type TranscriptItem =
  | Exclude<ViewEntry, { kind: "assistant" }>
  | (Extract<ViewEntry, { kind: "assistant" }> & { bodyContinued?: boolean })
  | { kind: "separator"; key: string; text: string }
  | { kind: "header"; key: string; lines: LaidLine[] };

function UserRow({ entry }: { entry: Extract<ViewEntry, { kind: "user" }> }): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const text = userText(entry);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={theme.accent} bold>
        {glyphs(env).prompt}{" "}
        {splitInputTokens(text).map((part, i) =>
          part.image ? (
            <Text key={i} color={theme.accentAlt}>
              {part.text}
            </Text>
          ) : (
            part.text
          ),
        )}
      </Text>
      {(entry.fileRefs ?? []).map((ref, i) => (
        <Text key={`ref:${i}`} color={theme.accentAlt}>{`  ${fileRefLine(ref)}`}</Text>
      ))}
      {entry.skill ? (
        <Text
          color={theme.accentAlt}
        >{`  技能 ${entry.skill.name} · 已附加正文 ${entry.skill.body.length} 字`}</Text>
      ) : null}
      {(entry.attachments ?? []).map((att, i) => (
        <Text key={`${att.file}:${i}`} color={theme.accent} wrap="truncate">
          {`  ${attachmentLine(att, i, env.ascii)}`}
        </Text>
      ))}
      {(entry.descriptions ?? []).map((description) => (
        <Text
          key={`description:${description.attachmentRef.index}`}
          dimColor
        >{`  ${descriptionLine(description, entry.attachments?.[description.attachmentRef.index])}`}</Text>
      ))}
    </Box>
  );
}

function AssistantRow({
  entry,
  width,
  reasoning,
  now,
}: {
  entry: Extract<TranscriptItem, { kind: "assistant" }>;
  width: number;
  reasoning?: ReasoningMap | undefined;
  now?: number | undefined;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      {entry.reasoning !== "" ? (
        <Box flexDirection="column">
          {layoutEntry(
            { ...entry, text: "", finishReason: "stop" },
            width,
            env.ascii,
            reasoning,
            now,
            false,
            false,
            theme,
          ).map((line) => (
            <Text key={line.key} dimColor wrap="truncate">
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {entry.text !== ""
        ? renderAssistant(entry.text, width, entry.key, env.ascii, theme, entry.bodyContinued).map(
            (line) => (
              <Text key={line.key}>
                {line.segments?.map((seg, i) => (
                  <Text
                    key={i}
                    bold={seg.bold === true}
                    italic={seg.italic === true}
                    dimColor={seg.dim === true}
                    {...(seg.color !== undefined ? { color: seg.color } : {})}
                    {...(seg.backgroundColor !== undefined
                      ? { backgroundColor: seg.backgroundColor }
                      : {})}
                  >
                    {seg.text}
                  </Text>
                )) ?? line.text}
              </Text>
            ),
          )
        : null}
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
  const theme = useTheme();
  const g = glyphs(env);
  const color =
    entry.subtype === "permission"
      ? theme.warning
      : entry.subtype === "turn_end"
        ? theme.error
        : theme.muted;
  return <Text color={color}>{`${g.notice} ${entry.message}`}</Text>;
}

function SeparatorRow({ text }: { text: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text dimColor>{`── ${text} ──`}</Text>
    </Box>
  );
}

export function EntryRow({
  entry,
  width,
  reasoning,
  now,
}: {
  entry: TranscriptItem;
  width: number;
  reasoning?: ReasoningMap | undefined;
  now?: number | undefined;
}): React.JSX.Element {
  switch (entry.kind) {
    case "user":
      return <UserRow entry={entry} />;
    case "assistant":
      return <AssistantRow entry={entry} width={width} reasoning={reasoning} now={now} />;
    case "tool":
      return (
        <Box flexDirection="column">
          <ToolRow entry={entry} width={width} />
          {(entry.descriptions ?? []).map((description) => (
            <Text
              key={`description:${description.attachmentRef.index}`}
              dimColor
            >{`  ${descriptionLine(description, entry.result?.attachments?.[description.attachmentRef.index])}`}</Text>
          ))}
        </Box>
      );
    case "notice":
      return <NoticeRow entry={entry} />;
    case "separator":
      return <SeparatorRow text={entry.text} />;
    case "header":
      return (
        <Box flexDirection="column">
          {entry.lines.map((line) => (
            <Text
              key={line.key}
              {...(line.color !== undefined ? { color: line.color } : {})}
              dimColor={line.dim === true}
              bold={line.bold === true}
              italic={line.italic === true}
            >
              {line.segments !== undefined
                ? line.segments.map((seg, i) => (
                    <Text
                      key={i}
                      {...(seg.color !== undefined ? { color: seg.color } : {})}
                      {...(seg.backgroundColor !== undefined
                        ? { backgroundColor: seg.backgroundColor }
                        : {})}
                      dimColor={seg.dim === true}
                      bold={seg.bold === true}
                      italic={seg.italic === true}
                      strikethrough={seg.strikethrough === true}
                    >
                      {seg.text}
                    </Text>
                  ))
                : line.text || " "}
            </Text>
          ))}
        </Box>
      );
  }
}

/**
 * 回放区：<Static> 逐项只写一次。entries 必须是"完结前缀"
 * （第一个未完结条目及其后条目由活动区渲染，App 负责切分）。
 */
export function Transcript({
  entries,
  width,
  reasoning,
  now,
}: {
  entries: readonly TranscriptItem[];
  width: number;
  reasoning?: ReasoningMap | undefined;
  now?: number | undefined;
}): React.JSX.Element {
  return (
    <Static items={[...entries]}>
      {(entry) => (
        <EntryRow key={entry.key} entry={entry} width={width} reasoning={reasoning} now={now} />
      )}
    </Static>
  );
}
