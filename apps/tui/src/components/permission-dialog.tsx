/**
 * 权限对话框（tui.md §3）：pendingPermission 出现时独占交互焦点。
 * 五键 a/s/p/d/x；d 先进反馈行——Enter 发送拒绝（空 = 不带反馈），
 * Esc 退回五选项；Tab 在选项间移动焦点，Enter 激活焦点项。
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

import { glyphs, useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";

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
    label: OPTION_LABELS[option],
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

export function PermissionDialog({
  pending,
  active,
  onReply,
  width,
}: {
  pending: PendingPermission;
  active: boolean;
  onReply: (reply: PermissionReply) => void;
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const g = glyphs(env);
  const opts = optionsOf(pending);
  const [focus, setFocus] = useState(0);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);

  // 新请求到来时重置内部状态
  useEffect(() => {
    setFocus(0);
    setFeedback(undefined);
  }, [pending.requestId]);

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
      if (key.tab) {
        setFocus((f) => (f + 1) % opts.length);
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
  return (
    <Box flexDirection="column" borderStyle={env.ascii ? "single" : "round"} borderColor="yellow">
      <Text bold color="yellow">
        {g.wait} 需要确认
      </Text>
      <Text wrap="truncate">{truncateLine(subjectText(pending), width - 4, g.ellipsis)}</Text>
      {pending.reason !== "" && !narrow ? (
        <Text dimColor wrap="truncate">
          {truncateLine(`原因：${pending.reason}`, width - 4, g.ellipsis)}
        </Text>
      ) : null}
      {feedback !== undefined ? (
        <Text>
          <Text color="yellow">d{g.prompt} </Text>
          {feedback}
          <Text inverse> </Text>
        </Text>
      ) : narrow ? (
        <Text wrap="truncate">{opts.map((o) => `[${o.key}]${o.label}`).join(" ")}</Text>
      ) : (
        <Box>
          {opts.map((o, i) => (
            <Text key={o.key} inverse={i === focus} {...(i === focus ? { color: "cyan" } : {})}>
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
