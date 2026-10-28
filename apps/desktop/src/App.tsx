import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcError, type RpcClient, type RpcRuntime, type RpcSession } from "@nocturne/rpc/client";
import type {
  ExternalAgentOverview,
  ModelRef,
  RewindMode,
  RuntimeEvent,
  SessionView,
  SkillOverview,
  TurnChanges,
  TurnChangeDiff,
} from "@nocturne/core/protocol";

import { createAttachmentImageSource, type AttachmentImageSource } from "./attachment-images";
import {
  BackendLogsPage,
  KEY_DIAG_ID,
  SHELL_LOG_ID,
  type BackendLogTarget,
} from "./BackendLogsPage";
import { Composer, type ComposerSubmit, type WorkspaceChoice } from "./Composer";
import {
  Conversation,
  QuestionCard,
  type ConversationProps,
  type FileLinkHooks,
  type SubagentLinks,
} from "./Conversation";
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
import { GrantsPage } from "./GrantsPage";
import { desktopWarningText } from "./open-warnings";
import { ModelRecoveryCard } from "./ModelRecoveryCard";
import { ExternalAgentsPage } from "./ExternalAgentsPage";
import { SkillsPage } from "./SkillsPage";
import { SettingsPage } from "./SettingsPage";
import { RemotePage } from "./RemotePage";
import { useRemoteStatus } from "./remote";
import type { RemoteStatus } from "@nocturne/rpc/client";
import { UsagePage } from "./UsagePage";
import { SchedulePage, type ScheduleWorkspaceOption } from "./SchedulePage";
import { catchupPreface } from "./schedule-format";

import { BackendPool } from "./backends";
import type { DesktopHost } from "./host";
import { NodeHelp } from "./NodeHelp";
import {
  decideNotification,
  NOTIFY_DEFAULTS,
  notifyPrefsFrom,
  sessionMarkFor,
  pushRemoteNotification,
} from "./notify";
import { abbreviateHome, middleTruncate } from "./paths";
import { useSidePanel, type SidePanelController } from "./PanelHost";
import {
  createPrefsStore,
  FILE_OPENER_LABELS,
  migrateLegacyProjectOrder,
  outsideOpenable,
  type PrefsStore,
} from "./prefs";
import { useDraftControls, useSessionControls } from "./session-controls";
import {
  buildSessionTree,
  moveProjectKey,
  projectKey,
  projectName,
  type SessionMark,
  type SessionSummary,
  type SessionTree,
} from "./session-tree";
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
  const workspaceRef = useRef<string | null>(null);
  const pool = useMemo(() => new BackendPool(host, () => workspaceRef.current), [host]);
  const remoteStatus = useRemoteStatus(pool.get());
  const remoteRef = useRef(remoteStatus);
  remoteRef.current = remoteStatus;
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
  /** 已成功拿到过会话列表：项目顺序的迁移与新键写回都要等它 */
  const [listed, setListed] = useState(false);
  /** 最近一次渲染的会话树（「打开项目」判断项目是否已可见） */
  const treeRef = useRef<SessionTree | null>(null);
  /** 外壳 plain_workspace 的默认路径（恢复默认用）；生效路径另看 prefs.plainWorkspace */
  const [defaultWorkspace, setDefaultWorkspace] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [prefsVersion, setPrefsVersion] = useState(0);
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
  /**
   * 回答内文件引用的打开能力（U-09）：左键按"打开文件用"设置打开，右键菜单
   * 列出资源管理器与检测到的编辑器。prefsVersion 驱动设置变更后重算。
   */
  const panelRef = useRef<SidePanelController | null>(null);
  const fileLinks: FileLinkHooks = useMemo(() => {
    // 缺省 Nocturne 面板（ADR-0060）；面板之外的选择照旧
    const opener = () => prefs.get().fileOpener ?? "panel";
    return {
      openerLabel: () => FILE_OPENER_LABELS[opener()],
      open: async (absolutePath, line, ref) => {
        const kind = opener();
        if (kind === "panel") {
          panelRef.current?.openFile(absolutePath, line, ref);
          return;
        }
        // 选中的编辑器没装（或探测失败）时退回系统默认程序
        if (kind === "system" || !editors[kind]) {
          await host.openPath(absolutePath);
          return;
        }
        await host.openInEditor(kind, absolutePath, line);
      },
      outsideOpenable: () => outsideOpenable(opener(), editors),
      editors: () => editors,
      openInEditor: (editor, absolutePath, line) => host.openInEditor(editor, absolutePath, line),
      // 目录交给系统（资源管理器打开）；open_with_default 对目录不拦截
      openFolder: (absolutePath) => host.openPath(absolutePath),
      copy: async (text) => {
        await navigator.clipboard.writeText(text);
      },
      reveal: (absolutePath) => host.revealItem(absolutePath),
      // 工作区内的 HTML 左键进面板浏览器；「查看源码」照旧进文件标签
      previewsHtml: (absolutePath) =>
        opener() === "panel" && panelRef.current?.previewsHtml(absolutePath) === true,
      viewSource: async (absolutePath, line) => {
        panelRef.current?.viewSource(absolutePath, line);
        return Promise.resolve();
      },
    };
  }, [host, prefs, prefsVersion, editors]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  /**
   * 最近一次后台退出（单后台只有一个）：workspace 是启动它的工作区（诊断
   * 用），stderr 是 closed 消息携带的尾部日志；restarting/restartError/
   * sessionErrors 是「重启后台」的进度与按会话的失败明细。
   */
  const [backendExit, setBackendExit] = useState<{
    workspace: string;
    code: number | null;
    stderr: string[];
    restarting?: boolean;
    restartError?: string;
    sessionErrors?: { id: string; message: string; code?: string }[];
    /** stderr 块默认只显示最后几行，展开看全部 */
    expanded?: boolean;
  } | null>(null);
  const lastFocusRefresh = useRef(0);
  const [conversationVersion, setConversationVersion] = useState(0);
  const [providersVersion, setProvidersVersion] = useState(0);
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  /** 会话被别处占用；model 是这次打开携带的替代模型，「强制打开」时一并带上 */
  const [lockedSession, setLockedSession] = useState<{
    id: string;
    cwd: string;
    model?: ModelRef;
  } | null>(null);
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
  /**
   * 设置区当前导航项；null = 会话或空状态。设置区盖在会话区之上，会话区保持挂载
   * （inert），返回时还是原来的会话和滚动位置。
   */
  const [page, setPage] = useState<SettingsSection | null>(null);
  /** 定时任务页盖在会话区上，左栏会话树保持显示（不同于设置区） */
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [scheduledExpanded, setScheduledExpanded] = useState(false);
  const [enabledScheduleCount, setEnabledScheduleCount] = useState<number | undefined>();
  const [scheduleNames, setScheduleNames] = useState<ReadonlyMap<string, string>>(() => new Map());
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
  workspaceRef.current = effectiveWorkspace;
  // ── 通知（ADR-0056）：判定规则在 src/notify.ts，这里只备实时输入与外壳调用 ──
  /**
   * 判定用的实时输入：事件回调里读（闭包快照会过期）。focused 与 selectedId
   * 是「在看」的两个条件，prefs 是 settings.json 的生效值，turnStarts 记
   * 每个会话当前 Turn 的开始时间（事件只有完成时刻，用时靠它相减）。
   */
  const notifyState = useRef({
    focused: true,
    selectedId: null as string | null,
    /** 设置区当前导航；非 null 时会话区被盖住，不算「在看」任何会话 */
    page: null as SettingsSection | null,
    schedulesOpen: false,
    prefs: NOTIFY_DEFAULTS,
    /** 会话标题来源（treeSessions：会话标题 ?? 首条用户消息首行） */
    sessions: [] as SessionSummary[],
    turnStarts: new Map<string, number>(),
  });
  notifyState.current.selectedId = selectedId;
  notifyState.current.page = page;
  notifyState.current.schedulesOpen = schedulesOpen;
  /** 侧栏留痕：本次运行里「没看到」的出错 / 已完成，打开会话即清除（不持久化） */
  const [sessionMarks, setSessionMarks] = useState<Record<string, SessionMark>>({});

  /** 用户已经看到这个会话：撤掉它的系统通知，并清掉侧栏留痕 */
  const markSeen = useCallback(
    (id: string | null) => {
      if (id === null) return;
      void host.dismissNotification(id);
      setSessionMarks((cur) => {
        if (!(id in cur)) return cur;
        const { [id]: _seen, ...rest } = cur;
        return rest;
      });
    },
    [host],
  );

  // Conversations 只建一次：事件回调经 ref 读最新实现，避免闭包停在首帧
  const onSessionEventRef = useRef<(sessionId: string, event: RuntimeEvent, live: boolean) => void>(
    () => undefined,
  );
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
        (sessionId, event, live) => {
          onSessionEventRef.current(sessionId, event, live);
        },
      ),
    [pool],
  );
  /**
   * 会话事件 → 通知判定：只对本次运行实时到达的事件（live）判，重放与恢复不算；
   * 在看（窗口有焦点且正显示该会话）时不提醒。留痕另算，与通知开关无关。
   * 标题与侧栏一致：已打开会话的生成标题优先，否则首条用户消息首行，
   * 再没有回退 Nocturne（notify.ts sessionTitle）。
   */
  const onSessionEvent = useCallback(
    (sessionId: string, event: RuntimeEvent, live: boolean) => {
      const state = notifyState.current;
      if (event.type === "turn.started") {
        const started = Date.parse(event.time);
        if (!Number.isNaN(started)) state.turnStarts.set(sessionId, started);
        // 新 Turn 开始：旧的出错 / 已完成留痕已过时，直接清掉（跑起来后也不再显示旧标签）
        if (live) {
          setSessionMarks((cur) => {
            if (!(sessionId in cur)) return cur;
            const { [sessionId]: _stale, ...rest } = cur;
            return rest;
          });
        }
        return;
      }
      // 在看 = 窗口有焦点 + 正显示该会话 + 没被设置区盖住（page === null）
      const watching =
        state.focused &&
        state.page === null &&
        !state.schedulesOpen &&
        state.selectedId === sessionId;
      if (live && !watching) {
        const mark = sessionMarkFor(event);
        if (mark !== null) {
          setSessionMarks((cur) => (cur[sessionId] === mark ? cur : { ...cur, [sessionId]: mark }));
        }
      }
      const summary = state.sessions.find((s) => s.id === sessionId);
      const decision = decideNotification({
        event,
        prefs: state.prefs,
        live,
        watching,
        session: {
          title: conversations.opened.get(sessionId)?.view.title,
          firstText: summary?.firstText,
        },
        turnStartedAt: state.turnStarts.get(sessionId),
      });
      if (decision === null) return;
      void host.notify({
        sessionId,
        title: decision.title,
        body: decision.body,
        sound: state.prefs.sound,
      });
      void host.requestAttention();
      void pushRemoteNotification(pool.get(), remoteRef.current, host.note);
    },
    [host, conversations, pool],
  );
  onSessionEventRef.current = onSessionEvent;

  const bumpPrefs = useCallback(() => {
    setPrefsVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async (): Promise<SessionSummary[]> => {
    const client = pool.get();
    if (client === undefined) return [];
    try {
      const list = await client.runtime.listSessions();
      setSessions(list);
      setListed(true);
      setStartupError(null);
      return list;
    } catch (error) {
      setStartupError({ message: errMessage(error) });
      return [];
    }
  }, [pool]);

  const connect = useCallback(async (): Promise<ConnectResult> => {
    try {
      await pool.ensure();
      return { ok: true };
    } catch (error) {
      // DesktopError/RpcError/Error 的 message 直接给用户看
      // （如 backend_script_missing 提示先 pnpm build、protocol_version_mismatch、invalid_workspace）
      return { ok: false, message: errMessage(error) };
    }
  }, [pool]);

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
    workspaceRef.current = override ?? fallback;
    const result = await connect();
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
        const stopProviders = client.onProvidersChanged(() => {
          setProvidersVersion((v) => v + 1);
          void refresh();
        });
        let alive = true;
        const loadSchedules = () => {
          void client.runtime
            .listSchedules()
            .then((result) => {
              if (!alive) return;
              setEnabledScheduleCount(result.tasks.filter((task) => task.enabled).length);
              setScheduleNames(new Map(result.tasks.map((task) => [task.id, task.name])));
            })
            .catch(() => undefined);
        };
        loadSchedules();
        const stopSchedules = client.onNotification("schedule.changed", () => {
          loadSchedules();
          void refresh();
        });
        return () => {
          alive = false;
          stopProviders();
          stopSchedules();
        };
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
      const { failed } = await conversations.resumeBackend();
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

  // 「打开项目」只更新 prefs 并刷新列表，不启动后台（项目后台在打开会话时才启动）。
  // 不在列表里或已隐藏的项目移到 projectOrder 最前面；已经可见的不移动。
  const openProject = useCallback(async () => {
    const dir = await host.pickFolder();
    if (dir === null) return;
    const key = projectKey(dir);
    const current = prefs.get();
    const visible = treeRef.current?.projects.some((project) => project.key === key) === true;
    const order = current.projectOrder;
    prefs.update({
      projects: current.projects.includes(dir) ? current.projects : [...current.projects, dir],
      hidden: current.hidden.filter((k) => projectKey(k) !== key),
      ...(!visible && order !== undefined
        ? { projectOrder: [key, ...order.filter((k) => k !== key)] }
        : {}),
    });
    bumpPrefs();
    await refresh();
    return dir;
  }, [host, prefs, refresh, bumpPrefs]);

  const selectSession = async (id: string, workspace: string, force = false, model?: ModelRef) => {
    // 选中立即生效：会话区先显示「正在打开…」，内容到了再渲染（ADR-0051）
    setSelectedId(id);
    setPanel(null);
    setLockedSession(null);
    // 用户看到这个会话了：撤掉它的系统通知与侧栏留痕（ADR-0056）
    markSeen(id);
    try {
      await conversations.open(id, workspace, force, model);
      setSelectedId(conversations.selectedId);
      await refresh();
    } catch (error) {
      if (error instanceof RpcError && error.code === "session_locked") {
        setLockedSession({ id, cwd: workspace, ...(model !== undefined ? { model } : {}) });
      }
      // 其他失败：openErrors 已按错误码记录，占位区显示「换模型」卡片或错误与「重试」
    }
  };
  // 通知被点击时要切到那个会话：经 ref 读最新的列表与选择函数（监听只注册一次）
  const sessionsRef = useRef<SessionSummary[]>(sessions);
  sessionsRef.current = sessions;
  const selectSessionRef = useRef<typeof selectSession | null>(null);
  selectSessionRef.current = selectSession;

  // 外壳在通知被点击（toast 激活）时调用：把窗口带到前台后切到对应会话
  useEffect(
    () =>
      host.onNotificationActivated((sessionId) => {
        const summary = sessionsRef.current.find((s) => s.id === sessionId);
        if (summary === undefined) return;
        setPage(null);
        void selectSessionRef.current?.(summary.id, summary.cwd);
      }),
    [host],
  );

  // 窗口焦点是「在看」的一半（ADR-0056）：失焦才提醒；重新获得焦点时把当前
  // 会话的通知与留痕一并清掉（重新获得焦点前的事件都已经提醒过了）
  useEffect(() => {
    notifyState.current.focused = document.hasFocus();
    const onFocus = () => {
      notifyState.current.focused = true;
      if (notifyState.current.page === null) markSeen(notifyState.current.selectedId);
    };
    const onBlur = () => {
      notifyState.current.focused = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [markSeen]);

  useEffect(() => {
    if (page === null && notifyState.current.focused) markSeen(selectedId);
  }, [page, selectedId, markSeen]);

  /**
   * 通知设置的生效值：连上后台后取一次，设置页保存后再取（保存经 onConfigSaved）。
   * 读不到就按 Core 缺省（全开、阈值 60 秒）——宁可多提醒也不要静默不提醒。
   */
  const refreshNotifyPrefs = useCallback(async () => {
    const client = pool.get();
    if (client === undefined) return;
    try {
      notifyState.current.prefs = notifyPrefsFrom(await client.runtime.describeSettings());
    } catch {
      notifyState.current.prefs = NOTIFY_DEFAULTS;
    }
  }, [pool]);
  useEffect(() => {
    void refreshNotifyPrefs();
  }, [refreshNotifyPrefs, listed]);

  /**
   * ADR-0054 §4：重新启用被停用的服务商或模型，然后回到会话（已打开的会话
   * 直接回到对话；未打开的仍留在卡片里由用户选模型）。
   * 双重停用（disabled === "model" + providerDisabled）时同时恢复两者，
   * 点一次即可用；单重停用只写对应的一项（读 Core 错误字段，不另判停用）。
   */
  const reenableModel = async (
    id: string,
    info: {
      disabled?: "provider" | "model" | undefined;
      disabledModel?: ModelRef | undefined;
      providerDisabled?: boolean | undefined;
    },
  ) => {
    const client = pool.get();
    if (client === undefined || info.disabledModel === undefined) return;
    const ref = info.disabledModel;
    try {
      if (info.disabled === "model") {
        await client.provider.setModelsEnabled(ref.provider, [ref.model], true);
        if (info.providerDisabled === true) {
          await client.provider.setProviderEnabled(ref.provider, true);
        }
      } else {
        await client.provider.setProviderEnabled(ref.provider, true);
      }
      conversations.acknowledgeReenabled(id);
      await refresh();
    } catch (error) {
      setStartupError({ message: errMessage(error) });
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
      const current = prefs.get();
      const known = current.plainWorkspaces;
      const remembered = [target, defaultWorkspace].filter(
        (path): path is string => !known.some((entry) => projectKey(entry) === projectKey(path)),
      );
      prefs.update({ plainWorkspace: dir === null ? undefined : target });
      prefs.update({ plainWorkspaces: [...known, ...remembered] });
      bumpPrefs();
      workspaceRef.current = target;
      try {
        await pool.ensure();
      } catch (error) {
        return errMessage(error);
      }
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
                `${server.name}  ${server.state}${server.error === undefined ? "" : `：${server.error}`}`,
            )
            .join("\n"),
    );
    return true;
  };

  const treeSessions = useMemo(
    () =>
      sessions.map((summary) => {
        const entry = conversations.opened.get(summary.id);
        return entry === undefined
          ? summary
          : { ...summary, locked: false, firstText: entry.view.title ?? summary.firstText };
      }),
    [sessions, conversationVersion],
  );
  const tree = useMemo(
    () =>
      buildSessionTree(treeSessions, p, {
        plainWorkspace: effectiveWorkspace,
        plainWorkspaces: p.plainWorkspaces,
        chatsExpanded,
        scheduledExpanded,
        expanded,
        collapsed,
        statuses: Object.fromEntries(
          [...conversations.opened].map(([id, entry]) => [id, conversationStatus(entry)]),
        ),
        marks: sessionMarks,
      }),
    // prefs 快照经 prefsVersion 驱动重算
    [
      treeSessions,
      prefsVersion,
      effectiveWorkspace,
      chatsExpanded,
      scheduledExpanded,
      expanded,
      collapsed,
      conversationVersion,
      sessionMarks,
    ],
  );
  treeRef.current = tree;
  notifyState.current.sessions = treeSessions;
  const scheduleWorkspaces: ScheduleWorkspaceOption[] = [
    { path: null, label: "普通对话" },
    ...tree.projects.map((project) => ({ path: project.path, label: project.name })),
  ];

  // 项目手动顺序：拿到会话列表后，旧数据（无 projectOrder）按升级前「最近活动」的显示顺序
  // 初始化一次（隐藏项目也排进去，恢复时回原位）；之后每次列表变化把新出现的项目键按显示
  // 顺序插到最前面并保存，此后它们固定在原位
  useEffect(() => {
    if (!listed) return;
    const current = prefs.get();
    if (current.projectOrder === undefined) {
      const legacy = buildSessionTree(
        treeSessions,
        { ...current, hidden: [], projectSort: "activity" },
        {
          plainWorkspace: effectiveWorkspace,
          plainWorkspaces: current.plainWorkspaces,
          expanded: new Set(),
          collapsed: new Set(),
        },
      );
      const patch = migrateLegacyProjectOrder(
        current,
        legacy.projects.map((project) => project.key),
      );
      if (patch !== null) {
        prefs.update(patch);
        bumpPrefs();
      }
      return;
    }
    if (tree.newProjectKeys.length > 0) {
      prefs.update({ projectOrder: [...tree.newProjectKeys, ...current.projectOrder] });
      bumpPrefs();
    }
  }, [listed, tree, treeSessions, effectiveWorkspace, prefs, bumpPrefs]);

  const pinnedIds = new Set(p.pinned);

  const active = conversations.selected;
  const selected = sessions.find((s) => s.id === selectedId);
  /** 当前选中会话的打开失败（占位区显示错误与「重试」，不退回上一个会话） */
  const selectedOpenError =
    selectedId === null ? undefined : conversations.openErrors.get(selectedId);
  const sidePanel = useSidePanel({
    prefs,
    host,
    // 面板跟着会话走：首页和新建会话页没有面板（ADR-0060 修订 2026-10-18（二））
    sessionId: selectedId,
    active:
      active === undefined || active.dead === true || active.session.id !== selectedId
        ? undefined
        : active,
    sessionCwd: selected?.cwd,
    sessions: listed ? sessions : undefined,
    openIds: new Set(conversations.opened.keys()),
    loadDiff: (entry, seq, path) => conversations.turnChangeDiff(entry, seq, path),
    editors,
    settingsOpen: page !== null,
    plainKey: effectiveWorkspace === null ? null : projectKey(effectiveWorkspace),
    client: pool.get(),
    ensureClient: () => pool.ensure(),
    images,
  });
  panelRef.current = sidePanel;
  // 有活着的 agent 标签的会话不随空闲关闭；标签都关了再按原规则关
  const agentSessions = sidePanel.agentSessions;
  useEffect(() => {
    conversations.setAgentSessions(agentSessions);
  }, [conversations, agentSessions]);
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
  // 「后台日志」页的选择器（ADR-0051）：单后台与两个独立的外壳内存缓冲
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
      detail: "更新检查等",
    },
    {
      backendId: KEY_DIAG_ID,
      label: "按键诊断",
      detail: "焦点、输入法状态与快捷键去向（仅内存）",
    },
  ];

  return (
    <div
      className={`body${page !== null ? " settings-mode" : ""}${sidePanel.bodyClass}`}
      ref={sidePanel.bodyRef}
    >
      <Sidebar
        tree={tree}
        pinnedIds={pinnedIds}
        selectedId={selectedId}
        collapsed={collapsed}
        expanded={expanded}
        chatsExpanded={chatsExpanded}
        scheduledExpanded={scheduledExpanded}
        enabledScheduleCount={enabledScheduleCount}
        schedulesOpen={schedulesOpen}
        onOpenSchedules={() => {
          setPage(null);
          setSchedulesOpen(true);
        }}
        onToggleScheduled={() => {
          setScheduledExpanded((open) => !open);
        }}
        onSelectSession={(id) => {
          const summary = sessions.find((s) => s.id === id);
          if (summary !== undefined) {
            setPage(null);
            setSchedulesOpen(false);
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
        onMoveProject={(key, toIndex) => {
          const cur = prefs.get();
          const visible = tree.projects.map((project) => project.key);
          prefs.update({
            projectOrder: moveProjectKey(cur.projectOrder ?? [], visible, key, toIndex),
          });
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
        onRename={async (id, title) => {
          const client = pool.get();
          if (!client) throw new Error("后台尚未连接");
          await client.runtime.renameSession(id, title);
          await refresh();
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
          setSchedulesOpen(false);
          void newSession(workspace);
        }}
        page={page}
        onOpenPage={(target) => {
          setSchedulesOpen(false);
          setPage(target);
        }}
        onLeaveSettings={() => {
          setPage(null);
        }}
      />
      <div className={`main${sidePanel.mainClass}`}>
        {sidePanel.mainOverlays}
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
                {backendExit.sessionErrors?.map(({ id, message, code }) => (
                  <div className="fail" key={id}>
                    会话「
                    {conversations.opened.get(id)?.view.title ??
                      sessions.find((s) => s.id === id)?.firstText ??
                      id}
                    」
                    {code === "invalid_model"
                      ? "用的模型已不可用，点开它选一个模型继续"
                      : `恢复失败：${message}`}
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
        {schedulesOpen && page === null && (
          <div className="settings-over">
            <PaneErrorBoundary key="schedules">
              <SchedulePage
                api={pageClient?.runtime}
                workspaces={scheduleWorkspaces}
                onOpenSession={async (sessionId) => {
                  const summary =
                    sessions.find((item) => item.id === sessionId) ??
                    (await refresh()).find((item) => item.id === sessionId);
                  if (summary === undefined) return false;
                  setSchedulesOpen(false);
                  await selectSession(summary.id, summary.cwd);
                  return true;
                }}
                onChanged={() => {
                  void refresh();
                }}
              />
            </PaneErrorBoundary>
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
                />
              </PaneErrorBoundary>
            ) : page === "mcp" ? (
              <PaneErrorBoundary key="mcp">
                <McpPage
                  client={pageClient}
                  workspaceRoot={effectiveWorkspace ?? undefined}
                  version={providersVersion}
                  agentBrowser={host.agentBrowser}
                  prefs={prefs}
                  onChanged={() => {
                    void refresh();
                  }}
                />
              </PaneErrorBoundary>
            ) : page === "grants" ? (
              <PaneErrorBoundary key="grants">
                <GrantsPage client={pageClient} plainWorkspace={effectiveWorkspace ?? undefined} />
              </PaneErrorBoundary>
            ) : page === "agents" ? (
              <PaneErrorBoundary key="agents">
                <ExternalAgentsPage
                  client={pageClient}
                  workspaceRoot={effectiveWorkspace ?? undefined}
                  version={providersVersion}
                />
              </PaneErrorBoundary>
            ) : page === "remote" ? (
              <PaneErrorBoundary key="remote">
                <RemotePage client={pageClient} />
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
            ) : page === "usage" ? (
              <PaneErrorBoundary key="usage">
                <UsagePage client={pageClient} />
              </PaneErrorBoundary>
            ) : page === "logs" ? (
              <PaneErrorBoundary key="logs">
                <BackendLogsPage
                  backends={logTargets}
                  fetchStderr={(backendId) =>
                    backendId === KEY_DIAG_ID
                      ? (host.invoke("key_diag_log") as Promise<string[]>)
                      : backendId === SHELL_LOG_ID
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
                  fileOpener={p.fileOpener ?? "panel"}
                  editors={editors}
                  onFileOpenerChange={(opener) => {
                    prefs.update({ fileOpener: opener === "panel" ? undefined : opener });
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
                    // 通知开关就写在这份设置里：保存后立刻按新值判定（ADR-0056）
                    void refreshNotifyPrefs();
                  }}
                  onOpenProviders={() => {
                    setPage("providers");
                  }}
                  onOpenSubagents={() => {
                    setPage("agents");
                  }}
                  notifications={{
                    sendTest: (sound) =>
                      host.notify({
                        sessionId: "test",
                        title: "Nocturne",
                        body: "这是一条测试通知",
                        sound,
                      }),
                  }}
                />
              </PaneErrorBoundary>
            )}
          </div>
        )}
        <div
          className="mainpane"
          inert={page !== null || schedulesOpen}
          aria-hidden={page !== null || schedulesOpen ? true : undefined}
        >
          {active !== undefined && selectedOpenError === undefined ? (
            <PaneErrorBoundary key={active.session.id}>
              <SessionPane
                view={active.view}
                openWarnings={active.warnings}
                replaying={active.replaying === true}
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
                turnChanges={active.turnChanges}
                onRewindFiles={(seq) => conversations.rewindFiles(seq)}
                loadChangeDiff={(seq, path) => conversations.turnChangeDiff(active, seq, path)}
                onViewChanges={sidePanel.viewChanges}
                subagentLinks={sidePanel.subagentLinks}
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
                scheduleSource={scheduleSourceFor(sessions, scheduleNames, active.session.id)}
                onManageProviders={() => {
                  setPage("providers");
                }}
                onManageGrants={() => {
                  setPage("grants");
                }}
                onManageMcp={() => {
                  setPage("mcp");
                }}
                remoteStatus={remoteStatus}
                onManageRemote={() => {
                  setPage("remote");
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
              ) : selectedOpenError.code === "invalid_model" ? (
                <ModelRecoveryCard
                  key={selectedId}
                  runtime={pool.get()?.runtime}
                  workspace={selectedOpenError.workspace}
                  error={selectedOpenError.message}
                  attempted={selectedOpenError.model}
                  disabled={selectedOpenError.disabled}
                  disabledModel={selectedOpenError.disabledModel}
                  providersVersion={providersVersion}
                  onContinue={(model) =>
                    void selectSession(selectedId, selectedOpenError.workspace, false, model)
                  }
                  onOpenProviders={() => {
                    setPage("providers");
                  }}
                  onReenable={
                    selectedOpenError.disabled === undefined
                      ? undefined
                      : () => {
                          void reenableModel(selectedId, selectedOpenError);
                        }
                  }
                />
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
                  onClick={() =>
                    void selectSession(
                      lockedSession.id,
                      lockedSession.cwd,
                      true,
                      lockedSession.model,
                    )
                  }
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
      {sidePanel.panel}
    </div>
  );
}

// ── 会话界面：消息流 + 输入框 + 状态栏 ──

interface SessionPaneProps {
  view: SessionView;
  /** 会话打开时的警告，显示在对话页顶部 */
  openWarnings: readonly string[];
  replaying: boolean;
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
  turnChanges: ReadonlyMap<number, TurnChanges>;
  onRewindFiles: (seq: number) => Promise<void>;
  loadChangeDiff: (seq: number, path: string) => Promise<TurnChangeDiff>;
  /** 改动卡片「查看变更」→ 右侧面板（ADR-0060） */
  onViewChanges: (seq: number) => void;
  /** task 行的「在面板中查看」（右侧面板打开子代理标签）；没连着后台时没有 */
  subagentLinks: SubagentLinks | undefined;
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  onInterrupt: () => void;
  onSlash: (line: string) => Promise<boolean>;
  pickImages: DesktopHost["pickImages"];
  openUrl: (url: string) => void;
  panel: StatusPanel | null;
  onPanelChange: (panel: StatusPanel | null) => void;
  onManageProviders: () => void;
  /** 状态栏「MCP 未连接」标记：进入设置 › MCP */
  onManageMcp: () => void;
  onManageGrants: () => void;
  remoteStatus: RemoteStatus | undefined;
  onManageRemote: () => void;
  /** 服务商配置变更计数：状态栏的模型/档位/预设数据随之重取 */
  providersVersion: number;
  scheduleSource?: ConversationProps["scheduleSource"];
}

function scheduleSourceFor(
  sessions: readonly SessionSummary[],
  names: ReadonlyMap<string, string>,
  sessionId: string,
): ConversationProps["scheduleSource"] {
  const summary = sessions.find((item) => item.id === sessionId);
  const source = summary?.schedule;
  if (source === undefined) return undefined;
  const titled = summary?.firstText?.split(" · ")[0];
  return {
    name: names.get(source.taskId) ?? (titled !== undefined && titled !== "" ? titled : "定时任务"),
    trigger: source.trigger,
    preface: source.trigger === "catchup" ? catchupPreface(source.scheduledAt) : undefined,
  };
}

function SessionPane({
  view,
  openWarnings,
  replaying,
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
  turnChanges,
  onRewindFiles,
  loadChangeDiff,
  onViewChanges,
  subagentLinks,
  onSubmit,
  onInterrupt,
  onSlash,
  pickImages,
  openUrl,
  panel,
  onPanelChange,
  providersVersion,
  onManageProviders,
  onManageMcp,
  onManageGrants,
  remoteStatus,
  onManageRemote,
  scheduleSource,
}: SessionPaneProps) {
  const runtime = client.runtime;
  const controls = useSessionControls(
    session,
    runtime,
    view,
    prefs,
    providersVersion,
    workspace,
    replaying,
  );
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
        openWarnings={openWarnings.map(desktopWarningText)}
        openUrl={openUrl}
        cwd={workspace}
        shellKind={controls.shell?.effective?.kind}
        subscribeEvents={subscribeEvents}
        images={images}
        busy={running}
        scheduleSource={scheduleSource}
        onResubmit={onResubmit}
        turnChanges={turnChanges}
        onRewindFiles={onRewindFiles}
        loadChangeDiff={loadChangeDiff}
        onViewChanges={onViewChanges}
        subagentLinks={subagentLinks}
        fileLinks={fileLinks}
      />
      {view.pendingQuestion ? (
        <div className="question-dock">
          <QuestionCard
            key={view.pendingQuestion.requestId}
            pending={view.pendingQuestion}
            session={session}
          />
        </div>
      ) : null}
      <Composer
        key={`composer:${session.id}`}
        hidden={view.pendingQuestion !== undefined}
        skills={skills}
        externalAgents={externalAgents}
        variant="session"
        todos={view.todos}
        prefs={prefs}
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
        replaying={replaying}
        controls={controls}
        panel={panel}
        onPanelChange={onPanelChange}
        home={home}
        onManageProviders={onManageProviders}
        onManageMcp={onManageMcp}
        onManageGrants={onManageGrants}
        remoteStatus={remoteStatus}
        remoteClient={client}
        onManageRemote={onManageRemote}
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
