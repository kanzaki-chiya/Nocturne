/**
 * Provider 向导视图（provider-setup.md 第 6 节；cli.md §4 /provider add）：
 * 渲染 useProviderWizard 的状态——print() 日志区 + 当前 prompt + 单行输入框。
 * secret 提示回显 *。Enter 提交、Esc 取消（reject WizardAbort）。
 * 两种宿主共用：模型选择页内嵌（备用屏内）与 /provider add 主屏弹层。
 * prompt.multi = 多选勾选（ADR-0018 思考档位）：↑↓ 移动、空格勾选、Enter 确认。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";
import type { WizardState } from "../wizard-io.js";

const MAX_LOGS = 8;

export function WizardView({
  title,
  state,
  active,
  width,
  onSubmit,
  onSubmitMulti,
  onCancel,
}: {
  title: string;
  state: WizardState;
  active: boolean;
  width: number;
  onSubmit: (value: string) => void;
  /** 多选确认：选中下标数组 */
  onSubmitMulti: (indices: number[]) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const secret = state.prompt?.secret === true;
  const multi = state.prompt?.multi;

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
  const echo = secret ? "*".repeat(value.length) : value;
  return (
    <Box flexDirection="column" borderStyle={env.ascii ? "single" : "round"} borderColor="cyan">
      <Text bold>{title}</Text>
      {logs.map((l, i) => (
        <Text key={i} wrap="truncate">
          {truncateLine(l, width - 4)}
        </Text>
      ))}
      {state.prompt !== undefined ? (
        multi !== undefined ? (
          <Box flexDirection="column">
            <Text wrap="truncate">{truncateLine(state.prompt.text, width - 4)}</Text>
            {multi.options.map((opt, i) => (
              <Text key={opt} wrap="truncate">
                <Text {...(i === cursor ? { color: "cyan" } : {})}>
                  {i === cursor ? "> " : "  "}
                </Text>
                {checked.has(i) ? "[x] " : "[ ] "}
                {truncateLine(opt, width - 10)}
              </Text>
            ))}
          </Box>
        ) : (
          <Text wrap="truncate">
            {truncateLine(`${state.prompt.text}${echo}`, width - 4)}
            <Text inverse> </Text>
          </Text>
        )
      ) : state.running ? (
        <Text dimColor>处理中…</Text>
      ) : null}
      {state.doneText !== undefined && state.doneText !== "" ? (
        <Text wrap="truncate">{truncateLine(state.doneText, width - 4)}</Text>
      ) : null}
      <Text dimColor>
        {state.prompt === undefined
          ? "Esc 关闭"
          : multi !== undefined
            ? "↑↓ 移动，空格勾选，Enter 确认，Esc 取消"
            : "Enter 确认，Esc 取消"}
      </Text>
    </Box>
  );
}
