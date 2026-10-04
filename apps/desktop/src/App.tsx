import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcError, type RpcClient, type RpcRuntime, type RpcSession } from "@nocturne/rpc/client";
import type { RuntimeEvent, SessionView } from "@nocturne/core/protocol";

import { createAttachmentImageSource, type AttachmentImageSource } from "./attachment-images";
import { Composer, type ComposerSubmit, type WorkspaceChoice } from "./Composer";
import { Conversation } from "./Conversation";
import { Conversations, conversationStatus, type CreateSessionChoice } from "./conversations";
import { parseSlash } from "./commands";
import { StatusBar, type StatusPanel } from "./StatusBar";
import { PaneErrorBoundary } from "./ErrorBoundary";

import { BackendPool } from "./backends";
import type { DesktopHost } from "./host";
import { NodeHelp } from "./NodeHelp";
import { abbreviateHome, middleTruncate } from "./paths";
import { createPrefsStore, type PrefsStore } from "./prefs";
import { useDraftControls, useSessionControls } from "./session-controls";
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
  const images = useMemo(() => createAttachmentImageSource(), []);

  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [plainWorkspace, setPlainWorkspace] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
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
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
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

  // 主目录只读一次（路径 ~ 缩写）
  useEffect(() => {
    void host.homeDir().then(setHome);
  }, [host]);

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

  // 发送消息：接受成功后登记附件缩略图源（以 sha256 命中消息流里的图片）
  const submitInput = async (
    input: ComposerSubmit,
    create?: CreateSessionChoice,
  ): Promise<boolean> => {
    // 先登记附件字节：发送被拒也只是缓存里多一条，而接受后首帧用户气泡就有缩略图
    await Promise.all(
      input.attachments.map((attachment) => images.register(attachment.data, attachment.mimeType)),
    );
    await conversations.send(input, create);
    setSelectedId(conversations.selectedId);
    await refresh();
    return true;
  };

  const runSlash = async (line: string): Promise<boolean> => {
    const parsed = parseSlash(line);
    if (parsed?.kind !== "command") return false;
    await conversations.selected?.session.recordInputHistory(line);
    if (parsed.name === "/compact") {
      await conversations.compact();
      await refresh();
      return true;
    }
    const active = conversations.selected;
    if (active === undefined) throw new Error("请先打开会话");
    const servers = await active.session.mcpServers();
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
    return true;
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

  const plainKey = plainWorkspace === null ? null : projectKey(plainWorkspace);
  const projects = tree.projects.map((project) => ({
    key: project.key,
    path: project.path,
    name: project.name,
  }));

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
          <PaneErrorBoundary key={active.session.id}>
            <SessionPane
              view={active.view}
              workspace={active.workspace}
              session={active.session}
              client={active.client}
              prefs={prefs}
              images={images}
              plainKey={plainKey}
              home={home}
              selected={selected}
              running={conversationStatus(active) !== "idle"}
              onSubmit={(input) => submitInput(input)}
              onInterrupt={() => {
                conversations.interrupt();
              }}
              onSlash={runSlash}
              pickImages={() => host.pickImages()}
              openUrl={(url) => void host.openUrl(url)}
              panel={panel}
              onPanelChange={setPanel}
            />
          </PaneErrorBoundary>
        ) : (
          <PaneErrorBoundary key="draft">
            <DraftPane
              runtime={pool.any()?.runtime}
              prefs={prefs}
              workspace={conversations.draftWorkspace ?? plainWorkspace}
              plainKey={plainKey}
              projects={projects}
              disabled={plainWorkspace === null || pool.any() === undefined}
              historyKey={conversations.draftWorkspace ?? plainWorkspace}
              onSubmit={submitInput}
              onSlash={runSlash}
              pickImages={() => host.pickImages()}
              onSelectPlain={() => void newSession(plainWorkspace ?? undefined)}
              onSelectProject={(path) => void newSession(path)}
              onOpenOther={() =>
                void openProject().then((dir) => {
                  if (dir !== undefined) void newSession(dir);
                })
              }
              dirMenuOpen={dirMenuOpen}
              onDirMenuOpenChange={setDirMenuOpen}
            />
          </PaneErrorBoundary>
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

// ── 会话界面：消息流 + 输入框 + 状态栏 ──

interface SessionPaneProps {
  view: SessionView;
  workspace: string;
  session: RpcSession;
  client: RpcClient;
  prefs: PrefsStore;
  images: AttachmentImageSource;
  plainKey: string | null;
  home: string | null;
  selected: SessionSummary | undefined;
  running: boolean;
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  onInterrupt: () => void;
  onSlash: (line: string) => Promise<boolean>;
  pickImages: DesktopHost["pickImages"];
  openUrl: (url: string) => void;
  panel: StatusPanel | null;
  onPanelChange: (panel: StatusPanel | null) => void;
}

function SessionPane({
  view,
  workspace,
  session,
  client,
  prefs,
  images,
  plainKey,
  home,
  selected,
  running,
  onSubmit,
  onInterrupt,
  onSlash,
  pickImages,
  openUrl,
  panel,
  onPanelChange,
}: SessionPaneProps) {
  const runtime = client.runtime;
  const controls = useSessionControls(session, runtime, view, prefs);
  const subscribeEvents = useCallback(
    (listener: (event: RuntimeEvent) => void) =>
      client.onEvent((sessionId, event) => {
        if (sessionId === session.id) listener(event);
      }),
    [client, session.id],
  );
  const isPlain = plainKey !== null && projectKey(workspace) === plainKey;
  const head = abbreviateHome(workspace, home);
  const shown = middleTruncate(head, 56);
  return (
    <>
      <div className="head">
        <div className="crumb">
          {isPlain ? "对话" : projectName(workspace)}
          <span>›</span>
          <em>{view.title ?? selected?.firstText ?? "新会话"}</em>
        </div>
        <div className="path" title={workspace}>
          {shown}
        </div>
      </div>
      <Conversation
        key={`conversation:${session.id}`}
        session={session}
        view={view}
        openUrl={openUrl}
        cwd={workspace}
        shellKind={controls.shell?.effective?.kind}
        subscribeEvents={subscribeEvents}
        images={images}
      />
      <Composer
        key={`composer:${session.id}`}
        variant="session"
        running={running}
        onSubmit={onSubmit}
        onInterrupt={onInterrupt}
        historyKey={session.id}
        readInputHistory={() => session.readInputHistory()}
        fileRefs={isPlain ? null : { load: () => session.fileIndex(), key: view.turnCount }}
        fileRefsUnavailable="普通对话没有项目文件"
        getVisionHint={controls.visionHint}
        pickImages={pickImages}
        onSlash={onSlash}
      />
      <StatusBar
        session={session}
        view={view}
        controls={controls}
        panel={panel}
        onPanelChange={onPanelChange}
        home={home}
      />
    </>
  );
}

// ── 空状态（草稿）：hero + 同一个输入框 ──

interface DraftPaneProps {
  runtime: RpcRuntime | undefined;
  prefs: PrefsStore;
  workspace: string | null;
  plainKey: string | null;
  projects: { key: string; path: string; name: string }[];
  disabled: boolean;
  historyKey: string | null;
  onSubmit: (input: ComposerSubmit, create: CreateSessionChoice) => Promise<boolean>;
  onSlash: (line: string) => Promise<boolean>;
  pickImages: DesktopHost["pickImages"];
  onSelectPlain: () => void;
  onSelectProject: (path: string) => void;
  onOpenOther: () => void;
  dirMenuOpen: boolean;
  onDirMenuOpenChange: (open: boolean) => void;
}

function DraftPane({
  runtime,
  prefs,
  workspace,
  plainKey,
  projects,
  disabled,
  historyKey,
  onSubmit,
  onSlash,
  pickImages,
  onSelectPlain,
  onSelectProject,
  onOpenOther,
  dirMenuOpen,
  onDirMenuOpenChange,
}: DraftPaneProps) {
  const draft = useDraftControls(runtime, prefs);
  const isPlain = workspace === null || (plainKey !== null && projectKey(workspace) === plainKey);
  const workspaceChoice: WorkspaceChoice = {
    label: isPlain ? "普通对话" : projectName(workspace),
    kind: isPlain ? "plain" : "project",
    ...(workspace === null ? {} : { title: workspace }),
    readOnly: false,
    currentKey: isPlain ? null : projectKey(workspace),
    projects,
    onSelectPlain,
    onSelectProject,
    onOpenOther,
  };
  return (
    <div className="hero">
      <div className="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16" width={40} height={40}>
          <path d="M10.5 1.5a6.5 6.5 0 1 0 4 11.6A7 7 0 0 1 10.5 1.5z" fill="var(--a-accent)" />
        </svg>
      </div>
      <h3>
        {isPlain ? (
          "有什么可以帮你？"
        ) : (
          <>
            要在{" "}
            <button
              type="button"
              className="hero-project"
              onClick={() => {
                onDirMenuOpenChange(true);
              }}
            >
              {projectName(workspace)}
            </button>{" "}
            里做什么？
          </>
        )}
      </h3>
      <div className="hero-composer">
        <Composer
          running={false}
          disabled={disabled}
          onSubmit={(input) => onSubmit(input, draft.createOptions())}
          onInterrupt={() => undefined}
          historyKey={historyKey}
          controls={draft.controls}
          workspace={workspaceChoice}
          fileRefs={null}
          fileRefsUnavailable={isPlain ? "普通对话没有项目文件" : "发送第一条消息后可搜索项目文件"}
          pickImages={pickImages}
          dirMenuOpen={dirMenuOpen}
          onDirMenuOpenChange={onDirMenuOpenChange}
          onSlash={onSlash}
        />
      </div>
    </div>
  );
}
