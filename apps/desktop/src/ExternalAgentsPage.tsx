import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import { EXTERNAL_AGENT_PRESETS } from "@nocturne/core/protocol";
import type {
  ExternalAgentConfig,
  ExternalAgentOverview,
  ExternalAgentProbeResult,
  PluginAgentOverview,
  PluginOverview,
  SkillOverview,
  SubagentProfileConfig,
} from "@nocturne/core/protocol";
import { Dropdown } from "./Dropdown";
import { Menu, MenuItem } from "./Menu";
import { PluginIcon } from "./PluginsPage";
import { ConfirmDialog } from "./ProvidersPage";
import { externalAgentSlashConflict } from "./commands";
import { profilesFromSettings, SubagentProfileEditor } from "./SubagentProfileEditor";
import type { ModelInfo, SettingItem, SettingsPatch } from "./rpc-types";
import {
  Badge,
  Button,
  Field,
  FormFooter,
  ICON_MD,
  Icon,
  IconButton,
  PageHeader,
  SettingsGroup,
  SettingsListRow,
  SettingsRow,
  Switch,
} from "./ui";
import "./subagent-profiles.css";
import "./pages.css";
import "./mcp.css";
import "./external-agents.css";

interface ProbeRecord {
  result: ExternalAgentProbeResult;
  at: string;
}

// 测试结果只在本次应用运行内保留（不持久化，同 ADR-0047 第 4 节）；放在模块级，
// 切换设置页、保存表单后不丢失
const probeCache = new Map<string, ProbeRecord>();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export { EXTERNAL_AGENT_PRESETS };

function formatTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const resultText = (result: ExternalAgentProbeResult | undefined): ReactNode =>
  !result ? (
    "未测试"
  ) : result.ok ? (
    <>
      已连接
      {result.agentInfo && (
        <span className="muted-value">
          {result.agentInfo.name} {result.agentInfo.version}
        </span>
      )}
    </>
  ) : (
    (result.error?.message ?? "测试失败")
  );

// 探测只用启动参数（不发 configOptions），保存时据此判断测试结果是否仍然有效
const launchKey = (config: ExternalAgentConfig) =>
  JSON.stringify([config.command, config.args, config.env ?? {}]);

function configOf(agent: ExternalAgentOverview): ExternalAgentConfig {
  return {
    name: agent.name,
    command: agent.command,
    args: agent.args,
    enabled: agent.enabled,
    ...(agent.env ? { env: agent.env } : {}),
    ...(agent.mode ? { mode: agent.mode } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.configOptions ? { configOptions: agent.configOptions } : {}),
  };
}

function stringMap(text: string, label: string): Record<string, string> {
  const value: unknown = JSON.parse(text || "{}");
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    throw new Error(`${label}必须是值为字符串的 JSON 对象`);
  return value as Record<string, string>;
}

function readonlyReasonOf(agent: ExternalAgentOverview): string | undefined {
  if (agent.editable) return undefined;
  const sourcePath =
    agent.path ?? (agent.origin === "app" ? "external-agents.json" : "config.json");
  return `来自 ${sourcePath}，请修改该文件`;
}

function profilePatch(name: string, value: SubagentProfileConfig | null): SettingsPatch {
  const patch: SettingsPatch = {};
  patch[`subagents.profiles.${name}`] = value;
  return patch;
}

function pluginModelPatch(id: string, value: string | null): SettingsPatch {
  const patch: SettingsPatch = {};
  patch[`subagents.pluginModels.${id}`] = value;
  return patch;
}

function modelIdOf(modelRef: string, models: readonly ModelInfo[]): string {
  const found = models.find((m) => `${m.ref.provider}/${m.ref.model}` === modelRef);
  if (found !== undefined) return found.ref.model;
  const slash = modelRef.indexOf("/");
  return slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
}

function pluginGroupRank(plugin: PluginOverview): number {
  if (plugin.host === "nocturne" && plugin.marketplace === "builtin") return 0;
  if (plugin.host === "nocturne") return 1;
  if (plugin.host === "codex") return 2;
  return 3;
}

type SubagentView =
  | { kind: "list" }
  | { kind: "profile"; name: string }
  | { kind: "newProfile" }
  | { kind: "pluginAgent"; id: string }
  | { kind: "agent"; name: string }
  | { kind: "agentForm"; config: ExternalAgentConfig; replace: boolean };

export function ExternalAgentsPage({
  client,
  workspaceRoot,
  version,
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
}) {
  const [agents, setAgents] = useState<ExternalAgentOverview[]>([]);
  const [plugins, setPlugins] = useState<PluginOverview[]>([]);
  const [items, setItems] = useState<SettingItem[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [skills, setSkills] = useState<SkillOverview[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [view, setView] = useState<SubagentView>({ kind: "list" });
  const [results, setResultsState] = useState<Record<string, ProbeRecord>>(() =>
    Object.fromEntries(probeCache),
  );
  const setResults = useCallback(
    (update: (old: Record<string, ProbeRecord>) => Record<string, ProbeRecord>) => {
      setResultsState((old) => {
        const next = update(old);
        probeCache.clear();
        for (const [key, value] of Object.entries(next)) probeCache.set(key, value);
        return next;
      });
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast("");
    }, 2400);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  const refresh = useCallback(async () => {
    if (!client) return;
    const current = ++generation.current;
    const accept = () => current === generation.current;
    try {
      await Promise.all([
        client.runtime.describeExternalAgents({ workspaceRoot }).then((data) => {
          if (!accept()) return;
          setAgents(data.agents);
          setWarnings(data.warnings);
        }),
        client.runtime.describeSkills({ workspaceRoot }).then((data) => {
          if (accept()) setSkills(data.skills);
        }),
        client.runtime.describeSettings({ workspaceRoot }).then((data) => {
          if (accept()) setItems(data);
        }),
        client.runtime.listModels({ workspaceRoot }).then((data) => {
          if (accept()) setModels(data);
        }),
        client.runtime
          .describePlugins()
          .catch(() => undefined)
          .then((data) => {
            if (accept() && data !== undefined) setPlugins(data.plugins);
          }),
      ]);
    } catch (e) {
      if (accept()) setError(message(e));
    }
  }, [client, workspaceRoot]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, version]);

  const profiles = profilesFromSettings(items);
  const defaultModel = items.find((item) => item.key === "modelRoles.task")?.effective;

  const currentAgent =
    view.kind === "agent" ? agents.find((agent) => agent.name === view.name) : undefined;
  const recentAgentProbe = currentAgent ? results[currentAgent.name] : undefined;

  const currentProfileConfig: SubagentProfileConfig | undefined =
    view.kind === "newProfile"
      ? { description: "", enabled: true }
      : view.kind === "profile"
        ? view.name === "default"
          ? {
              description: "",
              enabled: true,
              ...(defaultModel ? { model: defaultModel } : {}),
            }
          : profiles.find((profile) => profile.name === view.name)?.config
        : undefined;

  const changed = async (text: string) => {
    // RPC 在响应之前发 providersChanged；单后台下 App 只刷新本会话的数据版本。
    setToast(text);
    await refresh();
  };

  const mutate = async (action: () => Promise<unknown>, text: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await changed(text);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const probeAgent = async (agentName: string) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.runtime.probeExternalAgent({ name: agentName });
      setResults((old) => ({
        ...old,
        [agentName]: { result, at: formatTime() },
      }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (patch: SettingsPatch) => {
    if (!client) return;
    await client.runtime.updateSettings(patch, { workspaceRoot });
    const profileEntry = Object.entries(patch).find(([key]) =>
      key.startsWith("subagents.profiles."),
    );
    const profileKey = profileEntry?.[0];
    const savedName =
      profileKey !== undefined ? profileKey.slice("subagents.profiles.".length) : "default";
    const isDelete = profileEntry?.[1] === null;
    await refresh();
    if (isDelete) {
      setView({ kind: "list" });
      setToast(`已删除 ${savedName}`);
    } else {
      if (view.kind === "newProfile" && profileKey !== undefined) {
        setView({ kind: "profile", name: savedName });
      }
      setToast(`已保存 ${savedName}`);
    }
  };

  const toggleProfileRow = async (
    entry: { name: string; config: SubagentProfileConfig },
    enabled: boolean,
  ) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      await client.runtime.updateSettings(profilePatch(entry.name, { ...entry.config, enabled }), {
        workspaceRoot,
      });
      await refresh();
      setToast(enabled ? "已启用" : "已停用");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const orderedAgents = [
    ...agents.filter((agent) => agent.editable),
    ...agents.filter((agent) => !agent.editable),
  ];

  // 与插件页分组顺序一致（内置 → Nocturne → Codex → Claude Code），
  // 已启用且带子代理的插件按名去重（保留发现顺序的第一个，与 Core 同口径）
  const pluginAgentGroups = (() => {
    const seenNames = new Set<string>();
    const active: { plugin: PluginOverview; agents: PluginAgentOverview[] }[] = [];
    for (const plugin of plugins) {
      if (plugin.state !== "on" || (plugin.agents?.length ?? 0) === 0) continue;
      if (seenNames.has(plugin.name)) continue;
      seenNames.add(plugin.name);
      active.push({ plugin, agents: plugin.agents ?? [] });
    }
    return active.sort((a, b) => pluginGroupRank(a.plugin) - pluginGroupRank(b.plugin));
  })();

  const basePluginModelOptions = [
    { value: "", label: "跟随默认" },
    ...models
      .filter((m) => !m.unavailable)
      .map((m) => ({
        value: `${m.ref.provider}/${m.ref.model}`,
        label: m.displayName ?? m.ref.model,
        description: m.ref.provider,
      })),
  ];
  const pluginModelOptionsFor = (selected: string) =>
    selected !== "" && !basePluginModelOptions.some((opt) => opt.value === selected)
      ? [
          ...basePluginModelOptions,
          { value: selected, label: modelIdOf(selected, models), disabled: "不可用" },
        ]
      : basePluginModelOptions;

  const savePluginAgentModel = async (agentId: string, nextModel: string) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      await client.runtime.updateSettings(
        pluginModelPatch(agentId, nextModel === "" ? null : nextModel),
        { workspaceRoot },
      );
      await refresh();
      setToast("已保存");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const currentPluginAgent =
    view.kind === "pluginAgent"
      ? pluginAgentGroups
          .flatMap((group) => group.agents.map((agent) => ({ plugin: group.plugin, agent })))
          .find((entry) => entry.agent.id === view.id)
      : undefined;

  const previewPluginAgents = pluginAgentGroups.flatMap((group) =>
    group.agents.map((agent) => ({
      id: agent.id,
      description: agent.description,
      effort: agent.effort,
      model: items.find((item) => item.key === `subagents.pluginModels.${agent.id}`)?.effective,
    })),
  );

  const openList = () => {
    setError("");
    setMenuOpen(false);
    setDeleting(false);
    setView({ kind: "list" });
  };

  const renderBody = () => {
    if (view.kind === "pluginAgent" && currentPluginAgent) {
      const { plugin, agent } = currentPluginAgent;
      const modelItem = items.find((item) => item.key === `subagents.pluginModels.${agent.id}`);
      const selectedModel = modelItem?.effective ?? "";
      const ro = modelItem !== undefined && modelItem.source !== "settings";
      return (
        <>
          <PageHeader
            crumb={{ parent: "子代理", onBack: openList }}
            title={<span className="mono">{agent.name}</span>}
          />
          {error && (
            <p className="errt" role="alert">
              {error}
            </p>
          )}
          <div className="sbody">
            <SettingsGroup plain>
              <SettingsRow label="名称">
                <span className="val mono">{agent.id}</span>
              </SettingsRow>
              <SettingsRow label="描述">
                <p className="plugin-agent-detail-desc">{agent.description}</p>
              </SettingsRow>
              <SettingsRow label="来源插件">
                <span className="val">{plugin.displayName ?? plugin.name}</span>
              </SettingsRow>
              <SettingsRow label="工具清单">
                {agent.tools !== undefined && agent.tools.length > 0 ? (
                  <div className="plugin-agent-tools">
                    {agent.tools.map((tool) => (
                      <span key={tool}>{tool}</span>
                    ))}
                  </div>
                ) : (
                  <span className="val">全部</span>
                )}
              </SettingsRow>
              <SettingsRow label="模型">
                <Dropdown
                  label="模型"
                  value={selectedModel}
                  searchable
                  disabled={!client || busy || ro ? "不可编辑" : undefined}
                  options={pluginModelOptionsFor(selectedModel)}
                  onChange={(next) => {
                    if (next === selectedModel) return;
                    void savePluginAgentModel(agent.id, next);
                  }}
                />
              </SettingsRow>
            </SettingsGroup>
          </div>
        </>
      );
    }

    if (view.kind === "newProfile" || (view.kind === "profile" && currentProfileConfig)) {
      const profileName = view.kind === "newProfile" ? "" : view.name;
      return (
        <SubagentProfileEditor
          key={view.kind === "newProfile" ? "new-profile" : `profile-${profileName}`}
          name={profileName}
          initial={currentProfileConfig ?? { description: "", enabled: true }}
          creating={view.kind === "newProfile"}
          items={items}
          models={models}
          agents={agents}
          pluginAgents={previewPluginAgents}
          onSave={saveProfile}
          onCancel={openList}
          onDelete={async () => {
            if (view.kind !== "profile" || view.name === "default") return;
            await saveProfile(profilePatch(view.name, null));
          }}
        />
      );
    }

    if (view.kind === "agentForm" && client) {
      const { config, replace } = view;
      return (
        <ExternalAgentForm
          key={`${replace}-${config.name}`}
          client={client}
          initial={config}
          replace={replace}
          recent={results[config.name]}
          onBackToList={openList}
          onProbed={(agentName, probed) => {
            setResults((old) => ({
              ...old,
              [agentName]: probed,
            }));
          }}
          onCancel={() => {
            setError("");
            setView(replace ? { kind: "agent", name: config.name } : { kind: "list" });
          }}
          onSaved={async (savedName, tested) => {
            await changed(`已保存 ${savedName}`);
            setView({ kind: "agent", name: savedName });
            setResults((old) => {
              const { [savedName]: _removed, ...rest } = old;
              return tested ? { ...rest, [savedName]: tested } : rest;
            });
          }}
        />
      );
    }

    if (view.kind === "agent" && currentAgent) {
      const readonlyReason = readonlyReasonOf(currentAgent);
      const commandText = [currentAgent.command, ...currentAgent.args].join(" ");
      const envKeys = Object.keys(currentAgent.env ?? {});
      const cfgCount = Object.keys(currentAgent.configOptions ?? {}).length;
      const conflict = externalAgentSlashConflict(currentAgent.name, skills);
      return (
        <>
          <PageHeader
            crumb={{ parent: "子代理", onBack: openList }}
            title={<span className="mono">{currentAgent.name}</span>}
            extra={!currentAgent.editable ? <Badge title={readonlyReason}>只读</Badge> : undefined}
            actions={
              <>
                <Switch
                  aria-label="启用 agent"
                  checked={currentAgent.enabled}
                  disabled={!client || !currentAgent.editable || busy}
                  title={readonlyReason}
                  onChange={(next) => {
                    if (client)
                      void mutate(
                        () =>
                          client.runtime.setExternalAgentEnabled({
                            name: currentAgent.name,
                            enabled: next,
                          }),
                        next ? "已启用" : "已停用",
                      );
                  }}
                />
                <Button
                  disabled={!client || busy}
                  onClick={() => void probeAgent(currentAgent.name)}
                >
                  {busy ? "处理中…" : "测试连接"}
                </Button>
                {currentAgent.editable && (
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
                        <MenuItem
                          label="编辑"
                          onSelect={() => {
                            setMenuOpen(false);
                            setError("");
                            setView({
                              kind: "agentForm",
                              config: configOf(currentAgent),
                              replace: true,
                            });
                          }}
                        />
                        <hr className="menu-sep" />
                        <MenuItem
                          danger
                          label="删除"
                          onSelect={() => {
                            setMenuOpen(false);
                            setDeleting(true);
                          }}
                        />
                      </Menu>
                    )}
                  </>
                )}
              </>
            }
          />
          {error && (
            <div className="desc err" role="alert">
              {error}
            </div>
          )}
          {currentAgent.description && <p className="desc">{currentAgent.description}</p>}
          {conflict && (
            <p className="errt" role="status">
              {conflict}
            </p>
          )}
          <div className="sbody">
            <SettingsGroup title="连接">
              <SettingsRow label="命令">
                <span className="val mono ellip" title={commandText}>
                  {commandText}
                </span>
              </SettingsRow>
              <SettingsRow label="模式">
                <span className="val">
                  {currentAgent.mode !== undefined && currentAgent.mode !== ""
                    ? currentAgent.mode
                    : "默认"}
                </span>
              </SettingsRow>
              <SettingsRow label="环境变量">
                {envKeys.length > 0 ? (
                  <span className="val mono ellip">{envKeys.join(", ")}</span>
                ) : (
                  <span className="val dim">—</span>
                )}
              </SettingsRow>
              <SettingsRow label="会话配置项">
                {cfgCount > 0 ? (
                  <span className="val mono">{cfgCount} 项</span>
                ) : (
                  <span className="val dim">—</span>
                )}
              </SettingsRow>
            </SettingsGroup>
            <ProbeDetails result={recentAgentProbe?.result} at={recentAgentProbe?.at} />
          </div>
        </>
      );
    }

    // 列表页
    const defaultEntry = {
      name: "default",
      config: {
        description: "通用",
        enabled: true,
        ...(defaultModel ? { model: defaultModel } : {}),
      } satisfies SubagentProfileConfig,
      readonly: true,
    };

    return (
      <>
        <PageHeader
          title="子代理"
          actions={
            <>
              <Button
                size="sm"
                disabled={!client || busy}
                onClick={() => {
                  setError("");
                  setView({
                    kind: "agentForm",
                    config: { name: "", command: "", args: [], enabled: false },
                    replace: false,
                  });
                }}
              >
                添加 agent
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!client || busy}
                onClick={() => {
                  setError("");
                  setView({ kind: "newProfile" });
                }}
              >
                添加档位
              </Button>
            </>
          }
        />
        {error && (
          <div className="desc err" role="alert">
            {error}
          </div>
        )}
        {warnings.map((warning, i) => (
          <div className="desc err" role="status" key={`${i}-${warning}`}>
            {warning}
          </div>
        ))}
        <div className="sbody">
          <SettingsGroup title="内置档位" count={profiles.length + 1} plain>
            <SettingsListRow
              key={defaultEntry.name}
              name={defaultEntry.name}
              mono
              badge={
                defaultEntry.config.model !== undefined ? (
                  <Badge>{modelIdOf(defaultEntry.config.model, models)}</Badge>
                ) : undefined
              }
              description={defaultEntry.config.description}
              status="默认"
              onOpen={() => {
                setError("");
                setView({ kind: "profile", name: "default" });
              }}
            />
            {profiles.map((entry) => {
              const ro = entry.item.source !== "settings";
              return (
                <SettingsListRow
                  key={entry.name}
                  name={entry.name}
                  mono
                  badge={
                    entry.config.model !== undefined ? (
                      <Badge>{modelIdOf(entry.config.model, models)}</Badge>
                    ) : undefined
                  }
                  description={entry.config.description}
                  disabled={!entry.config.enabled}
                  toggle={
                    <Switch
                      aria-label={`启用 ${entry.name}`}
                      checked={entry.config.enabled}
                      disabled={!client || busy || ro}
                      onChange={(next) => {
                        void toggleProfileRow(entry, next);
                      }}
                    />
                  }
                  onOpen={() => {
                    setError("");
                    setView({ kind: "profile", name: entry.name });
                  }}
                />
              );
            })}
          </SettingsGroup>
          {pluginAgentGroups.map(({ plugin, agents: pluginAgents }) => (
            <SettingsGroup
              key={plugin.id}
              title={plugin.displayName ?? plugin.name}
              count={pluginAgents.length}
              plain
            >
              {pluginAgents.map((agent) => {
                const modelItem = items.find(
                  (item) => item.key === `subagents.pluginModels.${agent.id}`,
                );
                const selectedModel = modelItem?.effective ?? "";
                const ro = modelItem !== undefined && modelItem.source !== "settings";
                return (
                  <SettingsListRow
                    key={agent.id}
                    className="plugin-agent-row"
                    leading={<PluginIcon icon={plugin.icon} size="md" />}
                    name={agent.name}
                    mono
                    badge={
                      agent.tools !== undefined ? (
                        <Badge>{`${agent.tools.length} 个工具`}</Badge>
                      ) : undefined
                    }
                    description={agent.description}
                    toggle={
                      <span
                        className="plugin-agent-model"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <Dropdown
                          label={`${agent.name} 模型`}
                          value={selectedModel}
                          searchable
                          disabled={!client || busy || ro ? "不可编辑" : undefined}
                          options={pluginModelOptionsFor(selectedModel)}
                          onChange={(next) => {
                            if (next === selectedModel) return;
                            void savePluginAgentModel(agent.id, next);
                          }}
                        />
                      </span>
                    }
                    onOpen={() => {
                      setError("");
                      setMenuOpen(false);
                      setView({ kind: "pluginAgent", id: agent.id });
                    }}
                  />
                );
              })}
            </SettingsGroup>
          ))}
          {orderedAgents.length > 0 && (
            <SettingsGroup title="外部 Agent" count={orderedAgents.length} plain>
              {orderedAgents.map((agent) => {
                const readonlyReason = readonlyReasonOf(agent);
                const conflict = externalAgentSlashConflict(agent.name, skills);
                const probe = results[agent.name]?.result;
                const cmdText = [agent.command, ...agent.args].join(" ");
                const statusNode = conflict ? (
                  <span className="st err" title={conflict}>
                    <span className="dot" aria-hidden="true" />
                    名称冲突
                  </span>
                ) : probe ? (
                  <span className={probe.ok ? "st ok" : "st err"}>
                    <span className="dot" aria-hidden="true" />
                    {resultText(probe)}
                  </span>
                ) : undefined;
                return (
                  <SettingsListRow
                    key={agent.name}
                    name={agent.name}
                    mono
                    badge={!agent.editable ? <Badge title={readonlyReason}>只读</Badge> : undefined}
                    description={cmdText}
                    descriptionMono
                    disabled={!agent.enabled}
                    status={statusNode}
                    toggle={
                      <Switch
                        aria-label={`启用 ${agent.name}`}
                        checked={agent.enabled}
                        disabled={!client || !agent.editable || busy}
                        title={readonlyReason}
                        onChange={(next) => {
                          if (client)
                            void mutate(
                              () =>
                                client.runtime.setExternalAgentEnabled({
                                  name: agent.name,
                                  enabled: next,
                                }),
                              next ? "已启用" : "已停用",
                            );
                        }}
                      />
                    }
                    onOpen={() => {
                      setError("");
                      setMenuOpen(false);
                      setView({ kind: "agent", name: agent.name });
                    }}
                  />
                );
              })}
            </SettingsGroup>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="page3 external-agents-page">
      <div className="spage">
        <div className="readable">{renderBody()}</div>
      </div>
      {toast && (
        <div className="toast3" role="status">
          ✓ {toast}
        </div>
      )}
      {deleting && currentAgent && (
        <ConfirmDialog
          title={`删除 ${currentAgent.name}？`}
          confirmLabel="删除"
          danger
          onClose={() => {
            if (!busy) setDeleting(false);
          }}
          onConfirm={async () => {
            if (!client) return;
            await mutate(async () => {
              await client.runtime.deleteExternalAgent({ name: currentAgent.name });
              setDeleting(false);
              setView({ kind: "list" });
            }, `已删除 ${currentAgent.name}`);
          }}
        />
      )}
    </div>
  );
}

function ProbeDetails({
  result,
  at,
}: {
  result: ExternalAgentProbeResult | undefined;
  at?: string | undefined;
}) {
  const statusCls = result === undefined ? "st" : result.ok ? "st ok" : "st err";
  const dotCls = result === undefined ? "dot hollow" : "dot";
  return (
    <SettingsGroup title="最近测试">
      <SettingsRow label="结果">
        <span className={statusCls}>
          <span className={dotCls} aria-hidden="true" />
          {resultText(result)}
        </span>
      </SettingsRow>
      {result !== undefined && (
        <SettingsRow label="时间">
          <span className="val mono">
            {at !== undefined ? `${at} · ${result.durationMs} ms` : `${result.durationMs} ms`}
          </span>
        </SettingsRow>
      )}
      {result?.ok && result.authMethods && result.authMethods.length > 0 && (
        <SettingsRow label="登录方式">
          <span className="val">{result.authMethods.map((m) => m.name).join("、")}</span>
        </SettingsRow>
      )}
      {result?.ok && (
        <SettingsRow label="可配置选项">
          <span className="val mono">{result.configOptions.length} 项</span>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

function ExternalAgentForm({
  client,
  initial,
  replace,
  recent,
  onBackToList,
  onProbed,
  onCancel,
  onSaved,
}: {
  client: RpcClient;
  initial: ExternalAgentConfig;
  replace: boolean;
  recent: ProbeRecord | undefined;
  onBackToList: () => void;
  onProbed: (name: string, record: ProbeRecord) => void;
  onCancel: () => void;
  onSaved: (name: string, tested: ProbeRecord | undefined) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState(initial.args.join("\n"));
  const [mode, setMode] = useState(initial.mode ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [enabled, setEnabled] = useState(initial.enabled);
  const [env, setEnv] = useState(JSON.stringify(initial.env ?? {}, null, 2));
  const [options, setOptions] = useState(JSON.stringify(initial.configOptions ?? {}, null, 2));
  const [probeRecord, setProbeRecord] = useState<ProbeRecord | undefined>(recent);
  const [testedDraft, setTestedDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nameId = useId();
  const descId = useId();
  const cmdId = useId();
  const argsId = useId();
  const modeId = useId();
  const envId = useId();
  const optionsId = useId();

  const draft = (): ExternalAgentConfig => ({
    name: name.trim(),
    command: command.trim(),
    args: args.split(/\r?\n/).filter((arg) => arg !== ""),
    enabled,
    ...(mode.trim() ? { mode: mode.trim() } : {}),
    ...(description.trim() ? { description: description.trim() } : {}),
    env: stringMap(env, "环境变量"),
    configOptions: stringMap(options, "会话配置项"),
  });

  let selectedOptions: Record<string, string> = {};
  try {
    selectedOptions = stringMap(options, "会话配置项");
  } catch {
    /* 保存和测试时显示具体错误，保留用户正在编辑的 JSON。 */
  }

  const preset = (value: string) => {
    const config = EXTERNAL_AGENT_PRESETS.find((item) => item.name === value);
    if (!config) return;
    setName(config.name);
    setCommand(config.command);
    setArgs(config.args.join("\n"));
    setMode("");
    setDescription(config.description ?? "");
    setEnabled(false);
    setEnv("{}");
    setOptions("{}");
    setProbeRecord(undefined);
  };

  const run = async (save: boolean) => {
    setBusy(true);
    setError("");
    try {
      const config = draft();
      if (save) {
        const { name: agentName, ...body } = config;
        await client.runtime.saveExternalAgent({
          mode: replace ? "replace" : "create",
          name: agentName,
          config: body,
        });
        await onSaved(agentName, testedDraft === launchKey(config) ? probeRecord : undefined);
      } else {
        const probed = await client.runtime.probeExternalAgent({ config });
        const record: ProbeRecord = { result: probed, at: formatTime() };
        setProbeRecord(record);
        setTestedDraft(launchKey(config));
        if (config.name !== "") onProbed(config.name, record);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const result = probeRecord?.result;

  return (
    <>
      <PageHeader
        crumb={{ parent: "子代理", onBack: onBackToList }}
        title={replace ? <span className="mono">{initial.name}</span> : "添加外部 Agent"}
      />
      <form
        className="form settings-subpage-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(true);
        }}
      >
        <SettingsGroup plain>
          {!replace && (
            <Field label="从预设填入">
              <Dropdown
                label="外部 agent 预设"
                value={undefined}
                options={EXTERNAL_AGENT_PRESETS.map((config) => ({
                  value: config.name,
                  label: config.name,
                  description: `${config.command} ${config.args.join(" ")}`,
                }))}
                onChange={preset}
                disabled={busy ? "正在处理" : undefined}
              />
            </Field>
          )}
          <fieldset disabled={busy}>
            <Field label="名称" htmlFor={nameId}>
              <input
                id={nameId}
                aria-label="名称"
                className="input mono"
                value={name}
                disabled={replace}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="描述" htmlFor={descId}>
              <input
                id={descId}
                aria-label="描述"
                className="input"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </Field>
            <Field label="命令" htmlFor={cmdId}>
              <input
                id={cmdId}
                aria-label="命令"
                className="input mono"
                value={command}
                onChange={(event) => {
                  setCommand(event.target.value);
                  setProbeRecord(undefined);
                }}
                required
              />
            </Field>
            <Field label="参数" htmlFor={argsId}>
              <textarea
                id={argsId}
                aria-label="参数"
                className="textarea mono"
                rows={3}
                value={args}
                onChange={(event) => {
                  setArgs(event.target.value);
                  setProbeRecord(undefined);
                }}
              />
            </Field>
            <Field label="模式 id" htmlFor={modeId}>
              <input
                id={modeId}
                aria-label="模式 id"
                className="input mono"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value);
                  setProbeRecord(undefined);
                }}
              />
            </Field>
            <Field label="环境变量" htmlFor={envId}>
              <textarea
                id={envId}
                aria-label="环境变量"
                className="textarea mono"
                rows={3}
                value={env}
                onChange={(event) => {
                  setEnv(event.target.value);
                  setProbeRecord(undefined);
                }}
              />
            </Field>
            <SettingsRow label="启用">
              <Switch aria-label="启用" checked={enabled} onChange={setEnabled} />
            </SettingsRow>
          </fieldset>
        </SettingsGroup>
        <SettingsGroup title="会话配置项" plain>
          {result?.ok &&
            result.configOptions.map((option) => (
              <Field
                key={option.id}
                label={
                  <>
                    {option.name}
                    {option.id.toLowerCase() !== option.name.toLowerCase() && (
                      <>
                        {" "}
                        <code>{option.id}</code>
                      </>
                    )}
                  </>
                }
                aside={option.description}
              >
                <div className="external-option-ctl">
                  <Dropdown
                    searchable
                    label={option.name}
                    value={selectedOptions[option.id] ?? option.currentValue}
                    placeholder={selectedOptions[option.id] ?? option.currentValue}
                    options={option.options.map((item) => {
                      // 同名选项靠对方给的 description 区分；没有时显示值本身（只展示，不解析）
                      const detail =
                        item.description ?? (item.value !== item.name ? item.value : undefined);
                      return {
                        value: item.value,
                        label: item.name,
                        ...(detail !== undefined ? { description: detail } : {}),
                        ...(item.group !== undefined ? { tag: item.group } : {}),
                      };
                    })}
                    disabled={busy ? "正在处理" : undefined}
                    onChange={(value) => {
                      try {
                        setOptions(
                          JSON.stringify(
                            { ...stringMap(options, "会话配置项"), [option.id]: value },
                            null,
                            2,
                          ),
                        );
                      } catch (e) {
                        setError(message(e));
                      }
                    }}
                  />
                  {selectedOptions[option.id] !== undefined && (
                    <Button
                      size="sm"
                      className="external-option-reset"
                      disabled={busy}
                      onClick={() => {
                        const { [option.id]: _removed, ...rest } = selectedOptions;
                        setOptions(JSON.stringify(rest, null, 2));
                      }}
                    >
                      恢复默认
                    </Button>
                  )}
                </div>
              </Field>
            ))}
          <Field label="JSON" htmlFor={optionsId}>
            <textarea
              id={optionsId}
              aria-label="JSON"
              className="textarea mono"
              rows={3}
              disabled={busy}
              value={options}
              onChange={(event) => {
                setOptions(event.target.value);
              }}
            />
          </Field>
        </SettingsGroup>
        {probeRecord !== undefined && (
          <ProbeDetails result={probeRecord.result} at={probeRecord.at} />
        )}
        {error && (
          <div className="errt" role="alert">
            {error}
          </div>
        )}
        <FormFooter>
          <Button disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void run(false)}>
            {busy ? "处理中…" : "测试连接"}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            保存
          </Button>
        </FormFooter>
      </form>
    </>
  );
}
