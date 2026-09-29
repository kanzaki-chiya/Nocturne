/**
 * 模型设置编辑（ADR-0024 第 5 节；tui.md §8）：服务商页内的两个子视图。
 * 列表页：按模型 id 排序的清单，行显示 id、上下文/最大输出、R/I 标记；
 * 编辑页：逐字段「字段名 当前值 [来源]」，光标跳过不可编辑行，
 * 文本行直接键入（空 = 跟随下层值），开关/枚举行 ←/→ 循环，
 * 思考档位 Enter 打开多选（「跟随」「不支持思考强度」与其余互斥）。
 * 组件只管交互与草稿，数据与校验走 Core（listModelSettings/saveModelSettings）。
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";

import {
  modelFieldSourceText,
  REASONING_EFFORT_LEVELS,
  type ModelField,
  type ModelSettingsPatch,
  type ModelSettingsView,
  type ReasoningEffortLevel,
} from "@nocturne/core";

import { useTuiEnv } from "../env.js";
import { padToWidth, truncateLine, truncateLineHead } from "../format.js";
import { theme } from "../theme.js";

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
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
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
      if (key.escape) {
        if (query !== "") {
          setQuery("");
          setCursor(0);
          return;
        }
        onBack();
        return;
      }
      if (views === undefined) return;
      if (key.upArrow) {
        setCursor((c) => (c + filtered.length - 1) % Math.max(1, filtered.length));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % Math.max(1, filtered.length));
        return;
      }
      if (key.return) {
        const v = filtered[cur];
        if (v !== undefined) onOpen(v.modelId);
        return;
      }
      if (key.backspace || key.delete) {
        if (query !== "") {
          setQuery((q) => q.slice(0, -1));
          setCursor(0);
        }
        return;
      }
      if (ch !== "" && !key.ctrl && !key.meta) {
        setQuery((q) => q + ch);
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
        <Text inverse> </Text>
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
              <Text inverse={focused} color={focused ? theme.accent : theme.success}>
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
  if (draft.reasoning !== "follow")
    patch.reasoning = draft.reasoning === "yes" ? "visible" : "none";
  else if (f.reasoning.userValue !== undefined) patch.reasoning = null;
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

/** 编辑子视图：字段行 + 底部 [保存] [取消]；思考档位经多选弹层 */
export function ModelEditPane({
  view,
  readonly,
  readonlyHint,
  error,
  saving,
  active,
  width,
  height,
  onSave,
  onBack,
}: {
  view: ModelSettingsView;
  /** 整个服务商只读：所有行不可聚焦，只剩返回 */
  readonly?: boolean | undefined;
  /** 只读原因（面包屑下方显示） */
  readonlyHint?: string | undefined;
  /** 上一次保存失败的原因（页内显示不退出） */
  error?: string | undefined;
  /** 保存进行中 */
  saving?: boolean | undefined;
  active: boolean;
  width: number;
  height: number;
  onSave: (patch: ModelSettingsPatch) => void;
  onBack: () => void;
}): React.JSX.Element {
  const env = useTuiEnv();
  const [draft, setDraft] = useState<Draft>(() => initDraft(view));
  const [cursor, setCursor] = useState(0);
  const [multi, setMulti] = useState<{ cursor: number; selected: number[] } | undefined>(undefined);

  // 可聚焦项：可编辑字段 + 保存 + 取消（readonly 时只剩取消）
  const reasoningValue =
    draft.reasoning === "follow"
      ? view.fields.reasoning.userValue !== undefined
        ? view.fields.reasoning.lowerValue
        : view.fields.reasoning.value
      : draft.reasoning === "yes"
        ? "visible"
        : "none";
  const visibleFields = FIELD_ORDER.filter(
    (k) => k !== "reasoningEffort" || reasoningValue === "visible" || reasoningValue === "hidden",
  );
  const focusables: (FieldKey | "save" | "cancel")[] = [
    ...visibleFields.filter((k) => readonly !== true && view.fields[k].editable),
    ...(readonly === true ? (["cancel"] as const) : (["save", "cancel"] as const)),
  ];
  const focusIndex = Math.min(cursor, Math.max(0, focusables.length - 1));
  const focused = focusables[focusIndex];
  const isField = (x: string): x is FieldKey => (FIELD_ORDER as readonly string[]).includes(x);

  const move = (delta: number): void => {
    setCursor((c) => (c + delta + focusables.length) % focusables.length);
  };
  const cycle = (key: FieldKey, delta: number): void => {
    setDraft((d) => {
      if (key === "imageInput") {
        const seq: TriState[] = ["follow", "true", "false"];
        const i = (seq.indexOf(d.imageInput) + delta + seq.length) % seq.length;
        return { ...d, imageInput: seq[i] ?? "follow" };
      }
      if (key === "protocol") {
        const seq: ProtocolDraft[] = ["follow", "chat", "messages"];
        const i = (seq.indexOf(d.protocol) + delta + seq.length) % seq.length;
        return { ...d, protocol: seq[i] ?? "follow" };
      }
      const seq: ReasoningDraft[] = ["follow", "yes", "no"];
      const i = (seq.indexOf(d.reasoning) + delta + seq.length) % seq.length;
      return { ...d, reasoning: seq[i] ?? "follow" };
    });
  };

  useInput(
    (ch, key) => {
      // 思考档位多选弹层
      if (multi !== undefined) {
        const total = 8; // 跟随 / 不支持 / 六档
        const toggle = (i: number): number[] => {
          if (i <= 1) return [i]; // 「跟随」「不支持」互斥且独占
          const sel = multi.selected.includes(i)
            ? multi.selected.filter((x) => x !== i)
            : [...multi.selected.filter((x) => x > 1), i].sort((a, b) => a - b);
          return sel;
        };
        if (key.escape) {
          setMulti(undefined);
          return;
        }
        if (key.upArrow) {
          setMulti((m) => m && { ...m, cursor: (m.cursor + total - 1) % total });
          return;
        }
        if (key.downArrow) {
          setMulti((m) => m && { ...m, cursor: (m.cursor + 1) % total });
          return;
        }
        if (ch === " ") {
          setMulti((m) => m && { ...m, selected: toggle(m.cursor) });
          return;
        }
        if (key.return) {
          const sel = multi.selected;
          setMulti(undefined);
          setDraft((d) => {
            if (sel.includes(0)) return { ...d, reasoningEffort: "follow" };
            if (sel.includes(1) || sel.length === 0) return { ...d, reasoningEffort: [] };
            const levels = sel
              .map((i) => REASONING_EFFORT_LEVELS[i - 2])
              .filter((l): l is ReasoningEffortLevel => l !== undefined);
            return { ...d, reasoningEffort: levels };
          });
          return;
        }
        return;
      }

      if (key.escape) {
        onBack();
        return;
      }
      if (saving === true) return;
      if (key.upArrow) {
        move(-1);
        return;
      }
      if (key.downArrow) {
        move(1);
        return;
      }
      if (focused !== undefined && isField(focused) && CYCLE_FIELDS.has(focused)) {
        if (key.leftArrow) {
          cycle(focused, -1);
          return;
        }
        if (key.rightArrow) {
          cycle(focused, 1);
          return;
        }
      }
      if (key.return) {
        if (focused === "save") {
          onSave(draftToPatch(view, draft));
          return;
        }
        if (focused === "cancel") {
          onBack();
          return;
        }
        if (focused === "reasoningEffort") {
          const d = draft.reasoningEffort;
          setMulti({
            cursor: 0,
            selected:
              d === "follow"
                ? [0]
                : d.length === 0
                  ? [1]
                  : d.map((l) => REASONING_EFFORT_LEVELS.indexOf(l) + 2).filter((i) => i >= 2),
          });
          return;
        }
        move(1);
        return;
      }
      // 文本字段：直接键入
      if (focused !== undefined && isField(focused) && TEXT_FIELDS.has(focused)) {
        const k = focused as "displayName" | "contextWindow" | "maxOutputTokens";
        if (key.backspace || key.delete) {
          setDraft((d) => ({ ...d, [k]: d[k].slice(0, -1) }));
          return;
        }
        if (ch !== "" && !key.ctrl && !key.meta) {
          setDraft((d) => ({ ...d, [k]: d[k] + ch }));
          return;
        }
      }
    },
    { isActive: active },
  );

  // 列宽按显示宽度：值列 = min(本页值文本最大宽度, 32)，来源列紧跟其后占剩余宽度
  const LABEL_W = 10;
  const valueTexts = visibleFields.map((k) => fieldValueText(k, draft, view.fields[k]));
  const VALUE_W = Math.min(Math.max(8, ...valueTexts.map((t) => stringWidth(t))), 32);
  const SOURCE_W = Math.max(8, width - 2 - LABEL_W - 1 - VALUE_W - 2);
  const row = (key: FieldKey): React.JSX.Element => {
    const f = view.fields[key];
    const enabled = readonly !== true && f.editable;
    const isFocus = focused === key;
    const text = valueTexts[visibleFields.indexOf(key)] ?? "";
    const editMark = isFocus && TEXT_FIELDS.has(key);
    const inner =
      `${isFocus ? "›" : " "} ${padToWidth(FIELD_LABELS[key], LABEL_W)} ` +
      padToWidth(truncateLine(text, VALUE_W), VALUE_W);
    return (
      <Text key={key} wrap="truncate">
        {isFocus ? (
          <Text inverse color={theme.accent}>
            {inner}
            {editMark ? <Text inverse> </Text> : null}
          </Text>
        ) : enabled ? (
          <Text>{inner}</Text>
        ) : (
          <Text color={theme.muted}>{inner}</Text>
        )}
        <Text color={theme.muted}>
          {`  ${truncateLineHead(modelFieldSourceText(f.source, key), SOURCE_W)}`}
        </Text>
      </Text>
    );
  };
  const buttonsFocus = focused === "save" || focused === "cancel";

  return (
    <Box flexDirection="column" height={height}>
      <Text color={theme.muted} wrap="truncate">
        {`服务商 ${view.providerId} › ${view.modelId}`}
      </Text>
      {readonlyHint !== undefined ? (
        <Text color={theme.warning} wrap="truncate">
          {readonlyHint}
        </Text>
      ) : null}
      {/* ADR-0026 §5：当前推导为不可用时提示原因（可经协议字段指定后恢复） */}
      {view.unavailable !== undefined ? (
        <Text color={theme.warning} wrap="truncate">
          {view.unavailable.reason}
        </Text>
      ) : null}
      {visibleFields.map((key) => row(key))}
      {readonly !== true ? (
        <Text wrap="truncate">
          {buttonsFocus ? "›" : " "} <Text inverse={focused === "save"}>[保存]</Text>
          {"  "}
          <Text inverse={focused === "cancel"}>[取消]</Text>
        </Text>
      ) : null}
      {multi === undefined ? (
        <Text color={theme.muted} wrap="truncate">
          {readonly === true
            ? " 只读 • Esc 返回 • Ctrl+C 退出"
            : " ↑/↓ 移动 • ←/→ 切换 • Enter 编辑/确认 • Esc 取消 • Ctrl+C 退出"}
        </Text>
      ) : null}
      {saving === true ? <Text color={theme.info}>正在保存…</Text> : null}
      {error !== undefined ? (
        <Text color={theme.error} wrap="truncate">
          {`! ${error}`}
        </Text>
      ) : null}
      {multi !== undefined ? (
        <Box flexDirection="column">
          <Text color={theme.accent}>思考档位</Text>
          {["跟随", "不支持思考强度", ...REASONING_EFFORT_LEVELS].map((label, i) => {
            const on = multi.selected.includes(i);
            const mark = env.ascii ? (on ? "[x]" : "[ ]") : on ? "[✓]" : "[ ]";
            return (
              <Text key={label} wrap="truncate">
                <Text inverse={multi.cursor === i}>
                  {`${multi.cursor === i ? "›" : " "} ${mark} ${label}`}
                </Text>
              </Text>
            );
          })}
          <Text color={theme.muted} wrap="truncate">
            {" 空格勾选 • Enter 确认 • Esc 取消 • Ctrl+C 退出"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
