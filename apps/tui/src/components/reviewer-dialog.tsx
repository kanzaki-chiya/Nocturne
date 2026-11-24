import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  decisionModelRecipient,
  validateSettingsPatch,
  type DecisionModelConfig,
  type Runtime,
  type SecurityReviewerConfig,
} from "@nocturne/core";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { Buttons } from "./dialog/buttons.js";
import { Segmented } from "./dialog/segmented.js";
import { TextInput, inputWindow } from "./dialog/text-input.js";
import { moveFocus } from "./dialog/focus.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { InputCursor } from "./input-cursor.js";
import { ModelPicker } from "./model-picker.js";
import { useTheme } from "../theme.js";

const BACKENDS = ["off", "decision", "model"] as const;

function parseAcceptedRecipients(
  raw: string | undefined,
  legacyJev: string | undefined,
): Set<string> {
  const set = new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
  if (legacyJev === "yes") set.add("opencode-zen");
  return set;
}

export function ReviewerDialog({
  runtime,
  initial,
  decisionModel,
  disclosureAccepted = false,
  width,
  height,
  onOpenDecisionModel,
  onApply,
  onCancel,
  onMouseFrame,
}: {
  runtime: Runtime;
  initial: SecurityReviewerConfig | undefined;
  decisionModel: DecisionModelConfig | undefined;
  disclosureAccepted?: boolean | undefined;
  width: number;
  height: number;
  onOpenDecisionModel?: (() => void) | undefined;
  /** 保存即落盘：返回错误文案则留在对话框内显示，成功返回 undefined 由调用方关闭 */
  onApply: (
    reviewer: SecurityReviewerConfig,
    acceptedRecipient?: string,
  ) => Promise<string | undefined>;
  onCancel: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [backend, setBackend] = useState<"off" | "decision" | "model">(() => {
    if (initial?.backend === "model") return "model";
    if (initial?.backend === "decision" || initial?.backend === "jev") return "decision";
    return "off";
  });
  const [model, setModel] = useState(initial?.backend === "model" ? initial.model : undefined);
  const [threshold, setThreshold] = useState(
    initial !== undefined && (initial.backend === "decision" || initial.backend === "jev")
      ? String(initial.minConfidence ?? 0.7)
      : "0.7",
  );
  const [focus, setFocus] = useState("backend");
  const [nested, setNested] = useState<"model" | undefined>();
  const [notice, setNotice] = useState<string>();
  const [disclosure, setDisclosure] = useState(false);
  const [accepted, setAccepted] = useState(disclosureAccepted);
  const [cursor, setCursor] = useState(0);
  const boxes = useRef(new Map<string, DOMElement>());
  const mounted = useRef(true);
  const saving = useRef(false);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const fields =
    backend === "decision"
      ? ["backend", "decisionModel", "threshold"]
      : backend === "model"
        ? ["backend", "model"]
        : ["backend"];
  const order = [...fields, "cancel", "save"];
  const editing = focus === "threshold";

  const recipient = decisionModel !== undefined ? decisionModelRecipient(decisionModel) : undefined;
  const recipientDisplay =
    decisionModel?.endpoint === "custom"
      ? (decisionModel.baseURL ?? "自定义地址")
      : (recipient?.label ?? "");

  const apply = (confirmed = accepted) => {
    if (backend === "model" && !model) {
      setNotice("请选择审查模型");
      setFocus("model");
      return;
    }
    if (backend === "decision" && decisionModel === undefined) {
      setNotice("先设置决策模型");
      return;
    }
    const confidence = threshold.trim() === "" ? undefined : Number(threshold);
    if (
      backend === "decision" &&
      confidence !== undefined &&
      !(confidence >= 0 && confidence <= 1)
    ) {
      setNotice("置信度阈值应在 0–1 之间");
      setFocus("threshold");
      return;
    }
    const selected: SecurityReviewerConfig =
      backend === "decision"
        ? {
            backend: "decision",
            ...(confidence !== undefined ? { minConfidence: confidence } : {}),
          }
        : backend === "model" && model
          ? { backend, model }
          : { backend: "off" };
    try {
      validateSettingsPatch({ "permission.reviewer": selected });
    } catch {
      setNotice("请填写有效的配置");
      return;
    }
    if (backend === "decision" && recipient !== undefined && !confirmed) {
      const acceptedSet = parseAcceptedRecipients(
        runtime.getPreference("decisionDisclosureAccepted"),
        runtime.getPreference("jevDisclosureAccepted"),
      );
      if (!acceptedSet.has(recipient.id)) {
        setDisclosure(true);
        setFocus("cancel");
        return;
      }
    }
    if (saving.current) return;
    saving.current = true;
    void onApply(
      selected,
      backend === "decision" && confirmed && recipient !== undefined ? recipient.id : undefined,
    ).then((failure) => {
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
      if (disclosure) {
        setAccepted(true);
        apply(true);
      } else apply();
    } else if (id === "backend") {
      if (backend === "model") setNested("model");
      else if (backend === "decision") setFocus("decisionModel");
      else setFocus("save");
    } else if (id === "decisionModel") {
      onOpenDecisionModel?.();
    } else if (id === "model") {
      setNested("model");
    } else if (id === "threshold") {
      setFocus("save");
    }
  };

  useInput(
    (input, key) => {
      if (nested !== undefined) return;
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
        const next = moveFocus(order, focus, dir);
        setFocus(next);
        if (next === "threshold") setCursor(Array.from(threshold).length);
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
        if (editing) {
          const chars = Array.from(threshold);
          setCursor(Math.max(0, Math.min(chars.length, cursor + step)));
          return;
        }
      }
      if (key.return) {
        activate(focus);
        return;
      }
      if (editing) {
        const chars = Array.from(threshold);
        const pos = Math.max(0, Math.min(chars.length, cursor));
        if (key.backspace || key.delete) {
          if (pos > 0) {
            chars.splice(pos - 1, 1);
            setThreshold(chars.join(""));
            setCursor(pos - 1);
          }
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          const inserted = Array.from(input);
          chars.splice(pos, 0, ...inserted);
          setThreshold(chars.join(""));
          setCursor(pos + inserted.length);
        }
      }
    },
    { isActive: nested === undefined },
  );

  const framed = width >= 44 && height >= 12;
  const dialogWidth = Math.min(width, 64);
  const dialogHeight = Math.min(height, Math.max(10, fields.length * 2 + 6));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const innerWidth = Math.max(10, dialogWidth - (framed ? 4 : 2));
  const visibleCount = Math.max(1, Math.floor((dialogHeight - 5) / 2));
  const focusIndex = Math.max(0, fields.indexOf(focus));
  const start = Math.max(0, Math.min(fields.length - visibleCount, focusIndex - visibleCount + 1));

  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };

  useEffect(() => {
    if (!onMouseFrame) return;
    if (nested !== undefined) {
      onMouseFrame(undefined);
      return;
    }
    const activeIds = disclosure ? ["cancel", "save"] : order;
    const hitBoxes: DialogMouseFrame["boxes"] = activeIds.flatMap((id) => {
      const node = boxes.current.get(id);
      if (!node) return [];
      const rect = screenRect(node);
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
    });
    onMouseFrame({
      layer: "reviewer",
      boxes: hitBoxes,
      click: (id) => {
        setFocus(id);
        if (id === "cancel" || id === "save" || id === "decisionModel" || id === "model")
          activate(id);
      },
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });

  const decisionSummary =
    decisionModel === undefined
      ? "未设置 · 设置 › 模型"
      : `${decisionModel.model} ${decisionModel.source === "gemini" ? "Gemini" : "Jev"} · 设置 › 模型`;

  const labels: Record<string, string> = {
    backend: "审查器",
    decisionModel: "决策模型",
    threshold: "置信度阈值",
    model: "小模型",
  };
  const values: Record<string, string> = {
    decisionModel: decisionSummary,
    threshold,
    model: model ? `${model.provider}/${model.model}` : "未选择",
  };

  const picker =
    nested === "model" ? (
      <ModelPicker
        models={runtime.listModels()}
        recents={[]}
        providers={[]}
        presets={[]}
        current={model}
        defaultModel={undefined}
        wizard={undefined}
        onStartWizard={() => {
          setNested(undefined);
        }}
        selectionOnly
        onPick={(ref) => {
          const slash = ref.indexOf("/");
          setModel({ provider: ref.slice(0, slash), model: ref.slice(slash + 1) });
          setNested(undefined);
          setFocus("save");
        }}
        onClose={() => {
          setNested(undefined);
        }}
        width={innerWidth}
        height={Math.max(1, dialogHeight - 4)}
        active
      />
    ) : undefined;

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
          title={nested === "model" ? "/settings · 安全审查模型" : "/settings · 安全审查"}
          width={dialogWidth}
          height={dialogHeight}
          framed={framed}
        >
          {picker ?? (
            <>
              <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {disclosure ? (
                  <>
                    <Text>首次启用决策模型审查</Text>
                    <Text>
                      将发送待确认操作的类别、目标/命令、工作目录、全部用户消息（约 8000
                      字内）、项目说明前 2000 字和 git remote 地址。
                    </Text>
                    <Text>接收方：{recipientDisplay}；可能包含任务代码或命令文本。</Text>
                    <Text>确认后保存即生效。</Text>
                  </>
                ) : (
                  fields.slice(start, start + visibleCount).map((id, index) => (
                    <Box
                      key={id}
                      flexDirection="column"
                      flexShrink={0}
                      ref={(node) => {
                        onBox(id, node);
                      }}
                    >
                      <Text color={theme.muted} wrap="truncate">
                        {labels[id]}
                      </Text>
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
                          value={values[id] ?? ""}
                          cursor={Math.min(cursor, Array.from(values[id] ?? "").length)}
                          focused={focus === id}
                          width={innerWidth}
                        />
                      )}
                      {focus === id && editing ? (
                        <InputCursor
                          active
                          prefix=""
                          text=""
                          width={innerWidth}
                          x={
                            left +
                            (framed ? 2 : 0) +
                            2 +
                            inputWindow(
                              threshold,
                              Math.min(cursor, Array.from(threshold).length),
                              innerWidth,
                            ).column
                          }
                          y={top + (framed ? 1 : 0) + 2 + index * 2 - height}
                        />
                      ) : null}
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
            </>
          )}
        </DialogFrame>
      )}
    </Box>
  );
}
