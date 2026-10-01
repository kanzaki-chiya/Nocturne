import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import { boxSafe } from "../format.js";
import { useTheme } from "../theme.js";
import { Buttons } from "./dialog/buttons.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";

const ACTIONS = [
  ["key", "换密钥"],
  ["refresh", "刷新模型列表"],
  ["model", "编辑模型"],
  ["remove", "删除"],
  ["cancel", "取消"],
] as const;

export function ProviderDialog({
  providerId,
  confirmRemove = false,
  deleteDisabled,
  width,
  height,
  active,
  onActivate,
  onMouseFrame,
}: {
  providerId: string;
  confirmRemove?: boolean;
  deleteDisabled: boolean;
  width: number;
  height: number;
  active: boolean;
  onActivate: (action: string) => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [focus, setFocus] = useState(confirmRemove ? "cancel" : "key");
  const boxes = useRef(new Map<string, DOMElement>());
  const items = confirmRemove
    ? ([
        ["cancel", "取消"],
        ["remove", "删除"],
      ] as const)
    : ACTIONS;
  const order: string[] = items
    .map(([id]) => id)
    .filter((id) => id !== "remove" || !deleteDisabled);
  const needed = confirmRemove ? 7 : deleteDisabled ? 12 : 11;
  const framed = width >= 28 && height >= needed + 2;
  const dialogWidth = framed ? Math.min(72, width - 4) : width;
  const dialogHeight = Math.min(needed, height);
  const inner = Math.max(1, dialogWidth - (framed ? 4 : 0));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const tooSmall = inner < 12 || height < (confirmRemove ? 5 : 8);
  const activate = (id: string) => {
    if (id === "remove" && deleteDisabled) return;
    onActivate(id);
  };
  useInput(
    (input, key) => {
      if (key.escape) activate("cancel");
      else if (
        !tooSmall &&
        (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
      ) {
        const backwards = key.upArrow || key.leftArrow || (key.tab && key.shift);
        setFocus(
          order[(order.indexOf(focus) + (backwards ? -1 : 1) + order.length) % order.length] ??
            "cancel",
        );
      } else if (!tooSmall && (key.return || input === " ")) activate(focus);
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
      layer: confirmRemove ? "provider-remove" : "provider-actions",
      boxes: tooSmall
        ? []
        : [...boxes.current].flatMap(([id, node]) => {
            if (id === "remove" && deleteDisabled) return [];
            const rect = screenRect(node);
            return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
          }),
      click: activate,
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });
  return (
    <Box width={width} height={height} paddingLeft={left} paddingTop={top}>
      <DialogFrame
        title={boxSafe(`${confirmRemove ? "删除服务商" : "服务商"} ${providerId}`)}
        width={dialogWidth}
        height={dialogHeight}
        framed={framed}
      >
        {tooSmall ? (
          <Text>终端太小，请放大 · Esc 返回</Text>
        ) : (
          <>
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {confirmRemove ? (
                <Text wrap="truncate">删除 {boxSafe(providerId)} 的配置与已保存的密钥</Text>
              ) : (
                items.map(([id, label]) =>
                  id === "remove" && deleteDisabled ? (
                    <Text key={id} color={theme.muted}>
                      {" "}
                      [ 删除 ]（不可用）
                    </Text>
                  ) : (
                    <Buttons
                      key={id}
                      focused={focus}
                      readonly={false}
                      width={inner}
                      items={[[id, label]]}
                      onBox={onBox}
                    />
                  ),
                )
              )}
              {!confirmRemove && deleteDisabled ? (
                <Text color={theme.muted} wrap="truncate">
                  当前会话正在使用，先用 /model 切换
                </Text>
              ) : null}
            </Box>
            {confirmRemove ? (
              <Buttons focused={focus} readonly={false} width={inner} items={items} onBox={onBox} />
            ) : null}
            <Text color={theme.muted} wrap="truncate">
              ↑↓/Tab 移动 · Enter 执行 · Esc 关闭
            </Text>
          </>
        )}
      </DialogFrame>
    </Box>
  );
}
