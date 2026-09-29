/**
 * 模型设置编辑（ADR-0024 第 5 节；tui.md §8）：服务商页内的两个子视图。
 * 列表页：按模型 id 排序的清单，行显示 id、上下文/最大输出、R/I 标记；
 * 编辑页：逐字段「字段名 当前值 [来源]」，光标跳过不可编辑行，
 * 文本行直接键入（空 = 跟随下层值），开关/枚举行 ←/→ 循环，
 * 思考档位 Enter 打开多选（「跟随」「不支持思考强度」与其余互斥）。
 * 组件只管交互与草稿，数据与校验走 Core（listModelSettings/saveModelSettings）。
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";

import {
  modelFieldSourceText,
  REASONING_EFFORT_LEVELS,
  type ModelField,
  type ModelSettingsPatch,
  type ModelSettingsView,
  type ReasoningEffortLevel,
} from "@nocturne/core";

import { padToWidth, truncateLine } from "../format.js";
import { useTheme } from "../theme.js";
import { InputCursor } from "./input-cursor.js";
import { Buttons } from "./dialog/buttons.js";
import { ConfirmDiscard } from "./dialog/confirm-discard.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { focusOrder, moveFocus } from "./dialog/focus.js";
import { Segmented } from "./dialog/segmented.js";
import { SourceLine } from "./dialog/source-line.js";
import { inputWindow, TextInput } from "./dialog/text-input.js";

/** 上下文的紧凑写法（128000 → 128k） */
function contextText(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 能力标记：R = 推理（≠none），I = 图片输入 */
function flagsText(view: ModelSettingsView): string {
  const r =
    view.fields.reasoning.value === "visible" || view.fields.reasoning.value === "hidden"
      ? "R"
      : "·";
  const i = view.fields.imageInput.value === true ? "I" : "·";
  return `${r}${i}`;
}

/** 模型列表子视图（可过滤；Enter 进编辑；Esc 返回服务商列表） */
export function ModelListPane({
  providerId,
  views,
  readonlyHint,
  error,
  active,
  width,
  height,
  onOpen,
  onBack,
}: {
  providerId: string;
  /** undefined = 加载中 */
  views: readonly ModelSettingsView[] | undefined;
  /** 只读服务商的顶部提示 */
  readonlyHint?: string | undefined;
  /** 加载失败原因 */
  error?: string | undefined;
  active: boolean;
  width: number;
  height: number;
  onOpen: (modelId: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  // 镜像 ref：一次 'data' 突发里的多个按键可能在 React 提交前到达，
  // handler 读写同步更新的 ref，不用渲染闭包里的旧状态。
  const cursorRef = useRef(0);
  const queryRef = useRef("");
  const list = views ?? [];
  const filtered =
    query === "" ? list : list.filter((v) => v.modelId.toLowerCase().includes(query.toLowerCase()));
  const cur = Math.min(cursor, Math.max(0, filtered.length - 1));
  const hintLines = (readonlyHint !== undefined ? 1 : 0) + (error !== undefined ? 1 : 0);
  // 面包屑 1 行 + 提示行 + 过滤行 + 底部按键提示行
  const listH = Math.max(1, height - 3 - hintLines);
  const start = Math.min(
    Math.max(0, cur - Math.floor(listH / 2)),
    Math.max(0, filtered.length - listH),
  );
  const visible = filtered.slice(start, start + listH);

  useInput(
    (ch, key) => {
      // 编辑对话框打开时本列表只剩背景：isActive=false 的退订落后于帧提交，
      // 旧订阅仍可能被分发到（ADR-0030 §4：下层页面收不到任何按键）。
      if (!active) return;
      if (key.escape) {
        if (queryRef.current !== "") {
          queryRef.current = "";
          setQuery("");
          cursorRef.current = 0;
          setCursor(0);
          return;
        }
        onBack();
        return;
      }
      if (views === undefined) return;
      const filteredNow =
        queryRef.current === ""
          ? list
          : list.filter((v) => v.modelId.toLowerCase().includes(queryRef.current.toLowerCase()));
      if (key.upArrow) {
        cursorRef.current =
          (cursorRef.current + filteredNow.length - 1) % Math.max(1, filteredNow.length);
        setCursor(cursorRef.current);
        return;
      }
      if (key.downArrow) {
        cursorRef.current = (cursorRef.current + 1) % Math.max(1, filteredNow.length);
        setCursor(cursorRef.current);
        return;
      }
      if (key.return) {
        const v = filteredNow[Math.min(cursorRef.current, Math.max(0, filteredNow.length - 1))];
        if (v !== undefined) onOpen(v.modelId);
        return;
      }
      if (key.backspace || key.delete) {
        if (queryRef.current !== "") {
          queryRef.current = queryRef.current.slice(0, -1);
          setQuery(queryRef.current);
          cursorRef.current = 0;
          setCursor(0);
        }
        return;
      }
      if (ch !== "" && !key.ctrl && !key.meta) {
        queryRef.current += ch;
        setQuery(queryRef.current);
        cursorRef.current = 0;
        setCursor(0);
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" height={height}>
      <Text color={theme.muted} wrap="truncate">
        {`服务商 ${providerId} › 模型（${views === undefined ? "…" : list.length}）`}
      </Text>
      {readonlyHint !== undefined ? (
        <Text color={theme.warning} wrap="truncate">
          {readonlyHint}
        </Text>
      ) : null}
      {error !== undefined ? (
        <Text color={theme.error} wrap="truncate">
          {`! ${error}`}
        </Text>
      ) : null}
      <Text wrap="truncate">
        <Text color={theme.muted}>{"过滤: "}</Text>
        {query}
        <Text color={theme.selected} backgroundColor={theme.selectionBg}>
          {" "}
        </Text>
      </Text>
      {views === undefined ? (
        <Text color={theme.muted}>正在读取模型设置…</Text>
      ) : filtered.length === 0 ? (
        <Text color={theme.muted}>（无模型）</Text>
      ) : (
        visible.map((v, i) => {
          const idx = start + i;
          const focused = idx === cur;
          const row =
            `${focused ? "›" : " "} ${padToWidth(v.modelId, 28)} ` +
            `${padToWidth(contextText(v.fields.contextWindow.value) + "/" + contextText(v.fields.maxOutputTokens.value), 9)} ` +
            flagsText(v);
          return (
            <Text key={v.modelId} wrap="truncate">
              <Text
                color={focused ? theme.selected : theme.success}
                {...(focused ? { backgroundColor: theme.selectionBg } : {})}
              >
                {truncateLine(row, width - 2)}
              </Text>
              {/* ADR-0026 §5：不可用模型照常列出并标注 */}
              {v.unavailable !== undefined ? <Text color={theme.muted}> 协议不支持</Text> : null}
            </Text>
          );
        })
      )}
      <Text color={theme.muted} wrap="truncate">
        {readonlyHint !== undefined
          ? " 只读 • Esc 返回 • Ctrl+C 退出"
          : " ↑/↓ 选择 • Enter 编辑 • Esc 返回 • Ctrl+C 退出"}
      </Text>
    </Box>
  );
}

// ── 编辑页 ──────────────────────────────────────────────

const FIELD_ORDER = [
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "imageInput",
  "reasoning",
  "reasoningEffort",
  "protocol",
] as const;
type FieldKey = (typeof FIELD_ORDER)[number];
const FIELD_LABELS: Record<FieldKey, string> = {
  displayName: "显示名",
  contextWindow: "上下文长度",
  maxOutputTokens: "最大输出",
  imageInput: "图片输入",
  reasoning: "推理",
  reasoningEffort: "思考档位",
  // ADR-0026 §7：第七个字段「协议」
  protocol: "协议",
};
const TEXT_FIELDS: ReadonlySet<FieldKey> = new Set([
  "displayName",
  "contextWindow",
  "maxOutputTokens",
]);
const CYCLE_FIELDS: ReadonlySet<FieldKey> = new Set(["imageInput", "reasoning", "protocol"]);

type TriState = "follow" | "true" | "false";
type ReasoningDraft = "follow" | "yes" | "no";
/** 协议选项（ADR-0026 §7）：跟随 / Chat Completions / Messages */
type ProtocolDraft = "follow" | "chat" | "messages";

interface Draft {
  displayName: string;
  contextWindow: string;
  maxOutputTokens: string;
  imageInput: TriState;
  reasoning: ReasoningDraft;
  reasoningEffort: "follow" | ReasoningEffortLevel[];
  protocol: ProtocolDraft;
}

function initDraft(view: ModelSettingsView): Draft {
  const f = view.fields;
  return {
    displayName: f.displayName.userValue ?? "",
    contextWindow: f.contextWindow.userValue !== undefined ? String(f.contextWindow.userValue) : "",
    maxOutputTokens:
      f.maxOutputTokens.userValue !== undefined ? String(f.maxOutputTokens.userValue) : "",
    imageInput:
      f.imageInput.userValue === undefined ? "follow" : f.imageInput.userValue ? "true" : "false",
    reasoning:
      f.reasoning.userValue === undefined
        ? "follow"
        : f.reasoning.userValue === "none"
          ? "no"
          : "yes",
    reasoningEffort: f.reasoningEffort.userValue ?? "follow",
    protocol:
      f.protocol.userValue === undefined
        ? "follow"
        : f.protocol.userValue === "anthropic"
          ? "messages"
          : "chat",
  };
}

/** 单个值的显示：undefined → 未声明；布尔 → 是/否；数组 → 斜杠连接（空 = 不支持） */
function scalarText(v: unknown): string {
  if (v === undefined) return "未声明";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (Array.isArray(v)) return v.length > 0 ? v.join("/") : "不支持";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return "未声明";
}

/**
 * 字段行当前值（tui.md §8）：
 * - 只读字段（config 来源）：直接显示生效值，不出现「跟随」；
 * - 可编辑字段「跟随」：无用户编辑时显示生效值 field.value，
 *   用户改回跟随/清空时显示回落值 field.lowerValue。
 */
function fieldValueText(key: FieldKey, draft: Draft, field: ModelField<unknown>): string {
  const show = (value: unknown): string => {
    if (key === "reasoning" && value !== undefined) return value === "none" ? "否" : "是";
    // 协议：undefined = 推导为 unavailable（ADR-0026 §5）
    if (key === "protocol") {
      if (value === "openai-compatible") return "Chat Completions";
      if (value === "anthropic") return "Messages";
      return "协议不支持";
    }
    return scalarText(value);
  };
  if (!field.editable) return show(field.value);
  const followBase = field.userValue !== undefined ? field.lowerValue : field.value;
  const follow = `跟随（${show(followBase)}）`;
  if (TEXT_FIELDS.has(key)) {
    const raw = draft[key as "displayName" | "contextWindow" | "maxOutputTokens"];
    return raw !== "" ? raw : follow;
  }
  if (key === "imageInput") {
    const d = draft.imageInput;
    if (d === "follow") return follow;
    return d === "true" ? "是" : "否";
  }
  if (key === "reasoning") {
    const d = draft.reasoning;
    return d === "follow" ? follow : d === "yes" ? "是" : "否";
  }
  if (key === "protocol") {
    const d = draft.protocol;
    return d === "follow" ? follow : d === "chat" ? "Chat Completions" : "Messages";
  }
  // reasoningEffort
  const d = draft.reasoningEffort;
  if (d === "follow") return follow;
  return d.length > 0 ? d.join(" / ") : "不支持思考强度";
}

/** 当前草稿 → 补丁（跟随/为空写 null 清除用户编辑，仅在该字段有用户编辑时） */
export function draftToPatch(view: ModelSettingsView, draft: Draft): ModelSettingsPatch {
  const f = view.fields;
  const patch: ModelSettingsPatch = {};
  const num = (s: string): number | null =>
    s === "" ? null : Number.isInteger(Number(s)) && Number(s) > 0 ? Number(s) : null;
  if (draft.displayName !== "") patch.displayName = draft.displayName;
  else if (f.displayName.userValue !== undefined) patch.displayName = null;
  if (draft.contextWindow !== "") {
    const n = num(draft.contextWindow);
    if (n !== null) patch.contextWindow = n;
    else patch.contextWindow = -1; // 非法值交给 Core 校验报错（保持 patch 形状）
  } else if (f.contextWindow.userValue !== undefined) patch.contextWindow = null;
  if (draft.maxOutputTokens !== "") {
    const n = num(draft.maxOutputTokens);
    if (n !== null) patch.maxOutputTokens = n;
    else patch.maxOutputTokens = -1;
  } else if (f.maxOutputTokens.userValue !== undefined) patch.maxOutputTokens = null;
  if (draft.imageInput !== "follow") patch.imageInput = draft.imageInput === "true";
  else if (f.imageInput.userValue !== undefined) patch.imageInput = null;
  // 修复原有 bug（ADR-0030 §3）：已有 hidden 显示为「是」，未改动时不可写成 visible。
  if (draft.reasoning !== "follow") {
    if (!(f.reasoning.userValue === "hidden" && draft.reasoning === "yes"))
      patch.reasoning = draft.reasoning === "yes" ? "visible" : "none";
  } else if (f.reasoning.userValue !== undefined) patch.reasoning = null;
  if (draft.reasoning === "no" && f.reasoningEffort.userValue !== undefined)
    patch.reasoningEffort = null;
  else if (draft.reasoningEffort !== "follow") patch.reasoningEffort = draft.reasoningEffort;
  else if (f.reasoningEffort.userValue !== undefined) patch.reasoningEffort = null;
  // ADR-0026 §7：跟随 = 清除用户编辑（写 null），仅在有用户编辑时
  if (draft.protocol !== "follow")
    patch.protocol = draft.protocol === "messages" ? "anthropic" : "openai-compatible";
  else if (f.protocol.userValue !== undefined) patch.protocol = null;
  return patch;
}

/** 模型编辑对话框。 */
export function ModelEditPane({
  view,
  readonly = false,
  readonlyHint,
  error,
  saving = false,
  active,
  width,
  height,
  onSave,
  onBack,
}: {
  view: ModelSettingsView;
  readonly?: boolean | undefined;
  readonlyHint?: string | undefined;
  error?: string | undefined;
  saving?: boolean | undefined;
  active: boolean;
  width: number;
  height: number;
  onSave: (patch: ModelSettingsPatch) => void;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [draft, setDraft] = useState<Draft>(() => initDraft(view));
  const [focused, setFocused] = useState<string>(() =>
    readonly ? "return" : (FIELD_ORDER.find((k) => view.fields[k].editable) ?? "cancel"),
  );
  const [position, setPosition] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [discard, setDiscard] = useState<boolean | undefined>();
  const [multi, setMulti] = useState<{ cursor: number; selected: number[] }>();
  const savingGuard = useRef(false);
  useEffect(() => {
    if (!saving) savingGuard.current = false;
  }, [saving]);
  // 镜像 ref：一次 'data' 突发里的多个按键可能在 React 提交前到达，
  // handler 必须读写同步更新的 ref，不能依赖渲染闭包里的状态。
  const draftRef = useRef(draft);
  const focusRef = useRef(focused);
  const posRef = useRef(position);
  const discardRef = useRef(discard);
  const multiRef = useRef(multi);
  const reasoning =
    draft.reasoning === "follow"
      ? view.fields.reasoning.userValue !== undefined
        ? view.fields.reasoning.lowerValue
        : view.fields.reasoning.value
      : draft.reasoning === "no"
        ? "none"
        : "visible";
  const fields = FIELD_ORDER.filter(
    (k) => k !== "reasoningEffort" || reasoning === "visible" || reasoning === "hidden",
  );
  const pageReadonly = readonly || fields.every((key) => !view.fields[key].editable);
  const order = focusOrder(
    fields.map((key) => ({ key, editable: view.fields[key].editable })),
    pageReadonly,
  );
  const current = order.includes(focused) ? focused : (order[0] ?? "return");
  const currentField = fields.includes(current as FieldKey) ? (current as FieldKey) : undefined;
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const value = draft[key];
    if (value !== "" && !(Number.isInteger(Number(value)) && Number(value) > 0))
      errors[key] = "请输入正整数";
  }
  const move = (direction: "tab" | "shiftTab" | "up" | "down" | "left" | "right"): void => {
    const cur = order.includes(focusRef.current) ? focusRef.current : (order[0] ?? "return");
    const next = moveFocus(order, cur, direction);
    focusRef.current = next;
    setFocused(next);
    if (TEXT_FIELDS.has(next as FieldKey)) {
      posRef.current = Array.from(
        draftRef.current[next as "displayName" | "contextWindow" | "maxOutputTokens"],
      ).length;
      setPosition(posRef.current);
    }
  };
  const cancel = (): void => {
    if (JSON.stringify(draftRef.current) !== JSON.stringify(initDraft(view))) {
      discardRef.current = false;
      setDiscard(false);
    } else onBack();
  };
  const cycle = (field: "imageInput" | "reasoning" | "protocol", delta: number): void => {
    const d = draftRef.current;
    const choices =
      field === "imageInput"
        ? ["follow", "true", "false"]
        : field === "reasoning"
          ? ["follow", "yes", "no"]
          : ["follow", "chat", "messages"];
    draftRef.current = {
      ...d,
      [field]: choices[Math.max(0, Math.min(2, choices.indexOf(d[field]) + delta))],
    };
    setDraft(draftRef.current);
  };
  useInput(
    (ch, key) => {
      if (!active) return;
      if (tiny) {
        if (key.escape) onBack();
        return;
      }
      if (saving || savingGuard.current) return;
      if (discardRef.current !== undefined) {
        if (key.escape) {
          discardRef.current = undefined;
          setDiscard(undefined);
        } else if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
          discardRef.current = !discardRef.current;
          setDiscard(discardRef.current);
        } else if (key.return || ch === " ") {
          const drop = discardRef.current;
          discardRef.current = undefined;
          setDiscard(undefined);
          if (drop) onBack();
        }
        return;
      }
      if (multiRef.current) {
        const m = multiRef.current;
        if (key.escape) {
          multiRef.current = undefined;
          setMulti(undefined);
          return;
        }
        if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
          const delta = key.shift || key.upArrow || key.leftArrow ? -1 : 1;
          multiRef.current = { ...m, cursor: (m.cursor + 8 + delta) % 8 };
          setMulti(multiRef.current);
          return;
        }
        if (ch === " ") {
          const selected =
            m.cursor <= 1
              ? [m.cursor]
              : m.selected.includes(m.cursor)
                ? m.selected.filter((i) => i !== m.cursor)
                : [...m.selected.filter((i) => i > 1), m.cursor].sort((a, b) => a - b);
          multiRef.current = { ...m, selected };
          setMulti(multiRef.current);
          return;
        }
        if (key.return) {
          const sel = m.selected;
          draftRef.current = {
            ...draftRef.current,
            reasoningEffort: sel.includes(0)
              ? "follow"
              : sel.includes(1) || sel.length === 0
                ? []
                : sel
                    .map((i) => REASONING_EFFORT_LEVELS[i - 2])
                    .filter((x): x is ReasoningEffortLevel => x !== undefined),
          };
          setDraft(draftRef.current);
          multiRef.current = undefined;
          setMulti(undefined);
        }
        return;
      }
      if (key.escape) {
        cancel();
        return;
      }
      if (key.tab) {
        move(key.shift ? "shiftTab" : "tab");
        return;
      }
      if (key.upArrow || key.downArrow) {
        move(key.upArrow ? "up" : "down");
        return;
      }
      const cur = order.includes(focusRef.current) ? focusRef.current : (order[0] ?? "return");
      if (cur === "save" || cur === "cancel" || cur === "return") {
        if (key.leftArrow || key.rightArrow) move(key.leftArrow ? "left" : "right");
        else if (key.return || ch === " ") {
          if (cur === "save") {
            savingGuard.current = true;
            onSave(draftToPatch(view, draftRef.current));
          } else cancel();
        }
        return;
      }
      if (cur === "reasoningEffort") {
        if (key.return || ch === " ") {
          const value = draftRef.current.reasoningEffort;
          multiRef.current = {
            cursor: 0,
            selected:
              value === "follow"
                ? [0]
                : value.length === 0
                  ? [1]
                  : value.map((x) => REASONING_EFFORT_LEVELS.indexOf(x) + 2),
          };
          setMulti(multiRef.current);
        }
        return;
      }
      if (CYCLE_FIELDS.has(cur as FieldKey)) {
        if (key.leftArrow || key.rightArrow)
          cycle(cur as "imageInput" | "reasoning" | "protocol", key.leftArrow ? -1 : 1);
        return;
      }
      if (TEXT_FIELDS.has(cur as FieldKey)) {
        const field = cur as "displayName" | "contextWindow" | "maxOutputTokens";
        const chars = Array.from(draftRef.current[field]);
        if (key.return) {
          move("tab");
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          posRef.current = Math.max(
            0,
            Math.min(chars.length, posRef.current + (key.leftArrow ? -1 : 1)),
          );
          setPosition(posRef.current);
          return;
        }
        if (key.home || key.end) {
          posRef.current = key.home ? 0 : chars.length;
          setPosition(posRef.current);
          return;
        }
        if (key.backspace || key.delete) {
          if (key.backspace && posRef.current > 0) {
            chars.splice(posRef.current - 1, 1);
            posRef.current -= 1;
          } else if (key.delete && posRef.current < chars.length) chars.splice(posRef.current, 1);
          setPosition(posRef.current);
          draftRef.current = { ...draftRef.current, [field]: chars.join("") };
          setDraft(draftRef.current);
          return;
        }
        if (ch !== "" && !key.ctrl && !key.meta) {
          chars.splice(posRef.current, 0, ...Array.from(ch));
          posRef.current += Array.from(ch).length;
          setPosition(posRef.current);
          draftRef.current = { ...draftRef.current, [field]: chars.join("") };
          setDraft(draftRef.current);
        }
      }
    },
    { isActive: active },
  );
  const preferredWidth = Math.max(1, Math.min(72, width - 4));
  const fieldMin = currentField === "protocol" ? 19 : currentField === "reasoningEffort" ? 18 : 10;
  const framed = preferredWidth - 4 >= 12 + fieldMin && height - 2 >= 8;
  const outerWidth = framed ? preferredWidth : width;
  const innerWidth = outerWidth - (framed ? 4 : 2);
  const compact = innerWidth < 12 + fieldMin;
  const single = compact && innerWidth < fieldMin + 6;
  const tiny = height < (single ? 4 : 6) || width < (single ? 8 : 12);
  const rowHeight = (key: FieldKey): number => {
    const label = compact ? 4 : 12;
    const available = innerWidth - label - 3;
    const value = fieldValueText(key, draft, view.fields[key]);
    const controlRows =
      key === "reasoningEffort"
        ? Math.ceil(stringWidth(`[ 编辑档位… ] 当前：${value}`) / Math.max(1, available))
        : 1;
    return Math.max(1, controlRows) + (single ? 0 : 1) + (errors[key] ? 1 : 0);
  };
  const hintRows = (readonlyHint ? 1 : 0) + (view.unavailable ? 1 : 0);
  // 高度按字段实际行数（档位折行、错误行）计算，放得下就不滚动
  const totalRows = fields.reduce((n, key) => n + rowHeight(key), 0);
  const outerHeight = framed ? Math.min(height - 2, 2 + 4 + hintRows + totalRows) : height;
  const left = framed ? Math.floor((width - outerWidth) / 2) : 0;
  const top = framed ? Math.floor((height - outerHeight) / 2) : 0;
  const fieldHeight = Math.max(1, outerHeight - (framed ? 2 : 0) - 4 - hintRows);
  const fieldStart = fields
    .slice(0, Math.max(0, fields.indexOf(current as FieldKey)))
    .reduce((n, key) => n + rowHeight(key), 0);
  const fieldEnd = fieldStart + (currentField ? rowHeight(currentField) : 0);
  // 只滚到焦点字段刚好可见为止，并且不滚过内容末尾（避免下方留空）
  const wanted =
    currentField === undefined
      ? scroll
      : fieldStart < scroll
        ? fieldStart
        : fieldEnd > scroll + fieldHeight
          ? fieldEnd - fieldHeight
          : scroll;
  const nextScroll = Math.max(0, Math.min(wanted, totalRows - fieldHeight));
  if (nextScroll !== scroll) setScroll(nextScroll);
  let rowOffset = 0;
  const visible = single
    ? fields.filter((field) => field === currentField)
    : fields.filter((field) => {
        const start = rowOffset;
        rowOffset += rowHeight(field);
        return start >= nextScroll && start < nextScroll + fieldHeight;
      });
  const row = (field: FieldKey): React.JSX.Element => {
    const f = view.fields[field],
      editable = !readonly && f.editable,
      focus = current === field;
    const label = compact ? FIELD_LABELS[field].slice(0, 2) : FIELD_LABELS[field];
    const prefix = `${focus ? "> " : "  "}${padToWidth(label, compact ? 4 : 12)} `;
    const value = fieldValueText(field, draft, f);
    let control: React.JSX.Element;
    if (!editable)
      control = (
        <Text color={theme.muted} wrap="truncate">
          {value} [只读]
        </Text>
      );
    else if (TEXT_FIELDS.has(field)) {
      const raw = draft[field as "displayName" | "contextWindow" | "maxOutputTokens"];
      control = (
        <TextInput
          value={raw}
          cursor={focus ? position : Array.from(raw).length}
          focused={focus}
          width={Math.max(5, innerWidth - stringWidth(prefix) - 1)}
          invalid={errors[field] !== undefined}
        />
      );
    } else if (CYCLE_FIELDS.has(field)) {
      const selected =
        field === "imageInput"
          ? ["follow", "true", "false"].indexOf(draft.imageInput)
          : field === "reasoning"
            ? ["follow", "yes", "no"].indexOf(draft.reasoning)
            : ["follow", "chat", "messages"].indexOf(draft.protocol);
      control = (
        <Segmented
          options={
            field === "protocol" ? ["跟随", "Chat Completions", "Messages"] : ["跟随", "是", "否"]
          }
          selected={selected}
          focused={false}
          width={Math.max(1, innerWidth - stringWidth(prefix))}
          maxLines={single ? 1 : 2}
        />
      );
    } else control = <Text color={theme.text}>[ 编辑档位… ] 当前：{value}</Text>;
    const source =
      modelFieldSourceText(f.source, field) + (value.startsWith("跟随（") ? `；${value}` : "");
    return (
      <Box key={field} flexDirection="column" flexShrink={0}>
        <Box flexDirection="row">
          <Text color={focus ? theme.accent : editable ? theme.text : theme.muted}>{prefix}</Text>
          {control}
          {errors[field] ? <Text color={theme.error}> !</Text> : null}
        </Box>
        {/* ADR-0030 §3：来源与错误行缩进 2 列，跟在控件下方 */}
        {!single ? (
          <Box paddingLeft={2}>
            <SourceLine source={source} width={innerWidth - 2} />
          </Box>
        ) : null}
        {errors[field] ? (
          <Box paddingLeft={2}>
            <Text color={theme.error}>! {errors[field]}</Text>
          </Box>
        ) : null}
        {focus && TEXT_FIELDS.has(field) && !tiny ? (
          <InputCursor
            active
            prefix=""
            text=""
            width={innerWidth}
            x={
              left +
              (framed ? 2 : 0) +
              stringWidth(prefix) +
              2 +
              inputWindow(
                draft[field as "displayName" | "contextWindow" | "maxOutputTokens"],
                position,
                Math.max(5, innerWidth - stringWidth(prefix) - 1),
              ).column
            }
            y={top + (framed ? 1 : 0) + 1 + hintRows + fieldStart - nextScroll - height}
          />
        ) : null}
      </Box>
    );
  };
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      paddingTop={top}
      paddingLeft={left}
    >
      {tiny ? (
        <Text color={theme.warning}>终端太小，请放大（Esc 返回）</Text>
      ) : (
        <DialogFrame
          title={`服务商 ${view.providerId} / 模型 ${view.modelId}`}
          width={outerWidth}
          height={outerHeight}
          framed={framed}
        >
          {readonlyHint ? (
            <Box flexShrink={0}>
              <Text color={theme.warning} wrap="truncate">
                {readonlyHint}
              </Text>
            </Box>
          ) : null}
          {view.unavailable ? (
            <Box flexShrink={0}>
              <Text color={theme.warning} wrap="truncate">
                {view.unavailable.reason}
              </Text>
            </Box>
          ) : null}
          {multi ? (
            <Box flexDirection="column" height={fieldHeight} overflow="hidden">
              <Text color={theme.accent}>思考档位</Text>
              {["跟随", "不支持思考强度", ...REASONING_EFFORT_LEVELS].map((label, i) => (
                <Text
                  key={label}
                  color={multi.cursor === i ? theme.selected : theme.text}
                  {...(multi.cursor === i ? { backgroundColor: theme.selectionBg } : {})}
                >
                  {multi.cursor === i ? "> " : "  "}[{multi.selected.includes(i) ? "x" : " "}]{" "}
                  {label}
                </Text>
              ))}
              <Text color={theme.muted}>空格勾选 Enter 确认 Esc 取消</Text>
            </Box>
          ) : (
            <Box flexDirection="column" height={fieldHeight} overflow="hidden">
              {visible.map(row)}
            </Box>
          )}
          <Box flexShrink={0}>
            <Text color={error ? theme.error : theme.muted} wrap="truncate">
              {error ? `! 保存失败：${error}` : saving ? "正在保存…" : " "}
            </Text>
          </Box>
          {discard === undefined ? (
            <Buttons focused={current} readonly={pageReadonly} width={innerWidth} />
          ) : (
            <ConfirmDiscard discard={discard} />
          )}
          <Box flexShrink={0}>
            <Text color={theme.muted} wrap="truncate">
              {"Tab/方向键移动  空格/Enter 选择  Esc 取消"}
            </Text>
          </Box>
        </DialogFrame>
      )}
    </Box>
  );
}
