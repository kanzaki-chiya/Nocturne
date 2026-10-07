import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcError, type RpcClient, type RpcRuntime, type RpcSession } from "@nocturne/rpc/client";
import type {
  ExternalAgentOverview,
  RewindMode,
  RuntimeEvent,
  SessionView,
  SkillOverview,
} from "@nocturne/core/protocol";

import { createAttachmentImageSource, type AttachmentImageSource } from "./attachment-images";
import { BackendLogsPage, SHELL_LOG_ID, type BackendLogTarget } from "./BackendLogsPage";
import { Composer, type ComposerSubmit, type WorkspaceChoice } from "./Composer";
import { Conversation, type FileLinkHooks } from "./Conversation";
import {
  activeConversationCount,
  Conversations,
  conversationStatus,
  type CreateSessionChoice,
} from "./conversations";
import { parseSlash } from "./commands";
import { StatusBar, type StatusPanel } from "./StatusBar";
import { PaneErrorBoundary } from "./ErrorBoundary";
import { ProvidersPage } from "./ProvidersPage";
import { McpPage } from "./McpPage";
import { ExternalAgentsPage } from "./ExternalAgentsPage";
import { SkillsPage } from "./SkillsPage";
import { SettingsPage } from "./SettingsPage";

import { BackendPool } from "./backends";
import type { DesktopHost } from "./host";
import { NodeHelp } from "./NodeHelp";
import { abbreviateHome, middleTruncate } from "./paths";
import { createPrefsStore, type PrefsStore } from "./prefs";
import { useDraftControls, useSessionControls } from "./session-controls";
import { buildSessionTree, projectKey, projectName, type SessionSummary } from "./session-tree";
import { Sidebar, type SettingsSection } from "./Sidebar";
import type { NodeProbe } from "./types";
import { createUpdateService, describeUpdateError, type UpdateNotice } from "./updater";

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
/** 崩溃横幅里 stderr 默认只显示最后几行 */
const CRASH_STDERR_PREVIEW = 5;

export function App({ host }: { host: DesktopHost }) {
  const prefs = useMemo(() => createPrefsStore(globalThis.localStorage), []);
  const pool = useMemo(() => new BackendPool(host), [host]);
  const images = useMemo(() => createAttachmentImageSource(), []);
  const p = prefs.get();
  useEffect(
    () => () => {
      images.dispose();
    },
    [images],
  );

  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** 外壳 plain_workspace 的默认路径（恢复默认用）；生效路径另看 prefs.plainWorkspace */
  const [defaultWorkspace, setDefaultWorkspace] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [prefsVersion, setPrefsVersion] = useState(0);
  /**
   * 回答内文件引用的打开能力（U-09）：按"打开文件用"设置走 opener 或
   * 编辑器。prefsVersion 驱动设置变更后重算；编辑器可用性按需探测。
   */
  const fileLinks: FileLinkHooks = useMemo(() => {
    const opener = () => prefs.get().fileOpener ?? "system";
    const openerLabel = () =>
      opener() === "vscode" ? "VS Code" : opener() === "cursor" ? "Cursor" : "系统默认程序";
    const clipboard = async (text: string) => {
      await navigator.clipboard.writeText(text);
    };
    return {
      opener,
      openerLabel,
      open: async (absolutePath, line) => {
        const kind = opener();
        if (kind === "system") {
          await host.openPath(absolutePath);
          return;
        }
        await host.openInEditor(kind, absolutePath, line);
      },
      copy: (absolutePath) => clipboard(absolutePath),
      reveal: (absolutePath) => host.revealItem(absolutePath),
    };
  }, [host, prefs, prefsVersion]);
  /** 已安装的编辑器（设置页"打开文件用"只列检测到的；失败按都没装） */
  const [editors, setEditors] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: false,
    cursor: false,
  });
  useEffect(() => {
    let alive = true;
    void host
      .detectEditors()
      .then((result) => {
        if (alive) setEditors(result);
      })
      .catch(() => {
        if (alive) setEditors({ vscode: false, cursor: false });
      });
    return () => {
      alive = false;
    };
  }, [host]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  /**
   * 最近一次后台退出（单后台只有一个）：workspace 是启动它的工作区（重启
   * 复用），stderr 是 closed 消息携带的尾部日志；restarting/restartError/
   * sessionErrors 是「重启后台」的进度与按会话的失败明细。
   */
  const [backendExit, setBackendExit] = useState<{
    workspace: string;
    code: number | null;
    stderr: string[];
    restarting?: boolean;
    restartError?: string;
    sessionErrors?: { id: string; message: string }[];
    /** stderr 块默认只显示最后几行，展开看全部 */
    expanded?: boolean;
  } | null>(null);
  const lastFocusRefresh = useRef(0);
  const [conversationVersion, setConversationVersion] = useState(0);
  const [providersVersion, setProvidersVersion] = useState(0);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  const [lockedSession, setLockedSession] = useState<{ id: string; cwd: string } | null>(null);
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
  /**
   * 设置区当前导航项；null = 会话或空状态。设置区盖在会话区之上，会话区保持挂载
   * （inert），返回时还是原来的会话和滚动位置。
   */
  const [page, setPage] = useState<SettingsSection | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  // ── 自动更新（ADR-0050）：提示不打断会话，装前确认运行中的 Turn ──
  const appVersionRef = useRef<string | undefined>(undefined);
  const updateSvc = useMemo(
    () =>
      createUpdateService({
        host,
        prefs,
        currentVersion: () => appVersionRef.current,
      }),
    [host, prefs],
  );
  /** 待提示的新版本；「稍后」只清这个 state，prefs.pendingUpdate 保留到下次启动 */
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  const [updateFlow, setUpdateFlow] = useState<
    | null
    | { stage: "confirm"; running: number }
    | { stage: "working"; text: string }
    | { stage: "error"; message: string }
  >(null);
  // 生效的普通对话工作区 = prefs 覆盖 ?? 外壳默认
  const effectiveWorkspace = p.plainWorkspace ?? defaultWorkspace;
  const workspaceRef = useRef<string | null>(null);
  workspaceRef.current = effectiveWorkspace;
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
    const client = pool.get();
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

  // 启动链：普通对话工作区（外壳创建，prefs.plainWorkspace 可覆盖）→ 常驻后台 → 会话列表。
  // plain_workspace 或 ensure 失败都显示真实错误，「重试」重走这条链。
  const boot = useCallback(async () => {
    let fallback: string;
    try {
      fallback = (await host.invoke("plain_workspace")) as string;
    } catch (error) {
      setStartupError({ message: errMessage(error) });
      return;
    }
    setDefaultWorkspace(fallback);
    // 记进用过的普通对话工作区列表（cwd 命中任意一个的会话都归「对话」区）
    const current = prefs.get();
    const override = current.plainWorkspace;
    const known = current.plainWorkspaces;
    const next = [fallback, ...(override !== undefined ? [override] : [])].filter(
      (path) => !known.some((entry) => projectKey(entry) === projectKey(path)),
    );
    if (next.length > 0) {
      prefs.update({ plainWorkspaces: [...known, ...next] });
      bumpPrefs();
    }
    const result = await connect(override ?? fallback);
    if (!result.ok) {
      setStartupError({ message: result.message });
      return;
    }
    setBackendExit(null);
    await refresh();
  }, [host, connect, refresh, prefs, bumpPrefs]);

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

  // 启动后检查一次更新（之后由 24h 节流控制）；失败只写外壳日志，不出 UI
  const updateBooted = useRef(false);
  useEffect(() => {
    if (phase.kind !== "ready" || updateBooted.current) return;
    updateBooted.current = true;
    void (async () => {
      try {
        appVersionRef.current = await host.appVersion();
      } catch {
        // 版本号取不到不阻塞更新流程（pendingUpdate 的版本过滤跳过）
      }
      const pending = updateSvc.pendingNotice();
      if (pending !== undefined) setUpdateNotice(pending);
      const found = await updateSvc.autoCheck();
      if (found !== undefined) setUpdateNotice(found);
    })();
  }, [phase.kind, host, updateSvc]);

  // 主题：prefs.theme 覆盖系统外观，立即生效；跟随系统则删掉属性回到 media query
  useEffect(() => {
    const theme = p.theme ?? "system";
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [p.theme]);

  // 后台的 providersChanged：刷新会话列表并 bump providersVersion，
  // 状态栏与空状态的模型菜单、打开中的服务商页随之重取数据。
  // 单后台没有跨后台协调（ADR-0051）：写操作由同一个后台串行「变更→重载→通知」。
  useEffect(
    () =>
      pool.onClient((client) => {
        // 新后台出现也刷新一次渲染：「后台日志」页的后台条目才有候选
        setConversationVersion((v) => v + 1);
        return client.onProvidersChanged(() => {
          setProvidersVersion((v) => v + 1);
          void refresh();
        });
      }),
    [pool, refresh],
  );

  // 设置区里按 Esc = 「← 返回」；下拉、对话框自己处理的 Esc 不算
  useEffect(() => {
    if (page === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (settingsRef.current?.querySelector('[role="dialog"]') != null) return;
      setPage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [page]);

  // 主目录只读一次（路径 ~ 缩写）
  useEffect(() => {
    void host.homeDir().then(setHome);
  }, [host]);

  // 后台退出：全部会话标 dead（保留视图与 seq 断点），横幅给「重启后台」
  useEffect(
    () =>
      pool.onExit(({ workspace, code, stderr }) => {
        conversations.backendExited();
        setBackendExit({ workspace, code, stderr });
      }),
    [pool, conversations],
  );

  // 后台恢复且无 dead 会话残留时收起横幅（「重启后台」成功或逐个点开死会话都算）
  useEffect(() => {
    setBackendExit((cur) => {
      if (cur === null || cur.restarting === true) return cur;
      const backendUp = pool.get() !== undefined;
      const deadLeft = [...conversations.opened.values()].some((entry) => entry.dead === true);
      return backendUp && !deadLeft ? null : cur;
    });
  }, [conversationVersion, pool, conversations]);

  // 重启后台；全部 dead 会话按各自 lastSeq 在同一个新后台续接恢复，单会话失败单独列出
  const restartBackend = async () => {
    if (backendExit === null) return;
    setBackendExit((cur) => {
      if (cur === null) return cur;
      const { restarting: _r, restartError: _e, sessionErrors: _s, ...rest } = cur;
      return { ...rest, restarting: true };
    });
    try {
      const { failed } = await conversations.resumeBackend(backendExit.workspace);
      await refresh();
      setBackendExit((cur) => {
        if (cur === null) return cur;
        if (failed.length === 0) return null;
        return { ...cur, restarting: false, sessionErrors: failed };
      });
    } catch (error) {
      setBackendExit((cur) =>
        cur === null ? cur : { ...cur, restarting: false, restartError: errMessage(error) },
      );
    }
  };

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

  const selectSession = async (id: string, workspace: string, force = false) => {
    // 选中立即生效：会话区先显示「正在打开…」，内容到了再渲染（ADR-0051）
    setSelectedId(id);
    setPanel(null);
    setLockedSession(null);
    try {
      await conversations.open(id, workspace, force);
      setSelectedId(conversations.selectedId);
      await refresh();
    } catch (error) {
      if (error instanceof RpcError && error.code === "session_locked") {
        setLockedSession({ id, cwd: workspace });
      }
      // 其他失败：openErrors 已记录，该会话的占位区显示错误与「重试」
    }
  };

  const newSession = async (workspace?: string) => {
    const target = workspace ?? effectiveWorkspace;
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

  // 「普通对话工作区」切换：prefs 记覆盖与新路径 → 刷新列表。
  // 单后台不随工作区切换重启（ADR-0051）；后台没在跑时 ensure 以新工作区为 cwd 启动。
  // 旧位置的会话 cwd 仍在 plainWorkspaces 里，继续归「对话」区。
  const changePlainWorkspace = useCallback(
    async (dir: string | null): Promise<string | undefined> => {
      const target = dir ?? defaultWorkspace;
      if (target === null || defaultWorkspace === null) return "默认工作区尚未就绪";
      try {
        await pool.ensure(target);
      } catch (error) {
        return errMessage(error);
      }
      const current = prefs.get();
      const known = current.plainWorkspaces;
      const remembered = [target, defaultWorkspace].filter(
        (path): path is string => !known.some((entry) => projectKey(entry) === projectKey(path)),
      );
      prefs.update({ plainWorkspace: dir === null ? undefined : target });
      prefs.update({ plainWorkspaces: [...known, ...remembered] });
      bumpPrefs();
      workspaceRef.current = target;
      await refresh();
      return undefined;
    },
    [pool, prefs, bumpPrefs, refresh, defaultWorkspace],
  );

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

  // 重发/编辑重发（U-01）：rewind 走会话串行锁，发送后同步会话列表
  const resubmit = async (targetSeq: number, text: string, mode: RewindMode): Promise<void> => {
    await conversations.resubmit(targetSeq, text, mode);
    setSelectedId(conversations.selectedId);
    await refresh();
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
          plainWorkspace: effectiveWorkspace,
          plainWorkspaces: p.plainWorkspaces,
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
      effectiveWorkspace,
      chatsExpanded,
      expanded,
      collapsed,
      conversationVersion,
    ],
  );

  const pinnedIds = new Set(p.pinned);

  const active = conversations.selected;
  const selected = sessions.find((s) => s.id === selectedId);
  /** 当前选中会话的打开失败（占位区显示错误与「重试」，不退回上一个会话） */
  const selectedOpenError =
    selectedId === null ? undefined : conversations.openErrors.get(selectedId);
  // 会话由忙转闲时刷新一次列表（标题/时间可能更新）；切换本身由
  // selectSession 刷新一次，不在此重复（ADR-0051）
  const runningSessions = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set(
      [...conversations.opened.values()]
        .filter(
          (entry) => entry.dead !== true && (entry.busy || conversationStatus(entry) !== "idle"),
        )
        .map((entry) => entry.session.id),
    );
    const finished = [...runningSessions.current].filter((id) => !now.has(id));
    runningSessions.current = now;
    if (finished.length > 0) void refresh();
  }, [conversationVersion, conversations, refresh]);

  // 服务商 / 设置页走常驻后台（全局配置；项目层查询由各页/控件自带 workspaceRoot）
  const pageClient = pool.get();
  // 打开的会话正在用的服务商：删除按钮预先置灰（真正的拦截仍以服务端 provider_in_use 为准）
  const providersInUse = new Set<string>();
  for (const entry of conversations.opened.values()) {
    const provider = entry.view.config.model?.provider;
    if (provider !== undefined) providersInUse.add(provider);
  }

  const toggleIn = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  // ── 更新安装：有运行中的 Turn 先确认；下载/签名失败把原因留在提示条里 ──
  const doUpdateInstall = async () => {
    setUpdateFlow({ stage: "working", text: "正在下载并安装更新…" });
    try {
      const result = await updateSvc.install((downloaded, total) => {
        const mb = (n: number) => (n / 1048576).toFixed(0);
        setUpdateFlow((cur) =>
          cur?.stage === "working"
            ? {
                stage: "working",
                text: `正在下载并安装更新…已下载 ${mb(downloaded)}${
                  total !== undefined ? ` / ${mb(total)}` : ""
                } MB`,
              }
            : cur,
        );
      });
      if (result === "gone") {
        // 实际已无更新（比如手动装过新版）：清掉提示
        setUpdateFlow(null);
        setUpdateNotice(null);
      }
      // "installed"：随即重启；Windows 上进程在 downloadAndInstall 期间已被安装器退出
    } catch (error) {
      setUpdateFlow({ stage: "error", message: errMessage(error) });
    }
  };

  const beginUpdateInstall = () => {
    const running = activeConversationCount(conversations.opened.values());
    if (running > 0) {
      setUpdateFlow({ stage: "confirm", running });
    } else {
      void doUpdateInstall();
    }
  };

  const updateNoticeSummary =
    updateNotice?.notes
      ?.split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/^#+\s*/, "")
          .replace(/^-+\s*/, ""),
      )
      .find((line) => line !== "")
      ?.slice(0, 80) ?? null;

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

  const plainKey = effectiveWorkspace === null ? null : projectKey(effectiveWorkspace);
  const projects = tree.projects.map((project) => ({
    key: project.key,
    path: project.path,
    name: project.name,
  }));
  // 「后台日志」页的选择器（ADR-0051）：单后台只有「后台」与「外壳」两项
  const currentBackend = pool.current();
  const logTargets: BackendLogTarget[] = [
    ...(currentBackend !== undefined
      ? [
          {
            backendId: currentBackend.backendId,
            label: "后台",
            detail: abbreviateHome(currentBackend.workspace, home),
          },
        ]
      : []),
    {
      backendId: SHELL_LOG_ID,
      label: "外壳",
      detail: "外壳自身诊断（更新检查结果等），不写盘",
    },
  ];

  return (
    <div className={`body${page !== null ? " settings-mode" : ""}`}>
      <Sidebar
        tree={tree}
        pinnedIds={pinnedIds}
        selectedId={selectedId}
        collapsed={collapsed}
        expanded={expanded}
        chatsExpanded={chatsExpanded}
        onSelectSession={(id) => {
          const summary = sessions.find((s) => s.id === id);
          if (summary !== undefined) {
            setPage(null);
            void selectSession(summary.id, summary.cwd);
          }
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
        onNewSession={(workspace) => {
          setPage(null);
          void newSession(workspace);
        }}
        page={page}
        onOpenPage={(target) => {
          setPage(target);
        }}
        onLeaveSettings={() => {
          setPage(null);
        }}
      />
      <div className="main">
        {(backendExit !== null || startupError !== null) && (
          <div className="banner">
            {backendExit !== null && (
              <div className="crash">
                <div className="t">
                  后台已退出（退出码 {backendExit.code ?? "未知"}）
                  <span className="acts">
                    <button
                      className="btn"
                      onClick={() => {
                        setPage("logs");
                      }}
                    >
                      查看日志
                    </button>
                    <button
                      className="btn primary"
                      disabled={backendExit.restarting === true}
                      onClick={() => void restartBackend()}
                    >
                      {backendExit.restarting === true ? "重启中…" : "重启后台"}
                    </button>
                  </span>
                </div>
                {backendExit.stderr.length > 0 && (
                  <>
                    <pre>
                      {(backendExit.expanded === true
                        ? backendExit.stderr
                        : backendExit.stderr.slice(-CRASH_STDERR_PREVIEW)
                      ).join("\n")}
                    </pre>
                    {backendExit.stderr.length > CRASH_STDERR_PREVIEW && (
                      <button
                        className="btn ghost logmore"
                        onClick={() => {
                          setBackendExit((cur) =>
                            cur === null ? cur : { ...cur, expanded: cur.expanded !== true },
                          );
                        }}
                      >
                        {backendExit.expanded === true
                          ? "收起"
                          : `展开全部（${backendExit.stderr.length} 行）`}
                      </button>
                    )}
                  </>
                )}
                {backendExit.restartError !== undefined && (
                  <div className="fail">重启失败：{backendExit.restartError}</div>
                )}
                {backendExit.sessionErrors?.map(({ id, message }) => (
                  <div className="fail" key={id}>
                    会话「
                    {conversations.opened.get(id)?.view.title ??
                      sessions.find((s) => s.id === id)?.firstText ??
                      id}
                    」恢复失败：{message}
                  </div>
                ))}
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
        {page !== null && (
          <div className="settings-over" ref={settingsRef}>
            {page === "providers" ? (
              <PaneErrorBoundary key="providers">
                <ProvidersPage
                  client={pageClient}
                  currentProvider={active?.view.config.model?.provider}
                  currentModel={active?.view.config.model?.model}
                  inUse={providersInUse}
                  openUrl={(url) => void host.openUrl(url)}
                  providersVersion={providersVersion}
                  onOpenModels={() => {
                    setPage("models");
                  }}
                />
              </PaneErrorBoundary>
            ) : page === "mcp" ? (
              <PaneErrorBoundary key="mcp">
                <McpPage
                  client={pageClient}
                  workspaceRoot={effectiveWorkspace ?? undefined}
                  version={providersVersion}
                  onChanged={() => {
                    void refresh();
                  }}
                />
              </PaneErrorBoundary>
            ) : page === "agents" ? (
              <PaneErrorBoundary key="agents">
                <ExternalAgentsPage
                  client={pageClient}
                  workspaceRoot={effectiveWorkspace ?? undefined}
                  version={providersVersion}
                />
              </PaneErrorBoundary>
            ) : page === "skills" ? (
              <PaneErrorBoundary key="skills">
                <SkillsPage
                  client={pageClient}
                  workspaceRoot={effectiveWorkspace ?? undefined}
                  version={providersVersion}
                  openDirectory={(path, create) =>
                    host.invoke("open_skill_directory", {
                      path,
                      create: create ?? false,
                    }) as Promise<void>
                  }
                  openUrl={host.openUrl}
                  pickFolder={() => host.pickFolder()}
                />
              </PaneErrorBoundary>
            ) : page === "logs" ? (
              <PaneErrorBoundary key="logs">
                <BackendLogsPage
                  backends={logTargets}
                  fetchStderr={(backendId) =>
                    backendId === SHELL_LOG_ID
                      ? (host.invoke("shell_log") as Promise<string[]>)
                      : (host.invoke("backend_stderr", { backendId }) as Promise<string[]>)
                  }
                />
              </PaneErrorBoundary>
            ) : (
              <PaneErrorBoundary key="settings">
                <SettingsPage
                  section={page}
                  client={pageClient}
                  theme={p.theme ?? "system"}
                  fileOpener={p.fileOpener ?? "system"}
                  editors={editors}
                  onFileOpenerChange={(opener) => {
                    prefs.update({ fileOpener: opener === "system" ? undefined : opener });
                    bumpPrefs();
                    return prefs.persistent;
                  }}
                  workspace={effectiveWorkspace}
                  defaultWorkspace={defaultWorkspace}
                  workspaceOverridden={p.plainWorkspace !== undefined}
                  update={{
                    autoUpdate: p.autoUpdate !== false,
                    onAutoUpdateChange: (enabled) => {
                      // 默认开：开启时清掉显式值，关闭才写 false
                      prefs.update({ autoUpdate: enabled ? undefined : false });
                      bumpPrefs();
                      return prefs.persistent;
                    },
                    onCheck: async () => {
                      const result = await updateSvc.manualCheck();
                      if (result.kind === "update") setUpdateNotice(result.notice);
                      return result;
                    },
                  }}
                  onThemeChange={(theme) => {
                    prefs.update({ theme: theme === "system" ? undefined : theme });
                    bumpPrefs();
                    return prefs.persistent;
                  }}
                  onWorkspaceChange={changePlainWorkspace}
                  pickFolder={() => host.pickFolder()}
                  providersVersion={providersVersion}
                  onConfigSaved={() => {
                    void refresh();
                  }}
                  onOpenProviders={() => {
                    setPage("providers");
                  }}
                />
              </PaneErrorBoundary>
            )}
          </div>
        )}
        <div
          className="mainpane"
          inert={page !== null}
          aria-hidden={page !== null ? true : undefined}
        >
          {active !== undefined && selectedOpenError === undefined ? (
            <PaneErrorBoundary key={active.session.id}>
              <SessionPane
                view={active.view}
                workspace={active.workspace}
                session={active.session}
                client={active.client}
                prefs={prefs}
                fileLinks={fileLinks}
                images={images}
                plainKey={plainKey}
                home={home}
                selected={selected}
                running={conversationStatus(active) !== "idle"}
                onResubmit={resubmit}
                onSubmit={(input) => submitInput(input)}
                onInterrupt={() => {
                  conversations.interrupt();
                }}
                onSlash={runSlash}
                pickImages={() => host.pickImages()}
                openUrl={(url) => void host.openUrl(url)}
                panel={panel}
                onPanelChange={setPanel}
                providersVersion={providersVersion}
                onManageProviders={() => {
                  setPage("providers");
                }}
              />
            </PaneErrorBoundary>
          ) : selectedId !== null ? (
            // 正在打开 / 打开失败：占位区不退回上一个会话（ADR-0051）
            <div className="center">
              {selectedOpenError === undefined ? (
                <div className="opening" role="status">
                  <span className="spin" aria-hidden="true" />
                  正在打开…
                </div>
              ) : (
                <div className="nodecard">
                  <h3>打开会话失败</h3>
                  <div className="lead">{selectedOpenError.message}</div>
                  <div className="acts">
                    <button
                      className="btn primary"
                      onClick={() => void selectSession(selectedId, selectedOpenError.workspace)}
                    >
                      重试
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <PaneErrorBoundary key="draft">
              <DraftPane
                runtime={pool.get()?.runtime}
                prefs={prefs}
                workspace={conversations.draftWorkspace ?? effectiveWorkspace}
                plainKey={plainKey}
                projects={projects}
                disabled={effectiveWorkspace === null || pool.get() === undefined}
                historyKey={conversations.draftWorkspace ?? effectiveWorkspace}
                providersVersion={providersVersion}
                onSubmit={submitInput}
                onSlash={runSlash}
                pickImages={() => host.pickImages()}
                onSelectPlain={() => void newSession()}
                onSelectProject={(path) => void newSession(path)}
                onOpenOther={() =>
                  void openProject().then((dir) => {
                    if (dir !== undefined) void newSession(dir);
                  })
                }
                dirMenuOpen={dirMenuOpen}
                onDirMenuOpenChange={setDirMenuOpen}
                onManageProviders={() => {
                  setPage("providers");
                }}
              />
            </PaneErrorBoundary>
          )}
        </div>
        {updateNotice !== null && (
          <div className="updbar" role="status" aria-label="发现新版本">
            {updateFlow?.stage === "working" ? (
              <span className="t">{updateFlow.text}</span>
            ) : (
              <>
                <span className="t">发现新版本 v{updateNotice.version}</span>
                {updateNoticeSummary !== null && (
                  <span className="notes">{updateNoticeSummary}</span>
                )}
                {updateFlow?.stage === "error" && (
                  <span className="err">{describeUpdateError(updateFlow.message)}</span>
                )}
                <button className="btn primary" onClick={beginUpdateInstall}>
                  {updateFlow?.stage === "error" ? "重试" : "立即更新"}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    // 「稍后」只对本次运行有效：prefs.pendingUpdate 保留，
                    // 下次启动若仍比当前版本新会继续提示
                    setUpdateNotice(null);
                    setUpdateFlow(null);
                  }}
                >
                  稍后
                </button>
              </>
            )}
          </div>
        )}
        {updateFlow?.stage === "confirm" && (
          <div className="dialog-backdrop">
            <div className="desktop-dialog" role="dialog" aria-modal="true" aria-label="更新确认">
              <h3>更新到 v{updateNotice?.version ?? "新版本"}</h3>
              <p>
                将中断 {updateFlow.running}
                个正在运行的会话。安装更新会关闭窗口与后台进程，完成后自动重启。
              </p>
              <div className="acts">
                <button
                  className="btn"
                  onClick={() => {
                    setUpdateFlow(null);
                  }}
                >
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    void doUpdateInstall();
                  }}
                >
                  继续更新
                </button>
              </div>
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
                  onClick={() => void selectSession(lockedSession.id, lockedSession.cwd, true)}
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
  /** 回答内文件引用的打开能力（U-09）；App 按 host + prefs 组装 */
  fileLinks: FileLinkHooks | undefined;
  images: AttachmentImageSource;
  plainKey: string | null;
  home: string | null;
  selected: SessionSummary | undefined;
  running: boolean;
  onResubmit: (targetSeq: number, text: string, mode: RewindMode) => Promise<void>;
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  onInterrupt: () => void;
  onSlash: (line: string) => Promise<boolean>;
  pickImages: DesktopHost["pickImages"];
  openUrl: (url: string) => void;
  panel: StatusPanel | null;
  onPanelChange: (panel: StatusPanel | null) => void;
  onManageProviders: () => void;
  /** 服务商配置变更计数：状态栏的模型/档位/预设数据随之重取 */
  providersVersion: number;
}

function SessionPane({
  view,
  workspace,
  session,
  client,
  prefs,
  fileLinks,
  images,
  plainKey,
  home,
  selected,
  running,
  onResubmit,
  onSubmit,
  onInterrupt,
  onSlash,
  pickImages,
  openUrl,
  panel,
  onPanelChange,
  providersVersion,
  onManageProviders,
}: SessionPaneProps) {
  const runtime = client.runtime;
  const controls = useSessionControls(session, runtime, view, prefs, providersVersion, workspace);
  const [skills, setSkills] = useState<SkillOverview[]>([]);
  const [externalAgents, setExternalAgents] = useState<ExternalAgentOverview[]>([]);
  useEffect(() => {
    let active = true;
    void session
      .describeExternalAgents()
      .then((result) => {
        if (active) setExternalAgents(result.agents);
      })
      .catch(() => {
        if (active) setExternalAgents([]);
      });
    return () => {
      active = false;
    };
  }, [session, providersVersion, view.turnCount]);
  useEffect(() => {
    let active = true;
    void session
      .describeSkills()
      .then((result) => {
        if (active) setSkills(result.skills);
      })
      .catch(() => {
        if (active) setSkills([]);
      });
    return () => {
      active = false;
    };
  }, [session, providersVersion, view.turnCount]);
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
          <em title={view.title ?? selected?.firstText ?? "新会话"}>
            {view.title ?? selected?.firstText ?? "新会话"}
          </em>
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
        busy={running}
        onResubmit={onResubmit}
        fileLinks={fileLinks}
      />
      <Composer
        key={`composer:${session.id}`}
        skills={skills}
        externalAgents={externalAgents}
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
        onManageProviders={onManageProviders}
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
  /** 服务商配置变更计数：空状态模型菜单随之重取 */
  providersVersion: number;
  /** 模型菜单底部「管理服务商…」 */
  onManageProviders: () => void;
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
  providersVersion,
  onManageProviders,
}: DraftPaneProps) {
  const draft = useDraftControls(runtime, prefs, providersVersion, workspace);
  const [skills, setSkills] = useState<SkillOverview[]>([]);
  const [externalAgents, setExternalAgents] = useState<ExternalAgentOverview[]>([]);
  useEffect(() => {
    if (!runtime) return;
    let active = true;
    void runtime
      .describeExternalAgents({ workspaceRoot: workspace ?? undefined })
      .then((result) => {
        if (active) setExternalAgents(result.agents);
      })
      .catch(() => {
        if (active) setExternalAgents([]);
      });
    return () => {
      active = false;
    };
  }, [runtime, workspace, providersVersion]);
  useEffect(() => {
    if (!runtime) return;
    let active = true;
    void runtime
      .describeSkills({ workspaceRoot: workspace ?? undefined })
      .then((result) => {
        if (active) setSkills(result.skills);
      })
      .catch(() => {
        if (active) setSkills([]);
      });
    return () => {
      active = false;
    };
  }, [runtime, workspace, providersVersion]);
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
          skills={skills}
          externalAgents={externalAgents}
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
          onManageProviders={onManageProviders}
        />
      </div>
    </div>
  );
}
