/**
 * Provider 向导视图（provider-setup.md 第 6 节；ADR-0019 第 4 条）：
 * 渲染 useProviderWizard 的状态，omp 风格就地表单——
 * 已完成步骤折叠为一行 "a • b • c" 摘要；当前步骤用强调色提问、
 * 灰色小字说明（hint）；瞬时进度行（busyText）随结果被覆盖；
 * 不堆叠逐行问答历史。secret 提示回显 *。Enter 提交、Esc 取消。
 * prompt.multi = 多选勾选（思考档位）：上下键移动、空格勾选、Enter 确认；
 * 框内禁用歧义宽度字符（conhost 实宽 2 列会撑破整宽行→折行滚屏），
 * 动态文本经 boxSafe 兜底，盒体距右缘保留 2 列余量。
 * exclusiveIndex 项（"不支持思考强度"）与其余选项互斥。
 * 选项超出可用行数时按光标窗口滚动（maxRows 由调用方给）。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { useTuiEnv } from "../env.js";
import { boxSafe, truncateLine } from "../format.js";
import { useTheme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import { InputCursor } from "./input-cursor.js";

/** print() 行最多保留的行数（失败原因等） */
const MAX_LOGS = 4;

export function WizardView({
  title,
  state,
  active,
  width,
  maxRows,
  offsetY = 0,
  offsetX = 0,
  onSubmit,
  onSubmitMulti,
  onCancel,
}: {
  title: string;
  state: WizardState;
  active: boolean;
  width: number;
  /** 组件可用行数（含边框）：超出时多选选项按光标窗口滚动 */
  maxRows?: number | undefined;
  offsetY?: number | undefined;
  offsetX?: number | undefined;
  onSubmit: (value: string) => void;
  /** 多选确认：选中下标数组 */
  onSubmitMulti: (indices: number[]) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const secret = state.prompt?.secret === true;
  const multi = state.prompt?.multi;
  const exclusive = multi?.exclusiveIndex;

  useInput(
    (ch, key) => {
      if (key.escape) {
        setValue("");
        onCancel();
        return;
      }
      // 输入框只在有挂起提示时受理
      if (state.prompt === undefined) return;
      if (multi !== undefined) {
        // 多选模式：↑↓ 移动、空格勾选、Enter 确认（不进入字符输入逻辑）
        if (key.upArrow) {
          setCursor((c) => (c + multi.options.length - 1) % multi.options.length);
          return;
        }
        if (key.downArrow) {
          setCursor((c) => (c + 1) % multi.options.length);
          return;
        }
        if (ch === " ") {
          setChecked((s) => {
            const next = new Set(s);
            if (cursor === exclusive) {
              // "全否"项：勾选 = 清空其余；再按取消它也清空
              return next.has(cursor) ? new Set<number>() : new Set<number>([cursor]);
            }
            next.delete(exclusive ?? -1);
            if (next.has(cursor)) next.delete(cursor);
            else next.add(cursor);
            return next;
          });
          return;
        }
        if (key.return) {
          const picked = [...checked].sort((a, b) => a - b);
          setChecked(new Set());
          setCursor(0);
          onSubmitMulti(picked);
        }
        return;
      }
      if (key.return) {
        const v = value;
        setValue("");
        onSubmit(v);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (ch !== "" && !key.ctrl && !key.meta) {
        setValue((v) => v + ch);
      }
    },
    { isActive: active },
  );

  const logs = state.logs.slice(-MAX_LOGS);
  // 回显/摘要/提示都进框内行：歧义宽度字符换成 1 列近形（防 conhost 折行滚屏）
  const echo = boxSafe(secret ? "*".repeat(value.length) : value);
  const stepsLine = state.steps.map(boxSafe).join(" • ");

  // 多选选项窗口：maxRows 限定时其余区域占用的行先扣掉
  const optBudget =
    maxRows !== undefined
      ? Math.max(
          3,
          maxRows -
            2 /* 边框 */ -
            1 /* 标题 */ -
            (stepsLine !== "" ? 1 : 0) -
            logs.length -
            2 /* prompt+hint */ -
            2 /* footer+done */,
        )
      : (multi?.options.length ?? 0);
  const optWin = Math.min(multi?.options.length ?? 0, optBudget);
  const optStart =
    multi !== undefined && optWin < multi.options.length
      ? Math.min(
          Math.max(0, cursor - Math.floor(optWin / 2)),
          Math.max(0, multi.options.length - optWin),
        )
      : 0;
  const optVisible = multi !== undefined ? multi.options.slice(optStart, optStart + optWin) : [];

  return (
    <Box
      flexDirection="column"
      width={width - 2}
      borderStyle={env.ascii ? "single" : "round"}
      borderColor={theme.accent}
    >
      <InputCursor
        active={active && state.prompt !== undefined && multi === undefined}
        prefix="> "
        text={echo}
        width={width - 4}
        x={offsetX + 1}
        y={
          offsetY + 2 + (stepsLine !== "" ? 1 : 0) + logs.length + (state.prompt?.hint ? 1 : 0) + 1
        }
      />
      <Text bold color={theme.accent} wrap="truncate">
        {boxSafe(title)}
      </Text>
      {stepsLine !== "" ? (
        <Text wrap="truncate" color={theme.muted}>
          {truncateLine(stepsLine, width - 4)}
        </Text>
      ) : null}
      {logs.map((l, i) => (
        <Text key={i} wrap="truncate" color={theme.muted}>
          {truncateLine(boxSafe(l), width - 4)}
        </Text>
      ))}
      {state.prompt !== undefined ? (
        <Box flexDirection="column">
          <Text bold wrap="truncate">
            {truncateLine(boxSafe(state.prompt.text), width - 4)}
          </Text>
          {state.prompt.hint !== undefined && state.prompt.hint !== "" ? (
            <Text wrap="truncate" color={theme.muted}>
              {truncateLine(boxSafe(`  ${state.prompt.hint}`), width - 4)}
            </Text>
          ) : null}
          {multi !== undefined ? (
            <Box flexDirection="column">
              {optVisible.map((opt, i) => {
                const idx = optStart + i;
                return (
                  <Text key={idx} wrap="truncate">
                    <Text color={idx === cursor ? theme.accent : theme.muted}>
                      {idx === cursor ? ">" : " "}
                    </Text>
                    <Text {...(idx === exclusive ? { color: theme.warning } : {})}>
                      {checked.has(idx) ? " [x] " : " [ ] "}
                    </Text>
                    {truncateLine(boxSafe(opt), width - 10)}
                  </Text>
                );
              })}
            </Box>
          ) : (
            <Text wrap="truncate">
              {truncateLine(`> ${echo}`, width - 4)}
              <Text color={theme.selected} backgroundColor={theme.selectionBg}>
                {" "}
              </Text>
            </Text>
          )}
        </Box>
      ) : state.running ? (
        <Text color={theme.muted} wrap="truncate">
          {truncateLine(boxSafe(state.busyText ?? "处理中…"), width - 4)}
        </Text>
      ) : null}
      {state.doneText !== undefined && state.doneText !== "" ? (
        <Text wrap="truncate" color={theme.accent}>
          {truncateLine(boxSafe(state.doneText), width - 4)}
        </Text>
      ) : null}
      <Text dimColor>
        {state.prompt === undefined
          ? "Esc 关闭"
          : multi !== undefined
            ? "上下移动，空格勾选，Enter 确认，Esc 取消"
            : "Enter 确认，Esc 取消"}
      </Text>
    </Box>
  );
}
