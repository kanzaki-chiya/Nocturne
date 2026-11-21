import { useEffect, useId, useRef, useState } from "react";
import type { ModelInfo, SettingItem, SettingsPatch } from "./rpc-types";
import {
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  truncateSubagentTableDescription,
  type SubagentProfileConfig,
  type ExternalAgentOverview,
  type ReasoningEffort,
} from "@nocturne/core/protocol";
import { Dropdown } from "./Dropdown";
import { Menu, MenuItem } from "./Menu";
import { ConfirmDialog } from "./ProvidersPage";
import {
  Badge,
  Button,
  Field,
  FormFooter,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  Switch,
} from "./ui";

export function profilesFromSettings(items: readonly SettingItem[]) {
  return items
    .filter((item) => item.key.startsWith("subagents.profiles."))
    .map((item) => ({
      name: item.key.slice("subagents.profiles.".length),
      config: JSON.parse(item.effective ?? "{}") as SubagentProfileConfig,
      item,
    }));
}

function profilePatch(name: string, value: SubagentProfileConfig | null): SettingsPatch {
  const patch: SettingsPatch = {};
  patch[`subagents.profiles.${name}`] = value;
  return patch;
}

function timeoutInputValue(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? "" : String(timeoutMs / 1000);
}

export interface ProjectAgentPreviewEntry {
  id: string;
  description: string;
  effort?: ReasoningEffort | undefined;
}

export interface PluginAgentPreviewEntry {
  id: string;
  description: string;
  effort?: ReasoningEffort | undefined;
  model?: string | undefined;
}

export function SubagentProfileEditor({
  name: initialName,
  initial,
  creating,
  items,
  models,
  agents,
  projectAgents = [],
  pluginAgents = [],
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
  projectAgents?: readonly ProjectAgentPreviewEntry[];
  pluginAgents?: readonly PluginAgentPreviewEntry[];
  onSave: (patch: SettingsPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initial);
  const [timeoutText, setTimeoutText] = useState(() => timeoutInputValue(initial.timeoutMs));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const savedRef = useRef(initial);
  const submittedTimeoutRef = useRef<number | undefined>(initial.timeoutMs);

  useEffect(() => {
    if (creating) return;
    savedRef.current = initial;
    submittedTimeoutRef.current = initial.timeoutMs;
    setDraft(initial);
    setTimeoutText(timeoutInputValue(initial.timeoutMs));
  }, [creating, initial]);

  const nameId = useId();
  const descId = useId();
  const timeoutId = useId();

  const isDefault = initialName === "default" && !creating;
  const set = (patch: Partial<SubagentProfileConfig>) => {
    setDraft((old) => ({ ...old, ...patch }));
  };

  const model = models.find((m) => `${m.ref.provider}/${m.ref.model}` === draft.model);
  const efforts = model
    ? ["off", ...(model.capabilities.reasoningEffort ?? [])]
    : REASONING_EFFORT_ORDER;
  const source = items.find((item) => item.key === `subagents.profiles.${initialName}`);
  const readonly = !creating && source !== undefined && source.source !== "settings";

  const previewProfiles = profilesFromSettings(items)
    .filter((profile) => profile.name !== name)
    .map((profile) => ({ ...profile.config, name: profile.name }));
  if (!isDefault && (creating || name !== "")) {
    previewProfiles.push({ ...draft, name });
  }
  const defaultTaskModel = isDefault
    ? draft.model
    : items.find((item) => item.key === "modelRoles.task")?.effective;
  const defaultTaskModelAvailable =
    defaultTaskModel === undefined ||
    models.some((m) => `${m.ref.provider}/${m.ref.model}` === defaultTaskModel && !m.unavailable);
  const previewProjectProfiles = defaultTaskModelAvailable
    ? projectAgents.map((agent) => ({
        name: agent.id,
        description: truncateSubagentTableDescription(agent.description),
        enabled: true,
        ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
        ...(defaultTaskModel !== undefined ? { model: defaultTaskModel } : {}),
      }))
    : [];
  const previewPluginProfiles = pluginAgents
    .filter(
      (agent) =>
        agent.model === undefined ||
        models.some((m) => `${m.ref.provider}/${m.ref.model}` === agent.model && !m.unavailable),
    )
    .map((agent) => ({
      name: agent.id,
      description: agent.description,
      enabled: true,
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      ...((agent.model ?? defaultTaskModel) !== undefined
        ? { model: agent.model ?? defaultTaskModel }
        : {}),
    }));
  const preview = subagentSelectionTable(
    [
      ...previewProfiles.filter(
        (profile) =>
          profile.enabled &&
          (profile.model === undefined ||
            models.some(
              (m) => `${m.ref.provider}/${m.ref.model}` === profile.model && !m.unavailable,
            )),
      ),
      ...previewProjectProfiles,
      ...previewPluginProfiles,
    ],
    agents.filter((agent) => agent.enabled),
    defaultTaskModel,
    (ref) =>
      ref !== undefined
        ? models.find((m) => `${m.ref.provider}/${m.ref.model}` === ref)?.pricing
        : undefined,
  );

  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveInstant = async (nextConfig: SubagentProfileConfig) => {
    const previous = savedRef.current;
    setDraft(nextConfig);
    setTimeoutText(timeoutInputValue(nextConfig.timeoutMs));
    setBusy(true);
    setError("");
    try {
      await onSave(
        isDefault
          ? { "modelRoles.task": nextConfig.model ?? null }
          : profilePatch(name, nextConfig),
      );
      savedRef.current = nextConfig;
      submittedTimeoutRef.current = nextConfig.timeoutMs;
    } catch (e) {
      savedRef.current = previous;
      submittedTimeoutRef.current = previous.timeoutMs;
      setDraft(previous);
      setTimeoutText(timeoutInputValue(previous.timeoutMs));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commitDescription = () => {
    if (creating || isDefault || readonly) return;
    if (draft.description.trim() === "") {
      setDraft((old) => ({ ...old, description: savedRef.current.description }));
      return;
    }
    if (draft.description === savedRef.current.description) return;
    void saveInstant({ ...savedRef.current, description: draft.description });
  };

  const commitTimeout = () => {
    if (creating || isDefault || readonly) return;
    const trimmed = timeoutText.trim();
    let nextTimeoutMs: number | undefined;
    if (trimmed === "") {
      nextTimeoutMs = undefined;
    } else {
      const secs = Number(trimmed);
      if (!Number.isFinite(secs) || secs < 1) {
        setTimeoutText(timeoutInputValue(savedRef.current.timeoutMs));
        return;
      }
      nextTimeoutMs = Math.round(secs * 1000);
    }
    if (nextTimeoutMs === submittedTimeoutRef.current) return;
    submittedTimeoutRef.current = nextTimeoutMs;
    void saveInstant({ ...savedRef.current, timeoutMs: nextTimeoutMs });
  };

  const modelOptions = [
    { value: "", label: "跟随当前模型" },
    ...models
      .filter((m) => !m.unavailable)
      .map((m) => ({
        value: `${m.ref.provider}/${m.ref.model}`,
        label: m.displayName ?? m.ref.model,
        description: m.ref.provider,
      })),
  ];

  const effortOptions = ["", ...efforts].map((effort) => ({
    value: effort,
    label: effort || "跟随会话",
  }));

  const runSection = (
    <SettingsGroup title="运行" plain>
      <Field label="模型">
        <Dropdown
          label="档位模型"
          value={draft.model ?? ""}
          searchable
          disabled={readonly || busy ? "不可编辑" : undefined}
          options={modelOptions}
          onChange={(nextModel) => {
            const normalized = nextModel || undefined;
            if (creating) {
              set({ model: normalized, effort: undefined });
              return;
            }
            if (isDefault) {
              if (normalized === savedRef.current.model) return;
              void saveInstant({ ...savedRef.current, model: normalized });
              return;
            }
            void saveInstant({ ...savedRef.current, model: normalized, effort: undefined });
          }}
        />
      </Field>
      {isDefault ? (
        <SettingsRow label="思考档位">
          <span className="val">跟随会话</span>
        </SettingsRow>
      ) : (
        <Field label="思考档位">
          <Dropdown
            label="思考档位"
            value={draft.effort ?? ""}
            disabled={readonly || busy ? "不可编辑" : undefined}
            options={effortOptions}
            onChange={(effort) => {
              const nextEffort = (effort || undefined) as ReasoningEffort | undefined;
              if (creating) {
                set({ effort: nextEffort });
                return;
              }
              if (nextEffort === savedRef.current.effort) return;
              void saveInstant({ ...savedRef.current, effort: nextEffort });
            }}
          />
        </Field>
      )}
      {isDefault ? (
        <SettingsRow label="工具集上限">
          <span className="val">全部</span>
        </SettingsRow>
      ) : (
        <Field label="工具集上限">
          <SegmentedControl
            role="radiogroup"
            aria-label="工具集上限"
            disabled={readonly || busy}
            value={draft.tools ?? "general"}
            options={[
              { value: "general", label: "全部" },
              { value: "explore", label: "只读" },
            ]}
            onChange={(tools) => {
              if (creating) {
                set({ tools });
                return;
              }
              if (tools === (savedRef.current.tools ?? "general")) return;
              void saveInstant({ ...savedRef.current, tools });
            }}
          />
        </Field>
      )}
      {isDefault ? (
        <SettingsRow label="默认超时">
          <span className="val dim">—</span>
        </SettingsRow>
      ) : (
        <Field label="默认超时" htmlFor={timeoutId}>
          <span className="profile-unit">
            <input
              id={timeoutId}
              className="input"
              aria-label="默认超时"
              type="number"
              min={1}
              value={timeoutText}
              disabled={readonly || busy}
              onChange={(event) => {
                const val = event.target.value;
                setTimeoutText(val);
                if (creating) {
                  set({
                    timeoutMs: val.trim() ? Number(val) * 1000 : undefined,
                  });
                }
              }}
              onBlur={commitTimeout}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitTimeout();
                }
              }}
            />
            <span className="profile-unit-label">秒</span>
          </span>
        </Field>
      )}
    </SettingsGroup>
  );

  return (
    <>
      <PageHeader
        crumb={{ parent: "子代理", onBack: onCancel }}
        title={creating ? "添加档位" : <span className="mono">{name}</span>}
        extra={isDefault || readonly ? <Badge>只读</Badge> : undefined}
        actions={
          !creating ? (
            <>
              <Switch
                aria-label="启用"
                checked={draft.enabled}
                disabled={isDefault || readonly || busy}
                onChange={(enabled) => {
                  void saveInstant({ ...savedRef.current, enabled });
                }}
              />
              {!isDefault && !readonly && (
                <>
                  <IconButton
                    ref={moreRef}
                    aria-label="更多"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen((open) => !open);
                    }}
                  >
                    <Icon name="more" size={ICON_MD} />
                  </IconButton>
                  {menuOpen && (
                    <Menu
                      anchor={moreRef.current}
                      align="right"
                      className="more-menu"
                      label="更多"
                      onClose={() => {
                        setMenuOpen(false);
                      }}
                    >
                      <hr className="menu-sep" />
                      <MenuItem
                        danger
                        label="删除"
                        onSelect={() => {
                          setMenuOpen(false);
                          setConfirmingDelete(true);
                        }}
                      />
                    </Menu>
                  )}
                </>
              )}
            </>
          ) : undefined
        }
      />
      {error && (
        <p className="errt" role="alert">
          {error}
        </p>
      )}
      {creating ? (
        <form
          className="form settings-subpage-form profile-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^[a-z0-9-]{1,32}$/.test(name) || draft.description.trim() === "") {
              event.currentTarget.reportValidity();
              return;
            }
            void mutate(() => onSave(profilePatch(name, draft)));
          }}
        >
          <SettingsGroup plain>
            <Field label="名称" htmlFor={nameId}>
              <input
                id={nameId}
                className="input mono"
                aria-label="档位名称"
                value={name}
                maxLength={32}
                pattern="[a-z0-9-]+"
                required
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>
            <Field label="描述" htmlFor={descId}>
              <textarea
                id={descId}
                className="textarea ta-auto profile-description"
                rows={1}
                aria-label="描述"
                value={draft.description}
                required
                onChange={(event) => {
                  set({ description: event.target.value });
                }}
              />
            </Field>
          </SettingsGroup>
          {runSection}
          <FormFooter>
            <Button type="button" onClick={onCancel}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </FormFooter>
        </form>
      ) : (
        <div className="form settings-subpage-form profile-editor">
          {!isDefault && (
            <SettingsGroup plain>
              <Field label="描述" htmlFor={descId}>
                <textarea
                  id={descId}
                  className="textarea ta-auto profile-description"
                  rows={1}
                  aria-label="描述"
                  value={draft.description}
                  disabled={readonly || busy}
                  required
                  onChange={(event) => {
                    set({ description: event.target.value });
                  }}
                  onBlur={commitDescription}
                />
              </Field>
            </SettingsGroup>
          )}
          {runSection}
          <details className="profile-preview">
            <summary>
              <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
              预览模型看到的文字
            </summary>
            <pre>{preview}</pre>
          </details>
        </div>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`删除档位 ${name}？`}
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
    </>
  );
}
