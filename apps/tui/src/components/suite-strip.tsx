/**
 * 组曲状态块（tui.md、ADR-0097）：当前会话是组曲指挥时固定在合奏状态块同一位置。
 * 首行强调色 `◆` + 组曲名 + 淡色各非空组计数；其下每行一条「等你处理」或「进行中」的线程：
 * 状态点 + 对齐的标题 + 淡色模型名 + 第二段摘要。放不下时按 frameBudget 与 `+N` 规则。
 */
import { Text } from "ink";
import stringWidth from "string-width";

import type { SuiteThreadView, SuiteView } from "@nocturne/core/protocol";

import { glyphs, useTuiEnv } from "../env.js";
import { padToWidth, truncateLine } from "../format.js";
import {
  suiteStatusCounts,
  suiteStripThreads,
  suiteThreadModelLabel,
  suiteThreadSecondary,
} from "../text-format-suite.js";
import { useTheme } from "../theme.js";

/** 状态块希望占的行数：首行 + 「等你处理」「进行中」线程数；非组曲指挥时为 0 */
export function suiteStripRows(suite: SuiteView | undefined): number {
  if (suite === undefined) return 0;
  return 1 + suiteStripThreads(suite).length;
}

export function SuiteStrip({
  suite,
  name,
  width,
  height,
}: {
  suite: SuiteView;
  name?: string | undefined;
  width: number;
  height: number;
}): React.JSX.Element | null {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  if (height <= 0) return null;

  const inner = Math.max(1, width - 1);
  const threads = suiteStripThreads(suite);
  const room = height - 1;
  const overflow = threads.length > room;
  const shown = overflow ? threads.slice(0, Math.max(0, room - 1)) : threads;
  const hidden = threads.length - shown.length;

  const mark = env.ascii ? "*" : "◆";
  const countsText = suiteStatusCounts(suite.threads);
  const trimmedName = name?.trim();
  const rawName =
    trimmedName !== undefined && trimmedName !== ""
      ? trimmedName
      : suite.suiteId !== ""
        ? suite.suiteId
        : "组曲";
  const maxHeadW =
    countsText === ""
      ? inner
      : Math.max(6, inner - Math.min(stringWidth(countsText) + 2, Math.floor(inner / 2)));
  const head = truncateLine(`${mark} ${rawName}`, maxHeadW, g.ellipsis);
  const countsRoom = Math.max(0, inner - stringWidth(head) - 2);
  const counts = countsText === "" ? "" : truncateLine(countsText, countsRoom, g.ellipsis);

  const rawTitleW = Math.max(0, ...threads.map((t) => stringWidth(t.title)));
  const titleW = Math.min(rawTitleW, Math.max(8, Math.floor(inner / 3)));
  const modelW = Math.max(0, ...threads.map((t) => stringWidth(suiteThreadModelLabel(t))));

  const row = (t: SuiteThreadView): React.JSX.Element => {
    const attention = t.group === "needs_attention";
    const titleCell = padToWidth(truncateLine(t.title, titleW, g.ellipsis), titleW);
    const modelCell = padToWidth(suiteThreadModelLabel(t), modelW);
    const prefix = `  ${g.dot} ${titleCell}  ${modelCell}`;
    const secondary = suiteThreadSecondary(t);
    const secRoom = Math.max(0, inner - stringWidth(prefix) - 2);
    const secText =
      secondary.text !== "" && secRoom > 0 ? truncateLine(secondary.text, secRoom, g.ellipsis) : "";
    return (
      <Text key={t.threadId} wrap="truncate">
        {"  "}
        <Text color={attention ? theme.warning : theme.accent}>{g.dot}</Text>
        {` ${titleCell}  `}
        <Text color={theme.muted}>{modelCell}</Text>
        {secText !== "" ? (
          secondary.warn ? (
            <Text color={theme.warning}>{`  ${secText}`}</Text>
          ) : (
            `  ${secText}`
          )
        ) : null}
      </Text>
    );
  };

  return (
    <>
      <Text wrap="truncate">
        <Text color={theme.accent}>{head}</Text>
        {counts !== "" ? <Text color={theme.muted}>{`  ${counts}`}</Text> : null}
      </Text>
      {shown.map(row)}
      {overflow ? <Text color={theme.muted}>{`  +${hidden}`}</Text> : null}
    </>
  );
}
