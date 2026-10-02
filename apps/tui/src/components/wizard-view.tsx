/** Core 编排的服务商向导；只负责对话框画法、焦点与输入。 */
import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { boxSafe, truncateLine } from "../format.js";
import { useTheme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import { copyText } from "../clipboard.js";
import { unstoredKeyCommands } from "../provider-login.js";
import { Buttons } from "./dialog/buttons.js";
import { ConfirmDiscard } from "./dialog/confirm-discard.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { TextInput, inputWindow } from "./dialog/text-input.js";
import { InputCursor } from "./input-cursor.js";

export function WizardView({
  title,
  state,
  active,
  width,
  height: suppliedHeight,
  maxRows,
  offsetY,
  offsetX = 0,
  onSubmit,
  onSubmitMulti,
  onCancel,
  onMouseFrame,
}: {
  title: string;
  state: WizardState;
  active: boolean;
  width: number;
  height?: number | undefined;
  maxRows?: number | undefined;
  offsetY?: number | undefined;
  offsetX?: number | undefined;
  onSubmit: (value: string) => void;
  onSubmitMulti: (indices: number[]) => void;
  onCancel: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [option, setOption] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [focus, setFocus] = useState("input");
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [copyNote, setCopyNote] = useState<string>();
  const boxes = useRef(new Map<string, DOMElement>());
  const previousPrompt = useRef<string | undefined>(undefined);
  const prompt = state.prompt;
  const secretDisplay = state.secretDisplay?.();
  const multi = prompt?.multi;
  const height = suppliedHeight ?? maxRows ?? 16;
  const logs = state.logs.slice(-2);
  const stepsLine = state.steps.map(boxSafe).join(" • ");
  const metadata = (stepsLine ? 1 : 0) + logs.length;
  const loginRows = state.login
    ? Math.ceil(stringWidth(state.login.authorizeUrl) / Math.max(1, Math.min(68, width - 8))) + 1
    : 0;
  const needed = Math.max(
    9 + loginRows + (secretDisplay ? 6 : 0),
    Math.min(18, 9 + metadata + (multi ? Math.min(multi.options.length, 7) : 0)),
  );
  const framed = width >= 28 && height >= 10;
  const dialogWidth = framed ? Math.min(72, width - 4) : Math.max(1, width);
  const dialogHeight = Math.min(needed, framed ? height - 2 : height);
  const inner = Math.max(1, dialogWidth - (framed ? 4 : 0));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const tooSmall = height < 5 || inner < 12;
  const compact = dialogHeight < 9 + metadata;
  const visibleMetadata = compact ? 0 : metadata;
  const optionCount = multi
    ? Math.max(
        1,
        Math.min(multi.options.length, dialogHeight - visibleMetadata - (framed ? 2 : 0) - 5),
      )
    : 0;
  const optionStart = Math.min(
    Math.max(0, option - Math.floor(optionCount / 2)),
    Math.max(0, (multi?.options.length ?? 0) - optionCount),
  );
  const echo = prompt?.secret ? "*".repeat(Array.from(value).length) : boxSafe(value);
  const saveLabel = secretDisplay
    ? "已保存，继续"
    : state.login
      ? "提交"
      : prompt?.confirmation || state.mode === "key"
        ? "保存"
        : "下一步";
  useEffect(() => {
    if (!prompt) return;
    // 同一提问重试保留草稿（换密钥保存失败、拉模型 Esc 回上一步）。
    if (previousPrompt.current !== prompt.text) {
      setValue("");
      setCursor(0);
      setChecked(new Set());
      setOption(0);
    }
    previousPrompt.current = prompt.text;
    setFocus(prompt.confirmation ? "save" : "input");
  }, [prompt]);
  const close = () => {
    if (state.login) {
      onCancel();
      return;
    }
    if (value !== "" || checked.size > 0) {
      setConfirm(true);
      setDiscard(false);
    } else onCancel();
  };
  const toggle = (index: number) => {
    setOption(index);
    setFocus("input");
    setChecked((current) => {
      const next = new Set(current);
      if (index === multi?.exclusiveIndex) return next.has(index) ? new Set() : new Set([index]);
      next.delete(multi?.exclusiveIndex ?? -1);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const copyUrl = () => {
    const url = state.login?.authorizeUrl;
    if (url === undefined) return;
    void copyText(url).then((ok) => {
      setCopyNote(
        ok.length > 0 ? "已复制授权地址，粘贴到浏览器打开" : "! 复制失败，请手动选中地址",
      );
    });
  };
  // 登录等待时多一个「复制地址」：长地址折行后终端只能识别首行链接，选中复制又会带上边框。
  const buttonIds = state.login && prompt ? ["cancel", "copy", "save"] : ["cancel", "save"];
  const activate = (id: string) => {
    if (id === "cancel") close();
    else if (id === "copy") copyUrl();
    else if (id === "save" && prompt) {
      if (multi) onSubmitMulti([...checked].sort((a, b) => a - b));
      else onSubmit(prompt.confirmation ? "" : value);
    }
  };
  useInput(
    (input, key) => {
      if (confirm) {
        if (key.escape) setConfirm(false);
        else if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
          setDiscard(!discard);
        else if (key.return || input === " ") {
          if (discard) onCancel();
          else setConfirm(false);
        }
        return;
      }
      if (key.escape) {
        if (!prompt) onCancel();
        else close();
        return;
      }
      if (!prompt || tooSmall) return;
      const order = prompt.confirmation ? buttonIds : ["input", ...buttonIds];
      if (key.tab) {
        setFocus(
          order[(order.indexOf(focus) + (key.shift ? -1 : 1) + order.length) % order.length] ??
            "input",
        );
        return;
      }
      if (focus !== "input") {
        if (key.upArrow && !prompt.confirmation) setFocus("input");
        else if (key.leftArrow || key.rightArrow) {
          const at = buttonIds.indexOf(focus);
          setFocus(
            buttonIds[(at + (key.leftArrow ? -1 : 1) + buttonIds.length) % buttonIds.length] ??
              "cancel",
          );
        } else if (key.return || input === " ") activate(focus);
        return;
      }
      if (multi) {
        if (key.upArrow) setOption(Math.max(0, option - 1));
        else if (key.downArrow) {
          if (option >= multi.options.length - 1) setFocus("save");
          else setOption(option + 1);
        } else if (input === " ") toggle(option);
        else if (key.return) setFocus("save");
        return;
      }
      if (key.return) {
        activate("save");
        return;
      }
      if (key.downArrow) {
        setFocus("save");
        return;
      }
      const chars = Array.from(value);
      if (key.leftArrow || key.rightArrow) {
        setCursor(Math.max(0, Math.min(chars.length, cursor + (key.leftArrow ? -1 : 1))));
        return;
      }
      if (key.home || (key.ctrl && input === "a")) {
        setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setCursor(chars.length);
        return;
      }
      if (key.ctrl && input === "u") {
        setValue("");
        setCursor(0);
        return;
      }
      if (key.backspace || key.delete) {
        const at = key.backspace ? Math.max(0, cursor - 1) : cursor;
        if (key.delete || cursor > 0) chars.splice(at, 1);
        setValue(chars.join(""));
        setCursor(at);
      } else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) {
        chars.splice(cursor, 0, input);
        setValue(chars.join(""));
        setCursor(cursor + Array.from(input).length);
      }
    },
    { isActive: active },
  );
  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };
  useEffect(() => {
    if (!active || !onMouseFrame) return;
    onMouseFrame({
      layer: confirm ? "provider-wizard-discard" : "provider-wizard",
      boxes: tooSmall
        ? []
        : [...boxes.current].flatMap(([id, node]) => {
            if (
              confirm
                ? id !== "discard" && id !== "continue"
                : id === "discard" || id === "continue"
            )
              return [];
            const rect = screenRect(node);
            return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
          }),
      click: (id, mouse) => {
        if (confirm) {
          if (id === "discard") onCancel();
          else setConfirm(false);
          return;
        }
        if (id.startsWith("option:")) {
          toggle(Number(id.slice(7)));
          return;
        }
        setFocus(id);
        if (id === "input") {
          const node = boxes.current.get(id);
          if (!node) return;
          const window = inputWindow(echo, cursor, inner);
          const column = Math.max(0, mouse.x - screenRect(node).col - 2);
          let index = window.start,
            used = 0;
          const chars = Array.from(echo);
          while (index < chars.length && used + stringWidth(chars[index] ?? "") <= column)
            used += stringWidth(chars[index++] ?? "");
          setCursor(index);
        } else activate(id);
      },
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });
  const cursorWindow = inputWindow(echo, cursor, inner);
  const inputY = top + (framed ? 1 : 0) + 1 + visibleMetadata + 1;
  return (
    <Box width={width} height={height} paddingLeft={left} paddingTop={top}>
      <DialogFrame title={boxSafe(title)} width={dialogWidth} height={dialogHeight} framed={framed}>
        {tooSmall ? (
          <Text>终端太小，请放大 · Esc 返回</Text>
        ) : (
          <>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {state.login ? (
                <>
                  <Text wrap="wrap">{boxSafe(state.login.authorizeUrl)}</Text>
                  <Text color={theme.muted}>
                    {copyNote ??
                      (state.login.browserOpened
                        ? "已在浏览器打开；没有打开时选「复制地址」"
                        : "未能打开浏览器，选「复制地址」后粘贴到浏览器")}
                  </Text>
                </>
              ) : null}
              {secretDisplay ? (
                <>
                  <Text>系统凭据后端不可用；密钥仅显示一次</Text>
                  <Text wrap="wrap">{boxSafe(secretDisplay.key)}</Text>
                  <Text wrap="wrap">
                    {boxSafe(unstoredKeyCommands(secretDisplay.key, secretDisplay.envName))}
                  </Text>
                </>
              ) : null}
              {!compact && stepsLine ? (
                <Text color={theme.muted} wrap="truncate">
                  {truncateLine(stepsLine, inner)}
                </Text>
              ) : null}
              {!compact
                ? logs.map((log, index) => (
                    <Text key={index} color={theme.muted} wrap="truncate">
                      {truncateLine(boxSafe(log), inner)}
                    </Text>
                  ))
                : null}
              {prompt ? (
                <>
                  <Text bold wrap="truncate">
                    {truncateLine(boxSafe(prompt.text), inner)}
                  </Text>
                  {prompt.confirmation ? null : multi ? (
                    multi.options.slice(optionStart, optionStart + optionCount).map((label, i) => {
                      const index = optionStart + i;
                      return (
                        <Box
                          key={index}
                          ref={(node) => {
                            onBox(`option:${index}`, node);
                          }}
                        >
                          <Text
                            color={
                              focus === "input" && option === index ? theme.accent : theme.text
                            }
                            wrap="truncate"
                          >
                            {option === index ? "> " : "  "}
                            {checked.has(index) ? "[x] " : "[ ] "}
                            {truncateLine(boxSafe(label), inner - 6)}
                          </Text>
                        </Box>
                      );
                    })
                  ) : (
                    <Box
                      ref={(node) => {
                        onBox("input", node);
                      }}
                    >
                      <TextInput
                        value={echo}
                        cursor={cursor}
                        focused={focus === "input"}
                        width={inner}
                        invalid={state.error !== undefined}
                        placeholder=""
                      />
                    </Box>
                  )}
                  {!compact && prompt.hint
                    ? hintLines(boxSafe(prompt.hint), inner).map((line, i) => (
                        <Text key={i} color={theme.muted} wrap="truncate">
                          {line}
                        </Text>
                      ))
                    : null}
                </>
              ) : (
                <Text color={theme.muted} wrap="truncate">
                  {truncateLine(
                    boxSafe(state.running ? (state.busyText ?? "处理中…") : (state.doneText ?? "")),
                    inner,
                  )}
                </Text>
              )}
              <InputCursor
                active={
                  active &&
                  !confirm &&
                  focus === "input" &&
                  prompt !== undefined &&
                  !multi &&
                  !prompt.confirmation
                }
                prefix=""
                text=""
                width={inner}
                x={offsetX + left + (framed ? 2 : 0) + 2 + cursorWindow.column}
                y={(offsetY ?? -height) + inputY}
              />
            </Box>
            <Text color={state.error ? theme.error : theme.muted} wrap="truncate">
              {state.error ? `! ${boxSafe(state.error)}` : "Tab/↑↓ 移动 · Enter 确认 · Esc 取消"}
            </Text>
            {confirm ? (
              <ConfirmDiscard discard={discard} onBox={onBox} />
            ) : (
              <Buttons
                focused={focus}
                readonly={false}
                width={inner}
                items={
                  prompt
                    ? state.login
                      ? [
                          ["cancel", "取消"],
                          ["copy", "复制地址"],
                          ["save", saveLabel],
                        ]
                      : [
                          ["cancel", "取消"],
                          ["save", saveLabel],
                        ]
                    : [["cancel", "取消"]]
                }
                onBox={onBox}
              />
            )}
          </>
        )}
      </DialogFrame>
    </Box>
  );
}

/** 说明行最多两行：常含「直接回车改用环境变量」等操作提示，单行截断会丢掉关键信息。 */
function hintLines(hint: string, width: number): string[] {
  let first = "";
  const chars = Array.from(hint);
  let i = 0;
  while (i < chars.length && stringWidth(first + (chars[i] ?? "")) <= width)
    first += chars[i++] ?? "";
  const rest = chars.slice(i).join("").trimStart();
  return rest === "" ? [first] : [first, truncateLine(rest, width)];
}
