import { useCallback, useEffect, useState } from "react";
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
import "./pages.css";
import "./mcp.css";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const propagation = "空闲会话立即生效，正在回复的会话在本轮结束后切换";
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
const resultText = (r: McpProbeResult | undefined): string =>
  !r
    ? "未测试"
    : r.ok
      ? `已连接 · ${r.tools.length} 个工具`
      : r.error
        ? probeErrors[r.error.code]
        : "测试失败";
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
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
  onChanged: () => void;
}) {
  const [servers, setServers] = useState<McpServerOverview[]>([]);
  const [selected, setSelected] = useState<string>();
  const [form, setForm] = useState<{ draft: McpDraft; replace: boolean }>();
  const [results, setResults] = useState<Record<string, McpProbeResult>>({});
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
  const changed = async (text: string) => {
    onChanged();
    setToast(`${text} · ${propagation}`);
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
    <div className="page3 mcp-page">
      <header className="ph3">
        <div className="grow">
          <h3>MCP</h3>
          <span className="sub">
            {servers.length} 台服务器 ·
            改动对新会话和已打开的会话都生效，正在回复的会话在本轮结束后切换
          </span>
        </div>
      </header>
      {error && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      <div className={`cols3 ${servers.length === 0 && !form ? "mcp-no-servers" : ""}`}>
        <nav className="plist" aria-label="MCP 服务器列表">
          <div className="mcp-list-actions">
            <button className="btn primary" onClick={add} disabled={!client}>
              ＋ 添加服务器
            </button>
            <button
              className="btn"
              onClick={() => {
                setImporting(true);
              }}
            >
              从 JSON 导入
            </button>
          </div>
          {(["app", "readonly"] as const).map((group) => (
            <div key={group}>
              <h5>{group === "app" ? "程序管理" : "config.json · 只读"}</h5>
              {servers
                .filter((s) => (s.origin === "app") === (group === "app"))
                .map((s) => (
                  <button
                    className={`mcp-server-row ${selected === s.id && !form ? "on" : ""}`}
                    key={s.id}
                    onClick={() => {
                      setSelected(s.id);
                      setForm(undefined);
                      setQueue([]);
                    }}
                  >
                    <span
                      className={`dot ${results[s.id]?.ok ? "ok" : results[s.id] ? "warn" : "off"}`}
                    />
                    <span className="nm">{s.id}</span>
                    {s.transport === "http" && <span className="tagc">HTTP</span>}
                    <small>
                      {!s.enabled
                        ? "已停用"
                        : results[s.id]?.ok === false
                          ? "测试失败"
                          : resultText(results[s.id])}
                    </small>
                  </button>
                ))}
            </div>
          ))}
          <span className="fine pad">项目级配置不在全局页列出，随工作区查看。</span>
        </nav>
        <div className="pane">
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
            />
          ) : current ? (
            <>
              <div className="t1">
                <h3>{current.id}</h3>
                <span className="tagc">{current.editable ? "程序管理" : "只读"}</span>
                <span className="acts">
                  <button
                    role="switch"
                    aria-checked={current.enabled}
                    className={`mcp-switch ${current.enabled ? "on" : ""}`}
                    disabled={!current.editable || busy}
                    onClick={() => {
                      if (!client) return;
                      setBusy(true);
                      void client.runtime
                        .setMcpServerEnabled({ id: current.id, enabled: !current.enabled })
                        .then(() => changed(current.enabled ? "已停用" : "已启用"))
                        .catch((e: unknown) => {
                          setError(message(e));
                        })
                        .finally(() => {
                          setBusy(false);
                        });
                    }}
                  >
                    启用
                  </button>
                  <span className="mcp-action-divider" aria-hidden="true" />
                  <button
                    className="btn"
                    disabled={busy || !current.trusted}
                    onClick={() => void probe()}
                  >
                    {busy ? "测试中…" : "测试连接"}
                  </button>
                  {current.editable && (
                    <>
                      <button
                        className="btn"
                        onClick={() => {
                          setForm({ draft: draftOf(current), replace: true });
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className="btn danger"
                        onClick={() => {
                          setDeleting(true);
                        }}
                      >
                        删除
                      </button>
                    </>
                  )}
                </span>
              </div>
              {!current.editable && (
                <div className="hint">只读：在 {current.path} 中定义，请修改对应配置文件。</div>
              )}
              <dl className="kv">
                <div className="full">
                  <dt>{current.transport === "http" ? "地址" : "命令"}</dt>
                  <dd className="mono">
                    {current.url ?? [current.command, ...(current.args ?? [])].join(" ")}
                  </dd>
                </div>
                <div>
                  <dt>最近测试</dt>
                  <dd>{resultText(r)}</dd>
                </div>
                <div>
                  <dt>服务器</dt>
                  <dd>{r?.serverInfo ? `${r.serverInfo.name} ${r.serverInfo.version}` : "—"}</dd>
                </div>
                <div>
                  <dt>{current.transport === "http" ? "传输" : "工作目录"}</dt>
                  <dd>
                    {current.transport === "http"
                      ? "流式 HTTP"
                      : (current.cwd ?? "会话工作区（默认）")}
                  </dd>
                </div>
                <div>
                  <dt>超时（启动 / 调用）</dt>
                  <dd>
                    {current.startupTimeoutMs / 1000} 秒 / {current.callTimeoutMs / 1000} 秒
                  </dd>
                </div>
              </dl>
              {r && <ProbeResult result={r} />}
              <div className="sh">
                <h4>{current.transport === "http" ? "请求头" : "环境变量"}</h4>
              </div>
              <div className="mcp-values">
                {(current.headers ?? current.env ?? []).map((row) => (
                  <div key={row.name}>
                    <code>{row.name}</code>
                    <span>
                      {row.kind === "stored" ? "凭据库" : row.kind === "env" ? "环境变量" : "明文"}
                    </span>
                    <span>
                      {row.kind === "stored"
                        ? row.stored === "set"
                          ? "● 已保存"
                          : "缺少凭据"
                        : row.value}
                    </span>
                  </div>
                ))}
              </div>
              <div className="fine">
                模型调用这些工具时显示为 mcp {current.id}
                /&lt;工具名&gt;，是否需要确认由权限设置决定。
              </div>
            </>
          ) : (
            <div className="mcp-empty">
              <h3>给 Nocturne 接上外部工具</h3>
              <p>MCP 服务器可以提供代码搜索、浏览器、数据库等工具。</p>
              <button className="btn primary" onClick={add}>
                ＋ 添加服务器
              </button>
              <button
                className="btn"
                onClick={() => {
                  setImporting(true);
                }}
              >
                从 JSON 导入
              </button>
            </div>
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
              <button
                className="btn"
                onClick={() => {
                  setDeleting(false);
                }}
              >
                取消
              </button>
              <button
                className="btn danger"
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
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                删除
              </button>
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
        {result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""}
      </span>
      {result.stderrTail?.length ? (
        <details>
          <summary>诊断信息</summary>
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
}: {
  client: RpcClient;
  draft: McpDraft;
  replace: boolean;
  backend: boolean;
  workspaceRoot: string | undefined;
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
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
      <div className="t1">
        <h3>{replace ? `编辑 ${id}` : "添加 MCP 服务器"}</h3>
      </div>
      <form
        className="form wide"
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
        <label className="field">
          类型
          <div className="mcp-type" role="group" aria-label="传输类型">
            {(["stdio", "http"] as const).map((t) => (
              <button
                type="button"
                key={t}
                className={`btn ${type === t ? "primary" : ""}`}
                aria-pressed={type === t}
                onClick={() => {
                  if (type !== t) {
                    setType(t);
                    setRows([]);
                    setResult(undefined);
                  }
                }}
              >
                {t === "stdio" ? "STDIO · 本地命令" : "流式 HTTP · 远程地址"}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          名称
          <input
            className={replace ? "mcp-name-locked" : undefined}
            value={id}
            onChange={(e) => {
              setId(e.target.value);
            }}
            disabled={replace || busy}
            autoFocus
          />
          {err("id")}
          <small>模型看到的工具前缀，创建后不能改</small>
        </label>
        {type === "http" ? (
          <label className="field">
            地址
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
              placeholder="https://example.com/mcp"
            />
            {err("url")}
            <small>支持流式 HTTP；如需 OAuth 登录，本版本暂不支持</small>
          </label>
        ) : (
          <>
            <label className="field">
              命令
              <input
                value={command}
                onChange={(e) => {
                  setCommand(e.target.value);
                }}
              />
              {err("command")}
            </label>
            <label className="field">
              参数 · 一行一个
              <textarea
                value={args}
                onChange={(e) => {
                  setArgs(e.target.value);
                }}
                rows={3}
              />
            </label>
          </>
        )}
        <div className="field">
          <label>{type === "http" ? "请求头" : "环境变量"}</label>
          {err(type === "http" ? "headers" : "env")}
          {rows.map((row, index) => (
            <div className="mcp-value-editor" key={index}>
              <input
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
                label={`值类型 ${index + 1}`}
                value={row.kind}
                options={[
                  {
                    value: "literal",
                    label: "明文",
                    description: "值原样写进 mcp.json，适合地址、开关这类非敏感内容",
                  },
                  {
                    value: "env",
                    label: "引用环境变量",
                    description: "启动时从 Nocturne 的进程环境读取同名或指定变量",
                  },
                  {
                    value: "stored",
                    label: "保存到凭据库",
                    description: backend
                      ? "值存进系统凭据库，mcp.json 只记引用，界面不再显示"
                      : "系统凭据后端不可用，请引用环境变量",
                    ...(!backend ? { disabled: "系统凭据后端不可用，请引用环境变量" } : {}),
                  },
                ]}
                onChange={(kind) => {
                  update(index, { kind: kind as ValueRow["kind"], value: "", saved: false });
                }}
              />
              {row.saved && !row.clear ? (
                <span>
                  ● 已保存{" "}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      update(index, { saved: false });
                    }}
                  >
                    替换
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      update(index, { clear: true });
                    }}
                  >
                    清除
                  </button>
                </span>
              ) : (
                <input
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
              <button
                type="button"
                className="btn ghost"
                aria-label={`删除变量 ${index + 1}`}
                onClick={() => {
                  setRows((old) => old.filter((_, i) => i !== index));
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setRows((old) => [...old, { name: "", kind: "literal", value: "", saved: false }]);
            }}
          >
            ＋ 添加{type === "http" ? "请求头" : "变量"}
          </button>
          {!backend && <small>系统凭据后端不可用，保存到凭据库不可选；请引用环境变量。</small>}
        </div>
        <details>
          <summary>高级</summary>
          {type === "stdio" && (
            <label className="field">
              工作目录
              <input
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                }}
                placeholder="会话工作区（默认）"
              />
              {err("cwd")}
            </label>
          )}
          <label className="field">
            启动超时（秒）
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={startup}
              onChange={(e) => {
                setStartup(e.target.value);
              }}
            />
            {err("startupTimeoutMs")}
          </label>
          <label className="field">
            调用超时（秒）
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={call}
              onChange={(e) => {
                setCall(e.target.value);
              }}
            />
            {err("callTimeoutMs")}
          </label>
        </details>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(false)}>
          {busy ? "处理中…" : "测试连接"}
        </button>
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
        <div className="formacts">
          <button className="btn primary" type="submit" disabled={busy}>
            保存
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <span className="fine">测试失败也可以保存</span>
        </div>
      </form>
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
          <span>粘贴服务器 README 里给的配置片段</span>
        </div>
        <div className="db">
          <textarea
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
              <b>{row.id || "未命名"}</b> · {row.notice}
            </p>
          ))}
        </div>
        <div className="df">
          <span className="fine">
            识别到 {rows.length} 台 · 可导入 {drafts.length} 台
          </span>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!drafts.length}
            onClick={() => {
              onConfirm(drafts);
            }}
          >
            逐台确认（1 / {drafts.length}）
          </button>
        </div>
      </div>
    </Scrim>
  );
}
