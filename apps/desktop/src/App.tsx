import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BackendPool } from "./backends";
import type { DesktopHost } from "./host";
import { NodeHelp } from "./NodeHelp";
import { createPrefsStore } from "./prefs";
import { buildSessionTree, projectKey, projectName, type SessionSummary } from "./session-tree";
import { Sidebar } from "./Sidebar";
import type { NodeProbe } from "./types";

type Phase =
  | { kind: "probing" }
  | { kind: "probe-error"; message: string }
  | { kind: "node-help"; probe: NodeProbe; checking: boolean }
  | { kind: "ready" };

type ConnectResult = { ok: true } | { ok: false; message: string };

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StartupError {
  message: string;
}

const FOCUS_THROTTLE_MS = 2_000;

export function App({ host }: { host: DesktopHost }) {
  const prefs = useMemo(() => createPrefsStore(globalThis.localStorage), []);
  const pool = useMemo(() => new BackendPool(host), [host]);

  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [prefsVersion, setPrefsVersion] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [backendExit, setBackendExit] = useState<{ code: number | null } | null>(null);
  const lastFocusRefresh = useRef(0);

  const bumpPrefs = useCallback(() => {
    setPrefsVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    const client = pool.any();
    if (client === undefined) return;
    try {
      const list = await client.runtime.listSessions();
      setSessions(list);
      setStartupError(null);
    } catch (error) {
      setStartupError({ message: errMessage(error) });
    }
  }, [pool]);

  const connect = useCallback(
    async (workspace: string): Promise<ConnectResult> => {
      try {
        await pool.ensure(workspace);
        return { ok: true };
      } catch (error) {
        // DesktopError/RpcError/Error 的 message 直接给用户看
        // （如 backend_script_missing 提示先 pnpm build、protocol_version_mismatch、invalid_workspace）
        return { ok: false, message: errMessage(error) };
      }
    },
    [pool],
  );

  const boot = useCallback(async () => {
    // 启动项目：lastProject，否则第一个手动项目；全失败显示每个候选的原因
    const { lastProject, projects } = prefs.get();
    const candidates = [
      ...(lastProject !== null ? [lastProject] : []),
      ...projects.filter((p) => p !== lastProject),
    ];
    const failures: string[] = [];
    for (const workspace of candidates) {
      const result = await connect(workspace);
      if (result.ok) {
        await refresh();
        return;
      }
      failures.push(`${workspace}：${result.message}`);
    }
    if (failures.length > 0) {
      setStartupError({ message: `无法连接后台：${failures.join("；")}` });
    }
    // 没有候选项目：左栏只显示「打开项目…」
  }, [prefs, connect, refresh]);

  const probe = useCallback(async () => {
    let result: NodeProbe;
    try {
      result = (await host.invoke("node_probe")) as NodeProbe;
    } catch (error) {
      setPhase({ kind: "probe-error", message: errMessage(error) });
      return;
    }
    if (result.ok) {
      setPhase({ kind: "ready" });
      void boot();
    } else {
      setPhase({ kind: "node-help", probe: result, checking: false });
    }
  }, [host, boot]);

  const reprobe = useCallback(() => {
    setPhase((p) => (p.kind === "node-help" ? { ...p, checking: true } : p));
    void probe();
  }, [probe]);

  // 只在挂载时探测一次
  useEffect(() => {
    void probe();
  }, [probe]);

  // 后台退出：提示"后台已退出（退出码 N）"与「重新连接」
  useEffect(
    () =>
      pool.onExit(({ code }) => {
        setBackendExit({ code });
      }),
    [pool],
  );

  // 窗口重新获得焦点时刷新列表（节流 ≥ 2 秒）
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefresh.current < FOCUS_THROTTLE_MS) return;
      lastFocusRefresh.current = now;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const openProject = useCallback(async () => {
    const dir = await host.pickFolder();
    if (dir === null) return;
    const key = projectKey(dir);
    const current = prefs.get();
    prefs.update({
      projects: current.projects.includes(dir) ? current.projects : [...current.projects, dir],
      hidden: current.hidden.filter((k) => projectKey(k) !== key),
      lastProject: dir,
    });
    bumpPrefs();
    if (pool.any() === undefined) {
      const result = await connect(dir);
      if (!result.ok) {
        setStartupError({ message: `无法连接后台：${dir}：${result.message}` });
        return;
      }
    }
    await refresh();
  }, [host, prefs, pool, connect, refresh, bumpPrefs]);

  const reconnect = useCallback(async () => {
    const { lastProject, projects } = prefs.get();
    const candidates = [
      ...(lastProject !== null ? [lastProject] : []),
      ...projects.filter((p) => p !== lastProject),
    ];
    const failures: string[] = [];
    for (const workspace of candidates) {
      const result = await connect(workspace);
      if (result.ok) {
        setBackendExit(null);
        await refresh();
        return;
      }
      failures.push(`${workspace}：${result.message}`);
    }
    setStartupError({
      message:
        failures.length > 0
          ? `重新连接失败：${failures.join("；")}`
          : "重新连接失败：没有可用的项目目录",
    });
  }, [prefs, connect, refresh]);

  const p = prefs.get();
  const tree = useMemo(
    () =>
      buildSessionTree(sessions, p, {
        expanded,
        collapsed,
      }),
    // prefs 快照经 prefsVersion 驱动重算
    [sessions, prefsVersion, expanded, collapsed],
  );

  const pinnedIds = new Set(p.pinned);

  const selected = sessions.find((s) => s.id === selectedId);

  const toggleIn = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  if (phase.kind === "probing") {
    return <div className="center" />;
  }
  if (phase.kind === "probe-error") {
    return (
      <div className="center">
        <div className="nodecard">
          <h3>无法检测 Node.js</h3>
          <div className="lead">{phase.message}</div>
          <div className="acts">
            <button className="btn primary" onClick={reprobe}>
              重新检测
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (phase.kind === "node-help") {
    return (
      <NodeHelp
        probe={phase.probe}
        checking={phase.checking}
        onProbe={reprobe}
        openUrl={(url) => void host.openUrl(url)}
      />
    );
  }

  return (
    <div className="body">
      <Sidebar
        tree={tree}
        pinnedIds={pinnedIds}
        selectedId={selectedId}
        collapsed={collapsed}
        expanded={expanded}
        onSelectSession={(id) => {
          setSelectedId(id);
          const session = sessions.find((s) => s.id === id);
          if (session !== undefined) {
            prefs.update({ lastProject: session.cwd });
            bumpPrefs();
          }
        }}
        onToggleCollapse={(key) => {
          setCollapsed((s) => toggleIn(s, key));
        }}
        onToggleExpand={(key) => {
          setExpanded((s) => toggleIn(s, key));
        }}
        onPin={(id) => {
          const cur = prefs.get();
          prefs.update({ pinned: cur.pinned.includes(id) ? cur.pinned : [id, ...cur.pinned] });
          bumpPrefs();
        }}
        onUnpin={(id) => {
          const cur = prefs.get();
          prefs.update({ pinned: cur.pinned.filter((x) => x !== id) });
          bumpPrefs();
        }}
        onHideProject={(key) => {
          const cur = prefs.get();
          prefs.update({
            hidden: cur.hidden.includes(key) ? cur.hidden : [...cur.hidden, key],
            projects: cur.projects.filter((x) => projectKey(x) !== key),
          });
          bumpPrefs();
        }}
        onOpenProject={() => void openProject()}
      />
      <div className="main">
        {(backendExit !== null || startupError !== null) && (
          <div className="banner">
            {backendExit !== null && (
              <div className="crash">
                <div className="t">
                  后台已退出（退出码 {backendExit.code ?? "未知"}）
                  <button className="btn primary" onClick={() => void reconnect()}>
                    重新连接
                  </button>
                </div>
              </div>
            )}
            {startupError !== null && (
              <div className="crash">
                <div className="t">{startupError.message}</div>
              </div>
            )}
          </div>
        )}
        {selected !== undefined ? (
          <>
            <div className="head">
              <div className="crumb">
                {projectName(selected.cwd)}
                <span>›</span>
                <em>{selected.firstText ?? "未命名会话"}</em>
              </div>
              <div className="path">{selected.cwd}</div>
            </div>
            <div className="stream">
              <div className="col">
                <div className="placeholder">会话视图在第 2 步实现</div>
              </div>
            </div>
          </>
        ) : (
          <div className="stream">
            <div className="col">
              <div className="placeholder">
                {tree.projects.length === 0 && sessions.length === 0
                  ? "打开一个项目目录后列出会话"
                  : "从左侧选择一个会话"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
