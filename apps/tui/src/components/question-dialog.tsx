/** 提问面板：逐题回答或拒绝，焦点行始终保留在高度窗口内。 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { glyphs, useTuiEnv } from "../env.js";
import { boxSafe, truncateLine, truncateLineHead } from "../format.js";
import { wrap } from "../lines.js";
import { useTheme } from "../theme.js";
import type { PendingQuestion } from "@nocturne/core/protocol";
import type { QuestionAnswer, QuestionReply } from "@nocturne/core";

/** 行内占位标记：渲染时替换为反色光标块 / 灰色占位文字 */
const OTHER_CURSOR = "cursor";
const OTHER_PLACEHOLDER = "placeholder";

interface Draft {
  selected: string[];
  text: string;
  declined: boolean;
  editing: boolean;
}
const toAnswers = (drafts: readonly Draft[]): QuestionAnswer[] =>
  drafts.map((d) =>
    d.declined
      ? { declined: true }
      : { selected: d.selected, ...(d.text.trim() ? { text: d.text.trim() } : {}) },
  );
function answerText(a: QuestionAnswer): string {
  return "declined" in a
    ? "拒绝回答"
    : [...a.selected, ...(a.text ? [a.text] : [])].join("、") || "（未回答）";
}
/** 问题正文在弹窗内折行后的各行；wrap 已按边框和内边距留出 4 列。 */
function questionRows(question: string, width: number): string[] {
  return wrap(question, width).map((line) => line.text);
}
/** 确认页：问题和回答各自折行，窄窗口下回答不会被截在问题行尾部。 */
function confirmRows(
  pending: PendingQuestion,
  answers: readonly QuestionAnswer[],
  width: number,
): string[] {
  return [
    "确认回答：",
    ...pending.questions.flatMap((qq, i) => [
      ...questionRows(qq.question, width),
      ...questionRows("→ " + answerText(answers[i] ?? { selected: [] }), width),
    ]),
  ];
}
export function questionDialogRows(
  pending: PendingQuestion,
  width: number,
  index = 0,
  confirm = false,
  answers: readonly QuestionAnswer[] = [],
): number {
  if (confirm) return confirmRows(pending, answers, width).length + 4;
  const q = pending.questions[index];
  return (
    (q?.options?.length ?? 0) +
    6 +
    questionRows(q?.question ?? "", width).length +
    (q?.header !== undefined || pending.questions.length > 1 ? 1 : 0)
  );
}
export function QuestionDialog({
  pending,
  active,
  onReply,
  width,
  height,
  onPageChange,
  onEscape,
}: {
  pending: PendingQuestion;
  active: boolean;
  onReply: (reply: QuestionReply) => void;
  width: number;
  height?: number;
  onPageChange?: (index: number, confirm: boolean, answers: QuestionAnswer[]) => void;
  onEscape?: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const g = glyphs(env);
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState(0);
  const [confirm, setConfirm] = useState(false);
  // 从焦点所在窗口往上翻的行数；移动焦点或切题后回到焦点
  const [peek, setPeek] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    pending.questions.map((q) => ({
      selected: [],
      text: "",
      declined: false,
      editing: !q.options?.length,
    })),
  );
  // 新提问由调用方按 requestId 作 key 重新挂载，这里不再用 effect 重置状态
  const q = pending.questions[index];
  const opts = q?.options ?? [];
  const draft = drafts[index];
  const update = (patch: Partial<Draft>): Draft[] => {
    const next = drafts.map((d, i) => (i === index ? { ...d, ...patch } : d));
    setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...patch } : d)));
    return next;
  };
  const page = (next: number, confirmation = false, current = drafts): void => {
    setIndex(next);
    setConfirm(confirmation);
    setFocus(0);
    setPeek(0);
    // 带上答案：确认页按折行后的行数算高度
    onPageChange?.(next, confirmation, toAnswers(current));
  };
  const advance = (current = drafts): void => {
    page(
      Math.min(index + 1, pending.questions.length - 1),
      index === pending.questions.length - 1,
      current,
    );
  };
  useInput(
    (input, key) => {
      if (key.escape) {
        if (!confirm && draft?.editing) update({ editing: false });
        else onEscape?.();
        return;
      }
      if (key.pageUp || key.pageDown) {
        setPeek((p) =>
          Math.max(0, Math.min(focusStart, p + (key.pageUp ? 1 : -1) * Math.max(1, capacity - 1))),
        );
        return;
      }
      if (key.leftArrow || (key.tab && key.shift)) {
        page(confirm ? index : Math.max(0, index - 1));
        return;
      }
      if (key.rightArrow || key.tab) {
        advance();
        return;
      }
      if (confirm) {
        if (key.return) onReply({ answers: toAnswers(drafts) });
        return;
      }
      if (!q || !draft) return;
      if (key.upArrow || key.downArrow) {
        update({ editing: false });
        setPeek(0);
        setFocus((f) => (f + (key.upArrow ? opts.length + 1 : 1)) % (opts.length + 2));
        return;
      }
      const other = focus === opts.length;
      const decline = focus === opts.length + 1;
      if (key.return) {
        advance(
          q.multiSelect === true
            ? update({ editing: false })
            : decline
              ? update({ declined: true, selected: [], text: "", editing: false })
              : !other && opts[focus]
                ? update({
                    declined: false,
                    selected: [opts[focus].label],
                    text: "",
                    editing: false,
                  })
                : update({ declined: false, editing: false }),
        );
        return;
      }
      if (input === " " && q.multiSelect === true && !other && !key.ctrl && !key.meta) {
        if (decline) update({ declined: !draft.declined, selected: [], text: "", editing: false });
        else {
          const label = opts[focus]?.label;
          if (label === undefined) return;
          update({
            declined: false,
            selected: draft.selected.includes(label)
              ? draft.selected.filter((l) => l !== label)
              : [...draft.selected, label],
          });
        }
        return;
      }
      if (other && (key.backspace || key.delete)) {
        update({
          text: Array.from(draft.text).slice(0, -1).join(""),
          editing: true,
          declined: false,
        });
        return;
      }
      if (other && !key.ctrl && !key.meta && input && Array.from(draft.text + input).length <= 2000)
        update({
          text: draft.text + input,
          editing: true,
          declined: false,
          ...(q.multiSelect === true ? {} : { selected: [] }),
        });
    },
    { isActive: active },
  );
  const answers = toAnswers(drafts);
  // 「其他」行与选项同格式：标记 + 标签，输入后标签变为「其他：」并紧跟文本；
  // 光标另画反色块（不用下划线），见渲染处 OTHER_CURSOR 标记
  const otherFilled = draft !== undefined && !draft.declined && draft.text.trim() !== "";
  const otherMark = !opts.length
    ? ""
    : (q?.multiSelect
        ? otherFilled
          ? "[x]"
          : "[ ]"
        : otherFilled && draft.selected.length === 0
          ? "(o)"
          : "( )") + " ";
  const otherLabel = opts.length ? "其他" : "回答";
  const otherRow =
    (focus === opts.length ? ">" : " ") +
    " " +
    otherMark +
    (draft?.editing || draft?.text
      ? otherLabel + "：" + draft.text + (draft.editing ? OTHER_CURSOR : "")
      : opts.length
        ? "其他（自己输入）"
        : "回答：" + OTHER_PLACEHOLDER);
  const rows: string[] = confirm
    ? confirmRows(pending, answers, width)
    : [
        ...(q?.header !== undefined || pending.questions.length > 1
          ? [
              `${q?.header ? "[" + q.header + "] " : ""}第 ${index + 1}/${pending.questions.length} 题`,
            ]
          : []),
        ...questionRows(q?.question ?? "", width),
        ...opts.map(
          (o, i) =>
            (i === focus ? ">" : " ") +
            " " +
            (q?.multiSelect
              ? draft?.selected.includes(o.label)
                ? "[x]"
                : "[ ]"
              : draft?.selected.includes(o.label)
                ? "(o)"
                : "( )") +
            " " +
            o.label +
            (width >= 40 && o.description ? " - " + o.description : ""),
        ),
        otherRow,
        (focus === opts.length + 1 ? ">" : " ") +
          " " +
          (q?.multiSelect ? (draft?.declined ? "[x]" : "[ ]") : draft?.declined ? "(o)" : "( )") +
          " 拒绝回答",
      ];
  const h = height ?? questionDialogRows(pending, width, index, confirm, answers);
  const bordered = h >= 3;
  const room = Math.max(0, h - (bordered ? 2 : 0));
  const titleRows = room >= 3 ? 1 : 0;
  const hintRows = room >= 3 ? 1 : 0;
  const capacity = Math.max(0, room - titleRows - hintRows);
  const focusedRow = confirm ? rows.length - 1 : rows.length - (opts.length + 2) + focus;
  const focusStart = Math.max(0, Math.min(rows.length - capacity, focusedRow - capacity + 1));
  const start = Math.max(0, focusStart - peek);
  const hint = confirm
    ? "Enter 提交  ←/Shift+Tab 返回  Esc 中断"
    : draft?.editing
      ? "输入回答  Enter 下一题  Esc 退出输入"
      : q?.multiSelect
        ? "↑/↓ 移动  Space 勾选  Enter 下一题  ←/→/Tab 切题  Esc 中断"
        : "↑/↓ 移动  Enter 选中并下一题  ←/→/Tab 切题  Esc 中断";
  const renderRow = (row: string, room: number): React.ReactNode => {
    if (row.endsWith(OTHER_PLACEHOLDER)) {
      const head = row.slice(0, -OTHER_PLACEHOLDER.length);
      return (
        <>
          {truncateLine(boxSafe(head), room, g.ellipsis)}
          <Text dimColor>在此输入</Text>
        </>
      );
    }
    if (row.endsWith(OTHER_CURSOR)) {
      // 输入中：超宽时截掉头部，保留正在输入的尾部，并给光标留一格
      const head = row.slice(0, -OTHER_CURSOR.length);
      return (
        <>
          {truncateLineHead(boxSafe(head), Math.max(1, room - 1), g.ellipsis)}
          <Text inverse> </Text>
        </>
      );
    }
    return truncateLine(boxSafe(row), room, g.ellipsis);
  };
  return (
    <Box
      flexDirection="column"
      height={h}
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
      {titleRows ? (
        <Text wrap="truncate" bold color={theme.warning}>
          {g.wait} 提问
        </Text>
      ) : null}
      {rows.slice(start, start + capacity).map((row, i) => (
        <Text
          key={i}
          wrap="truncate"
          {...(start + i === focusedRow
            ? { color: theme.selected, backgroundColor: theme.selectionBg }
            : {})}
        >
          {renderRow(row, Math.max(1, width - 4))}
        </Text>
      ))}
      {hintRows ? (
        <Text dimColor wrap="truncate">
          {truncateLine(boxSafe(hint), Math.max(1, width - 4), g.ellipsis)}
        </Text>
      ) : null}
    </Box>
  );
}
