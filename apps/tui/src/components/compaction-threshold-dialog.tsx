import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import { parseCompactionThreshold } from "@nocturne/core/protocol";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { Segmented } from "./dialog/segmented.js";
import { TextInput, inputWindow } from "./dialog/text-input.js";
import { Buttons } from "./dialog/buttons.js";
import { ConfirmDiscard } from "./dialog/confirm-discard.js";
import { moveFocus } from "./dialog/focus.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { InputCursor } from "./input-cursor.js";

const ORDER = ["unit", "value", "cancel", "save"];
export function CompactionThresholdDialog({
  initial,
  width,
  height,
  onApply,
  onCancel,
  onMouseFrame,
}: {
  initial: string;
  width: number;
  height: number;
  onApply: (value: string) => void;
  onCancel: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const parsed = parseCompactionThreshold(initial);
  const [unit, setUnit] = useState(parsed.unit);
  const initialValue = parsed.unit === "percent" ? initial.slice(0, -1) : initial;
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const [focus, setFocus] = useState("unit");
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const boxes = useRef(new Map<string, DOMElement>());
  const dialogWidth = Math.max(1, Math.min(72, width - 4));
  const framed = width >= 24 && height >= 10;
  const inner = Math.max(1, dialogWidth - (framed ? 4 : 0));
  const dialogHeight = Math.min(10, height);
  const close = () => {
    if (unit !== parsed.unit || value !== initialValue) setConfirm(true);
    else onCancel();
  };
  const activate = (id: string) => {
    if (id === "cancel") close();
    else if (id === "save") {
      const threshold = unit === "percent" ? `${value}%` : value;
      try {
        parseCompactionThreshold(threshold);
        onApply(threshold);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setFocus("value");
      }
    }
  };
  useInput((input, key) => {
    if (confirm) {
      if (key.escape) setConfirm(false);
      else if (key.tab || key.leftArrow || key.rightArrow) setDiscard(!discard);
      else if (key.return) {
        if (discard) onCancel();
        else setConfirm(false);
      }
      return;
    }
    if (key.escape) {
      close();
      return;
    }
    if (height < 6 || width < 12) return;
    if (key.tab || key.upArrow || key.downArrow) {
      setFocus(
        moveFocus(
          ORDER,
          focus,
          key.tab ? (key.shift ? "shiftTab" : "tab") : key.upArrow ? "up" : "down",
        ),
      );
      return;
    }
    if (focus === "unit") {
      if (key.leftArrow || key.rightArrow || input === " ")
        setUnit(unit === "percent" ? "tokens" : "percent");
      else if (key.return) setFocus("value");
      return;
    }
    if (focus === "value") {
      if (key.return) {
        setFocus("save");
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setCursor(Math.max(0, Math.min(value.length, cursor + (key.leftArrow ? -1 : 1))));
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === "u") {
        setValue("");
        setCursor(0);
      } else if (key.backspace || key.delete) {
        const at = key.backspace ? Math.max(0, cursor - 1) : cursor;
        if (key.delete || cursor > 0) setValue(value.slice(0, at) + value.slice(at + 1));
        setCursor(at);
      } else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) {
        setValue(value.slice(0, cursor) + input + value.slice(cursor));
        setCursor(cursor + input.length);
      }
      setError(undefined);
      return;
    }
    if (key.leftArrow || key.rightArrow)
      setFocus(moveFocus(ORDER, focus, key.leftArrow ? "left" : "right"));
    else if (key.return || input === " ") activate(focus);
  });
  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };
  useEffect(() => {
    if (!onMouseFrame) return;
    onMouseFrame({
      layer: "compaction-threshold",
      boxes: [...boxes.current].flatMap(([id, node]) => {
        if (confirm && id !== "discard" && id !== "continue") return [];
        const rect = screenRect(node);
        return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
      }),
      click: (id, mouse) => {
        if (confirm) {
          if (id === "discard") onCancel();
          else setConfirm(false);
          return;
        }
        if (id === "unit") {
          setFocus("unit");
          const node = boxes.current.get(id);
          if (node)
            setUnit(
              inner >= 22
                ? mouse.x - screenRect(node).col < 13
                  ? "percent"
                  : "tokens"
                : unit === "percent"
                  ? "tokens"
                  : "percent",
            );
        } else {
          setFocus(id);
          if (id === "value") {
            const node = boxes.current.get(id);
            if (node)
              setCursor(
                Math.max(
                  0,
                  Math.min(
                    value.length,
                    inputWindow(value, cursor, inner).start + mouse.x - screenRect(node).col - 2,
                  ),
                ),
              );
          } else activate(id);
        }
      },
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });
  return (
    <Box width={width} height={height} alignItems="center" justifyContent="center">
      <DialogFrame title="压缩阈值" width={dialogWidth} height={dialogHeight} framed={framed}>
        {height < 6 || width < 12 ? (
          <Text>终端太小，请放大 · Esc 返回</Text>
        ) : (
          <>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              <Box
                ref={(node) => {
                  onBox("unit", node);
                }}
              >
                <Segmented
                  options={["百分比", "token"]}
                  selected={unit === "percent" ? 0 : 1}
                  focused={focus === "unit"}
                  width={Math.max(1, inner - 2)}
                  maxLines={1}
                />
              </Box>
              <Text wrap="truncate">数值（token 支持 200k / 1.5m）</Text>
              <Box
                ref={(node) => {
                  onBox("value", node);
                }}
              >
                <TextInput
                  value={value}
                  cursor={cursor}
                  focused={focus === "value"}
                  width={inner}
                  invalid={error !== undefined}
                />
                <InputCursor
                  active={focus === "value"}
                  prefix=""
                  text=""
                  width={inner}
                  x={
                    Math.floor((width - dialogWidth) / 2) +
                    (framed ? 2 : 0) +
                    2 +
                    inputWindow(value, cursor, inner).column
                  }
                  y={Math.floor((height - dialogHeight) / 2) + (framed ? 1 : 0) + 3 - height}
                />
              </Box>
            </Box>
            <Text wrap="truncate">{error ?? "Tab/↑↓ 移动 · Enter 确认 · Esc 取消"}</Text>
            {confirm ? (
              <ConfirmDiscard discard={discard} onBox={onBox} />
            ) : (
              <Buttons focused={focus} readonly={false} width={inner} onBox={onBox} />
            )}
          </>
        )}
      </DialogFrame>
    </Box>
  );
}
