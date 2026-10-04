import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcError } from "@nocturne/rpc/client";

import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import { Conversations, conversationStatus } from "./conversations";
import { parseCommand, COMMANDS } from "./commands";
import { StatusBar, type StatusPanel } from "./StatusBar";

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
  const [plainWorkspace, setPlainWorkspace] = useState<string | null>(null);
  const [prefsVersion, setPrefsVersion] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [backendExit, setBackendExit] = useState<{ code: number | null } | null>(null);
  const lastFocusRefresh = useRef(0);
  const [conversationVersion, setConversationVersion] = useState(0);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  const [lockedSession, setLockedSession] = useState<SessionSummary | null>(null);
  const workspaceRef = useRef<string | null>(null);
  workspaceRef.current = plainWorkspace;
  const conversations = useMemo(
    () =>
      new Conversations(
        pool,
        () => workspaceRef.current,
        () => {
          setConversationVersion((v) => v + 1);
        },
        (error) => {
          setStartupError({ message: errMessage(error) });
        },
      ),
    [pool],
  );

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

  // 启动链：普通对话工作区（外壳创建）→ 常驻后台 → 会话列表。
  // plain_workspace 或 ensure 失败都显示真实错误，「重试」重走这条链。
  const boot = useCallback(async () => {
    let workspace: string;
    try {
      workspace = (await host.invoke("plain_workspace")) as string;
    } catch (error) {
      setStartupError({ message: errMessage(error) });
      return;
    }
    setPlainWorkspace(workspace);
    const result = await connect(workspace);
    if (!result.ok) {
      setStartupError({ message: result.message });
      return;
    }
    setBackendExit(null);
    await refresh();
  }, [host, connect, refresh]);

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
      pool.onExit(({ key, code }) => {
        conversations.backendExited(key);
        setBackendExit({ code });
      }),
    [pool, conversations],
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

  // 「打开项目」只更新 prefs 并刷新列表，不启动后台（项目后台在打开会话时才启动）
  const openProject = useCallback(async () => {
    const dir = await host.pickFolder();
    if (dir === null) return;
    const key = projectKey(dir);
    const current = prefs.get();
    prefs.update({
      projects: current.projects.includes(dir) ? current.projects : [...current.projects, dir],
      hidden: current.hidden.filter((k) => projectKey(k) !== key),
    });
    bumpPrefs();
    await refresh();
    return dir;
  }, [host, prefs, refresh, bumpPrefs]);

  // 后台退出后的「重新连接」= 重走启动链
  const reconnect = boot;

  const selectSession = async (summary: SessionSummary, force = false) => {
    try {
      await conversations.open(summary.id, summary.cwd, force);
      setSelectedId(conversations.selectedId);
      setPanel(null);
      setLockedSession(null);
      await refresh();
    } catch (error) {
      if (error instanceof RpcError && error.code === "session_locked") setLockedSession(summary);
      else setStartupError({ message: errMessage(error) });
    }
  };

  const newSession = async (workspace?: string) => {
    const target = workspace ?? plainWorkspace;
    if (target === null) return;
    try {
      await conversations.newConversation(target);
      setSelectedId(null);
      setPanel(null);
      await refresh();
    } catch (error) {
      setStartupError({ message: errMessage(error) });
    }
  };

  const submitInput = async (line: string): Promise<boolean> => {
    try {
      const parsed = parseCommand(line);
      if (parsed === null) {
        await conversations.send(line);
        setSelectedId(conversations.selectedId);
        await refresh();
        return true;
      }
      if (parsed.kind === "unknown") throw new Error(`未知命令 ${parsed.name}；/help 列出可用命令`);
      if (parsed.kind === "invalid") throw new Error(parsed.message);
      await conversations.selected?.session.recordInputHistory(line);
      const { name, args } = parsed;
      if (parsed.command.status !== "supported") {
        setCommandOutput(parsed.command.statusText);
        return true;
      }
      if (args !== "" && parsed.command.arguments === undefined)
        throw new Error(`用法：${parsed.command.usage}`);
      if (name === "/new" || name === "/clear") {
        await newSession(
          conversations.selected?.workspace ?? conversations.draftWorkspace ?? undefined,
        );
        return true;
      }
      if (name === "/help") {
        setCommandOutput(
          COMMANDS.map(
            (command) => `${command.name}  ${command.summary} · ${command.statusText}`,
          ).join("\n"),
        );
        return true;
      }
      if (name === "/resume") {
        if (args === "") setCommandOutput("从左侧选择要恢复的会话");
        else {
          const target = sessions.find((s) => s.id === args);
          if (target === undefined) throw new Error("找不到该会话");
          await selectSession(target);
        }
        return true;
      }
      const active = conversations.selected;
      if (active === undefined) throw new Error("请先打开会话");
      const session = active.session;
      switch (name) {
        case "/compact":
          await conversations.compact();
          break;
        case "/context":
          setPanel("context");
          break;
        case "/model":
          if (args === "") setPanel("model");
          else await session.setModel(args);
          break;
        case "/effort":
          if (args === "") setPanel("effort");
          else await session.setReasoningEffort(args);
          break;
        case "/preset":
          if (args === "") setPanel("preset");
          else await session.setPermissionPreset(args);
          break;
        case "/shell":
          if (args === "") setPanel("shell");
          else await session.setShell(args);
          break;
        case "/mcp": {
          const servers = await session.mcpServers();
          setCommandOutput(
            servers.length === 0
              ? "本会话没有配置 MCP 服务器"
              : servers
                  .map(
                    (server) =>
                      `${server.name}  ${server.state}${server.error === undefined ? "" : ` · ${server.error}`}`,
                  )
                  .join("\n"),
          );
          break;
        }
        default:
          setCommandOutput("该命令不属于当前会话的 RPC 操作");
      }
      return true;
    } catch (error) {
      setStartupError({ message: errMessage(error) });
      return false;
    }
  };

  const p = prefs.get();
  const tree = useMemo(
    () =>
      buildSessionTree(
        sessions.map((summary) => {
          const entry = conversations.opened.get(summary.id);
          return entry === undefined
            ? summary
            : { ...summary, locked: false, firstText: entry.view.title ?? summary.firstText };
        }),
        p,
        {
          plainWorkspace,
          chatsExpanded,
          expanded,
          collapsed,
          statuses: Object.fromEntries(
            [...conversations.opened].map(([id, entry]) => [id, conversationStatus(entry)]),
          ),
        },
      ),
    // prefs 快照经 prefsVersion 驱动重算
    [
      sessions,
      prefsVersion,
      plainWorkspace,
      chatsExpanded,
      expanded,
      collapsed,
      conversationVersion,
    ],
  );

  const pinnedIds = new Set(p.pinned);

  const active = conversations.selected;
  const selected = sessions.find((s) => s.id === conversations.selectedId);
  useEffect(() => {
    if (active !== undefined && !active.busy) void refresh();
  }, [active?.view.turnCount, selectedId, refresh]);

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
        chatsExpanded={chatsExpanded}
        onSelectSession={(id) => {
          const summary = sessions.find((s) => s.id === id);
          if (summary !== undefined) void selectSession(summary);
        }}
        onToggleCollapse={(key) => {
          setCollapsed((s) => toggleIn(s, key));
        }}
        onToggleExpand={(key) => {
          setExpanded((s) => toggleIn(s, key));
        }}
        onToggleChats={() => {
          setChatsExpanded((v) => !v);
        }}
        projectSort={p.projectSort}
        hiddenProjects={p.hidden.map((path) => ({ path, name: projectName(path) }))}
        onSetSort={(sort) => {
          prefs.update({ projectSort: sort });
          bumpPrefs();
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
        onHideProject={(path) => {
          const cur = prefs.get();
          const key = projectKey(path);
          prefs.update({
            hidden: cur.hidden.some((h) => projectKey(h) === key)
              ? cur.hidden
              : [...cur.hidden, path],
          });
          bumpPrefs();
        }}
        onRestoreProject={(path) => {
          const cur = prefs.get();
          const key = projectKey(path);
          prefs.update({ hidden: cur.hidden.filter((h) => projectKey(h) !== key) });
          bumpPrefs();
        }}
        onOpenProject={() => void openProject()}
        onNewSession={(workspace) => void newSession(workspace)}
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
                <div className="t">
                  {startupError.message}
                  <button className="btn" onClick={() => void boot()}>
                    重试
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {active !== undefined ? (
          <>
            <div className="head">
              <div className="crumb">
                {projectKey(active.workspace) === projectKey(plainWorkspace ?? "")
                  ? "对话"
                  : projectName(active.workspace)}
                <span>›</span>
                <em>{active.view.title ?? selected?.firstText ?? "新会话"}</em>
              </div>
              <div className="path">{active.workspace}</div>
            </div>
            {active.warnings.map((warning) => (
              <div className="banner" key={warning}>
                {warning}
              </div>
            ))}
            <Conversation
              key={`conversation:${active.session.id}`}
              session={active.session}
              view={active.view}
              openUrl={(url) => void host.openUrl(url)}
            />
            <Composer
              key={`composer:${active.session.id}`}
              running={conversationStatus(active) !== "idle"}
              onSubmit={submitInput}
              onInterrupt={() => {
                conversations.interrupt();
              }}
              historyKey={active.session.id}
              readInputHistory={() => active.session.readInputHistory()}
            />
            <StatusBar
              session={active.session}
              runtime={active.client.runtime}
              view={active.view}
              panel={panel}
              onPanelChange={setPanel}
            />
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-col">
              <div className="welcome-icon" aria-hidden="true">
                ☾
              </div>
              <h1>开始一段新对话</h1>
              <div className="workspace-picker">
                <label htmlFor="draft-project">工作区</label>
                <select
                  id="draft-project"
                  value={conversations.draftWorkspace ?? plainWorkspace ?? ""}
                  onChange={(event) => {
                    if (event.target.value === "__open__") {
                      void openProject().then((dir) => {
                        if (dir !== undefined) void newSession(dir);
                      });
                    } else void newSession(event.target.value);
                  }}
                >
                  <option value={plainWorkspace ?? ""}>普通对话</option>
                  {tree.projects.map((project) => (
                    <option value={project.path} key={project.key}>
                      {project.name}
                    </option>
                  ))}
                  <option value="__open__">打开其他文件夹…</option>
                </select>
              </div>
              <Composer
                running={false}
                disabled={plainWorkspace === null || pool.any() === undefined}
                onSubmit={submitInput}
                onInterrupt={() => {
                  conversations.interrupt();
                }}
                historyKey={conversations.draftWorkspace ?? plainWorkspace}
              />
            </div>
          </div>
        )}
        {lockedSession !== null && (
          <div className="dialog-backdrop">
            <div
              className="desktop-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="locked-title"
            >
              <h3 id="locked-title">正在别处使用</h3>
              <p>强制打开会接管会话锁。请先确认其他进程已停止使用此会话，避免并发写入。</p>
              <div className="acts">
                <button
                  className="btn"
                  onClick={() => {
                    setLockedSession(null);
                  }}
                >
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={() => void selectSession(lockedSession, true)}
                >
                  强制打开
                </button>
              </div>
            </div>
          </div>
        )}
        {commandOutput !== null && (
          <div className="dialog-backdrop">
            <div className="desktop-dialog" role="dialog" aria-modal="true" aria-label="命令结果">
              <pre>{commandOutput}</pre>
              <button
                className="btn"
                onClick={() => {
                  setCommandOutput(null);
                }}
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
