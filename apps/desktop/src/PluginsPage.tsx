import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type {
  PluginHookOverview,
  PluginHost,
  PluginMcpServerOverview,
  PluginMcpSkipReason,
  PluginOverview,
  PluginUnsupportedHook,
  PluginUnsupportedReason,
  PluginsDescription,
} from "@nocturne/core/protocol";
import { Scrim } from "./ProvidersPage";
import {
  Badge,
  Button,
  EmptyState,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SettingsGroup,
  SettingsListRow,
  SettingsRow,
  Switch,
} from "./ui";
import "./pages.css";
import "./mcp.css";
import "./plugins.css";

const HOST_LABEL: Record<PluginHost, string> = {
  nocturne: "Nocturne",
  codex: "Codex",
  claude: "Claude Code",
};

const isBuiltinPlugin = (plugin: PluginOverview): boolean =>
  plugin.host === "nocturne" && plugin.marketplace === "builtin";

const PLUGIN_GROUPS: readonly {
  key: string;
  title: string;
  match: (plugin: PluginOverview) => boolean;
}[] = [
  { key: "builtin", title: "内置", match: isBuiltinPlugin },
  {
    key: "nocturne",
    title: "Nocturne",
    match: (p) => p.host === "nocturne" && p.marketplace !== "builtin",
  },
  { key: "codex", title: "Codex", match: (p) => p.host === "codex" },
  { key: "claude", title: "Claude Code", match: (p) => p.host === "claude" },
];

const UNSUPPORTED_REASON_LABEL: Record<PluginUnsupportedReason, string> = {
  point: "不支持的点位",
  type: "不支持的类型",
  async: "异步",
  user_config: "需要用户配置",
};

const MCP_SKIP_REASON_LABEL: Record<PluginMcpSkipReason, string> = {
  http: "不支持 HTTP",
  stored: "不支持凭据库",
  conflict: "与配置同名",
  invalid: "配置无效",
};

const pluginLabel = (plugin: PluginOverview): string => plugin.displayName ?? plugin.name;

function dataUriToBlobUrl(uri: string): string {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
  if (!match) return uri;
  const [, mime, payload] = match;
  if (!mime || !payload) return uri;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return uri;
  }
}

export function PluginIcon({
  icon,
  size = "md",
}: {
  icon?: string | undefined;
  size?: "sm" | "md";
}) {
  // 桌面端 CSP 为 img-src 'self' blob:，在支持 ObjectURL 的环境将 data URI 转为 blob URL 渲染
  const canBlobUrl = typeof URL.createObjectURL === "function";
  const [blobSrc, setBlobSrc] = useState<string>();

  useEffect(() => {
    if (!icon || !canBlobUrl) {
      setBlobSrc(undefined);
      return;
    }
    const url = dataUriToBlobUrl(icon);
    setBlobSrc(url);
    return () => {
      if (url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    };
  }, [icon, canBlobUrl]);

  const imgSrc = icon ? (canBlobUrl ? blobSrc : icon) : undefined;

  return (
    <span
      className={`plugin-icon plugin-icon-${size}${icon ? "" : " fallback"}`}
      aria-hidden="true"
    >
      {icon ? (
        imgSrc !== undefined ? (
          <img className="plugin-icon-img" src={imgSrc} alt="" />
        ) : null
      ) : (
        <Icon name="box_3" size={size === "sm" ? ICON_SM : ICON_MD} />
      )}
    </span>
  );
}

export function PluginsPage({
  client,
  version,
  openDirectory,
  openPlugin,
}: {
  client: RpcClient | undefined;
  version: number;
  openDirectory: (path: string) => Promise<void>;
  openPlugin?: { id: string; seq: number } | undefined;
}) {
  const [data, setData] = useState<PluginsDescription>();
  const [selected, setSelected] = useState<string>();
  const [confirming, setConfirming] = useState<PluginOverview>();
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshGeneration = useRef(0);
  const handledJumpSeq = useRef(0);

  useEffect(() => {
    if (openPlugin !== undefined && openPlugin.seq !== handledJumpSeq.current) {
      handledJumpSeq.current = openPlugin.seq;
      setError("");
      setSelected(openPlugin.id);
    }
  }, [openPlugin]);

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
    const generation = ++refreshGeneration.current;
    try {
      const result = await client.runtime.describePlugins();
      if (generation !== refreshGeneration.current) return;
      setData(result);
      setSelected((old) =>
        old !== undefined && result.plugins.some((p) => p.id === old) ? old : undefined,
      );
      setError("");
    } catch (e) {
      if (generation === refreshGeneration.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const off = client?.onProvidersChanged(() => {
      void refresh();
    });
    return () => {
      refreshGeneration.current++;
      off?.();
    };
  }, [client, refresh, version]);

  const plugin = selected !== undefined ? data?.plugins.find((p) => p.id === selected) : undefined;

  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const disablePlugin = async (target: PluginOverview) => {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    await attempt(async () => {
      await client.runtime.setPluginEnabled({ id: target.id, enabled: false });
      setToast(`已停用 ${pluginLabel(target)}`);
      await refresh();
    });
    setBusy(false);
  };

  const enablePlugin = async (target: PluginOverview) => {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.runtime.setPluginEnabled({ id: target.id, enabled: true });
      setConfirming(undefined);
      setToast(`已启用 ${pluginLabel(target)}`);
      await refresh();
    } catch (e) {
      setConfirming(undefined);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openConfirm = (target: PluginOverview) => {
    if (!client || busy) return;
    setError("");
    setConfirming(target);
  };

  const handleToggle = (target: PluginOverview) => {
    if (target.state === "on") {
      void disablePlugin(target);
      return;
    }
    if (isBuiltinPlugin(target)) {
      void enablePlugin(target);
      return;
    }
    openConfirm(target);
  };

  const empty = data?.plugins.length === 0;
  const pageWarnings = data?.warnings ?? [];

  return (
    <div className="page3 plugins-page">
      <div className="spage">
        <div className="readable">
          {plugin ? (
            <>
              <PageHeader
                title={
                  <span className="plugin-detail-title">
                    <PluginIcon icon={plugin.icon} size="sm" />
                    <span className="plugin-detail-name">{pluginLabel(plugin)}</span>
                  </span>
                }
                crumb={{
                  parent: "插件",
                  onBack: () => {
                    setError("");
                    setSelected(undefined);
                  },
                }}
                actions={
                  <>
                    {plugin.state === "changed" && (
                      <Button
                        size="sm"
                        disabled={busy || !client}
                        onClick={() => {
                          openConfirm(plugin);
                        }}
                      >
                        重新确认
                      </Button>
                    )}
                    <Switch
                      checked={plugin.state === "on"}
                      aria-label={`启用 ${pluginLabel(plugin)}`}
                      disabled={busy || !client}
                      onChange={() => {
                        handleToggle(plugin);
                      }}
                    />
                    <IconButton
                      aria-label="在资源管理器中打开"
                      title="在资源管理器中打开"
                      onClick={() => void attempt(() => openDirectory(plugin.root))}
                    >
                      <Icon name="folder" size={ICON_MD} />
                    </IconButton>
                  </>
                }
              />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              <div className="sbody">
                <SettingsGroup title="概况" plain>
                  <SettingsRow label="位置">
                    <code>{plugin.root}</code>
                  </SettingsRow>
                  <SettingsRow label="版本">
                    {plugin.version ? (
                      <span className="val mono">{plugin.version}</span>
                    ) : (
                      <span className="val dim">—</span>
                    )}
                  </SettingsRow>
                  <SettingsRow label="来源">
                    <>
                      {HOST_LABEL[plugin.host]}
                      {plugin.marketplace ? (
                        <>
                          <span className="val dim"> · </span>
                          <span className="mono">{plugin.marketplace}</span>
                        </>
                      ) : null}
                    </>
                  </SettingsRow>
                </SettingsGroup>
                {plugin.hooks.length > 0 && (
                  <SettingsGroup title="Hook" plain count={plugin.hooks.length}>
                    <PluginHookList hooks={plugin.hooks} />
                  </SettingsGroup>
                )}
                {plugin.skills.length > 0 && (
                  <SettingsGroup title="技能" plain count={plugin.skills.length}>
                    <div className="chips">
                      {plugin.skills.map((name) => (
                        <span key={name}>{name}</span>
                      ))}
                    </div>
                  </SettingsGroup>
                )}
                {plugin.mcpServers.length > 0 && (
                  <SettingsGroup title="MCP 服务器" plain count={plugin.mcpServers.length}>
                    <PluginMcpServerList servers={plugin.mcpServers} />
                  </SettingsGroup>
                )}
                {plugin.unsupported.length > 0 && (
                  <SettingsGroup title="不运行" plain count={plugin.unsupported.length}>
                    {plugin.unsupported.map((item, i) => (
                      <SettingsRow
                        key={`${item.point}-${item.reason}-${i}`}
                        label={<code>{item.point}</code>}
                      >
                        <span className="plugin-warn">{UNSUPPORTED_REASON_LABEL[item.reason]}</span>
                      </SettingsRow>
                    ))}
                  </SettingsGroup>
                )}
                <PluginWarnings warnings={plugin.warnings} />
              </div>
            </>
          ) : (
            <>
              <PageHeader title="插件" />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              {empty ? (
                <div>
                  <EmptyState>没有插件</EmptyState>
                  <PluginWarnings warnings={pageWarnings} />
                </div>
              ) : (
                <div className="sbody">
                  {PLUGIN_GROUPS.map((group) => {
                    const groupPlugins = data?.plugins.filter(group.match) ?? [];
                    if (groupPlugins.length === 0) return null;
                    return (
                      <SettingsGroup
                        key={group.key}
                        plain
                        title={group.title}
                        count={groupPlugins.length}
                      >
                        {groupPlugins.map((p) => {
                          const label = pluginLabel(p);
                          return (
                            <SettingsListRow
                              key={p.id}
                              leading={<PluginIcon icon={p.icon} />}
                              name={label}
                              badge={
                                p.version ? (
                                  <Badge className="plugin-version">{p.version}</Badge>
                                ) : undefined
                              }
                              description={p.description}
                              status={
                                p.state === "changed" ? (
                                  <span className="st warn">
                                    <span className="dot" aria-hidden="true" />
                                    已更改
                                  </span>
                                ) : undefined
                              }
                              toggle={
                                p.state === "changed" ? (
                                  <>
                                    <Button
                                      size="sm"
                                      disabled={busy || !client}
                                      onClick={() => {
                                        openConfirm(p);
                                      }}
                                    >
                                      重新确认
                                    </Button>
                                    <Switch
                                      checked={false}
                                      aria-label={`启用 ${label}`}
                                      disabled={busy || !client}
                                      onChange={() => {
                                        handleToggle(p);
                                      }}
                                    />
                                  </>
                                ) : (
                                  <Switch
                                    checked={p.state === "on"}
                                    aria-label={`启用 ${label}`}
                                    disabled={busy || !client}
                                    onChange={() => {
                                      handleToggle(p);
                                    }}
                                  />
                                )
                              }
                              disabled={p.state === "off"}
                              onOpen={() => {
                                setError("");
                                setSelected(p.id);
                              }}
                            />
                          );
                        })}
                      </SettingsGroup>
                    );
                  })}
                  <PluginWarnings warnings={pageWarnings} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {toast && (
        <div className="toast3" role="status">
          ✓ {toast}
        </div>
      )}
      {confirming !== undefined && (
        <PluginEnableDialog
          plugin={confirming}
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirming(undefined);
          }}
          onConfirm={() => {
            void enablePlugin(confirming);
          }}
        />
      )}
    </div>
  );
}

function PluginHookList({ hooks }: { hooks: readonly PluginHookOverview[] }) {
  return (
    <div className="plugin-hooks">
      {hooks.map((hook, i) => (
        <div
          key={`${hook.point}-${hook.matcher ?? ""}-${hook.command}-${i}`}
          className="plugin-hook-item"
        >
          <div className="plugin-hook-head">
            <span className="plugin-hook-point">{hook.point}</span>
            {hook.matcher !== undefined && hook.matcher !== "" && (
              <Badge className="plugin-hook-matcher">{hook.matcher}</Badge>
            )}
          </div>
          <code className="plugin-hook-cmd">{hook.command}</code>
        </div>
      ))}
    </div>
  );
}

function PluginMcpServerList({ servers }: { servers: readonly PluginMcpServerOverview[] }) {
  return (
    <div className="plugin-hooks">
      {servers.map((server) => (
        <div key={server.id} className="plugin-hook-item">
          <div className="plugin-hook-head">
            <span className="plugin-hook-point">{server.id}</span>
            {server.skipped === true && (
              <span className="plugin-warn">
                {server.skipReason !== undefined
                  ? MCP_SKIP_REASON_LABEL[server.skipReason]
                  : "已跳过"}
              </span>
            )}
          </div>
          {server.command !== undefined && server.command !== "" && (
            <code className="plugin-hook-cmd">{server.command}</code>
          )}
        </div>
      ))}
    </div>
  );
}

function PluginUnsupportedList({ unsupported }: { unsupported: readonly PluginUnsupportedHook[] }) {
  return (
    <div className="plugin-dlg-unsupported">
      {unsupported.map((item, i) => (
        <div key={`${item.point}-${item.reason}-${i}`} className="plugin-dlg-unsupported-row">
          <code>{item.point}</code>
          <span className="plugin-warn">{UNSUPPORTED_REASON_LABEL[item.reason]}</span>
        </div>
      ))}
    </div>
  );
}

function PluginEnableDialog({
  plugin,
  busy,
  onCancel,
  onConfirm,
}: {
  plugin: PluginOverview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = `启用 ${pluginLabel(plugin)}`;
  return (
    <Scrim onClose={onCancel}>
      <div className="dlg" role="dialog" aria-label={title}>
        <div className="dh3">
          <b>{title}</b>
        </div>
        <div className="db">
          {plugin.hooks.length > 0 && (
            <div className="plugin-dlg-section">
              <div className="plugin-dlg-title">Hook</div>
              <PluginHookList hooks={plugin.hooks} />
            </div>
          )}
          {plugin.skills.length > 0 && (
            <div className="plugin-dlg-section">
              <div className="plugin-dlg-title">技能</div>
              <div className="chips">
                {plugin.skills.map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </div>
            </div>
          )}
          {plugin.mcpServers.length > 0 && (
            <div className="plugin-dlg-section">
              <div className="plugin-dlg-title">MCP 服务器</div>
              <PluginMcpServerList servers={plugin.mcpServers} />
            </div>
          )}
          {plugin.unsupported.length > 0 && (
            <div className="plugin-dlg-section">
              <div className="plugin-dlg-title">不运行</div>
              <PluginUnsupportedList unsupported={plugin.unsupported} />
            </div>
          )}
        </div>
        <div className="df">
          <span className="sp" />
          <Button disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            启用
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

function PluginWarnings({ warnings }: { warnings: readonly string[] }) {
  return warnings.length ? (
    <details className="plugin-warnings">
      <summary>
        <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
        {warnings.length} 条警告，查看
      </summary>
      {warnings.map((w, i) => (
        <div key={`${i}-${w}`}>{w}</div>
      ))}
    </details>
  ) : null;
}
