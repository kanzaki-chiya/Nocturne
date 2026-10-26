/**
 * 权限对话框（tui.md §3）：pendingPermission 出现时独占交互焦点。
 * 五键 a/s/p/d/x；d 先进反馈行——Enter 发送拒绝（空 = 不带反馈），
 * Esc 退回五选项；Tab/Shift+Tab 在选项间正向/反向移动焦点，Enter 激活焦点项。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";

import { glyphs, useTuiEnv } from "../env.js";
import {
  boxSafe,
  permissionReviewLine,
  stripControls,
  truncateLine,
  truncateMiddle,
} from "../format.js";
import { useTheme } from "../theme.js";

import type { PendingPermission, PermissionOption } from "@nocturne/core/protocol";
import type { PermissionReply } from "@nocturne/core";

interface Option {
  option: PermissionOption;
  key: string;
  label: string;
  reply: PermissionReply;
}

/** 与 CLI render.ts 同口径的键位/文案映射（cli.md §6） */
const OPTION_KEYS: Record<PermissionOption, string> = {
  allow_once: "a",
  allow_session: "s",
  allow_project: "p",
  deny: "d",
  deny_stop: "x",
};
const OPTION_LABELS: Record<PermissionOption, string> = {
  allow_once: "允许一次",
  allow_session: "本会话内允许",
  allow_project: "在此项目中始终允许",
  deny: "拒绝（可附反馈）",
  deny_stop: "拒绝并停止本轮",
};
const OPTION_REPLIES: Record<PermissionOption, PermissionReply> = {
  allow_once: { decision: "allow" },
  allow_session: { decision: "allow", remember: "session" },
  allow_project: { decision: "allow", remember: "project" },
  deny: { decision: "deny" },
  deny_stop: { decision: "deny", stop: true },
};

function optionsOf(pending: PendingPermission): Option[] {
  const list: readonly PermissionOption[] =
    pending.options.length > 0 ? pending.options : ["allow_once", "deny"];
  return list.map((option) => ({
    option,
    key: OPTION_KEYS[option],
    label:
      option === "allow_session" && pending.subjects.some((s) => s.kind === "network")
        ? `本会话允许访问 ${pending.subjects
            .filter((s) => s.kind === "network")
            .map((s) => s.target)
            .join("、")}`
        : OPTION_LABELS[option],
    reply: OPTION_REPLIES[option],
  }));
}

function subjectText(pending: PendingPermission): string {
  return pending.subjects
    .map((s) => {
      const resolved =
        s.resolved !== undefined && s.resolved !== s.target ? ` → ${s.resolved}` : "";
      return `${s.kind}: ${s.target}${resolved}`;
    })
    .join("；");
}

/** schedule 主体的多行 detail 折叠到这么多行；超出的按 e 展开（ADR-0064） */
const SCHEDULE_FOLD_ROWS = 10;

/** 按显示宽度硬换行（空行保留）；detail 来自模型，先去掉终端控制序列 */
function wrapRow(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of Array.from(boxSafe(stripControls(text).replace(/\t/g, "  ")))) {
    const cw = stringWidth(ch);
    if (w + cw > width && line !== "") {
      out.push(line);
      line = "";
      w = 0;
    }
    line += ch;
    w += cw;
  }
  out.push(line);
  return out;
}

/**
 * schedule 主体的 detail 是多行纯文本（名称、计划、工作区、模型 · 档位 · 权限、指令全文）：
 * 逐行换行显示，不截断。超过折叠行数时默认折叠，`expanded` 为真则给全文。
 */
export function scheduleDetailRows(
  pending: PendingPermission,
  width: number,
  expanded: boolean,
): { rows: string[]; foldable: boolean } {
  const all = pending.subjects
    .filter((s) => s.kind === "schedule" && s.detail !== undefined)
    .flatMap((s) =>
      (s.detail ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .flatMap((line) => wrapRow(line, Math.max(1, width - 4))),
    );
  if (all.length <= SCHEDULE_FOLD_ROWS) return { rows: all, foldable: false };
  if (expanded) return { rows: [...all, "（按 e 折叠）"], foldable: true };
  return {
    rows: [
      ...all.slice(0, SCHEDULE_FOLD_ROWS),
      `… 还有 ${all.length - SCHEDULE_FOLD_ROWS} 行（按 e 展开）`,
    ],
    foldable: true,
  };
}

/** 固定单行标题、主体、可选原因、选项、提示与边框，无渲染后测量。 */
export function permissionDialogRows(
  pending: PendingPermission,
  width: number,
  expanded = false,
): number {
  return (
    6 +
    pending.subjects.filter((s) => s.detail !== undefined && s.kind !== "schedule").length +
    scheduleDetailRows(pending, width, expanded).rows.length +
    (pending.reason !== "" && width >= 40 ? 1 : 0) +
    (pending.review ? 1 : 0)
  );
}

export function PermissionDialog({
  pending,
  active,
  onReply,
  width,
  height,
  onEscape,
  expanded = false,
  onToggleExpanded,
}: {
  pending: PendingPermission;
  active: boolean;
  onReply: (reply: PermissionReply) => void;
  width: number;
  height?: number;
  onEscape?: () => void;
  /** schedule 主体的长 detail 是否展开（状态在 app 里，行数据此预留高度） */
  expanded?: boolean;
  onToggleExpanded?: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const opts = optionsOf(pending);
  const [focus, setFocus] = useState(0);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  const schedule = scheduleDetailRows(pending, width, expanded);

  useInput(
    (input, key) => {
      if (feedback !== undefined) {
        // 反馈行：Enter 发送拒绝（空 = 不带反馈），Esc 退回五选项
        if (key.escape) {
          setFeedback(undefined);
          return;
        }
        if (key.return) {
          const text = feedback.trim();
          onReply({
            decision: "deny",
            ...(text !== "" ? { feedback: text } : {}),
          });
          return;
        }
        if (key.backspace || key.delete) {
          setFeedback(feedback.slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && input !== "") setFeedback(feedback + input);
        return;
      }
      if (key.escape) {
        onEscape?.();
        return;
      }
      // 长 detail：e 展开/折叠；展开后内容超出高度时 ↑/↓ 滚动
      if (input === "e" && schedule.foldable && onToggleExpanded !== undefined) {
        setScroll(0);
        onToggleExpanded();
        return;
      }
      if (key.upArrow) {
        setScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setScroll((s) => s + 1);
        return;
      }
      if (key.tab) {
        // Shift+Tab = 反向移动焦点（不切换思考档位；ADR-0018）
        setFocus((f) => (f + (key.shift ? opts.length - 1 : 1)) % opts.length);
        return;
      }
      if (key.return) {
        const opt = opts[focus];
        if (opt === undefined) return;
        if (opt.option === "deny") setFeedback("");
        else onReply(opt.reply);
        return;
      }
      const lower = input.toLowerCase();
      const opt = opts.find((o) => o.key === lower);
      if (opt === undefined) return;
      if (opt.option === "deny") setFeedback("");
      else onReply(opt.reply);
    },
    { isActive: active },
  );

  const narrow = width < 40;
  const headRows = [
    `${g.wait} 需要确认`,
    subjectText(pending),
    ...pending.subjects.flatMap((s) =>
      s.detail === undefined || s.kind === "schedule"
        ? []
        : [truncateMiddle(s.detail, Math.max(1, width - 4), g.ellipsis)],
    ),
    ...schedule.rows,
    ...(pending.review ? [permissionReviewLine(pending.review)] : []),
    ...(pending.reason !== "" && !narrow ? [`原因：${pending.reason}`] : []),
  ];
  const bordered = height !== undefined && height >= 3;
  const capacity = height === undefined ? 0 : Math.max(0, height - (bordered ? 2 : 0));
  // 有 schedule 详情且放不下：选项与提示固定在底部，上面的内容可用 ↑/↓ 滚动（从头开始看）；
  // 其余情况沿用旧行为——放不下时保留尾部，选项始终可见
  const scrolling =
    height !== undefined &&
    schedule.rows.length > 0 &&
    headRows.length + 2 > capacity &&
    capacity > 3;
  const hints = [
    "Tab/Shift+Tab 选择  Enter 确认  Esc 中断",
    ...(schedule.foldable ? ["e 展开/折叠"] : []),
    ...(scrolling ? ["↑/↓ 滚动"] : []),
  ].join("  ");
  const tailRows = [
    feedback !== undefined
      ? `d${g.prompt} ${feedback}_`
      : opts.map((o, i) => `${i === focus ? ">" : ""}[${o.key}] ${o.label}`).join("  "),
    feedback !== undefined ? "Enter 发送拒绝（空 = 不带反馈）；Esc 返回" : hints,
  ];
  const rows = [...headRows, ...tailRows];
  if (height !== undefined) {
    const bodyCapacity = capacity - tailRows.length;
    const maxScroll = Math.max(0, headRows.length - bodyCapacity);
    const offset = Math.min(scroll, maxScroll);
    const start = capacity === 1 ? rows.length - 2 : Math.max(0, rows.length - capacity);
    const shown = scrolling
      ? [...headRows.slice(offset, offset + bodyCapacity), ...tailRows]
      : rows.slice(start, start + capacity);
    const optionsRowIndex = scrolling ? bodyCapacity : rows.length - 2 - start;
    const focused = opts[focus];
    return (
      <Box
        flexDirection="column"
        height={height}
        flexShrink={0}
        overflow="hidden"
        {...(bordered
          ? {
              borderStyle: env.ascii ? ("single" as const) : ("round" as const),
              borderColor: theme.border,
            }
          : {})}
        backgroundColor={theme.overlayBg}
      >
        {shown.map((row, i) => (
          <Text key={i} wrap="truncate">
            {truncateLine(
              boxSafe(
                i === optionsRowIndex &&
                  feedback === undefined &&
                  focused !== undefined &&
                  stringWidth(
                    boxSafe(
                      row.slice(
                        0,
                        row.indexOf(`>[${focused.key}]`) +
                          `>[${focused.key}] ${focused.label}`.length,
                      ),
                    ),
                  ) >
                    width - 4
                  ? `>[${focused.key}] ${focused.label}`
                  : row,
              ),
              Math.max(1, width - 4),
              g.ellipsis,
            )}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle={env.ascii ? "single" : "round"}
      borderColor={theme.border}
      backgroundColor={theme.overlayBg}
    >
      <Text bold color={theme.warning}>
        {g.wait} 需要确认
      </Text>
      <Text wrap="truncate">
        {truncateLine(boxSafe(subjectText(pending)), width - 8, g.ellipsis)}
      </Text>
      {pending.subjects.flatMap((s, i) =>
        s.detail === undefined || s.kind === "schedule"
          ? []
          : [
              <Text key={`detail:${i}`} wrap="truncate">
                {truncateMiddle(s.detail, Math.max(1, width - 8), g.ellipsis)}
              </Text>,
            ],
      )}
      {schedule.rows.map((row, i) => (
        <Text key={`schedule:${i}`} wrap="truncate">
          {row}
        </Text>
      ))}
      {pending.review ? (
        <Text dimColor wrap="truncate">
          {truncateLine(boxSafe(permissionReviewLine(pending.review)), width - 8, g.ellipsis)}
        </Text>
      ) : null}
      {pending.reason !== "" && !narrow ? (
        <Text dimColor wrap="truncate">
          {truncateLine(boxSafe(`原因：${pending.reason}`), width - 8, g.ellipsis)}
        </Text>
      ) : null}
      {feedback !== undefined ? (
        <Text>
          <Text color={theme.warning}>d{g.prompt} </Text>
          {boxSafe(feedback)}
          <Text color={theme.selected} backgroundColor={theme.selectionBg}>
            {" "}
          </Text>
        </Text>
      ) : narrow ? (
        <Text wrap="truncate">{opts.map((o) => `[${o.key}]${o.label}`).join(" ")}</Text>
      ) : (
        <Box>
          {opts.map((o, i) => (
            <Text
              key={o.key}
              {...(i === focus
                ? { color: theme.selected, backgroundColor: theme.selectionBg }
                : {})}
            >
              {` [${o.key}] ${o.label} `}
            </Text>
          ))}
        </Box>
      )}
      {feedback !== undefined ? (
        <Text dimColor>Enter 发送拒绝（空 = 不带反馈）；Esc 返回</Text>
      ) : null}
    </Box>
  );
}
