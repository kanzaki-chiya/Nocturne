/**
 * Provider 向导视图（provider-setup.md 第 6 节；cli.md §4 /provider add）：
 * 渲染 useProviderWizard 的状态——print() 日志区 + 当前 prompt + 单行输入框。
 * secret 提示回显 *。Enter 提交、Esc 取消（reject WizardAbort）。
 * 两种宿主共用：模型选择页内嵌（备用屏内）与 /provider add 主屏弹层。
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
  onCancel,
}: {
  title: string;
  state: WizardState;
  active: boolean;
  width: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const [value, setValue] = useState("");
  const secret = state.prompt?.secret === true;

  useInput(
    (ch, key) => {
      if (key.escape) {
        setValue("");
        onCancel();
        return;
      }
      // 输入框只在有挂起提示时受理
      if (state.prompt === undefined) return;
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
        <Text wrap="truncate">
          {truncateLine(`${state.prompt.text}${echo}`, width - 4)}
          <Text inverse> </Text>
        </Text>
      ) : state.running ? (
        <Text dimColor>处理中…</Text>
      ) : null}
      {state.doneText !== undefined && state.doneText !== "" ? (
        <Text wrap="truncate">{truncateLine(state.doneText, width - 4)}</Text>
      ) : null}
      <Text dimColor>{state.prompt !== undefined ? "Enter 确认，Esc 取消" : "Esc 关闭"}</Text>
    </Box>
  );
}
