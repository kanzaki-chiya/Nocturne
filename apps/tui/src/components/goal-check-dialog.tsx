import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import { decisionModelRecipient, type DecisionModelConfig, type Runtime } from "@nocturne/core";
import {
  GOAL_CHECK_DISCLOSURE_PREF,
  parseGoalCheckAccepted,
  type GoalCheckBackend,
} from "../goal-check.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { Buttons } from "./dialog/buttons.js";
import { Segmented } from "./dialog/segmented.js";
import { TextInput } from "./dialog/text-input.js";
import { moveFocus } from "./dialog/focus.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { useTheme } from "../theme.js";

const BACKENDS: readonly GoalCheckBackend[] = ["off", "decision", "smol"];

export function GoalCheckDialog({
  runtime,
  initial,
  decisionModel,
  width,
  height,
  onOpenDecisionModel,
  onApply,
  onCancel,
  onMouseFrame,
}: {
  runtime: Runtime;
  initial: GoalCheckBackend;
  decisionModel: DecisionModelConfig | undefined;
  width: number;
  height: number;
  onOpenDecisionModel?: (() => void) | undefined;
  /** 保存即落盘：返回错误文案则留在对话框内显示，成功返回 undefined 由调用方关闭 */
  onApply: (backend: GoalCheckBackend, acceptedRecipient?: string) => Promise<string | undefined>;
  onCancel: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [backend, setBackend] = useState<GoalCheckBackend>(initial);
  const [focus, setFocus] = useState("backend");
  const [notice, setNotice] = useState<string>();
  const [disclosure, setDisclosure] = useState(false);
  const boxes = useRef(new Map<string, DOMElement>());
  const mounted = useRef(true);
  const saving = useRef(false);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const needsDecisionModel = backend === "decision" && decisionModel === undefined;
  const fields = needsDecisionModel ? ["backend", "decisionModel"] : ["backend"];
  const order = [...fields, "cancel", "save"];

  const recipient = decisionModel !== undefined ? decisionModelRecipient(decisionModel) : undefined;
  const recipientDisplay =
    decisionModel?.endpoint === "custom"
      ? (decisionModel.baseURL ?? "自定义地址")
      : (recipient?.label ?? "");

  const apply = (confirmed = false) => {
    if (backend === "decision" && decisionModel !== undefined && recipient !== undefined) {
      const acceptedRecipients = parseGoalCheckAccepted(
        runtime.getPreference(GOAL_CHECK_DISCLOSURE_PREF),
      );
      if (!confirmed && !acceptedRecipients.has(recipient.id)) {
        setDisclosure(true);
        setFocus("save");
        return;
      }
    }
    if (saving.current) return;
    saving.current = true;
    const acceptedId =
      backend === "decision" && confirmed && recipient !== undefined ? recipient.id : undefined;
    void onApply(backend, acceptedId).then((failure) => {
      saving.current = false;
      if (failure === undefined || !mounted.current) return;
      setDisclosure(false);
      setNotice(`保存失败：${failure}`);
    });
  };

  const activate = (id: string) => {
    if (id === "cancel") {
      if (disclosure) setDisclosure(false);
      else onCancel();
    } else if (id === "save") {
      apply(disclosure);
    } else if (id === "backend") {
      if (needsDecisionModel) setFocus("decisionModel");
      else setFocus("save");
    } else if (id === "decisionModel") {
      onOpenDecisionModel?.();
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      if (disclosure) setDisclosure(false);
      else onCancel();
      return;
    }
    if (key.ctrl && input === "s") {
      apply(disclosure);
      return;
    }
    if (disclosure) {
      if (key.leftArrow || key.rightArrow || key.tab) {
        setFocus(focus === "cancel" ? "save" : "cancel");
      } else if (key.return) {
        activate(focus);
      }
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) {
      const dir = key.upArrow ? "up" : key.downArrow ? "down" : key.shift ? "shiftTab" : "tab";
      setFocus(moveFocus(order, focus, dir));
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const step = key.leftArrow ? -1 : 1;
      if (focus === "backend") {
        const i = BACKENDS.indexOf(backend);
        const next = BACKENDS[(i + step + BACKENDS.length) % BACKENDS.length];
        if (next) setBackend(next);
        setNotice(undefined);
        return;
      }
      if (focus === "cancel" || focus === "save") {
        setFocus(focus === "cancel" ? "save" : "cancel");
        return;
      }
    }
    if (key.return) {
      activate(focus);
    }
  });

  const framed = width >= 44 && height >= 12;
  const dialogWidth = Math.min(width, 64);
  const dialogHeight = Math.min(height, disclosure ? 13 : Math.max(10, fields.length * 2 + 6));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const innerWidth = Math.max(10, dialogWidth - (framed ? 4 : 2));

  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };

  useEffect(() => {
    if (!onMouseFrame) return;
    const targets = disclosure ? ["cancel", "save"] : order;
    const hitBoxes: DialogMouseFrame["boxes"] = targets.flatMap((id) => {
      const node = boxes.current.get(id);
      if (!node) return [];
      const rect = screenRect(node);
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
    });
    onMouseFrame({
      layer: "goalCheck",
      boxes: hitBoxes,
      click: (id) => {
        setFocus(id);
        if (id === "cancel" || id === "save" || id === "decisionModel") activate(id);
      },
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={left}
      paddingTop={top}
      overflow="hidden"
    >
      {width < 12 || height < 5 ? (
        <Text>终端太小，请放大（Esc 返回）</Text>
      ) : (
        <DialogFrame
          title="/settings · 目标核对"
          width={dialogWidth}
          height={dialogHeight}
          framed={framed}
        >
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {disclosure ? (
              <>
                <Text>
                  {decisionModel?.source === "gemini" ? "首次启用 Gemini" : "首次启用 Jev"}
                </Text>
                <Text>
                  目标核对将发送目标原文、完成清单与证据，以及脱敏后的工具调用记录与输出（60,000
                  字内，不含用户消息、项目指令与图片）。
                </Text>
                <Text>接收方：{recipientDisplay}；可能包含任务代码或命令输出。</Text>
                {recipient?.id === "google" ? (
                  <Text>Google 免费档数据会被用于改进产品。</Text>
                ) : null}
                <Text>确认后保存即生效。</Text>
              </>
            ) : (
              fields.map((id) => (
                <Box
                  key={id}
                  flexDirection="column"
                  flexShrink={0}
                  ref={(node) => {
                    onBox(id, node);
                  }}
                >
                  {id === "backend" ? (
                    <Segmented
                      options={["关闭", "决策模型", "小模型"]}
                      selected={BACKENDS.indexOf(backend)}
                      focused={focus === id}
                      width={innerWidth}
                      maxLines={1}
                    />
                  ) : (
                    <TextInput
                      value="设置 › 模型"
                      cursor={"设置 › 模型".length}
                      focused={focus === id}
                      width={innerWidth}
                    />
                  )}
                </Box>
              ))
            )}
          </Box>
          {notice ? (
            <Text color={theme.warning} wrap="truncate">
              {notice}
            </Text>
          ) : null}
          <Buttons
            focused={focus}
            readonly={false}
            width={innerWidth}
            onBox={onBox}
            {...(disclosure
              ? {
                  items: [
                    ["cancel", "取消"],
                    ["save", "确认启用"],
                  ] as const,
                }
              : {})}
          />
        </DialogFrame>
      )}
    </Box>
  );
}
