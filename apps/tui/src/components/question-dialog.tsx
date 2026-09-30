/**
 * 提问面板（ADR-0032 §6 TUI）：pendingQuestion 出现时独占交互焦点，
 * 位置与权限确认框相同。键位：←/→ 或 Tab/Shift+Tab 切题；↑/↓ 移动焦点；
 * 单选 Enter 选中并进下一题；多选 Space 勾选、Enter 进下一题；
 * 「其他」/自由文本题直接输入文字；最后一题 Enter 进确认行，再 Enter 提交；
 * Esc 先退出文本输入，否则跳过整次提问（面板内的 Esc 不中断 Turn）。
 * 选中状态用 (o)/[x]/[ ] 与焦点符号 > 表示，不依赖颜色（窄终端/ASCII/NO_COLOR）。
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

import { glyphs, useTuiEnv } from "../env.js";
import { boxSafe, truncateLine } from "../format.js";
import { useTheme } from "../theme.js";

import type { PendingQuestion, QuestionItem } from "@nocturne/core/protocol";
import type { QuestionAnswer, QuestionReply } from "@nocturne/core";

/** 文本回答的长度上限（与 Core 回复校验一致） */
const TEXT_MAX = 2000;

/** 每题的回答草稿：selected 是已勾选选项 label，text 是「其他」/自由文本 */
interface Draft {
  selected: string[];
  text: string;
  /** 文本行是否正在捕获按键输入 */
  editing: boolean;
}

const hasOptions = (q: QuestionItem): boolean => (q.options?.length ?? 0) > 0;

/** 焦点行数：有选项时 = 选项 + 一行「其他」；无选项时只有一行文本框 */
const rowCount = (q: QuestionItem): number => (q.options?.length ?? 0) + 1;

const initialDrafts = (questions: readonly QuestionItem[]): Draft[] =>
  questions.map((q) => ({
    selected: [],
    text: "",
    // 无选项题只有文本框，打开即处于输入态
    editing: !hasOptions(q),
  }));

/** 草稿 → respondQuestion 的回复形状；空的 selected/text 表示该题没答 */
const toAnswers = (drafts: readonly Draft[]): QuestionAnswer[] =>
  drafts.map((d) => ({
    selected: [...d.selected],
    ...(d.text.trim() !== "" ? { text: d.text.trim() } : {}),
  }));

/** 单题回答的摘要文本（与逐行 CLI 同口径） */
function answerText(a: QuestionAnswer | undefined): string {
  const parts: string[] = [];
  if (a !== undefined && a.selected.length > 0) parts.push(a.selected.join("、"));
  if (a?.text !== undefined) parts.push(a.text);
  return parts.length > 0 ? parts.join("；") : "（未回答）";
}

/** 提交/跳过后的对话摘要（§6：每题一行「问题 → 回答」；跳过显示「已跳过」） */
export function questionSummary(questions: readonly QuestionItem[], reply: QuestionReply): string {
  if ("skipped" in reply) return "◇ 提问已跳过";
  const lines = questions.map((q, i) => `  ${q.question} → ${answerText(reply.answers[i])}`);
  return ["◇ 已提交回答：", ...lines].join("\n");
}

export function QuestionDialog({
  pending,
  active,
  onReply,
  width,
}: {
  pending: PendingQuestion;
  active: boolean;
  onReply: (reply: QuestionReply) => void;
  width: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>(() => initialDrafts(pending.questions));

  // 新请求到来时重置内部状态
  useEffect(() => {
    setIndex(0);
    setFocus(0);
    setConfirm(false);
    setDrafts(initialDrafts(pending.questions));
  }, [pending.requestId, pending.questions]);

  const total = pending.questions.length;
  const q = pending.questions[index];
  const opts = q?.options ?? [];
  const draft = drafts[index];
  const updateDraft = (patch: Partial<Draft>): void => {
    setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };
  /** 当前题答完：还有下一题则翻页，否则进确认行 */
  const advance = (): void => {
    if (index < total - 1) {
      setIndex(index + 1);
      setFocus(0);
    } else {
      setConfirm(true);
    }
  };
  const switchQuestion = (delta: number): void => {
    if (total <= 1) return;
    setIndex((i) => (i + delta + total) % total);
    setFocus(0);
  };
  /** 文本行追加输入（受 2000 字符上限约束） */
  const appendText = (d: Draft, input: string): void => {
    const next = d.text + input;
    if (Array.from(next).length <= TEXT_MAX) {
      updateDraft({ editing: true, text: next });
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        // Esc：正在输入文本时先退出输入，否则跳过整次提问（面板内的 Esc 不中断 Turn）
        if (draft?.editing === true) {
          updateDraft({ editing: false });
          return;
        }
        onReply({ skipped: true });
        return;
      }
      if (confirm) {
        if (key.return) {
          onReply({ answers: toAnswers(drafts) });
          return;
        }
        // 确认行只允许返回上一题；其余键忽略
        if (key.leftArrow || (key.tab && key.shift)) setConfirm(false);
        return;
      }
      if (q === undefined || draft === undefined) return;

      if (draft.editing) {
        // 文本输入中：Enter 确认并进下一题；Backspace/Delete 删字；其余字符追加
        if (key.return) {
          updateDraft({ editing: false });
          advance();
          return;
        }
        if (key.backspace || key.delete) {
          updateDraft({ text: Array.from(draft.text).slice(0, -1).join("") });
          return;
        }
        if (!key.ctrl && !key.meta && !key.tab && input !== "") appendText(draft, input);
        return;
      }

      // 题间切换：←/→ 或 Tab/Shift+Tab
      if (key.leftArrow || (key.tab && key.shift)) {
        switchQuestion(-1);
        return;
      }
      if (key.rightArrow || (key.tab && !key.shift)) {
        switchQuestion(1);
        return;
      }

      const onTextRow = focus >= opts.length;
      if (key.upArrow) {
        setFocus((f) => (f + rowCount(q) - 1) % rowCount(q));
        return;
      }
      if (key.downArrow) {
        setFocus((f) => (f + 1) % rowCount(q));
        return;
      }
      if (key.return) {
        if (opts.length > 0 && !onTextRow) {
          // 单选选中并前进；多选直接进下一题（勾选用 Space）
          const label = opts[focus]?.label;
          if (q.multiSelect !== true && label !== undefined) {
            updateDraft({ selected: [label] });
          }
          advance();
          return;
        }
        // 焦点在文本行：Enter 开始输入
        updateDraft({ editing: true });
        return;
      }
      if (input === " " && !key.ctrl && !key.meta) {
        if (opts.length > 0 && !onTextRow) {
          // Space 勾选/取消（仅多选）
          if (q.multiSelect === true) {
            const label = opts[focus]?.label;
            if (label !== undefined) {
              updateDraft({
                selected: draft.selected.includes(label)
                  ? draft.selected.filter((l) => l !== label)
                  : [...draft.selected, label],
              });
            }
          }
          return;
        }
        // 文本行上的空格按普通字符处理
        appendText(draft, " ");
        return;
      }
      // 焦点在文本行时直接输入即开始编辑；选项行上的普通字符忽略
      if (!key.ctrl && !key.meta && !key.tab && input !== "" && onTextRow) {
        appendText(draft, input);
      }
    },
    { isActive: active },
  );

  const narrow = width < 40;
  const hint = confirm
    ? "Enter 提交；←/Shift+Tab 返回；Esc 跳过"
    : draft?.editing === true
      ? "输入回答  Enter 确认  Esc 退出输入"
      : opts.length > 0
        ? q?.multiSelect === true
          ? `↑/↓ 移动  Space 勾选  Enter 下一题${total > 1 ? "  ←/→/Tab 切题" : ""}  Esc 跳过`
          : `↑/↓ 移动  Enter 选择${total > 1 ? "  ←/→/Tab 切题" : ""}  Esc 跳过`
        : `输入回答  Enter 确认${total > 1 ? "  ←/→/Tab 切题" : ""}  Esc 跳过`;

  /** 文本输入行：有选项题标「其他」，自由文本题标「回答」 */
  const textRow = (d: Draft, label: string): React.JSX.Element => (
    <Text wrap="truncate" color={theme.selected} backgroundColor={theme.selectionBg}>
      {`> [${label}] ${
        d.editing ? `${boxSafe(d.text)}_` : d.text !== "" ? boxSafe(d.text) : "（直接输入）"
      }`}
    </Text>
  );

  return (
    <Box
      flexDirection="column"
      borderStyle={env.ascii ? "single" : "round"}
      borderColor={theme.border}
      backgroundColor={theme.overlayBg}
    >
      <Text bold color={theme.warning}>
        {g.wait} 提问
      </Text>
      {confirm ? (
        <Box flexDirection="column">
          <Text dimColor>确认回答：</Text>
          {pending.questions.map((qq, i) => (
            <Text key={qq.question} wrap="truncate">
              {truncateLine(
                boxSafe(`  ${qq.question} → ${answerText(toAnswers(drafts)[i])}`),
                width - 4,
                g.ellipsis,
              )}
            </Text>
          ))}
        </Box>
      ) : q === undefined || draft === undefined ? (
        <Text dimColor>…</Text>
      ) : (
        <Box flexDirection="column">
          {q.header !== undefined || total > 1 ? (
            <Text dimColor wrap="truncate">
              {q.header !== undefined ? `[${boxSafe(q.header)}] ` : ""}
              {total > 1 ? `第 ${index + 1}/${total} 题` : ""}
            </Text>
          ) : null}
          <Text wrap="truncate">{truncateLine(boxSafe(q.question), width - 4, g.ellipsis)}</Text>
          {opts.length > 0 ? (
            <>
              {opts.map((o, i) => {
                const sel = draft.selected.includes(o.label);
                const mark = q.multiSelect === true ? (sel ? "[x]" : "[ ]") : sel ? "(o)" : "( )";
                const desc = !narrow && o.description !== undefined ? ` - ${o.description}` : "";
                return (
                  <Text
                    key={o.label}
                    wrap="truncate"
                    {...(i === focus
                      ? { color: theme.selected, backgroundColor: theme.selectionBg }
                      : {})}
                  >
                    {truncateLine(
                      `${i === focus ? ">" : " "} ${mark} ${boxSafe(o.label)}${boxSafe(desc)}`,
                      width - 4,
                      g.ellipsis,
                    )}
                  </Text>
                );
              })}
              {focus === opts.length ? (
                textRow(draft, "其他")
              ) : (
                <Text wrap="truncate">{`  [其他] ${boxSafe(draft.text)}`}</Text>
              )}
            </>
          ) : (
            textRow(draft, "回答")
          )}
        </Box>
      )}
      <Text dimColor wrap="truncate">
        {hint}
      </Text>
    </Box>
  );
}
