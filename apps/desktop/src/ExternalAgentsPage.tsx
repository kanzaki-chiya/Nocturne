import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import { EXTERNAL_AGENT_PRESETS } from "@nocturne/core/protocol";
import type {
  ExternalAgentConfig,
  ExternalAgentOverview,
  ExternalAgentProbeResult,
  SkillOverview,
} from "@nocturne/core/protocol";
import { Dropdown } from "./Dropdown";
import { Scrim } from "./ProvidersPage";
import { externalAgentSlashConflict } from "./commands";
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
const resultText = (result: ExternalAgentProbeResult | undefined) =>
  !result
    ? "未测试"
    : result.ok
      ? `已连接${result.agentInfo ? ` · ${result.agentInfo.name} ${result.agentInfo.version}` : ""}`
      : (result.error?.message ?? "测试失败");
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
  const [skills, setSkills] = useState<SkillOverview[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [form, setForm] = useState<{ config: ExternalAgentConfig; replace: boolean }>();
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
  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const [data, skillData] = await Promise.all([
        client.runtime.describeExternalAgents({ workspaceRoot }),
        client.runtime.describeSkills({ workspaceRoot }),
      ]);
      setAgents(data.agents);
      setWarnings(data.warnings);
      setSkills(skillData.skills);
      setSelected((old) =>
        data.agents.some((agent) => agent.name === old) ? old : data.agents[0]?.name,
      );
    } catch (e) {
      setError(message(e));
    }
  }, [client, workspaceRoot]);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  const current = agents.find((agent) => agent.name === selected);
  const recent = current ? results[current.name] : undefined;
  const changed = async (text: string) => {
    // RPC 在响应之前发 providersChanged；单后台下 App 只刷新本会话的数据版本。
    setToast(`${text} · 空闲会话立即生效，正在回复的会话在本轮结束后切换`);
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
  const probe = async () => {
    if (!client || !current) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.runtime.probeExternalAgent({ name: current.name });
      setResults((old) => ({
        ...old,
        [current.name]: { result, at: new Date().toLocaleTimeString() },
      }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    setForm({ config: { name: "", command: "", args: [], enabled: false }, replace: false });
    setError("");
  };
  return (
    <div className="page3 mcp-page external-agents-page">
      <header className="ph3">
        <div className="grow">
          <h3>外部 agent</h3>
          <span className="sub">
            {agents.length} 个 agent · 费用与额度计在该 agent 自己的账号上
          </span>
        </div>
      </header>
      {error && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      {warnings.map((warning, i) => (
        <div className="errt" role="status" key={`${i}-${warning}`}>
          {warning}
        </div>
      ))}
      <div className="cols3">
        <nav className="plist" aria-label="外部 agent 列表">
          <div className="mcp-list-actions">
            <button className="btn primary" disabled={!client || busy} onClick={add}>
              添加 agent
            </button>
          </div>
          {(["app", "user"] as const).map((origin) => (
            <div key={origin}>
              <h5>{origin === "app" ? "程序管理" : "config.json · 只读"}</h5>
              {agents
                .filter((agent) => agent.origin === origin)
                .map((agent) => (
                  <button
                    key={agent.name}
                    className={`mcp-server-row ${selected === agent.name && !form ? "on" : ""}`}
                    onClick={() => {
                      setSelected(agent.name);
                      setForm(undefined);
                    }}
                  >
                    <span
                      className={`dot ${results[agent.name]?.result.ok ? "ok" : results[agent.name] ? "warn" : "off"}`}
                    />
                    <span className="nm">{agent.name}</span>
                    <small title={externalAgentSlashConflict(agent.name, skills)}>
                      {externalAgentSlashConflict(agent.name, skills)
                        ? "名称冲突"
                        : !agent.enabled
                          ? "已停用"
                          : resultText(results[agent.name]?.result)}
                    </small>
                  </button>
                ))}
            </div>
          ))}
          <span className="fine pad">只读取用户级配置，项目配置里的外部 agent 不生效。</span>
        </nav>
        <div className="pane">
          {form && client ? (
            <ExternalAgentForm
              key={`${form.replace}-${form.config.name}`}
              client={client}
              initial={form.config}
              replace={form.replace}
              recent={results[form.config.name]?.result}
              onProbed={(agentName, result) => {
                setResults((old) => ({
                  ...old,
                  [agentName]: { result, at: new Date().toLocaleTimeString() },
                }));
              }}
              onCancel={() => {
                setForm(undefined);
              }}
              onSaved={async (name, tested) => {
                await changed(`已保存 ${name}`);
                setSelected(name);
                setForm(undefined);
                // 保存的正是刚测试过的草稿时保留结果；配置有改动则旧结果作废
                setResults((old) => {
                  const { [name]: _removed, ...rest } = old;
                  return tested
                    ? { ...rest, [name]: { result: tested, at: new Date().toLocaleTimeString() } }
                    : rest;
                });
              }}
            />
          ) : current ? (
            <>
              <div className="t1">
                <h3>{current.name}</h3>
                <span className="tagc">{current.editable ? "程序管理" : "只读"}</span>
                <span className="acts">
                  <button
                    role="switch"
                    aria-label="启用 agent"
                    aria-checked={current.enabled}
                    className={`mcp-switch ${current.enabled ? "on" : ""}`}
                    disabled={!client || !current.editable || busy}
                    onClick={() => {
                      if (client)
                        void mutate(
                          () =>
                            client.runtime.setExternalAgentEnabled({
                              name: current.name,
                              enabled: !current.enabled,
                            }),
                          current.enabled ? "已停用" : "已启用",
                        );
                    }}
                  >
                    启用
                  </button>
                  <span className="mcp-action-divider" aria-hidden="true" />
                  <button className="btn" disabled={!client || busy} onClick={() => void probe()}>
                    {busy ? "处理中…" : "测试连接"}
                  </button>
                  <button
                    className="btn"
                    disabled={!current.editable || busy}
                    onClick={() => {
                      setError("");
                      setForm({ config: configOf(current), replace: true });
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="btn"
                    disabled={!current.editable || busy}
                    onClick={() => {
                      setDeleting(true);
                    }}
                  >
                    删除
                  </button>
                </span>
              </div>
              {externalAgentSlashConflict(current.name, skills) && (
                <p className="errt" role="status">
                  {externalAgentSlashConflict(current.name, skills)}
                </p>
              )}
              <p className="sub">{current.description ?? "没有说明"}</p>
              <div className="kv">
                <div className="full">
                  <label>命令</label>
                  <code>
                    {current.command} {current.args.join(" ")}
                  </code>
                </div>
                <div className="full">
                  <label>来源</label>
                  <span>
                    {current.path ??
                      (current.origin === "app" ? "external-agents.json" : "config.json")}
                    {!current.editable ? " · 在 config.json 中定义，请在文件中修改" : ""}
                  </span>
                </div>
                <div className="full">
                  <label>模式</label>
                  <code>{current.mode ?? "使用 agent 默认模式"}</code>
                </div>
                <div className="full">
                  <label>环境变量</label>
                  <pre>{JSON.stringify(current.env ?? {}, null, 2)}</pre>
                </div>
                <div className="full">
                  <label>会话配置项</label>
                  <pre>{JSON.stringify(current.configOptions ?? {}, null, 2)}</pre>
                </div>
                <div className="full">
                  <label>最近测试</label>
                  <span>
                    {resultText(recent?.result)}
                    {recent ? ` · ${recent.at} · ${recent.result.durationMs} ms` : ""}
                  </span>
                </div>
              </div>
              {recent && <ProbeDetails result={recent.result} />}
            </>
          ) : (
            <div className="mcp-empty">
              <h3>还没有外部 agent</h3>
              <p className="sub">添加已安装的 ACP 命令行工具，用斜杠点名委派任务。</p>
              <button className="btn primary" disabled={!client} onClick={add}>
                添加 agent
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
      {deleting && current && (
        <Scrim
          onClose={() => {
            if (!busy) setDeleting(false);
          }}
        >
          <div className="dialog">
            <h3>删除 {current.name}？</h3>
            <p>只删除程序维护的配置，不会卸载命令行工具或删除它的账号。</p>
            <div className="acts">
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setDeleting(false);
                }}
              >
                取消
              </button>
              <button
                className="btn danger"
                disabled={!client || busy}
                onClick={() => {
                  if (!client) return;
                  void mutate(async () => {
                    await client.runtime.deleteExternalAgent({ name: current.name });
                    setDeleting(false);
                  }, `已删除 ${current.name}`);
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </Scrim>
      )}
    </div>
  );
}

function ProbeDetails({ result }: { result: ExternalAgentProbeResult }) {
  return (
    <section className="external-probe" aria-label="探测结果">
      <p role="status" className={result.ok ? "sub" : "errt"}>
        {resultText(result)}
      </p>
      {result.ok && (
        <>
          <p className="fine">仅初始化并新建临时 ACP 会话，不发送 prompt，不消耗对方额度。</p>
          {result.authMethods && result.authMethods.length > 0 && (
            <div>
              <h4>登录方式</h4>
              <p className="sub">
                这是 agent 支持的登录方式，不代表当前未登录；请在它自己的命令行工具里管理登录。
              </p>
              {result.authMethods.map((method) => (
                <p key={method.id}>
                  {method.name}
                  {method.description ? ` · ${method.description}` : ""}
                </p>
              ))}
            </div>
          )}
          <p className="sub">{result.configOptions.length} 项可配置选项</p>
        </>
      )}
    </section>
  );
}

function ExternalAgentForm({
  client,
  initial,
  replace,
  recent,
  onProbed,
  onCancel,
  onSaved,
}: {
  client: RpcClient;
  initial: ExternalAgentConfig;
  replace: boolean;
  recent: ExternalAgentProbeResult | undefined;
  onProbed: (name: string, result: ExternalAgentProbeResult) => void;
  onCancel: () => void;
  onSaved: (name: string, tested: ExternalAgentProbeResult | undefined) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState(initial.args.join("\n"));
  const [mode, setMode] = useState(initial.mode ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [enabled, setEnabled] = useState(initial.enabled);
  const [env, setEnv] = useState(JSON.stringify(initial.env ?? {}, null, 2));
  const [options, setOptions] = useState(JSON.stringify(initial.configOptions ?? {}, null, 2));
  const [result, setResult] = useState(recent);
  const [testedDraft, setTestedDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    setResult(undefined);
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
        await onSaved(agentName, testedDraft === launchKey(config) ? result : undefined);
      } else {
        const probed = await client.runtime.probeExternalAgent({ config });
        setResult(probed);
        setTestedDraft(launchKey(config));
        if (config.name !== "") onProbed(config.name, probed);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(true);
      }}
    >
      <h3>{replace ? `编辑 ${initial.name}` : "添加外部 agent"}</h3>
      {!replace && (
        <div className="field">
          <span>从预设填入</span>
          <Dropdown
            label="外部 agent 预设"
            value={undefined}
            placeholder="自定义，或选择已安装的工具"
            options={EXTERNAL_AGENT_PRESETS.map((config) => ({
              value: config.name,
              label: config.name,
              description: `${config.command} ${config.args.join(" ")}`,
            }))}
            onChange={preset}
            disabled={busy ? "正在处理" : undefined}
          />
        </div>
      )}
      <fieldset disabled={busy}>
        <label className="field">
          名称
          <input
            value={name}
            disabled={replace}
            className={replace ? "mcp-name-locked" : ""}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
          />
          <small>创建后不可改，与所有来源中的名称不区分大小写唯一。</small>
        </label>
        <label className="field">
          说明
          <input
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
        <label className="field">
          命令
          <input
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setResult(undefined);
            }}
            required
          />
        </label>
        <label className="field">
          参数（逐行一个）
          <textarea
            rows={3}
            value={args}
            onChange={(event) => {
              setArgs(event.target.value);
              setResult(undefined);
            }}
          />
        </label>
        <label className="field">
          模式 id（可选）
          <input
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setResult(undefined);
            }}
          />
          <small>留空使用 agent 默认值，id 原样传递。</small>
        </label>
        <label className="field">
          环境变量（JSON 对象）
          <textarea
            rows={3}
            value={env}
            onChange={(event) => {
              setEnv(event.target.value);
              setResult(undefined);
            }}
          />
          <small>只接受字符串，支持字面值或 {"${NAME}"} 环境变量引用；不存储对方登录凭据。</small>
        </label>
        <label className="external-enabled">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
            }}
          />
          启用 agent
        </label>
      </fieldset>
      <section>
        <h4>会话配置项</h4>
        <p className="sub">
          测试连接后可从 agent 返回的可选值中搜索选择。未设置的项沿用 agent 默认值。
        </p>
        {result?.ok &&
          result.configOptions.map((option) => (
            <div className="field external-option" key={option.id}>
              <span>
                {option.name}
                {option.id.toLowerCase() !== option.name.toLowerCase() && (
                  <>
                    {" "}
                    <code>{option.id}</code>
                  </>
                )}
              </span>
              <small>{option.description}</small>
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
              <small>
                {selectedOptions[option.id] === undefined
                  ? `使用 agent 默认值（${option.currentValue}）`
                  : `已指定：${selectedOptions[option.id]}`}
              </small>
              {selectedOptions[option.id] !== undefined && (
                <button
                  type="button"
                  className="btn external-option-reset"
                  disabled={busy}
                  onClick={() => {
                    const { [option.id]: _removed, ...rest } = selectedOptions;
                    setOptions(JSON.stringify(rest, null, 2));
                  }}
                >
                  恢复默认
                </button>
              )}
            </div>
          ))}
        <label className="field">
          configOptions（JSON 对象）
          <textarea
            rows={3}
            disabled={busy}
            value={options}
            onChange={(event) => {
              setOptions(event.target.value);
            }}
          />
          <small>可手动填写未探测到的 id 和字符串值；agent 拒绝某项时不会静默忽略。</small>
        </label>
      </section>
      {result && <ProbeDetails result={result} />}
      {error && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      <div className="acts">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(false)}>
          {busy ? "处理中…" : "测试连接"}
        </button>
        <button className="btn primary" type="submit" disabled={busy}>
          保存
        </button>
      </div>
    </form>
  );
}
