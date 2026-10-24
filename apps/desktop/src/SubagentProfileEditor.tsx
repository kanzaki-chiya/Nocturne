import { useState } from "react";
import type { ModelInfo, SettingItem, SettingsPatch } from "./rpc-types";
import {
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  type SubagentProfileConfig,
  type ExternalAgentOverview,
  type ReasoningEffort,
} from "@nocturne/core/protocol";
import { Dropdown } from "./Dropdown";
import { ConfirmDialog } from "./ProvidersPage";

export function profilesFromSettings(items: readonly SettingItem[]) {
  return items
    .filter((item) => item.key.startsWith("subagents.profiles."))
    .map((item) => ({
      name: item.key.slice("subagents.profiles.".length),
      config: JSON.parse(item.effective ?? "{}") as SubagentProfileConfig,
      item,
    }));
}

export function SubagentProfileEditor({
  name: initialName,
  initial,
  creating,
  items,
  models,
  agents,
  onSave,
  onDelete,
  onCancel,
}: {
  name: string;
  initial: SubagentProfileConfig;
  creating: boolean;
  items: readonly SettingItem[];
  models: readonly ModelInfo[];
  agents: readonly ExternalAgentOverview[];
  onSave: (patch: SettingsPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isDefault = initialName === "default" && !creating;
  const set = (patch: Partial<SubagentProfileConfig>) => {
    setDraft((old) => ({ ...old, ...patch }));
  };
  const model = models.find((model) => `${model.ref.provider}/${model.ref.model}` === draft.model);
  const efforts = model
    ? ["off", ...(model.capabilities.reasoningEffort ?? [])]
    : REASONING_EFFORT_ORDER;
  const source = items.find((item) => item.key === `subagents.profiles.${initialName}`);
  const readonly = !creating && source !== undefined && source.source !== "settings";
  const previewProfiles = profilesFromSettings(items)
    .filter((profile) => profile.name !== name)
    .map((profile) => ({ ...profile.config, name: profile.name }));
  if (!isDefault) previewProfiles.push({ ...draft, name });
  const preview = subagentSelectionTable(
    previewProfiles.filter(
      (profile) =>
        profile.enabled &&
        (profile.model === undefined ||
          models.some(
            (model) =>
              `${model.ref.provider}/${model.ref.model}` === profile.model && !model.unavailable,
          )),
    ),
    agents.filter((agent) => agent.enabled),
    isDefault ? draft.model : items.find((item) => item.key === "modelRoles.task")?.effective,
  );
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="profile-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate(() =>
          onSave(
            isDefault
              ? { "modelRoles.task": draft.model ?? null }
              : { [`subagents.profiles.${name}`]: draft },
          ),
        );
      }}
    >
      <div className="t1">
        <h3>{creating ? "添加档位" : name}</h3>
        <span className="tagc">
          {isDefault
            ? "默认（始终启用）"
            : source?.source === "project"
              ? "项目配置（只读）"
              : readonly
                ? "config.json（只读）"
                : "settings.json"}
        </span>
      </div>
      {error && (
        <p className="errt" role="alert">
          {error}
        </p>
      )}
      {readonly && <p className="fine">请在来源配置文件中编辑此档位。</p>}
      {creating && (
        <label className="profile-field">
          名称
          <input
            aria-label="档位名称"
            value={name}
            maxLength={32}
            pattern="[a-z0-9-]+"
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <small>小写字母、数字和 -；创建后不可改，default 为保留名。</small>
        </label>
      )}
      <label className="profile-field">
        何时用（给模型看）
        <textarea
          aria-label="何时用"
          value={draft.description}
          disabled={isDefault || readonly}
          required
          onChange={(event) => {
            set({ description: event.target.value });
          }}
        />
        <small>说明适合与不适合的任务。</small>
      </label>
      <div className="profile-pair">
        <div className="profile-field">
          <label>模型</label>
          <Dropdown
            label="档位模型"
            value={draft.model ?? ""}
            searchable
            disabled={readonly || busy ? "不可编辑" : undefined}
            options={[
              { value: "", label: "跟随当前模型" },
              ...models
                .filter((model) => !model.unavailable)
                .map((model) => ({
                  value: `${model.ref.provider}/${model.ref.model}`,
                  label: model.displayName ?? model.ref.model,
                  description: model.ref.provider,
                })),
            ]}
            onChange={(model) => {
              set({ model: model || undefined, effort: undefined });
            }}
          />
        </div>
        <label className="profile-field">
          默认超时（秒）
          <input
            aria-label="默认超时"
            type="number"
            min={1}
            max={3600}
            value={draft.timeoutMs === undefined ? "" : draft.timeoutMs / 1000}
            placeholder="600"
            disabled={isDefault || readonly}
            onChange={(event) => {
              set({
                timeoutMs: event.target.value ? Number(event.target.value) * 1000 : undefined,
              });
            }}
          />
        </label>
      </div>
      <div className="profile-field">
        <label>思考强度</label>
        <div className="profile-options" role="radiogroup" aria-label="思考强度">
          {["", ...efforts].map((effort) => (
            <button
              type="button"
              role="radio"
              key={effort}
              aria-checked={(draft.effort ?? "") === effort}
              disabled={isDefault || readonly}
              className={`btn${(draft.effort ?? "") === effort ? " selected" : ""}`}
              onClick={() => {
                set({ effort: (effort || undefined) as ReasoningEffort | undefined });
              }}
            >
              {effort || "跟随会话"}
            </button>
          ))}
        </div>
        <small>继承或指定的强度会按子模型就近降档。</small>
      </div>
      <div className="profile-field">
        <label>工具集上限</label>
        <div className="profile-options" role="radiogroup" aria-label="工具集上限">
          {(["general", "explore"] as const).map((tools) => (
            <button
              type="button"
              role="radio"
              key={tools}
              aria-checked={(draft.tools ?? "general") === tools}
              disabled={isDefault || readonly}
              className={`btn${(draft.tools ?? "general") === tools ? " selected" : ""}`}
              onClick={() => {
                set({ tools });
              }}
            >
              {tools === "general" ? "全部（general）" : "只读（explore）"}
            </button>
          ))}
        </div>
      </div>
      <label className="profile-enabled">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={isDefault || readonly}
          onChange={(event) => {
            set({ enabled: event.target.checked });
          }}
        />
        启用此档位
      </label>
      <div className="acts">
        <button className="btn" type="button" onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" type="submit" disabled={busy || readonly}>
          {busy ? "保存中…" : "保存"}
        </button>
        {!creating && !isDefault && !readonly && (
          <button
            className="btn profile-delete"
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            删除档位
          </button>
        )}
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          title={`删除档位 ${name}？`}
          body="删除后，子代理不能再选这个档位。"
          confirmLabel="删除"
          danger
          onClose={() => {
            setConfirmingDelete(false);
          }}
          onConfirm={async () => {
            setConfirmingDelete(false);
            await mutate(onDelete);
          }}
        />
      )}
      <details className="profile-preview">
        <summary>预览模型看到的文字</summary>
        <pre>{preview}</pre>
      </details>
    </form>
  );
}
