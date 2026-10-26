import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type { Grant, GrantWorkspace, ProjectTrustDescription } from "@nocturne/core/protocol";
import { ConfirmDialog } from "./ProvidersPage";
import "./pages.css";
import "./grants.css";

export const grantKind = (kind: Grant["kind"]): string =>
  ({
    read: "读取",
    edit: "修改",
    shell: "命令",
    network: "网络",
    mcp: "MCP",
    subagent: "子代理",
    schedule: "定时任务",
  })[kind];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
const samePath = (a: string, b: string | undefined) =>
  a.replaceAll("\\", "/").toLowerCase() === b?.replaceAll("\\", "/").toLowerCase();
export function GrantTarget({ target }: { target: string }) {
  return target.length > 100 ? (
    <details className="grant-target">
      <summary>{target.slice(0, 96)}…</summary>
      <code>{target}</code>
    </details>
  ) : (
    <code className="grant-target">{target}</code>
  );
}

export function GrantsPage({
  client,
  plainWorkspace,
  remote = false,
}: {
  client: RpcClient | undefined;
  plainWorkspace?: string | undefined;
  remote?: boolean;
}) {
  const [workspaces, setWorkspaces] = useState<GrantWorkspace[]>([]);
  const [selected, setSelected] = useState<string>();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [description, setDescription] = useState<ProjectTrustDescription>();
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const refreshWorkspaces = useCallback(async () => {
    if (!client) return;
    try {
      const list = await client.runtime.listGrantWorkspaces();
      if (plainWorkspace && !list.some((item) => samePath(item.workspace, plainWorkspace)))
        list.unshift({
          workspace: plainWorkspace,
          grantCount: 0,
          trusted: false,
          hasProjectConfig: false,
        });
      list.sort(
        (a, b) =>
          Number(samePath(b.workspace, plainWorkspace)) -
            Number(samePath(a.workspace, plainWorkspace)) || a.workspace.localeCompare(b.workspace),
      );
      setWorkspaces(list);
      setSelected((value) =>
        list.some((item) => item.workspace === value) ? value : list[0]?.workspace,
      );
    } catch (reason) {
      setError(message(reason));
    }
  }, [client, plainWorkspace]);
  const refresh = useCallback(async () => {
    if (!client || !selected) return;
    const version = ++generation.current;
    try {
      const list = await client.runtime.listGrants({ workspace: selected });
      if (version === generation.current)
        setGrants(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (reason) {
      if (version === generation.current) setError(message(reason));
    }
  }, [client, selected]);
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);
  useEffect(() => {
    setGrants([]);
    setConfirmAll(false);
    setDescription(undefined);
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useEffect(
    () =>
      client?.onNotification("grants.changed", () => {
        void refreshWorkspaces();
        void refresh();
      }),
    [client, refresh, refreshWorkspaces],
  );
  const current = workspaces.find((item) => item.workspace === selected);
  const mutate = async (action: () => Promise<void>, text: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setNotice(text);
      setConfirmAll(false);
      await Promise.all([refreshWorkspaces(), refresh()]);
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page3 grants-page" aria-busy={busy}>
      <header className="ph3">
        <div className="grow">
          <h3>授权</h3>
          <span className="sub">查看和撤销确认时授予的允许</span>
        </div>
      </header>
      {error && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      <div className="cols3">
        <nav className="plist grants-workspaces" aria-label="工作区">
          <h5>工作区</h5>
          {workspaces.map((item) => (
            <button
              key={item.workspace}
              className={`grant-workspace ${selected === item.workspace ? "on" : ""}`}
              onClick={() => {
                setSelected(item.workspace);
              }}
            >
              <b>
                {samePath(item.workspace, plainWorkspace) ? "普通对话" : basename(item.workspace)}
              </b>
              <small>
                {item.grantCount} 项授权 · {item.trusted ? "已信任" : "未信任"}
              </small>
            </button>
          ))}
        </nav>
        <label className="grants-workspace-select">
          工作区
          <select
            value={selected ?? ""}
            onChange={(event) => {
              setSelected(event.target.value);
            }}
          >
            {workspaces.map((item) => (
              <option value={item.workspace} key={item.workspace}>
                {samePath(item.workspace, plainWorkspace) ? "普通对话" : basename(item.workspace)} ·{" "}
                {item.grantCount} 项授权
              </option>
            ))}
          </select>
        </label>
        <div className="pane">
          {current ? (
            <>
              <div className="t1">
                <h3>
                  {samePath(current.workspace, plainWorkspace)
                    ? "普通对话"
                    : basename(current.workspace)}
                </h3>
                <span className="sub grant-path">{current.workspace}</span>
              </div>
              <section className="grant-trust" aria-label="项目信任">
                <div>
                  <b>项目信任</b>
                  <p>
                    <span className={`grant-dot ${current.trusted ? "trusted" : ""}`} />
                    {!current.hasProjectConfig
                      ? "没有项目配置"
                      : current.trusted
                        ? "已信任"
                        : "未信任"}
                  </p>
                  <small>
                    {current.hasProjectConfig
                      ? "信任后，项目配置里的 MCP、Hook 和权限规则会参与运行。"
                      : "这个工作区没有 .nocturne/config.json。"}
                  </small>
                </div>
                <div title={remote ? "请在电脑上操作" : undefined}>
                  <button
                    className="btn"
                    disabled={remote || busy || !client || !current.hasProjectConfig}
                    onClick={() => {
                      if (!client) return;
                      if (current.trusted)
                        void mutate(
                          () =>
                            client.runtime.setWorkspaceTrusted({
                              workspace: current.workspace,
                              trusted: false,
                            }),
                          "已取消信任，新开或重新打开会话生效",
                        );
                      else {
                        setError("");
                        void client.runtime
                          .describeProject({ workspace: current.workspace })
                          .then(setDescription)
                          .catch((reason: unknown) => {
                            setError(message(reason));
                          });
                      }
                    }}
                  >
                    {current.trusted ? "取消信任" : "信任此项目"}
                  </button>
                  {remote && <small>请在电脑上操作</small>}
                </div>
              </section>
              <section className="grant-project" aria-label="项目授权">
                <div className="grant-section-head">
                  <h4>
                    项目授权 <span>{grants.length}</span>
                  </h4>
                  {grants.length > 0 && (
                    <button
                      className={`btn ${confirmAll ? "danger" : ""}`}
                      disabled={busy || !client}
                      onClick={() => {
                        if (!confirmAll) {
                          setConfirmAll(true);
                          return;
                        }
                        if (client)
                          void mutate(
                            () => client.runtime.revokeAllGrants({ workspace: current.workspace }),
                            "已撤销全部项目授权，下一次调用会重新询问",
                          );
                      }}
                    >
                      {confirmAll ? "确认全部撤销" : "全部撤销"}
                    </button>
                  )}
                </div>
                {grants.length === 0 ? (
                  <div className="grant-empty">
                    还没有项目授权。确认时选『本项目允许』会出现在这里。
                  </div>
                ) : (
                  <div className="grant-table" role="table" aria-label="项目授权列表">
                    <div className="grant-table-head" role="row">
                      <span>类别</span>
                      <span>目标</span>
                      <span>授予时间</span>
                      <span />
                    </div>
                    {grants.map((grant) => (
                      <div className="grant-row" role="row" key={`${grant.kind}:${grant.target}`}>
                        <span className="grant-kind">{grantKind(grant.kind)}</span>
                        <GrantTarget target={grant.target} />
                        <time dateTime={grant.createdAt}>
                          {new Date(grant.createdAt).toLocaleString("zh-CN", { hour12: false })}
                        </time>
                        <button
                          className="grant-revoke"
                          disabled={busy || !client}
                          onClick={() => {
                            if (client)
                              void mutate(
                                () =>
                                  client.runtime.revokeGrant({
                                    workspace: current.workspace,
                                    kind: grant.kind,
                                    target: grant.target,
                                  }),
                                "已撤销，下一次调用会重新询问",
                              );
                          }}
                        >
                          撤销
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <p className="grant-note">
                规则（例如「允许所有 git 命令」）写在 config.json 的
                permissions.rules；这里只管理确认时点出来的授权。
              </p>
            </>
          ) : (
            <p className="grant-empty">还没有工作区授权记录。</p>
          )}
        </div>
      </div>
      {notice && (
        <div className="toast3" role="status">
          {notice}
        </div>
      )}
      {description && current && client && (
        <ConfirmDialog
          title="信任此项目？"
          body={current.workspace}
          confirmLabel="信任此项目"
          note="这些配置来自仓库，信任后会在打开会话时执行。请只信任你了解的项目。新开或重新打开会话生效。"
          extra={
            <div className="grant-description">
              <h4>MCP 服务器 · {description.mcpServers.length}</h4>
              {description.mcpServers.map((server) => (
                <div key={server.name}>
                  <b>{server.name}</b>
                  <code>{server.command}</code>
                </div>
              ))}
              <h4>
                Hook · {description.hooks.reduce((total, entry) => total + entry.count, 0)} 条
              </h4>
              {description.hooks.map((entry) => (
                <p key={entry.event}>
                  {entry.event} · {entry.count} 条
                </p>
              ))}
              <h4>放宽的权限规则 · {description.relaxedRuleCount} 条</h4>
            </div>
          }
          onClose={() => {
            setDescription(undefined);
          }}
          onConfirm={async () => {
            const saved = await mutate(
              () =>
                client.runtime.setWorkspaceTrusted({ workspace: current.workspace, trusted: true }),
              "已信任，新开或重新打开会话生效",
            );
            if (saved) setDescription(undefined);
          }}
        />
      )}
    </div>
  );
}
