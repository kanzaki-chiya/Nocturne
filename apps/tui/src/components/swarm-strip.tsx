/**
 * Swarm 状态块（tui.md §2）：输入框下方、状态栏上方。首行 `◆ 标题  #n 作者: 首行  N 条`，
 * 其下每行一名 working / paused / 待确认成员：状态点、对齐的名字、淡色模型名、活动摘要。
 * Swarm 不存在或已结束时不渲染。
 */
import { Text } from "ink";
import stringWidth from "string-width";

import type { SwarmMemberView, SwarmView } from "@nocturne/core/protocol";

import { glyphs, useTuiEnv } from "../env.js";
import { padToWidth, truncateLine } from "../format.js";
import {
  firstLine,
  shortModelName,
  swarmActivityText,
  swarmAuthorLabel,
  swarmStripMembers,
} from "../text-format-swarm.js";
import { useTheme } from "../theme.js";

/** 状态块希望占的行数：首行 + 每名列出的成员；Swarm 不活动时为 0 */
export function swarmStripRows(swarm: SwarmView | undefined): number {
  if (swarm?.status !== "active") return 0;
  return 1 + swarmStripMembers(swarm).length;
}

export function SwarmStrip({
  swarm,
  width,
  height,
}: {
  swarm: SwarmView;
  width: number;
  height: number;
}): React.JSX.Element | null {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  if (swarm.status !== "active" || height <= 0) return null;
  const inner = Math.max(1, width - 1);
  const members = swarmStripMembers(swarm);
  const room = height - 1;
  // 放不下全部成员时最后一行写 `+N`
  const overflow = members.length > room;
  const shown = overflow ? members.slice(0, Math.max(0, room - 1)) : members;
  const hidden = members.length - shown.length;

  const mark = env.ascii ? "*" : "◆";
  const title = truncateLine(swarm.title || "合奏", Math.max(4, Math.floor(inner / 3)), g.ellipsis);
  const count = `${swarm.posts.length} 条`;
  const last = swarm.posts.at(-1);
  const head = `${mark} ${title}`;
  const fixed = stringWidth(head) + 2 + stringWidth(count) + 2;
  const latest =
    last === undefined
      ? ""
      : truncateLine(
          `#${last.number} ${swarmAuthorLabel(last.from, last.fromKind)}: ${firstLine(last.text)}`,
          Math.max(0, inner - fixed),
          g.ellipsis,
        );
  const gap = Math.max(1, inner - stringWidth(head) - 2 - stringWidth(latest) - stringWidth(count));

  const nameW = Math.max(0, ...members.map((m) => stringWidth(m.name)));
  const modelW = Math.max(0, ...members.map((m) => stringWidth(shortModelName(m.model))));
  const row = (m: SwarmMemberView): React.JSX.Element => {
    const attention = m.status === "paused" || m.pendingPermissions.length > 0;
    const prefix = `  ${g.dot} ${padToWidth(m.name, nameW)}  ${padToWidth(shortModelName(m.model), modelW)}  `;
    const activity = truncateLine(
      swarmActivityText(m.activity),
      Math.max(0, inner - stringWidth(prefix)),
      g.ellipsis,
    );
    return (
      <Text key={m.name} wrap="truncate">
        {"  "}
        <Text color={attention ? theme.warning : theme.accent}>{g.dot}</Text>
        {` ${padToWidth(m.name, nameW)}  `}
        <Text color={theme.muted}>{padToWidth(shortModelName(m.model), modelW)}</Text>
        {`  ${activity}`}
      </Text>
    );
  };

  return (
    <>
      <Text wrap="truncate">
        <Text color={theme.accent}>{head}</Text>
        {"  "}
        {latest}
        {" ".repeat(gap)}
        <Text color={theme.muted}>{count}</Text>
      </Text>
      {shown.map(row)}
      {overflow ? <Text color={theme.muted}>{`  +${hidden}`}</Text> : null}
    </>
  );
}
