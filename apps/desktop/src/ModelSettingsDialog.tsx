/**
 * 模型设置对话框（desktop-v3.html D 屏）：八项字段 + 来源 + 「全部恢复跟随」。
 * 草稿→补丁语义与 TUI model-settings-view 一致：跟随/为空写 null 清除用户编辑。
 */
import { useMemo, useState } from "react";
import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from "@nocturne/core/protocol";
import type { RpcProvider } from "@nocturne/rpc/client";
import type { ModelFieldSource, ModelSettingsPatch, ModelSettingsView } from "./rpc-types";

type FieldKey =
  | "displayName"
  | "contextWindow"
  | "maxOutputTokens"
  | "imageInput"
  | "reasoning"
  | "reasoningEffort"
  | "protocol"
  | "editTool";
const FIELD_LABELS: Record<FieldKey, string> = {
  displayName: "显示名",
  contextWindow: "上下文长度",
  maxOutputTokens: "最大输出",
  imageInput: "图片输入",
  reasoning: "推理",
  reasoningEffort: "思考档位",
  protocol: "协议",
  editTool: "编辑工具",
};

type TriState = "follow" | "true" | "false";
type ReasoningDraft = "follow" | "yes" | "no";
type ProtocolDraft = "follow" | "chat" | "messages" | "responses";
type EditToolDraft = "follow" | "edit" | "patch";

interface Draft {
  displayName: string;
  contextWindow: string;
  maxOutputTokens: string;
  imageInput: TriState;
  reasoning: ReasoningDraft;
  reasoningEffort: "follow" | ReasoningEffortLevel[];
  protocol: ProtocolDraft;
  editTool: EditToolDraft;
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
          : f.protocol.userValue === "openai-responses"
            ? "responses"
            : "chat",
    editTool:
      f.editTool.userValue === undefined
        ? "follow"
        : f.editTool.userValue === "apply_patch"
          ? "patch"
          : "edit",
  };
}

/** 当前草稿 → 补丁（与 TUI draftToPatch 同语义）。 */
export function draftToPatch(view: ModelSettingsView, draft: Draft): ModelSettingsPatch {
  const f = view.fields;
  const patch: ModelSettingsPatch = {};
  const num = (s: string): number | null =>
    s === "" ? null : Number.isInteger(Number(s)) && Number(s) > 0 ? Number(s) : null;
  if (draft.displayName !== "") patch.displayName = draft.displayName;
  else if (f.displayName.userValue !== undefined) patch.displayName = null;
  if (draft.contextWindow !== "") {
    patch.contextWindow = num(draft.contextWindow) ?? -1; // 非法值交给 Core 校验报错
  } else if (f.contextWindow.userValue !== undefined) patch.contextWindow = null;
  if (draft.maxOutputTokens !== "") {
    patch.maxOutputTokens = num(draft.maxOutputTokens) ?? -1;
  } else if (f.maxOutputTokens.userValue !== undefined) patch.maxOutputTokens = null;
  if (draft.imageInput !== "follow") patch.imageInput = draft.imageInput === "true";
  else if (f.imageInput.userValue !== undefined) patch.imageInput = null;
  // 已有 hidden 显示为「是」，未改动时不可写成 visible（TUI 同 bug 修复）
  if (draft.reasoning !== "follow") {
    if (!(f.reasoning.userValue === "hidden" && draft.reasoning === "yes"))
      patch.reasoning = draft.reasoning === "yes" ? "visible" : "none";
  } else if (f.reasoning.userValue !== undefined) patch.reasoning = null;
  if (draft.reasoning === "no" && f.reasoningEffort.userValue !== undefined)
    patch.reasoningEffort = null;
  else if (draft.reasoningEffort !== "follow") patch.reasoningEffort = draft.reasoningEffort;
  else if (f.reasoningEffort.userValue !== undefined) patch.reasoningEffort = null;
  if (draft.protocol !== "follow")
    patch.protocol =
      draft.protocol === "messages"
        ? "anthropic"
        : draft.protocol === "responses"
          ? "openai-responses"
          : "openai-compatible";
  else if (f.protocol.userValue !== undefined) patch.protocol = null;
  if (draft.editTool !== "follow")
    patch.editTool = draft.editTool === "patch" ? "apply_patch" : "edit";
  else if (f.editTool.userValue !== undefined) patch.editTool = null;
  return patch;
}

/** 单个值的显示：undefined → 未声明；布尔 → 是/否；数组 → 斜杠连接（空 = 不支持）。 */
function scalarText(v: unknown): string {
  if (v === undefined) return "未声明";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (Array.isArray(v)) return v.length > 0 ? v.join("/") : "不支持";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return "未声明";
}

function showValue(key: FieldKey, value: unknown): string {
  if (key === "reasoning" && value !== undefined) return value === "none" ? "否" : "是";
  if (key === "protocol") {
    if (value === "openai-compatible") return "Chat Completions";
    if (value === "anthropic") return "Messages";
    if (value === "openai-responses") return "Responses";
    return "协议不支持";
  }
  if (key === "editTool") return value === "apply_patch" ? "apply_patch" : "edit";
  return scalarText(value);
}

/** 字段来源文案（复刻 core 的 modelFieldSourceText，desktop 不能引 core） */
function sourceText(source: ModelFieldSource, edited: boolean): string {
  if (edited) return "已编辑";
  switch (source.kind) {
    case "upstream":
      return "上游";
    case "modelsDev":
      return "models.dev";
    case "user":
      return "用户编辑";
    case "config":
      switch (source.layer) {
        case "user":
          return `由 ${source.path ?? "config.json"} 决定`;
        case "project":
          return `由 ${source.path ?? "项目配置"} 决定`;
        case "env":
          return "由环境变量决定";
        case "cli":
          return "由命令行参数决定";
      }
      break;
    case "builtin":
      return "内置";
    case "default":
      return "默认";
    case "derived":
      return "推导";
    case "entryType":
      return "服务商类型";
  }
}

export function ModelSettingsDialog({
  view,
  provider,
  providerId,
  readonly = false,
  readonlyHint,
  onClose,
  onSaved,
}: {
  view: ModelSettingsView;
  provider: RpcProvider;
  providerId: string;
  readonly?: boolean;
  readonlyHint?: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initDraft(view));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = useMemo(() => draftToPatch(view, draft), [view, draft]);
  const empty = Object.keys(patch).length === 0;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  const resetAll = () => {
    setDraft({
      displayName: "",
      contextWindow: "",
      maxOutputTokens: "",
      imageInput: "follow",
      reasoning: "follow",
      reasoningEffort: "follow",
      protocol: "follow",
      editTool: "follow",
    });
  };

  const save = async () => {
    if (saving || empty) return;
    setSaving(true);
    setError(null);
    try {
      await provider.saveModelSettings(providerId, view.modelId, patch);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const field = view.fields;
  const reasoningOff = draft.reasoning === "no";
  // 推理切回「是/跟随」时按 Core 的推导规则视为可编辑（source 不是 config 写死）
  const effortEditable =
    field.reasoningEffort.editable ||
    (!reasoningOff && field.reasoning.editable && field.reasoningEffort.source.kind !== "config");
  const effortShown = draft.reasoningEffort === "follow" ? null : draft.reasoningEffort;

  const textInput = (
    key: "displayName" | "contextWindow" | "maxOutputTokens",
    opts: { placeholder?: string; width?: number; mono?: boolean } = {},
  ) => {
    const f = field[key];
    if (readonly || !f.editable) {
      return <span className="ro">{showValue(key, f.value)}</span>;
    }
    return (
      <input
        type="text"
        className="input"
        aria-label={FIELD_LABELS[key]}
        style={{
          width: opts.width ?? 180,
          fontFamily: opts.mono === false ? "inherit" : "var(--mono)",
        }}
        placeholder={f.userValue !== undefined ? `跟随（${showValue(key, f.lowerValue)}）` : "跟随"}
        value={draft[key]}
        onChange={(e) => {
          set(key, e.target.value);
        }}
      />
    );
  };

  const seg = <V extends string>(
    key: FieldKey,
    current: V,
    options: { v: V; label: string }[],
    onPick: (v: V) => void,
    enabled: boolean,
  ) => (
    <div className="seg" role="group" aria-label={FIELD_LABELS[key]}>
      {options.map((o) => (
        <button
          key={o.v}
          className={current === o.v ? "on" : undefined}
          disabled={!enabled}
          onClick={() => {
            onPick(o.v);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dlg" role="dialog" aria-label={`模型设置 · ${view.modelId}`}>
        <div className="dh3">
          <b className="mono">{view.modelId}</b>
          <span>
            {readonlyHint ??
              `${providerId} · 改动写入 providers.json 的 userModels，不影响其他服务商`}
          </span>
        </div>
        <div className="db">
          {/* 显示名 / 上下文长度 / 最大输出 */}
          <div className="mrow">
            <span>{FIELD_LABELS.displayName}</span>
            {textInput("displayName", { width: 200 })}
            <span className={`src ${field.displayName.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(field.displayName.source, field.displayName.userValue !== undefined)}
            </span>
          </div>
          <div className="mrow">
            <span>{FIELD_LABELS.contextWindow}</span>
            {textInput("contextWindow", { width: 110 })}
            <span className={`src ${field.contextWindow.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(field.contextWindow.source, field.contextWindow.userValue !== undefined)}
            </span>
          </div>
          <div className="mrow">
            <span>{FIELD_LABELS.maxOutputTokens}</span>
            {textInput("maxOutputTokens", { width: 110 })}
            <span className={`src ${field.maxOutputTokens.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(
                field.maxOutputTokens.source,
                field.maxOutputTokens.userValue !== undefined,
              )}
            </span>
          </div>
          {/* 推理 */}
          <div className="mrow">
            <span>{FIELD_LABELS.reasoning}</span>
            {readonly || !field.reasoning.editable ? (
              <span className="ro">{showValue("reasoning", field.reasoning.value)}</span>
            ) : (
              seg(
                "reasoning",
                draft.reasoning,
                [
                  { v: "follow", label: "跟随" },
                  { v: "yes", label: "是" },
                  { v: "no", label: "否" },
                ],
                (v) => {
                  set("reasoning", v);
                },
                true,
              )
            )}
            <span className={`src ${field.reasoning.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(field.reasoning.source, field.reasoning.userValue !== undefined)}
            </span>
          </div>
          {/* 图片输入 */}
          <div className="mrow">
            <span>{FIELD_LABELS.imageInput}</span>
            {readonly || !field.imageInput.editable ? (
              <span className="ro">{showValue("imageInput", field.imageInput.value)}</span>
            ) : (
              seg(
                "imageInput",
                draft.imageInput,
                [
                  { v: "follow", label: "跟随" },
                  { v: "true", label: "是" },
                  { v: "false", label: "否" },
                ],
                (v) => {
                  set("imageInput", v);
                },
                true,
              )
            )}
            <span className={`src ${field.imageInput.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(field.imageInput.source, field.imageInput.userValue !== undefined)}
            </span>
          </div>
          {/* 思考档位 */}
          <div className="mrow">
            <span>{FIELD_LABELS.reasoningEffort}</span>
            {readonly || !effortEditable ? (
              <span className="ro">{scalarText(field.reasoningEffort.value)}</span>
            ) : (
              <div
                className="effs"
                role="group"
                aria-label={FIELD_LABELS.reasoningEffort}
                title={reasoningOff ? "推理选「否」时不使用思考档位" : undefined}
              >
                <button
                  className={effortShown === null ? "on" : undefined}
                  disabled={reasoningOff}
                  onClick={() => {
                    set("reasoningEffort", "follow");
                  }}
                >
                  跟随
                </button>
                {REASONING_EFFORT_LEVELS.map((lv) => (
                  <button
                    key={lv}
                    className={effortShown?.includes(lv) === true ? "on" : undefined}
                    disabled={reasoningOff}
                    onClick={() => {
                      const cur = effortShown ?? [];
                      set(
                        "reasoningEffort",
                        cur.includes(lv)
                          ? cur.filter((x) => x !== lv)
                          : REASONING_EFFORT_LEVELS.filter((x) => cur.includes(x) || x === lv),
                      );
                    }}
                  >
                    {lv}
                  </button>
                ))}
                <button
                  className={effortShown !== null && effortShown.length === 0 ? "on" : undefined}
                  disabled={reasoningOff}
                  onClick={() => {
                    set("reasoningEffort", []);
                  }}
                >
                  不支持
                </button>
              </div>
            )}
            <span className={`src ${field.reasoningEffort.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(
                field.reasoningEffort.source,
                field.reasoningEffort.userValue !== undefined,
              )}
            </span>
          </div>
          {/* 协议 */}
          <div className="mrow">
            <span>{FIELD_LABELS.protocol}</span>
            {readonly || !field.protocol.editable ? (
              <span className="ro">{showValue("protocol", field.protocol.value)}</span>
            ) : (
              seg(
                "protocol",
                draft.protocol,
                [
                  { v: "follow", label: "跟随" },
                  { v: "chat", label: "Chat" },
                  { v: "messages", label: "Messages" },
                  { v: "responses", label: "Responses" },
                ],
                (v) => {
                  set("protocol", v);
                },
                true,
              )
            )}
            <span className={`src ${field.protocol.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(field.protocol.source, field.protocol.userValue !== undefined)}
            </span>
          </div>
          {/* 编辑工具 */}
          <div className="mrow">
            <span>{FIELD_LABELS.editTool}</span>
            {readonly || !field.editTool.editable ? (
              <span className="ro">{showValue("editTool", field.editTool.value)}</span>
            ) : (
              seg(
                "editTool",
                draft.editTool,
                [
                  { v: "follow", label: "跟随" },
                  { v: "edit", label: "edit" },
                  { v: "patch", label: "apply_patch" },
                ],
                (v) => {
                  set("editTool", v);
                },
                true,
              )
            )}
            <span className={`src ${field.editTool.userValue !== undefined ? "ed" : ""}`}>
              {sourceText(field.editTool.source, field.editTool.userValue !== undefined)}
            </span>
          </div>
        </div>
        {error !== null && <div className="errt">{error}</div>}
        <div className="df">
          <button className="btn ghost" onClick={resetAll} disabled={saving || readonly}>
            全部恢复跟随
          </button>
          <span className="sp" />
          <button className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={saving || empty || readonly}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
