import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { RpcError, type RpcClient } from "@nocturne/rpc/client";
import type { McpProbeResult, McpServerOverview, McpValueOverview } from "@nocturne/core/protocol";
import { Dropdown } from "./Dropdown";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { Scrim } from "./ProvidersPage";
import {
  overviewValues,
  parseMcpImport,
  secretName,
  type McpDraft,
  type McpImportRow,
} from "./mcp-import";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Form,
  FormFooter,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
  SettingsListRow,
  SettingsRow,
  Switch,
} from "./ui";
import "./pages.css";
import "./mcp.css";

export interface McpLiveStatus {
  name: string;
  state: "starting" | "ready" | "failed" | "crashed" | "stopped";
  toolCount: number;
  error?: string | undefined;
}

type McpView =
  | { kind: "list" }
  | { kind: "detail"; id: string }
  | { kind: "create"; draft: McpDraft; seq: number }
  | { kind: "edit"; id: string; draft: McpDraft };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const probeErrors = {
  auth_required: "认证失败，请检查请求头",
  spawn_failed: "启动失败，请检查命令是否已安装、路径是否正确",
  startup_timeout: "启动超时，请检查服务器是否正常启动或增加启动超时",
  http_redirect: "服务器重定向到其他地址，请检查 HTTP 地址",
  mcp_secret_missing: "缺少已保存的凭据，请替换密钥或引用环境变量",
  initialize_failed: "MCP 握手失败，请检查服务器是否支持 MCP 协议",
  connect_failed: "连接失败，请检查 HTTP 地址和网络连接",
  http_status: "HTTP 请求失败，请检查服务器返回的状态码",
};
const transportLabel = (transport: McpServerOverview["transport"]): string =>
  transport === "http" ? "流式 HTTP" : "本地命令";
const serverAddress = (server: McpServerOverview): string =>
  server.url ?? [server.command, ...(server.args ?? [])].join(" ");
const valueKindLabel = (kind: McpValueOverview["kind"]): string =>
  kind === "stored" ? "凭据库" : kind === "env" ? "环境变量" : "明文";

const resultText = (r: McpProbeResult | undefined): ReactNode =>
  !r ? (
    "未测试"
  ) : r.ok ? (
    <>
      已连接<span className="muted-value">{r.tools.length} 个工具</span>
    </>
  ) : r.error ? (
    probeErrors[r.error.code]
  ) : (
    "测试失败"
  );
const liveText = (live: McpLiveStatus | undefined): ReactNode =>
  !live ? (
    "未测试"
  ) : live.state === "ready" ? (
    <>
      已连接<span className="muted-value">{live.toolCount} 个工具</span>
    </>
  ) : live.state === "starting" ? (
    "连接中"
  ) : (
    (live.error ?? "未连接")
  );

function detailStatusOf(
  r: McpProbeResult | undefined,
  live: McpLiveStatus | undefined,
): { dot: "ok" | "warn" | ""; label: ReactNode; error?: string | undefined } {
  if (r) {
    if (r.ok) {
      return {
        dot: "ok",
        label: (
          <>
            已连接<span className="muted-value">{r.tools.length} 个工具</span>
          </>
        ),
      };
    }
    return {
      dot: "warn",
      label: "测试失败",
      error: r.error?.message,
    };
  }
  if (!live) return { dot: "", label: "未测试" };
  if (live.state === "ready") {
    return {
      dot: "ok",
      label: (
        <>
          已连接<span className="muted-value">{live.toolCount} 个工具</span>
        </>
      ),
    };
  }
  if (live.state === "starting") return { dot: "", label: "连接中" };
  return { dot: "warn", label: "未连接", error: live.error };
}

function draftOf(server: McpServerOverview): McpDraft {
  return {
    id: server.id,
    secrets: {},
    config: {
      type: server.transport,
      enabled: server.enabled,
      startupTimeoutMs: server.startupTimeoutMs,
      callTimeoutMs: server.callTimeoutMs,
      ...(server.transport === "http"
        ? { url: server.url ?? "", headers: overviewValues(server.headers ?? []) }
        : {
            command: server.command ?? "",
            args: server.args ?? [],
            ...(server.cwd ? { cwd: server.cwd } : {}),
            env: overviewValues(server.env ?? []),
          }),
    },
  };
}

export function McpPage({
  client,
  workspaceRoot,
  version,
  onChanged,
  loadLive,
  liveRevision,
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
  onChanged: () => void;
  /** 当前会话的连接状态；没有打开的会话时不传 */
  loadLive?: (() => Promise<readonly McpLiveStatus[]>) | undefined;
  /** 会话连接状态变化时改变，触发重新读取 */
  liveRevision?: string | undefined;
}) {
  const [servers, setServers] = useState<McpServerOverview[]>([]);
  const [view, setView] = useState<McpView>({ kind: "list" });
  const [results, setResults] = useState<Record<string, McpProbeResult>>({});
  const [live, setLive] = useState<readonly McpLiveStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [backend, setBackend] = useState(false);
  const [importing, setImporting] = useState(false);
  const [queue, setQueue] = useState<McpDraft[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const seqRef = useRef(0);
  const moreRef = useRef<HTMLButtonElement>(null);

  const nextSeq = () => {
    seqRef.current += 1;
    return seqRef.current;
  };

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const data = await client.runtime.describeMcpServers({ workspaceRoot });
      setServers(data.servers);
      setView((current) =>
        current.kind === "detail" && !data.servers.some((s) => s.id === current.id)
          ? { kind: "list" }
          : current,
      );
      const setup = await client.provider.describeProviderSetup("custom-openai");
      setBackend(setup.credential.backend.available);
    } catch (e) {
      setError(message(e));
    }
  }, [client, workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // 页面离开后仍保留：重新进入、配置变化或切换会话时，手动测试结果让位给会话状态
  useEffect(() => {
    if (loadLive) setResults({});
  }, [loadLive, version]);

  useEffect(() => {
    if (!loadLive) {
      setLive([]);
      return;
    }
    let stale = false;
    loadLive().then(
      (next) => {
        if (!stale) setLive(next);
      },
      () => {
        if (!stale) setLive([]);
      },
    );
    return () => {
      stale = true;
    };
  }, [loadLive, liveRevision, version]);

  const liveOf = (server: McpServerOverview) =>
    server.enabled ? live.find((s) => s.name === server.id && s.state !== "stopped") : undefined;

  const dotOf = (server: McpServerOverview): "ok" | "warn" | "" => {
    if (!server.enabled) return "";
    const probed = results[server.id];
    if (probed) return probed.ok ? "ok" : "warn";
    const state = liveOf(server)?.state;
    return state === "ready" ? "ok" : state === "failed" || state === "crashed" ? "warn" : "";
  };

  const changed = async (text: string) => {
    onChanged();
    setToast(text);
    await refresh();
  };

  const backToList = () => {
    setMenuOpen(false);
    setDeleting(false);
    setError("");
    setQueue([]);
    setView({ kind: "list" });
  };

  const openDetail = (id: string) => {
    setMenuOpen(false);
    setError("");
    setQueue([]);
    setView({ kind: "detail", id });
  };

  const toggleEnabled = (server: McpServerOverview, next: boolean) => {
    if (!client) return;
    setBusy(true);
    void client.runtime
      .setMcpServerEnabled({ id: server.id, enabled: next })
      .then(() => changed(server.enabled ? "已停用" : "已启用"))
      .catch((e: unknown) => {
        setError(message(e));
        // 失败时磁盘上的配置可能已改，列表重新拉取
        void refresh();
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const probe = async (server: McpServerOverview) => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      const r = await client.runtime.probeMcpServer({ id: server.id, workspaceRoot });
      setResults((old) => ({ ...old, [server.id]: r }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    setQueue([]);
    setError("");
    setMenuOpen(false);
    setView({
      kind: "create",
      seq: nextSeq(),
      draft: {
        id: "",
        config: { type: "stdio", command: "", args: [], enabled: true },
        secrets: {},
      },
    });
  };

  const current = view.kind === "detail" ? servers.find((s) => s.id === view.id) : undefined;
  const r = current ? results[current.id] : undefined;
  const liveStatus = current ? liveOf(current) : undefined;
  const detailStatus = current ? detailStatusOf(r, liveStatus) : undefined;
  const detailValues = current ? (current.headers ?? current.env ?? []) : [];

  return (
    <div className="page3 mcp-page">
      <div className="spage">
        <div className="readable">
          {(view.kind === "create" || view.kind === "edit") && client ? (
            <>
              <PageHeader
                title={
                  view.kind === "edit" ? (
                    <span className="mcp-head-mono">{view.draft.id}</span>
                  ) : (
                    "添加 MCP 服务器"
                  )
                }
                crumb={{ parent: "MCP", onBack: backToList }}
              />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              <McpForm
                key={view.kind === "edit" ? `edit-${view.id}` : `create-${view.seq}`}
                client={client}
                draft={view.draft}
                replace={view.kind === "edit"}
                backend={backend}
                workspaceRoot={workspaceRoot}
                onCancel={() => {
                  if (view.kind === "edit") {
                    setError("");
                    setView({ kind: "detail", id: view.id });
                  } else {
                    const [next, ...rest] = queue;
                    setQueue(rest);
                    setError("");
                    setView(
                      next ? { kind: "create", draft: next, seq: nextSeq() } : { kind: "list" },
                    );
                  }
                }}
                onSaved={async (id) => {
                  await changed(`已保存 ${id}`);
                  const [next, ...rest] = queue;
                  setQueue(rest);
                  setError("");
                  setView(
                    next ? { kind: "create", draft: next, seq: nextSeq() } : { kind: "detail", id },
                  );
                }}
                onSaveFailed={() => void refresh()}
              />
            </>
          ) : view.kind === "detail" && current && detailStatus ? (
            <>
              <PageHeader
                title={<span className="mcp-head-mono">{current.id}</span>}
                crumb={{ parent: "MCP", onBack: backToList }}
                extra={
                  !current.editable && (
                    <Badge title={`来自 ${current.path}，请修改该文件`}>只读</Badge>
                  )
                }
                actions={
                  <>
                    <Switch
                      aria-label="启用"
                      checked={current.enabled}
                      disabled={!current.editable || busy}
                      title={!current.editable ? `来自 ${current.path}，请修改该文件` : undefined}
                      onChange={(next) => {
                        toggleEnabled(current, next);
                      }}
                    />
                    <Button
                      disabled={busy || !current.trusted}
                      title={
                        !current.trusted ? "项目尚未信任，请先在「授权」页信任此工作区" : undefined
                      }
                      onClick={() => void probe(current)}
                    >
                      {busy ? "测试中…" : "测试连接"}
                    </Button>
                    {current.editable && (
                      <>
                        <IconButton
                          ref={moreRef}
                          aria-label="更多"
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
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
                                  kind: "edit",
                                  id: current.id,
                                  draft: draftOf(current),
                                });
                              }}
                            />
                            <MenuSeparator />
                            <MenuItem
                              label="删除"
                              danger
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
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              <div className="sbody">
                <SettingsGroup title="状态">
                  <SettingsRow
                    className="mcp-status-row"
                    label={
                      <span className="mcp-status">
                        <span
                          className={detailStatus.dot === "" ? "dot" : `dot ${detailStatus.dot}`}
                          aria-hidden="true"
                        />
                        {detailStatus.label}
                      </span>
                    }
                  >
                    {detailStatus.error !== undefined && (
                      <span className="val bad mcp-ellip" title={detailStatus.error}>
                        {detailStatus.error}
                      </span>
                    )}
                  </SettingsRow>
                  <SettingsRow label="服务器">
                    {r?.serverInfo ? (
                      `${r.serverInfo.name} ${r.serverInfo.version}`
                    ) : (
                      <span className="val dim">—</span>
                    )}
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="连接">
                  <SettingsRow label="传输">{transportLabel(current.transport)}</SettingsRow>
                  <SettingsRow label={current.transport === "http" ? "地址" : "命令"}>
                    <span className="val mono" title={serverAddress(current)}>
                      {serverAddress(current)}
                    </span>
                  </SettingsRow>
                  {current.transport === "stdio" && (
                    <SettingsRow label="工作目录">
                      <span className={current.cwd ? "val mono" : "val"}>
                        {current.cwd ?? "会话工作区（默认）"}
                      </span>
                    </SettingsRow>
                  )}
                </SettingsGroup>
                <SettingsGroup
                  title={current.transport === "http" ? "请求头" : "环境变量"}
                  count={detailValues.length > 0 ? detailValues.length : undefined}
                >
                  {detailValues.length === 0 ? (
                    <SettingsRow label={<span className="val dim">—</span>} />
                  ) : (
                    detailValues.map((row) => (
                      <SettingsRow key={row.name} label={<code>{row.name}</code>}>
                        <span className="val">{valueKindLabel(row.kind)}</span>
                      </SettingsRow>
                    ))
                  )}
                </SettingsGroup>
                <SettingsGroup title="超时">
                  <SettingsRow label="启动">
                    <span className="val mono">{current.startupTimeoutMs / 1000} 秒</span>
                  </SettingsRow>
                  <SettingsRow label="调用">
                    <span className="val mono">{current.callTimeoutMs / 1000} 秒</span>
                  </SettingsRow>
                </SettingsGroup>
              </div>
            </>
          ) : (
            <>
              <PageHeader
                title="MCP"
                actions={
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setImporting(true);
                      }}
                    >
                      从 JSON 导入
                    </Button>
                    <Button variant="primary" size="sm" onClick={add} disabled={!client}>
                      <Icon name="add" size={ICON_SM} />
                      添加服务器
                    </Button>
                  </>
                }
              />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              {servers.length === 0 ? (
                <EmptyState
                  action={
                    <>
                      <Button variant="primary" onClick={add} disabled={!client}>
                        <Icon name="add" size={ICON_SM} />
                        添加服务器
                      </Button>
                      <Button
                        onClick={() => {
                          setImporting(true);
                        }}
                      >
                        从 JSON 导入
                      </Button>
                    </>
                  }
                >
                  给 Nocturne 接上外部工具
                </EmptyState>
              ) : (
                <div className="sbody">
                  {(["app", "readonly"] as const).map((group) => {
                    const items = servers.filter((s) => (s.origin === "app") === (group === "app"));
                    if (items.length === 0) return null;
                    return (
                      <SettingsGroup
                        key={group}
                        plain
                        title={group === "app" ? undefined : "只读"}
                        count={group === "app" ? undefined : items.length}
                      >
                        {items.map((s) => {
                          const dot = dotOf(s);
                          const probed = results[s.id];
                          return (
                            <SettingsListRow
                              key={s.id}
                              name={s.id}
                              mono
                              title={s.id}
                              disabled={!s.enabled}
                              description={
                                <>
                                  {transportLabel(s.transport)} ·{" "}
                                  <span className="mono">{serverAddress(s)}</span>
                                </>
                              }
                              status={
                                s.enabled ? (
                                  <span className="mcp-status">
                                    <span
                                      className={dot === "" ? "dot" : `dot ${dot}`}
                                      aria-hidden="true"
                                    />
                                    {probed ? resultText(probed) : liveText(liveOf(s))}
                                  </span>
                                ) : undefined
                              }
                              toggle={
                                <Switch
                                  aria-label="启用"
                                  checked={s.enabled}
                                  disabled={!s.editable || busy}
                                  title={!s.editable ? `来自 ${s.path}，请修改该文件` : undefined}
                                  onChange={(next) => {
                                    toggleEnabled(s, next);
                                  }}
                                />
                              }
                              onOpen={() => {
                                openDetail(s.id);
                              }}
                            />
                          );
                        })}
                      </SettingsGroup>
                    );
                  })}
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
      {importing && (
        <McpImport
          existing={servers.map((s) => s.id)}
          onClose={() => {
            setImporting(false);
          }}
          onConfirm={(drafts) => {
            const [first, ...rest] = drafts;
            setQueue(rest);
            setImporting(false);
            if (first) {
              setError("");
              setView({ kind: "create", draft: first, seq: nextSeq() });
            }
          }}
        />
      )}
      {deleting && current && (
        <Scrim
          onClose={() => {
            setDeleting(false);
          }}
        >
          <div className="dlg narrow" role="dialog" aria-label="删除 MCP 服务器">
            <div className="dh3">
              <b>删除 {current.id}？</b>
            </div>
            <div className="db">
              <Checkbox checked disabled onChange={() => undefined}>
                同时删除保存的凭据
              </Checkbox>
            </div>
            <div className="df">
              <span className="sp" />
              <Button
                onClick={() => {
                  setDeleting(false);
                }}
              >
                取消
              </Button>
              <Button
                variant="danger-solid"
                disabled={busy}
                onClick={() => {
                  if (!client) return;
                  setBusy(true);
                  void client.runtime
                    .deleteMcpServer({ id: current.id })
                    .then(() => {
                      setDeleting(false);
                      setView({ kind: "list" });
                      return changed(`已删除 ${current.id}`);
                    })
                    .catch((e: unknown) => {
                      setDeleting(false);
                      setError(message(e));
                      // 失败时磁盘上的配置可能已改，列表重新拉取
                      void refresh();
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                删除
              </Button>
            </div>
          </div>
        </Scrim>
      )}
    </div>
  );
}

function ProbeResult({ result }: { result: McpProbeResult }) {
  return (
    <div className={result.ok ? "fetch" : "pbanner"} role="status">
      <b>{resultText(result)}</b>
      <span>
        {(result.durationMs / 1000).toFixed(1)} 秒
        {result.httpStatus ? `（HTTP ${result.httpStatus}）` : ""}
      </span>
      {result.stderrTail?.length ? (
        <details>
          <summary>
            <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
            诊断信息
          </summary>
          <pre>{result.stderrTail.join("\n")}</pre>
        </details>
      ) : null}
      {result.ok && (
        <div className="ms">
          {result.tools.map((tool) => (
            <span key={tool.name} title={tool.description}>
              {tool.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface ValueRow {
  name: string;
  kind: McpValueOverview["kind"];
  value: string;
  saved: boolean;
  clear?: boolean;
}
function McpForm({
  client,
  draft,
  replace,
  backend,
  workspaceRoot,
  onCancel,
  onSaved,
  onSaveFailed,
}: {
  client: RpcClient;
  draft: McpDraft;
  replace: boolean;
  backend: boolean;
  workspaceRoot: string | undefined;
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
  /** 保存失败：磁盘上的配置可能已改，由父级重新拉取列表 */
  onSaveFailed: () => void;
}) {
  const fid = useId();
  const [id, setId] = useState(draft.id);
  const [type, setType] = useState(draft.config.type ?? "stdio");
  const [command, setCommand] = useState(draft.config.command ?? "");
  const [args, setArgs] = useState((draft.config.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(draft.config.cwd ?? "");
  const [url, setUrl] = useState(draft.config.url ?? "");
  const [startup, setStartup] = useState(String((draft.config.startupTimeoutMs ?? 15000) / 1000));
  const [call, setCall] = useState(String((draft.config.callTimeoutMs ?? 60000) / 1000));
  const [rows, setRows] = useState<ValueRow[]>(
    Object.entries(draft.config.headers ?? draft.config.env ?? {}).map(([name, val]) => ({
      name,
      kind: typeof val !== "string" ? "stored" : val.startsWith("${") ? "env" : "literal",
      value: draft.secrets[name] ?? (typeof val === "string" ? val.replace(/^\$\{|\}$/g, "") : ""),
      saved: typeof val !== "string" && draft.secrets[name] === undefined,
    })),
  );
  const [result, setResult] = useState<McpProbeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string | undefined; message: string }>();
  const update = (index: number, patch: Partial<ValueRow>) => {
    setRows((old) => old.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const config = () => {
    const values = Object.fromEntries(
      rows
        .filter((row) => row.name && !row.clear)
        .map((row) => [
          row.name,
          row.kind === "stored"
            ? { stored: true as const }
            : row.kind === "env"
              ? `\${${row.value}}`
              : row.value,
        ]),
    );
    const secrets = Object.fromEntries(
      rows
        .filter((row) => row.name && row.kind === "stored" && (!row.saved || row.clear))
        .map((row) => [row.name, row.clear ? null : row.value]),
    );
    return {
      config: {
        type,
        enabled: draft.config.enabled ?? true,
        startupTimeoutMs: Number(startup) * 1000,
        callTimeoutMs: Number(call) * 1000,
        ...(type === "http"
          ? { url, headers: values }
          : {
              command,
              args: args ? args.split(/\r?\n/) : [],
              env: values,
              ...(cwd ? { cwd } : {}),
            }),
      },
      secrets,
    };
  };
  const run = async (save: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const data = config();
      if (save) {
        await client.runtime.saveMcpServer({
          mode: replace ? "replace" : "create",
          id,
          ...data,
          workspaceRoot,
        });
        await onSaved(id);
      } else
        setResult(
          await client.runtime.probeMcpServer({
            ...data,
            workspaceRoot,
            ...(replace ? { credentialServerId: draft.id } : {}),
          }),
        );
    } catch (e) {
      setError({ field: e instanceof RpcError ? e.field : undefined, message: message(e) });
      if (save) onSaveFailed();
    } finally {
      setBusy(false);
    }
  };
  const err = (field: string) => (error?.field === field ? error.message : undefined);
  return (
    <Form
      className="settings-subpage-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(true);
      }}
    >
      <SettingsGroup>
        <Field label="类型">
          <SegmentedControl
            className="mcp-type"
            aria-label="传输类型"
            value={type}
            options={[
              { value: "stdio", label: "本地命令" },
              { value: "http", label: "远程地址（HTTP）" },
            ]}
            onChange={(t) => {
              if (type !== t) {
                setType(t);
                setRows([]);
                setResult(undefined);
              }
            }}
          />
        </Field>
        <Field label="名称" htmlFor={`${fid}-name`} error={err("id")}>
          <input
            id={`${fid}-name`}
            className={replace ? "input lg mono mcp-name-locked" : "input lg mono"}
            aria-label="名称"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
            }}
            disabled={replace || busy}
            autoFocus
          />
        </Field>
        {type === "http" ? (
          <Field label="地址" htmlFor={`${fid}-url`} error={err("url")}>
            <input
              id={`${fid}-url`}
              className="input lg mono"
              aria-label="地址"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
          </Field>
        ) : (
          <>
            <Field label="命令" htmlFor={`${fid}-cmd`} error={err("command")}>
              <input
                id={`${fid}-cmd`}
                className="input lg mono"
                aria-label="命令"
                value={command}
                onChange={(e) => {
                  setCommand(e.target.value);
                }}
              />
            </Field>
            <Field label="参数" htmlFor={`${fid}-args`}>
              <textarea
                id={`${fid}-args`}
                className="textarea mono"
                aria-label="参数"
                value={args}
                onChange={(e) => {
                  setArgs(e.target.value);
                }}
                rows={3}
              />
            </Field>
          </>
        )}
        <Field
          label={type === "http" ? "请求头" : "环境变量"}
          error={err(type === "http" ? "headers" : "env")}
        >
          <div className="mcp-kv-list settings-form-wide">
            {rows.map((row, index) => (
              <div className="mcp-value-editor" key={index}>
                <input
                  className="input lg mono"
                  aria-label={`${type === "http" ? "请求头" : "变量"}名 ${index + 1}`}
                  value={row.name}
                  onChange={(e) => {
                    update(index, {
                      name: e.target.value,
                      ...(row.name === "" || row.kind === "literal"
                        ? { kind: secretName(e.target.value) ? "stored" : "literal" }
                        : {}),
                    });
                  }}
                />
                <Dropdown
                  appearance="lg"
                  label={`值类型 ${index + 1}`}
                  value={row.kind}
                  options={[
                    {
                      value: "literal",
                      label: "明文",
                    },
                    {
                      value: "env",
                      label: "引用环境变量",
                    },
                    {
                      value: "stored",
                      label: "保存到凭据库",
                      ...(backend
                        ? {}
                        : {
                            description: "系统凭据后端不可用，请引用环境变量",
                            disabled: "系统凭据后端不可用，请引用环境变量",
                          }),
                    },
                  ]}
                  onChange={(kind) => {
                    update(index, { kind: kind as ValueRow["kind"], value: "", saved: false });
                  }}
                />
                {row.saved && !row.clear ? (
                  <span className="mcp-saved-value">
                    ● 已保存{" "}
                    <Button
                      size="sm"
                      onClick={() => {
                        update(index, { saved: false });
                      }}
                    >
                      替换
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        update(index, { clear: true });
                      }}
                    >
                      清除
                    </Button>
                  </span>
                ) : (
                  <input
                    className="input lg mono"
                    aria-label={`值 ${index + 1}`}
                    type={row.kind === "stored" ? "password" : "text"}
                    disabled={row.clear}
                    value={row.value}
                    onChange={(e) => {
                      update(index, { value: e.target.value });
                    }}
                  />
                )}
                <Button
                  variant="ghost"
                  aria-label={`删除变量 ${index + 1}`}
                  onClick={() => {
                    setRows((old) => old.filter((_, i) => i !== index));
                  }}
                >
                  <Icon name="close" size={ICON_SM} />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              className="mcp-kv-add"
              onClick={() => {
                setRows((old) => [...old, { name: "", kind: "literal", value: "", saved: false }]);
              }}
            >
              <Icon name="add" size={ICON_SM} />
              添加{type === "http" ? "请求头" : "变量"}
            </Button>
          </div>
        </Field>
        {type === "stdio" && (
          <Field label="工作目录" htmlFor={`${fid}-cwd`} error={err("cwd")}>
            <input
              id={`${fid}-cwd`}
              className="input lg mono"
              aria-label="工作目录"
              value={cwd}
              onChange={(e) => {
                setCwd(e.target.value);
              }}
            />
          </Field>
        )}
      </SettingsGroup>
      <SettingsGroup title="超时">
        <Field label="启动" htmlFor={`${fid}-startup`} error={err("startupTimeoutMs")}>
          <span className="mcp-unit">
            <input
              id={`${fid}-startup`}
              className="input lg mono sm-w mcp-unit-input"
              aria-label="启动"
              type="number"
              min="0.001"
              step="0.001"
              value={startup}
              onChange={(e) => {
                setStartup(e.target.value);
              }}
            />
            <span className="mcp-unit-label">秒</span>
          </span>
        </Field>
        <Field label="调用" htmlFor={`${fid}-call`} error={err("callTimeoutMs")}>
          <span className="mcp-unit">
            <input
              id={`${fid}-call`}
              className="input lg mono sm-w mcp-unit-input"
              aria-label="调用"
              type="number"
              min="0.001"
              step="0.001"
              value={call}
              onChange={(e) => {
                setCall(e.target.value);
              }}
            />
            <span className="mcp-unit-label">秒</span>
          </span>
        </Field>
      </SettingsGroup>
      {result && <ProbeResult result={result} />}
      {error &&
        ![
          "id",
          "url",
          "command",
          "cwd",
          "env",
          "headers",
          "startupTimeoutMs",
          "callTimeoutMs",
        ].includes(error.field ?? "") && (
          <div className="errt" role="alert">
            {error.message}
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
    </Form>
  );
}

function McpImport({
  existing,
  onClose,
  onConfirm,
}: {
  existing: string[];
  onClose: () => void;
  onConfirm: (drafts: McpDraft[]) => void;
}) {
  const [text, setText] = useState("");
  let rows: McpImportRow[] = [];
  let error = "";
  try {
    if (text.trim()) rows = parseMcpImport(text, existing);
  } catch (e) {
    error = message(e);
  }
  const drafts = rows.flatMap((row) => (row.draft ? [row.draft] : []));
  return (
    <Scrim onClose={onClose}>
      <div className="dlg mcp-import" role="dialog" aria-label="从 JSON 导入">
        <div className="dh3">
          <b>从 JSON 导入</b>
        </div>
        <div className="db">
          <textarea
            className="input lg mono"
            aria-label="JSON 配置"
            rows={12}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            autoFocus
          />
          {error && (
            <div className="errt" role="alert">
              {error}
            </div>
          )}
          {rows.map((row, i) => (
            <p key={i}>
              <b>{row.id || "未命名"}</b>：{row.notice}
            </p>
          ))}
        </div>
        <div className="df">
          <span className="fine">
            识别到 {rows.length} 台，可导入 {drafts.length} 台
          </span>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!drafts.length}
            onClick={() => {
              onConfirm(drafts);
            }}
          >
            逐台确认（1 / {drafts.length}）
          </Button>
        </div>
      </div>
    </Scrim>
  );
}
