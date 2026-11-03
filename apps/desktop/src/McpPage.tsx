import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RpcError, type RpcClient } from "@nocturne/rpc/client";
import type { McpProbeResult, McpServerOverview, McpValueOverview } from "@nocturne/core/protocol";
import { Dropdown } from "./Dropdown";
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
  DetailHeader,
  EmptyState,
  Field,
  Form,
  FormFooter,
  ICON_SM,
  Icon,
  ListGroup,
  ListItem,
  MasterDetail,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
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
  const [selected, setSelected] = useState<string>();
  const [form, setForm] = useState<{ draft: McpDraft; replace: boolean }>();
  const [results, setResults] = useState<Record<string, McpProbeResult>>({});
  const [live, setLive] = useState<readonly McpLiveStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [backend, setBackend] = useState(false);
  const [importing, setImporting] = useState(false);
  const [queue, setQueue] = useState<McpDraft[]>([]);
  const [deleting, setDeleting] = useState(false);
  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const data = await client.runtime.describeMcpServers({});
      setServers(data.servers);
      setSelected((current) =>
        current && data.servers.some((s) => s.id === current) ? current : data.servers[0]?.id,
      );
      const setup = await client.provider.describeProviderSetup("custom-openai");
      setBackend(setup.credential.backend.available);
    } catch (e) {
      setError(message(e));
    }
  }, [client]);
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
  const current = servers.find((s) => s.id === selected);
  const probe = async () => {
    if (!client || !current) return;
    setBusy(true);
    setError("");
    try {
      const r = await client.runtime.probeMcpServer({ id: current.id, workspaceRoot });
      setResults((old) => ({ ...old, [current.id]: r }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    setQueue([]);
    setForm({
      draft: {
        id: "",
        config: { type: "stdio", command: "", args: [], enabled: true },
        secrets: {},
      },
      replace: false,
    });
  };
  const finish = () => {
    const [next, ...rest] = queue;
    setQueue(rest);
    setForm(next ? { draft: next, replace: false } : undefined);
  };
  const r = current ? results[current.id] : undefined;
  return (
    <div className="page3 mcp-page spage flush">
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
              ＋ 添加服务器
            </Button>
          </>
        }
      />
      {error && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      <MasterDetail
        listLabel="MCP 服务器列表"
        list={(["app", "readonly"] as const).map((group) => {
          const count = servers.filter((s) => (s.origin === "app") === (group === "app")).length;
          return (
            count > 0 && (
              <ListGroup key={group} title={group === "app" ? undefined : "只读"} count={count}>
                {servers
                  .filter((s) => (s.origin === "app") === (group === "app"))
                  .map((s) => (
                    <ListItem
                      key={s.id}
                      label={s.id}
                      mono
                      selected={selected === s.id && !form}
                      dot={dotOf(s)}
                      onClick={() => {
                        setSelected(s.id);
                        setForm(undefined);
                        setQueue([]);
                      }}
                    />
                  ))}
              </ListGroup>
            )
          );
        })}
      >
        {form && client ? (
          <McpForm
            key={`${form.replace}-${form.draft.id}`}
            client={client}
            draft={form.draft}
            replace={form.replace}
            backend={backend}
            workspaceRoot={workspaceRoot}
            onCancel={finish}
            onSaved={async (id) => {
              await changed(`已保存 ${id}`);
              setSelected(id);
              finish();
            }}
            onSaveFailed={() => void refresh()}
          />
        ) : current ? (
          <>
            <DetailHeader
              title={current.id}
              mono
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
                      if (!client) return;
                      setBusy(true);
                      void client.runtime
                        .setMcpServerEnabled({ id: current.id, enabled: next })
                        .then(() => changed(current.enabled ? "已停用" : "已启用"))
                        .catch((e: unknown) => {
                          setError(message(e));
                          // 失败时磁盘上的配置可能已改，列表重新拉取
                          void refresh();
                        })
                        .finally(() => {
                          setBusy(false);
                        });
                    }}
                  />
                  <Button
                    disabled={busy || !current.trusted}
                    title={
                      !current.trusted ? "项目尚未信任，请先在「授权」页信任此工作区" : undefined
                    }
                    onClick={() => void probe()}
                  >
                    {busy ? "测试中…" : "测试连接"}
                  </Button>
                  {current.editable && (
                    <>
                      <Button
                        onClick={() => {
                          setForm({ draft: draftOf(current), replace: true });
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          setDeleting(true);
                        }}
                      >
                        删除
                      </Button>
                    </>
                  )}
                </>
              }
            />
            <SettingsGroup title="连接">
              <SettingsRow label={current.transport === "http" ? "地址" : "命令"}>
                <span className="mono">
                  {current.url ?? [current.command, ...(current.args ?? [])].join(" ")}
                </span>
              </SettingsRow>
              <SettingsRow label="状态">
                {r ? resultText(r) : liveText(liveOf(current))}
              </SettingsRow>
              <SettingsRow label="服务器">
                {r?.serverInfo ? `${r.serverInfo.name} ${r.serverInfo.version}` : "—"}
              </SettingsRow>
              <SettingsRow label={current.transport === "http" ? "传输" : "工作目录"}>
                {current.transport === "http" ? "流式 HTTP" : (current.cwd ?? "会话工作区（默认）")}
              </SettingsRow>
              <SettingsRow label="超时（启动 / 调用）">
                {current.startupTimeoutMs / 1000} 秒 / {current.callTimeoutMs / 1000} 秒
              </SettingsRow>
            </SettingsGroup>
            {r && <ProbeResult result={r} />}
            {(current.headers ?? current.env ?? []).length > 0 && (
              <SettingsGroup title={current.transport === "http" ? "请求头" : "环境变量"}>
                {(current.headers ?? current.env ?? []).map((row) => (
                  <SettingsRow key={row.name} label={<code>{row.name}</code>}>
                    <Badge>
                      {row.kind === "stored" ? "凭据库" : row.kind === "env" ? "环境变量" : "明文"}
                    </Badge>
                    <span>
                      {row.kind === "stored"
                        ? row.stored === "set"
                          ? "● 已保存"
                          : "缺少凭据"
                        : row.value}
                    </span>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
          </>
        ) : (
          <EmptyState
            action={
              <>
                <Button variant="primary" onClick={add}>
                  ＋ 添加服务器
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
        )}
      </MasterDetail>
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
            if (first) setForm({ draft: first, replace: false });
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
              <span>同时删除这台服务器保存的凭据。</span>
            </div>
            <div className="df">
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
                      return changed(`已删除 ${current.id}`);
                    })
                    .catch((e: unknown) => {
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
  const err = (field: string) =>
    error?.field === field ? (
      <span className="errt" role="alert">
        {error.message}
      </span>
    ) : null;
  return (
    <div>
      <DetailHeader title={replace ? `编辑 ${id}` : "添加 MCP 服务器"} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
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
        <Field label="名称">
          <input
            className={replace ? "input lg mono mcp-name-locked" : "input lg mono"}
            aria-label="名称"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
            }}
            disabled={replace || busy}
            autoFocus
          />
          {err("id")}
        </Field>
        {type === "http" ? (
          <Field label="地址">
            <input
              className="input lg mono"
              aria-label="地址"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
              placeholder="https://example.com/mcp"
            />
            {err("url")}
          </Field>
        ) : (
          <>
            <Field label="命令">
              <input
                className="input lg mono"
                aria-label="命令"
                value={command}
                onChange={(e) => {
                  setCommand(e.target.value);
                }}
              />
              {err("command")}
            </Field>
            <Field label="参数，一行一个">
              <textarea
                className="textarea mono"
                aria-label="参数，一行一个"
                value={args}
                onChange={(e) => {
                  setArgs(e.target.value);
                }}
                rows={3}
              />
            </Field>
          </>
        )}
        <Field label={type === "http" ? "请求头" : "环境变量"}>
          {err(type === "http" ? "headers" : "env")}
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
                <span>
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
                  placeholder={
                    row.clear ? "已清除，保存后删除" : row.kind === "env" ? "环境变量名" : ""
                  }
                />
              )}
              <Button
                variant="ghost"
                aria-label={`删除变量 ${index + 1}`}
                onClick={() => {
                  setRows((old) => old.filter((_, i) => i !== index));
                }}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            onClick={() => {
              setRows((old) => [...old, { name: "", kind: "literal", value: "", saved: false }]);
            }}
          >
            ＋ 添加{type === "http" ? "请求头" : "变量"}
          </Button>
          {!backend && <small>系统凭据后端不可用，保存到凭据库不可选；请引用环境变量。</small>}
        </Field>
        <details>
          <summary>
            <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
            高级
          </summary>
          {type === "stdio" && (
            <Field label="工作目录">
              <input
                className="input lg mono"
                aria-label="工作目录"
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                }}
                placeholder="会话工作区（默认）"
              />
              {err("cwd")}
            </Field>
          )}
          <Field label="启动超时（秒）">
            <input
              className="input lg"
              aria-label="启动超时（秒）"
              type="number"
              min="0.001"
              step="0.001"
              value={startup}
              onChange={(e) => {
                setStartup(e.target.value);
              }}
            />
            {err("startupTimeoutMs")}
          </Field>
          <Field label="调用超时（秒）">
            <input
              className="input lg"
              aria-label="调用超时（秒）"
              type="number"
              min="0.001"
              step="0.001"
              value={call}
              onChange={(e) => {
                setCall(e.target.value);
              }}
            />
            {err("callTimeoutMs")}
          </Field>
        </details>
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
    </div>
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
