/**
 * 权限对话框（tui.md §3）：pendingPermission 出现时独占交互焦点。
 * 五键 a/s/p/d/x；d 先进反馈行——Enter 发送拒绝（空 = 不带反馈），
 * Esc 退回五选项；Tab/Shift+Tab 在选项间正向/反向移动焦点，Enter 激活焦点项。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";

import { glyphs, useTuiEnv } from "../env.js";
import { boxSafe, truncateLine, truncateMiddle } from "../format.js";
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
  deny_stop: "拒绝并停止本 Turn",
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

/** 固定单行标题、主体、可选原因、选项、提示与边框，无渲染后测量。 */
export function permissionDialogRows(pending: PendingPermission, width: number): number {
  return (
    6 +
    pending.subjects.filter((s) => s.detail !== undefined).length +
    (pending.reason !== "" && width >= 40 ? 1 : 0)
  );
}

export function PermissionDialog({
  pending,
  active,
  onReply,
  width,
  height,
  onEscape,
}: {
  pending: PendingPermission;
  active: boolean;
  onReply: (reply: PermissionReply) => void;
  width: number;
  height?: number;
  onEscape?: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const opts = optionsOf(pending);
  const [focus, setFocus] = useState(0);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

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
  const rows = [
    `${g.wait} 需要确认`,
    subjectText(pending),
    ...pending.subjects.flatMap((s) =>
      s.detail === undefined ? [] : [truncateMiddle(s.detail, Math.max(1, width - 4), g.ellipsis)],
    ),
    ...(pending.reason !== "" && !narrow ? [`原因：${pending.reason}`] : []),
    feedback !== undefined
      ? `d${g.prompt} ${feedback}_`
      : opts.map((o, i) => `${i === focus ? ">" : ""}[${o.key}] ${o.label}`).join("  "),
    feedback !== undefined
      ? "Enter 发送拒绝（空 = 不带反馈）；Esc 返回"
      : "Tab/Shift+Tab 选择  Enter 确认  Esc 中断",
  ];
  if (height !== undefined) {
    const bordered = height >= 3;
    const capacity = Math.max(0, height - (bordered ? 2 : 0));
    const start = capacity === 1 ? rows.length - 2 : Math.max(0, rows.length - capacity);
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
        {rows.slice(start, start + capacity).map((row, i) => (
          <Text key={i} wrap="truncate">
            {truncateLine(
              boxSafe(
                start + i === rows.length - 2 &&
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
        s.detail === undefined
          ? []
          : [
              <Text key={`detail:${i}`} wrap="truncate">
                {truncateMiddle(s.detail, Math.max(1, width - 8), g.ellipsis)}
              </Text>,
            ],
      )}
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
