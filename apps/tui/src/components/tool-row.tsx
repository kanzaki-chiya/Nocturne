/**
 * 工具条目行（tui.md §4）：● name <输入摘要> + 状态徽标；
 * 进行中显示 liveOutput 尾部；完结后按 output.diff / modelContent 展示。
 */
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { questionToolLines } from "../question-format.js";
import { webFetchSummary } from "../web-fetch.js";
import { attachmentLine } from "../attachment-line.js";
import { diffSummary, parseDiff, toolFileDiffs, type ToolFileDiff } from "../diff-format.js";
import { glyphs, useTuiEnv } from "../env.js";
import {
  formatDuration,
  permissionReviewLine,
  summarizeToolInput,
  subagentModel,
  tailLines,
  truncateLine,
} from "../format.js";
import { useTheme, type ThemePalette } from "../theme.js";
import { todoHeadline } from "../todo-format.js";
import { DiffView } from "./diff.js";
import { SegmentText, TodoRows } from "./todo-panel.js";

import type { LiveTool, ToolEntry } from "@nocturne/core/protocol";
import { todoItemsFromCompletion } from "@nocturne/core/protocol";

const LIVE_TAIL = 3;
const RESULT_TAIL = 5;

function useSpinner(active: boolean): string {
  const env = useTuiEnv();
  const frames = glyphs(env).spinner;
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active || !env.animated) return;
    const t = setInterval(() => {
      setI((v) => v + 1);
    }, 120);
    return () => {
      clearInterval(t);
    };
  }, [active, env.animated]);
  return frames[env.animated ? i % frames.length : 0] ?? "●";
}

function badge(
  status: ToolEntry["status"],
  spinner: string,
  env: ReturnType<typeof useTuiEnv>,
  theme: ThemePalette,
) {
  const g = glyphs(env);
  switch (status) {
    case "awaiting_permission":
      return { glyph: g.wait, color: theme.warning, word: "等待确认" };
    case "running":
      return { glyph: spinner, color: theme.accent, word: "" };
    case "ok":
      return { glyph: g.ok, color: theme.success, word: "" };
    case "error":
      return { glyph: g.err, color: theme.error, word: "" };
    case "denied":
      return { glyph: g.err, color: theme.warning, word: "已拒绝" };
    case "cancelled":
      return { glyph: g.err, color: theme.warning, word: "已取消" };
    case "interrupted":
      return { glyph: g.err, color: theme.error, word: "interrupted" };
  }
}

/** 结果输出里的逐文件 diff（edit/write 单文件；apply_patch 多文件，ADR-0035） */
function diffsOf(entry: ToolEntry): ToolFileDiff[] | undefined {
  return toolFileDiffs(entry.status, entry.result?.output, entry.input);
}

export function ToolRow({ entry, width }: { entry: ToolEntry; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const review = entry.review ? (
    <Text dimColor wrap="truncate">
      {truncateLine(permissionReviewLine(entry.review), width, g.ellipsis)}
    </Text>
  ) : null;
  const running = entry.status === "running";
  const spinner = useSpinner(running);
  if (entry.name === "ask_user")
    return (
      <Box flexDirection="column">
        {review}
        {questionToolLines(entry).map((line, i) => (
          <Text key={i} wrap="truncate">
            {truncateLine(line, width, g.ellipsis)}
          </Text>
        ))}
      </Box>
    );
  const b = badge(entry.status, spinner, env, theme);
  const name = entry.name ?? "?";
  const summary = truncateLine(
    summarizeToolInput(entry.name, entry.input),
    Math.max(10, width - 24),
    g.ellipsis,
  );
  const head = ` ${name}${subagentModel(entry)} ${summary}`;
  const duration = entry.result?.durationMs;
  const suffix =
    entry.status === "awaiting_permission"
      ? ` ${b.word}`
      : entry.status === "running"
        ? ""
        : ` ${b.word !== "" ? `${b.word} ` : ""}${formatDuration(duration)}`.trimEnd();
  const todos =
    entry.result === undefined
      ? undefined
      : todoItemsFromCompletion({ name, status: entry.status, output: entry.result.output });
  if (todos !== undefined) {
    return (
      <Box flexDirection="column">
        {review}
        <SegmentText
          segments={[
            ...(env.ascii ? [{ text: `${b.glyph} `, color: b.color }] : []),
            ...todoHeadline(todos, env.ascii, theme),
          ]}
        />
        <TodoRows items={todos} width={width} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {review}
      <Text wrap="truncate">
        <Text color={b.color}>{b.glyph}</Text>
        <Text>{head}</Text>
        {suffix !== "" ? <Text dimColor> {suffix.trim()}</Text> : null}
      </Text>
      {running && entry.liveOutput !== ""
        ? tailLines(entry.liveOutput, LIVE_TAIL).map((l, i) => (
            <Text key={i} dimColor wrap="truncate">
              {"  "}
              {truncateLine(l, Math.max(8, width - 2), g.ellipsis)}
            </Text>
          ))
        : null}
      {entry.result !== undefined ? <ToolResult entry={entry} width={width} /> : null}
      {(entry.result?.attachments ?? []).map((att, i) => (
        <Text key={`${att.file}:${i}`} color={theme.accent} wrap="truncate">
          {`  ${attachmentLine(att, i, env.ascii)}`}
        </Text>
      ))}
    </Box>
  );
}

function ToolResult({ entry, width }: { entry: ToolEntry; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const result = entry.result;
  if (result === undefined) return <></>;
  const diffs = diffsOf(entry);
  const single = diffs?.length === 1 && diffs[0]?.label === "" ? diffs[0].diff : undefined;
  const spill = result.spillPath;
  const webSummary = webFetchSummary(entry);
  return (
    <Box flexDirection="column">
      {webSummary !== undefined ? (
        <Text
          dimColor
          wrap="truncate"
        >{`  ${truncateLine(webSummary, Math.max(1, width - 2), g.ellipsis)}`}</Text>
      ) : diffs !== undefined && single === undefined ? (
        // apply_patch：按文件逐个显示标题与 diff（ADR-0035 §8 / tui.md）
        <>
          <Text dimColor>{`  ${result.modelContent.split("\n")[0] ?? ""}`}</Text>
          {diffs.map((f, i) => (
            <Box key={i} flexDirection="column">
              <Text dimColor wrap="truncate">
                {"  "}
                {truncateLine(
                  `${f.label}${f.diff !== undefined ? `（${diffSummary(parseDiff(f.diff))}）` : ""}`,
                  Math.max(8, width - 2),
                  g.ellipsis,
                )}
              </Text>
              {f.diff !== undefined ? <DiffView diff={f.diff} width={width} /> : null}
            </Box>
          ))}
        </>
      ) : single !== undefined ? (
        <>
          <Text
            dimColor
          >{`  ${result.modelContent.split("\n")[0] ?? ""}；${diffSummary(parseDiff(single))}`}</Text>
          <DiffView diff={single} width={width} />
        </>
      ) : result.modelContent !== "" ? (
        tailLines(result.modelContent, RESULT_TAIL).map((l, i) => (
          <Text key={i} dimColor wrap="truncate">
            {"  "}
            {truncateLine(l, Math.max(8, width - 2), g.ellipsis)}
          </Text>
        ))
      ) : null}
      {result.error !== undefined ? (
        <Text color={theme.error} wrap="truncate">
          {"  "}
          {truncateLine(
            `${result.error.code}: ${result.error.message}`,
            Math.max(8, width - 2),
            g.ellipsis,
          )}
        </Text>
      ) : null}
      {result.truncated || spill !== undefined ? (
        <Text dimColor wrap="truncate">
          {"  "}
          {truncateLine(
            `${result.truncated ? "输出已截断" : ""}${spill !== undefined ? `；完整输出：${spill}` : ""}`,
            Math.max(8, width - 2),
            g.ellipsis,
          )}
        </Text>
      ) : null}
    </Box>
  );
}

/** live.tools 中参数还在流式拼接的调用（尚无持久落点） */
export function LiveToolRow({ tool, width }: { tool: LiveTool; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const spinner = useSpinner(true);
  if (tool.name === "ask_user") return <Text>? 提问</Text>;
  return (
    <Text wrap="truncate">
      <Text color={theme.accent}>{spinner}</Text>
      <Text> {tool.name}</Text>
      <Text dimColor>
        {" "}
        {truncateLine(tool.inputText, Math.max(8, width - tool.name.length - 8), g.ellipsis)}
      </Text>
    </Text>
  );
}
