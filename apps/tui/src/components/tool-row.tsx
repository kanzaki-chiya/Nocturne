/**
 * 工具条目行（tui.md §4）：● name <输入摘要> + 状态徽标；
 * 进行中显示 liveOutput 尾部；完结后按 output.diff / modelContent 展示。
 */
import { Box, Text } from "ink";
import { shellToolStatus } from "../background-shell.js";
import { useEffect, useState } from "react";

import { questionToolLines } from "../question-format.js";
import {
  goalCheckFailedItems,
  goalCheckUnavailableReason,
  isGoalUnverified,
} from "../goal-check.js";
import { webFetchSummary } from "../web-fetch.js";
import {
  attachmentLine,
  fileAttachmentLine,
  inlinePageTitle,
  inlinePageVersionSuffix,
} from "../attachment-line.js";
import { diffSummary, parseDiff, toolFileDiffs, type ToolFileDiff } from "../diff-format.js";
import { glyphs, useTuiEnv } from "../env.js";
import {
  formatDuration,
  noteItemsFromEntry,
  permissionReviewLine,
  summarizeToolInput,
  subagentModel,
  tailLines,
  toolHeadlineSegments,
  toolTwoToneSummaryParts,
  truncateLine,
} from "../format.js";
import { useTheme, type ThemePalette } from "../theme.js";
import {
  ensembleReadCountText,
  ensembleReadPostsFromOutput,
  toolDisplayName,
} from "../text-format-ensemble.js";
import { todoHeadline } from "../todo-format.js";
import { DiffView } from "./diff.js";
import { SegmentText, TodoRows } from "./todo-panel.js";

import type { LiveTool, ToolEntry, ViewEntry } from "@nocturne/core/protocol";
import {
  inlineFilesOfTool,
  isNotReadToolFailure,
  todoItemsFromCompletion,
  subagentRowInfo,
  subagentApplyLine,
  backgroundToolStatus,
  subagentStartRejected,
} from "@nocturne/core/protocol";

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

export function ToolRow({
  entry,
  width,
  entries = [],
}: {
  entry: ToolEntry;
  width: number;
  entries?: readonly ViewEntry[];
}): React.JSX.Element {
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
  // 未读文件即写（not_read）的已结束工具行不渲染；执行中照常显示，出结果后该行消失。
  if (isNotReadToolFailure(entry)) return <></>;
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
  const goalUnverified = isGoalUnverified(entry);
  const b = goalUnverified
    ? { glyph: env.ascii ? "*" : "•", color: theme.muted, word: "核对未通过" }
    : badge(entry.status, spinner, env, theme);
  const name = entry.name ?? "?";
  const shownName = entry.target?.name ?? entry.name ?? "?";
  const shownInput = entry.target !== undefined ? entry.target.input : entry.input;
  const twoTone = toolTwoToneSummaryParts(
    shownName,
    shownInput,
    entry.status === "ok" ? entry.result?.output : undefined,
  );
  const summary =
    twoTone !== undefined
      ? ""
      : truncateLine(
          summarizeToolInput(
            entry.name,
            entry.input,
            entry.status === "ok" ? entry.result?.output : undefined,
          ),
          Math.max(10, width - 24),
          g.ellipsis,
        );
  const summaryPart = summary !== "" ? ` ${summary}` : "";
  const head =
    name === "apply_subagent_changes" && entry.result
      ? ` ${subagentApplyLine(entry.result.output)}`
      : name === "switch_worktree"
        ? ` 切换工作树 · ${summary}`
        : ` ${toolDisplayName(name)}${subagentModel(entry)}${summaryPart}`;
  const duration = entry.result?.durationMs;
  const boardCount = ensembleReadCountText(entry);
  const suffix = subagentStartRejected(entry)
    ? "未启动"
    : (shellToolStatus(entry, entries) ??
      backgroundToolStatus(entry, entries) ??
      (entry.status === "awaiting_permission"
        ? ` ${b.word}`
        : entry.status === "running"
          ? ""
          : boardCount !== undefined
            ? ` ${boardCount}${duration !== undefined ? ` ${formatDuration(duration)}` : ""}`
            : ` ${b.word !== "" ? `${b.word} ` : ""}${formatDuration(duration)}`.trimEnd()));
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
  const inlineFiles = inlineFilesOfTool(entry);
  if (inlineFiles.length > 0) {
    const prefix = env.ascii ? "[] " : "▣ ";
    return (
      <Box flexDirection="column">
        {review}
        {inlineFiles.map((file, i) => {
          const verSuffix = inlinePageVersionSuffix(file);
          return (
            <Text key={`${file.file}:${i}`} wrap="truncate">
              <Text color={theme.secondary}>{prefix}</Text>
              <Text>
                {truncateLine(
                  inlinePageTitle(file),
                  Math.max(4, width - 4 - verSuffix.length),
                  g.ellipsis,
                )}
              </Text>
              {verSuffix !== "" ? <Text dimColor>{verSuffix}</Text> : null}
            </Text>
          );
        })}
      </Box>
    );
  }
  const completedArtifact = entry.result?.artifact;
  if (completedArtifact !== undefined) {
    const prefix = env.ascii ? "[] " : "▣ ";
    const tail = ` [${completedArtifact.type}] · ${completedArtifact.url}`;
    return (
      <Box flexDirection="column">
        {review}
        <Text wrap="truncate">
          <Text color={theme.secondary}>{prefix}</Text>
          <Text>
            {truncateLine(
              completedArtifact.title || completedArtifact.id,
              Math.max(4, width - 4 - tail.length),
              g.ellipsis,
            )}
          </Text>
          <Text dimColor>{tail}</Text>
        </Text>
      </Box>
    );
  }
  const grantSuffix = entry.permission?.source === "grant" ? "（已授权）" : "";
  return (
    <Box flexDirection="column">
      {review}
      {twoTone !== undefined ? (
        <SegmentText
          segments={toolHeadlineSegments({
            mark: b.glyph,
            markColor: b.color,
            toolLabel: toolDisplayName(shownName),
            primary: twoTone.primary,
            query: twoTone.query,
            tail: `${suffix !== "" ? ` ${suffix.trim()}` : ""}${grantSuffix}`,
            tailDim: true,
            width,
            ellipsis: g.ellipsis,
          })}
        />
      ) : (
        <Text wrap="truncate">
          <Text color={b.color}>{b.glyph}</Text>
          <Text>{head}</Text>
          {suffix !== "" ? <Text dimColor> {suffix.trim()}</Text> : null}
          {grantSuffix !== "" && <Text dimColor>{grantSuffix}</Text>}
        </Text>
      )}
      {subagentRowInfo(entry).reason !== undefined && (
        <Text dimColor wrap="truncate">{`  选择理由：${subagentRowInfo(entry).reason}`}</Text>
      )}
      {running && entry.liveOutput !== ""
        ? tailLines(entry.liveOutput, LIVE_TAIL).map((l, i) => (
            <Text key={i} dimColor wrap="truncate">
              {"  "}
              {truncateLine(l, Math.max(8, width - 2), g.ellipsis)}
            </Text>
          ))
        : null}
      {entry.result !== undefined && !subagentStartRejected(entry) ? (
        <ToolResult entry={entry} width={width} />
      ) : null}
      {(entry.result?.attachments ?? []).map((att, i) => (
        <Text key={`${att.file}:${i}`} color={theme.accent} wrap="truncate">
          {`  ${attachmentLine(att, i, env.ascii)}`}
        </Text>
      ))}
      {(entry.result?.files ?? [])
        .filter((file) => file.inline === undefined)
        .map((file, i) => (
          <Text key={`${file.file}:f:${i}`} color={theme.accent} wrap="truncate">
            {`  ${fileAttachmentLine(file, env.ascii)}`}
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
  const goalUnverified = isGoalUnverified(entry);
  const goalFailed = goalUnverified ? goalCheckFailedItems(entry) : [];
  const goalUnavailable = goalCheckUnavailableReason(entry);
  const suppressModelContent =
    (goalUnverified && goalFailed.length > 0) ||
    (entry.status === "ok" &&
      (noteItemsFromEntry(entry) !== undefined ||
        ((entry.target?.name ?? entry.name) === "ensemble_read" &&
          ensembleReadPostsFromOutput(result.output) !== undefined)));
  return (
    <Box flexDirection="column">
      {goalUnavailable !== undefined ? (
        <Text dimColor wrap="truncate">
          {`  ${truncateLine(`核对不可用：${goalUnavailable}`, Math.max(8, width - 2), g.ellipsis)}`}
        </Text>
      ) : null}
      {goalUnverified && goalFailed.length > 0 ? (
        goalFailed.map((item, i) => (
          <Text key={i} dimColor wrap="truncate">
            {"  "}
            {truncateLine(
              `× ${item.label}${item.note !== undefined ? `：${item.note}` : ""}`,
              Math.max(8, width - 2),
              g.ellipsis,
            )}
          </Text>
        ))
      ) : webSummary !== undefined ? (
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
      ) : !suppressModelContent && result.modelContent !== "" ? (
        tailLines(result.modelContent, RESULT_TAIL).map((l, i) => (
          <Text key={i} dimColor wrap="truncate">
            {"  "}
            {truncateLine(l, Math.max(8, width - 2), g.ellipsis)}
          </Text>
        ))
      ) : null}
      {result.error !== undefined && !goalUnverified ? (
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

/** live.tools 中尚未进入执行管线的调用（流式接收参数或排队等待执行） */
export function LiveToolRow({ tool, width }: { tool: LiveTool; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const spinner = useSpinner(true);
  if (tool.name === "ask_user") return <Text>? 提问</Text>;
  const label = tool.queued ? "排队中" : "接收参数中";
  return (
    <Text wrap="truncate">
      <Text color={theme.accent}>{spinner}</Text>
      <Text> {toolDisplayName(tool.name)}</Text>
      <Text dimColor>
        {" "}
        {truncateLine(tool.inputText, Math.max(8, width - tool.name.length - 16), g.ellipsis)}
      </Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}
