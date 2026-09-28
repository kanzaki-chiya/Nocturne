/**
 * 工具条目行（tui.md §4）：● name <输入摘要> + 状态徽标；
 * 进行中显示 liveOutput 尾部；完结后按 output.diff / modelContent 展示。
 */
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { attachmentLine } from "../attachment-line.js";
import { glyphs, useTuiEnv } from "../env.js";
import { formatDuration, summarizeToolInput, tailLines, truncateLine } from "../format.js";
import { theme } from "../theme.js";
import { DiffView } from "./diff.js";

import type { LiveTool, ToolEntry } from "@nocturne/core/protocol";

const LIVE_TAIL = 3;
const RESULT_TAIL = 5;
const DIFF_MAX_WIDTH = 120;

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

function badge(status: ToolEntry["status"], spinner: string, env: ReturnType<typeof useTuiEnv>) {
  const g = glyphs(env);
  switch (status) {
    case "awaiting_permission":
      return { glyph: g.wait, color: "yellow", word: "等待确认" };
    case "running":
      return { glyph: spinner, color: "cyan", word: "" };
    case "ok":
      return { glyph: g.ok, color: "green", word: "" };
    case "error":
      return { glyph: g.err, color: "red", word: "" };
    case "denied":
      return { glyph: g.err, color: "yellow", word: "已拒绝" };
    case "cancelled":
      return { glyph: g.err, color: "yellow", word: "已取消" };
    case "interrupted":
      return { glyph: g.err, color: "red", word: "interrupted" };
  }
}

/** 结果输出里的 diff（edit/write 工具声明的 output.diff 字段） */
function diffOf(result: ToolEntry["result"]): string | undefined {
  const out = result?.output;
  if (typeof out !== "object" || out === null) return undefined;
  const d = (out as Record<string, unknown>).diff;
  return typeof d === "string" && d !== "" ? d : undefined;
}

export function ToolRow({ entry, width }: { entry: ToolEntry; width: number }): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const running = entry.status === "running";
  const spinner = useSpinner(running);
  const b = badge(entry.status, spinner, env);
  const name = entry.name ?? "?";
  const summary = truncateLine(
    summarizeToolInput(entry.name, entry.input),
    Math.max(10, width - 24),
    g.ellipsis,
  );
  const head = ` ${name} ${summary}`;
  const duration = entry.result?.durationMs;
  const suffix =
    entry.status === "awaiting_permission"
      ? ` ${b.word}`
      : entry.status === "running"
        ? ""
        : ` ${b.word !== "" ? `${b.word} ` : ""}${formatDuration(duration)}`.trimEnd();
  return (
    <Box flexDirection="column">
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
  const g = glyphs(env);
  const result = entry.result;
  if (result === undefined) return <></>;
  const diff = diffOf(result);
  const spill = result.spillPath;
  return (
    <Box flexDirection="column">
      {diff !== undefined ? (
        <DiffView diff={diff} width={Math.min(width - 2, DIFF_MAX_WIDTH)} />
      ) : result.modelContent !== "" ? (
        tailLines(result.modelContent, RESULT_TAIL).map((l, i) => (
          <Text key={i} dimColor wrap="truncate">
            {"  "}
            {truncateLine(l, Math.max(8, width - 2), g.ellipsis)}
          </Text>
        ))
      ) : null}
      {result.error !== undefined ? (
        <Text color="red" wrap="truncate">
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
  const g = glyphs(env);
  const spinner = useSpinner(true);
  return (
    <Text wrap="truncate">
      <Text color="cyan">{spinner}</Text>
      <Text> {tool.name}</Text>
      <Text dimColor>
        {" "}
        {truncateLine(tool.inputText, Math.max(8, width - tool.name.length - 8), g.ellipsis)}
      </Text>
    </Text>
  );
}
