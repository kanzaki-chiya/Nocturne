/**
 * 右侧面板的状态与接线（ADR-0060 及 2026-10-18（二）修订）：每个会话有自己的一套标签、
 * 当前标签、开关、文件树宽度与换行；面板宽度和概览浮层是全局的。没有会话（首页、
 * 新建会话页）就没有面板。切到别的会话时，原会话的终端和浏览器在后台继续（隐藏，不卸载；
 * 浏览器超出上限时由 browser-pool 回收）；会话被删除时结束它的终端、销毁浏览器并清掉
 * 面板记录。App 只拿回打开入口和要渲染的节点。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LocalFileContent, SubagentSummary, TurnChangeDiff } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";

import { createAttachmentImageSource, type AttachmentImageSource } from "./attachment-images";
import {
  activeAgent,
  agentPanelTabId,
  AgentBrowserStore,
  agentTabsFor,
  syncAgentTabs,
  withoutAgentTabs,
} from "./agent-browser";
import { BrowserPool } from "./browser-pool";
import type { SubagentLinks } from "./Conversation";
import type { OpenConversation } from "./conversations";
import type { BrowserBounds, DesktopHost } from "./host";
import { QuickOpen, SessionOverview, TitlebarButtons, type OverviewSubagents } from "./PanelChrome";
import type { PrefsStore } from "./prefs";
import { projectKey, projectName } from "./session-tree";
import { SidePanel, type PanelChangesSource, type TerminalShellChoice } from "./SidePanel";
import {
  browserTabShowing,
  clampPanelWidth,
  clampTreeWidth,
  fileUrl,
  isHtmlPath,
  joinWorkspace,
  migrateGlobalPanel,
  moveTab,
  nextActiveAfterClose,
  overviewDocks,
  PANEL_DEFAULT_WIDTH,
  panelOverlays,
  parseAddress,
  pushRecent,
  relativeTo,
  restoreSessionPanel,
  samePath,
  sessionChangeTotals,
  storeSessionPanel,
  subagentTabFor,
  vanishedSessions,
  type BrowserTab,
  type FileTab,
  type PanelTab,
  type SessionPanel,
  type SubagentTab,
  type TerminalTab,
} from "./side-panel";
import { SubagentDirectory } from "./subagent-directory";
import {
  externalRuns,
  isTaskEntry,
  linkFor,
  runningBuiltin,
  unsettledBuiltinTasks,
} from "./subagent-panel";
import { SubagentWatcher } from "./subagent-watch";

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `t${Date.now().toString(36)}${tabSeq.toString(36)}`;
}

/** 后台连接的序号：连接换了（后台重启）文件标签重读 */
const clientIds = new WeakMap<RpcClient, number>();
let clientSeq = 0;
function clientKey(client: RpcClient | undefined): string {
  if (client === undefined) return "none";
  let id = clientIds.get(client);
  if (id === undefined) {
    clientSeq += 1;
    id = clientSeq;
    clientIds.set(client, id);
  }
  return String(id);
}

/** describeSettings 里 shell 一行的生效值（种类名或可执行文件路径）；读不到当作 auto */
function shellSetting(items: readonly { key: string; effective?: string | undefined }[]) {
  return items.find((item) => item.key === "shell")?.effective;
}

/** 新增标签：选中的是新标签页时替换它，否则插在选中标签右边；顺带打开面板 */
function withTab(panel: SessionPanel, tab: PanelTab): SessionPanel {
  const index = panel.tabs.findIndex((t) => t.id === panel.activeId);
  const at = panel.tabs[index];
  let next: PanelTab[];
  if (at?.kind === "new") {
    next = panel.tabs.map((t) => (t.id === panel.activeId ? tab : t));
  } else {
    next = [...panel.tabs];
    next.splice(index < 0 ? next.length : index + 1, 0, tab);
  }
  return { ...panel, tabs: next, activeId: tab.id, open: true };
}

export interface SidePanelController {
  /**
   * 文件引用左键（打开文件用 = Nocturne 面板）：在当前会话的文件标签里打开并定位；
   * 工作区内的 HTML 在浏览器标签里打开（有内置浏览器时）
   */
  openFile: (absolutePath: string, line?: number, ref?: { endLine?: number | undefined }) => void;
  /** 工作区内 HTML 左键会进浏览器标签：右键菜单另给「查看源码」 */
  previewsHtml: (absolutePath: string) => boolean;
  /** 「查看源码」：总在文件标签里打开 */
  viewSource: (absolutePath: string, line?: number) => void;
  /** 改动卡片「查看变更」 */
  viewChanges: (seq: number) => void;
  /** 对话里 task 行的「在面板中查看」；没有连着后台时 undefined（不显示按钮） */
  subagentLinks: SubagentLinks | undefined;
  bodyClass: string;
  mainClass: string;
  /** .body 上的 ref：量宽度决定并排还是覆盖 */
  bodyRef: (node: HTMLDivElement | null) => void;
  /** 放在 .body 末尾：面板本身 */
  panel: ReactNode;
  /** 放在 .main 里：概览浮层、快速打开、标题栏按钮 */
  mainOverlays: ReactNode;
}

export function useSidePanel({
  prefs,
  host,
  sessionId,
  active,
  sessionCwd,
  sessions,
  openIds,
  loadDiff,
  editors,
  settingsOpen,
  plainKey,
  client,
  ensureClient,
  images,
}: {
  prefs: PrefsStore;
  host: DesktopHost;
  /** 面板所属的会话；首页和新建会话页为 null（没有面板） */
  sessionId: string | null;
  /** sessionId 对应的已打开会话；还在打开或后台已退出时 undefined */
  active: OpenConversation | undefined;
  /** 会话还没打开完时的工作目录（会话列表里的 cwd），终端用 */
  sessionCwd: string | undefined;
  /** 最新的会话列表；还没拿到时 undefined。用来迁移旧标签、识别被删除的会话 */
  sessions: readonly { id: string; mtimeMs: number }[] | undefined;
  /** 打开着的会话：刚建好还没进列表时不当作被删除 */
  openIds: ReadonlySet<string>;
  loadDiff: (entry: OpenConversation, seq: number, path: string) => Promise<TurnChangeDiff>;
  editors: { vscode: boolean; cursor: boolean };
  /** 设置区盖住主区时概览浮层隐藏、Esc 归设置区 */
  settingsOpen: boolean;
  /** 普通对话的项目键：概览里显示「对话」而不是目录名 */
  plainKey: string | null;
  /** 当前后台连接；没连上时 undefined（文件标签等它连上再读） */
  client: RpcClient | undefined;
  /** 需要后台时拉起（终端取 shell 列表与 Shell 设置） */
  ensureClient: () => Promise<RpcClient>;
  /** 窗口级图片缓存（子代理视图的图片按 sha256 共用）；缺省时面板自己建一份 */
  images?: AttachmentImageSource | undefined;
}): SidePanelController {
  const [width, setWidth] = useState(() => prefs.get().panelWidth ?? PANEL_DEFAULT_WIDTH);
  const [overview, setOverview] = useState(() => prefs.get().overviewOpen === true);
  /** 本次运行里动过的会话面板；没动过的按偏好记录恢复（restored 缓存） */
  const [panels, setPanels] = useState<ReadonlyMap<string, SessionPanel>>(new Map());
  const restored = useRef(new Map<string, SessionPanel>());
  /** 迁移或清理改了偏好里的记录：清缓存后重渲染一次 */
  const [, setRecords] = useState(0);
  const [quickOpen, setQuickOpen] = useState(false);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [bodySize, setBodySize] = useState({ width: 0, sidebar: 0 });
  /** 子代理标签的只读观察状态（每个 child 一个独立 SessionView）与目录查询 */
  const watcher = useMemo(() => new SubagentWatcher(), []);
  const directory = useMemo(() => new SubagentDirectory(), []);
  useSyncExternalStore(directory.subscribe, directory.getVersion);
  useEffect(() => {
    directory.revive();
    return () => {
      directory.dispose();
    };
  }, [directory]);
  useEffect(
    () => () => {
      watcher.dispose();
    },
    [watcher],
  );
  // 窗口没传图片缓存时（测试）面板自己建一份，并只回收自己建的
  const imageSource = useMemo(() => images ?? createAttachmentImageSource(), [images]);
  useEffect(
    () => () => {
      if (images === undefined) imageSource.dispose();
    },
    [imageSource, images],
  );

  const panelFor = useCallback(
    (id: string, map: ReadonlyMap<string, SessionPanel>): SessionPanel => {
      const live = map.get(id);
      if (live !== undefined) return live;
      let cached = restored.current.get(id);
      if (cached === undefined) {
        cached = restoreSessionPanel(prefs.get().panelSessions?.[id], newTabId);
        restored.current.set(id, cached);
      }
      return cached;
    },
    [prefs],
  );
  const current = sessionId === null ? undefined : panelFor(sessionId, panels);
  // ── agent 浏览器（第 5 轮）：外壳建的标签只在这里显示、布局与接管 ──
  const agentHost = host.agentBrowser;
  const agents = useMemo(() => new AgentBrowserStore(agentHost), [agentHost]);
  useSyncExternalStore(agents.subscribe, agents.getVersion);
  useEffect(() => {
    agents.start();
    return () => {
      agents.dispose();
    };
  }, [agents]);
  const agentSnapshot = agents.get();
  const [agentSlot, setAgentSlot] = useState<{ tabId: string; bounds: BrowserBounds }>();
  const [presentTick, setPresentTick] = useState(0);
  const layoutVersion = useRef(0);
  /** agent 标签的位置与尺寸：可见的 agent 标签报给外壳，其余由外壳移到可见区外 */
  const onAgentSlot = useCallback((tabId: string, bounds: BrowserBounds) => {
    setAgentSlot((current) => {
      if (current === undefined) return { tabId, bounds };
      const same =
        current.tabId === tabId &&
        current.bounds.x === bounds.x &&
        current.bounds.y === bounds.y &&
        current.bounds.width === bounds.width &&
        current.bounds.height === bounds.height;
      return same ? current : { tabId, bounds };
    });
  }, []);
  /**
   * 设置页和首页一样没有面板（ADR-0060 修订 2026-10-18（三））：只是不显示、按钮和快捷键
   * 不可用，会话自己的面板状态不动，返回会话时原样恢复；终端照常挂着。
   */
  const hasPanel = sessionId !== null && !settingsOpen;
  /** 会话面板记录里的开关；显示与否还要看 hasPanel */
  const open = current?.open === true;
  const shown = open && hasPanel;
  const tabs = useMemo(() => current?.tabs ?? [], [current]);
  const activeId = current?.activeId ?? "";
  /** 当前选中的是 agent 标签时，外壳里的对应标签信息 */
  const agentInfo = activeAgent(current);

  /** 改当前会话的面板；没有会话时什么都不做 */
  const update = useCallback(
    (fn: (panel: SessionPanel) => SessionPanel) => {
      if (sessionId === null) return;
      setPanels((map) => new Map(map).set(sessionId, fn(panelFor(sessionId, map))));
    },
    [sessionId, panelFor],
  );

  // ── agent 标签合进面板：当前会话按外壳状态增删改，别的会话里残留的清掉 ──
  useEffect(() => {
    const desired = agentTabsFor(agentSnapshot, sessionId);
    setPanels((map) => {
      let next: Map<string, SessionPanel> | undefined;
      for (const [id, panel] of map) {
        if (id === sessionId) continue;
        const cleaned = withoutAgentTabs(panel);
        if (cleaned !== panel) next = new Map(next ?? map).set(id, cleaned);
      }
      if (sessionId !== null) {
        const base = map.get(sessionId) ?? restored.current.get(sessionId);
        if (base !== undefined || desired.length > 0) {
          const panel = base ?? restoreSessionPanel(undefined, newTabId);
          const merged = syncAgentTabs(panel, desired);
          if (merged !== panel || base === undefined) {
            if (base !== undefined) restored.current.delete(sessionId);
            next = new Map(next ?? map).set(sessionId, merged);
          }
        }
      }
      return next ?? map;
    });
  }, [agentSnapshot, sessionId]);

  // `open` 在前台：切到 agent 的新标签，等布局送到外壳后确认（desktop-browser.md 第 6 节）
  useEffect(
    () =>
      agents.onPresent(({ tabId }) => {
        if (sessionId === null) return;
        const id = agentPanelTabId(tabId);
        setPresentTick((n) => n + 1);
        setPanels((map) => {
          const panel = syncAgentTabs(
            panelFor(sessionId, map),
            agentTabsFor(agents.get(), sessionId),
          );
          if (!panel.tabs.some((tab) => tab.id === id)) return map;
          return new Map(map).set(sessionId, { ...panel, open: true, activeId: id });
        });
      }),
    [agents, sessionId, panelFor],
  );

  // ── 持久化：动过的会话面板写回偏好（终端、新标签页不存） ──
  useEffect(() => {
    if (panels.size === 0) return;
    const stored = { ...(prefs.get().panelSessions ?? {}) };
    for (const [id, panel] of panels) stored[id] = storeSessionPanel(panel);
    prefs.update({ panelSessions: stored });
  }, [prefs, panels]);

  // ── 会话列表到了：一次性迁移旧全局标签；被删除的会话结束终端、清掉记录 ──
  /** 本次运行里出现在会话列表里的会话：再从列表里消失就是被删了（vanishedSessions） */
  const seenIds = useRef(new Set<string>());
  useEffect(() => {
    if (sessions === undefined) return;
    const p = prefs.get();
    let stored = p.panelSessions ?? {};
    if (p.panelSessionsMigrated !== true) {
      stored = migrateGlobalPanel(
        { tabs: p.panelTabs, activeTab: p.panelActiveTab, open: p.panelOpen },
        sessions,
        stored,
      );
      restored.current.clear();
      setRecords((n) => n + 1);
      prefs.update({
        panelSessions: stored,
        panelSessionsMigrated: true,
        panelTabs: undefined,
        panelActiveTab: undefined,
        panelOpen: undefined,
      });
    }
    for (const s of sessions) seenIds.current.add(s.id);
    const gone = vanishedSessions(
      [...Object.keys(stored), ...panels.keys()],
      sessions,
      seenIds.current,
      openIds,
      sessionId,
    );
    if (gone.length === 0) return;
    for (const id of gone) {
      restored.current.delete(id);
      seenIds.current.delete(id);
      watcher.releaseParent(id);
    }
    // 卸载它们的终端标签即结束进程（TerminalSession.dispose）
    setPanels((map) => {
      if (!gone.some((id) => map.has(id))) return map;
      const next = new Map(map);
      for (const id of gone) next.delete(id);
      return next;
    });
    const removed = new Set(gone);
    const rest = Object.fromEntries(
      Object.entries(prefs.get().panelSessions ?? {}).filter(([id]) => !removed.has(id)),
    );
    prefs.update({ panelSessions: rest });
    // panels / openIds / sessionId 变化不重跑：只在拿到新列表时比对
  }, [sessions, prefs, watcher]);

  // 浏览器池在后面才建好，这里经 ref 取
  const poolRef = useRef<BrowserPool | undefined>(undefined);
  const activeTabRef = useRef<string | undefined>(undefined);
  activeTabRef.current = current?.activeId;
  /**
   * 显示中的网页要被收起或换走时：先等它藏好再改界面。主界面重排在同一帧完成，
   * 原生 webview 走异步命令，不先藏就会在对话区或别的标签上多留一帧
   */
  const hideBrowserThen = useCallback((apply: () => void) => {
    const pool = poolRef.current;
    if (pool === undefined) apply();
    else void pool.hideShown().then(apply);
  }, []);
  const setPanelOpen = useCallback(
    (next: boolean) => {
      const apply = () => {
        update((panel) => ({ ...panel, open: next }));
      };
      if (next) apply();
      else hideBrowserThen(apply);
    },
    [update, hideBrowserThen],
  );
  const setOverviewOpen = useCallback(
    (next: boolean) => {
      setOverview(next);
      prefs.update({ overviewOpen: next });
    },
    [prefs],
  );

  // ── 宽度与覆盖判定 ──
  useEffect(() => {
    if (body === null) return;
    const measure = () => {
      const sidebar = body.firstElementChild?.getBoundingClientRect().width ?? 0;
      setBodySize({ width: body.getBoundingClientRect().width, sidebar });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => {
      observer.disconnect();
    };
  }, [body]);
  const available = bodySize.width > 0 ? bodySize.width - bodySize.sidebar : undefined;
  const shownWidth = clampPanelWidth(width, available);
  const overlay = bodySize.width > 0 && panelOverlays(bodySize.width, bodySize.sidebar, shownWidth);
  const docked = shown && !overlay;
  // 标题栏：并排时窗口按钮让到面板上方
  useEffect(() => {
    const root = document.documentElement;
    if (docked) root.style.setProperty("--panel-dock", `${shownWidth}px`);
    else root.style.removeProperty("--panel-dock");
    return () => {
      root.style.removeProperty("--panel-dock");
    };
  }, [docked, shownWidth]);
  const onResize = useCallback(
    (next: number, commit: boolean) => {
      const clamped = clampPanelWidth(next, available);
      setWidth(clamped);
      if (commit) prefs.update({ panelWidth: clamped });
    },
    [prefs, available],
  );

  // ── 标签操作（都作用于当前会话） ──
  /** 新增标签：选中的是新标签页时替换它，否则插在选中标签右边；顺带打开面板 */
  const placeTab = useCallback(
    (tab: PanelTab) => {
      update((panel) => withTab(panel, tab));
    },
    [update],
  );
  const newTab = useCallback(() => {
    update((panel) => {
      const id = newTabId();
      const index = panel.tabs.findIndex((t) => t.id === panel.activeId);
      const next = [...panel.tabs];
      next.splice(index < 0 ? next.length : index + 1, 0, { id, kind: "new" });
      return { ...panel, tabs: next, activeId: id, open: true };
    });
  }, [update]);
  const closeTab = useCallback(
    (id: string) => {
      const closing = tabs.find((t) => t.id === id);
      if (closing?.kind === "subagent" && sessionId !== null) {
        // 关标签就退订并丢弃它的视图（只是切走时才保留）
        watcher.release(sessionId, closing.childSessionId);
      }
      // agent 标签的 webview 在外壳里：先让外壳关，再移除本地标签
      if (closing?.kind === "browser" && closing.agent !== undefined) {
        void agents.control(closing.agent.tabId, "close");
      }
      const apply = () => {
        update((panel) => {
          const rest = panel.tabs.filter((t) => t.id !== id);
          if (rest.length === 0) {
            // 关掉最后一个标签：留一个新标签页，面板不收起
            const fresh = newTabId();
            return { ...panel, tabs: [{ id: fresh, kind: "new" }], activeId: fresh };
          }
          return {
            ...panel,
            tabs: rest,
            activeId: nextActiveAfterClose(panel.tabs, id, panel.activeId) ?? rest[0]?.id ?? "",
          };
        });
      };
      if (id === activeTabRef.current) hideBrowserThen(apply);
      else apply();
    },
    [tabs, sessionId, watcher, update, hideBrowserThen, agents],
  );
  const activate = useCallback(
    (id: string) => {
      const apply = () => {
        update((panel) => ({ ...panel, activeId: id }));
      };
      if (id === activeTabRef.current) apply();
      else hideBrowserThen(apply);
    },
    [update, hideBrowserThen],
  );
  /** 接管 / 交给 agent：外壳执行，结果经 watch 快照回来 */
  const agentControl = useCallback(
    (tabId: string, action: "takeover" | "return") => {
      void agents.control(tabId, action);
    },
    [agents],
  );
  const openChanges = useCallback(
    (seq?: number) => {
      const existing = tabs.find((t) => t.kind === "changes");
      if (existing !== undefined) {
        update((panel) => ({
          ...panel,
          open: true,
          activeId: existing.id,
          tabs: panel.tabs.map((t) =>
            t.id === existing.id && t.kind === "changes"
              ? { ...t, focusSeq: seq, focusNonce: (t.focusNonce ?? 0) + 1 }
              : t,
          ),
        }));
        return;
      }
      placeTab({ id: newTabId(), kind: "changes", focusSeq: seq, focusNonce: 1 });
    },
    [tabs, update, placeTab],
  );
  const openFileTab = useCallback(
    (file: Omit<FileTab, "id" | "kind" | "focusNonce">) => {
      const existing = tabs.find(
        (t): t is FileTab => t.kind === "file" && samePath(t.absolutePath, file.absolutePath),
      );
      if (existing !== undefined) {
        update((panel) => ({
          ...panel,
          open: true,
          activeId: existing.id,
          recent: pushRecent(panel.recent, file.absolutePath),
          tabs: panel.tabs.map((t) =>
            t.id === existing.id && t.kind === "file"
              ? {
                  ...t,
                  line: file.line,
                  endLine: file.endLine,
                  focusNonce: (t.focusNonce ?? 0) + 1,
                }
              : t,
          ),
        }));
        return;
      }
      placeTab({ id: newTabId(), kind: "file", ...file, focusNonce: 1 });
      // Ctrl+P 空查询时排在前面
      update((panel) => ({ ...panel, recent: pushRecent(panel.recent, file.absolutePath) }));
    },
    [tabs, update, placeTab],
  );

  const viewSource = useCallback<SidePanelController["viewSource"]>(
    (absolutePath, line) => {
      // 工作区外的文件不记工作区：标签显示所在目录名
      const workspace =
        active !== undefined && relativeTo(active.workspace, absolutePath) !== undefined
          ? active.workspace
          : undefined;
      openFileTab({ absolutePath, workspace, line });
    },
    [active, openFileTab],
  );
  const previewsHtml = useCallback(
    (absolutePath: string) =>
      host.browsers !== undefined &&
      isHtmlPath(absolutePath) &&
      active !== undefined &&
      relativeTo(active.workspace, absolutePath) !== undefined,
    [host.browsers, active],
  );
  const openBrowser = useCallback(
    (url: string) => {
      placeTab({ id: newTabId(), kind: "browser", url });
    },
    [placeTab],
  );
  /** 本地 HTML：已有标签在显示它就切过去，否则新开 */
  const openHtml = useCallback(
    (absolutePath: string) => {
      const existing = browserTabShowing(tabs, absolutePath);
      if (existing === undefined) {
        openBrowser(fileUrl(absolutePath));
        return;
      }
      const apply = () => {
        update((panel) => ({ ...panel, open: true, activeId: existing.id }));
      };
      if (existing.id === activeTabRef.current) apply();
      else hideBrowserThen(apply);
    },
    [tabs, openBrowser, update, hideBrowserThen],
  );
  const openFile = useCallback<SidePanelController["openFile"]>(
    (absolutePath, line, ref) => {
      if (previewsHtml(absolutePath)) {
        openHtml(absolutePath);
        return;
      }
      const workspace =
        active !== undefined && relativeTo(active.workspace, absolutePath) !== undefined
          ? active.workspace
          : undefined;
      openFileTab({ absolutePath, workspace, line, endLine: ref?.endLine });
    },
    [active, openFileTab, previewsHtml, openHtml],
  );

  // ── 子代理（ADR-0060 第 6 节与修订（五））──
  const runtime = client?.runtime;
  const hasSession = active !== undefined;
  const [documentVisible, setDocumentVisible] = useState(
    () =>
      typeof document === "undefined" ||
      (document.visibilityState !== "hidden" && document.hasFocus()),
  );
  useEffect(() => {
    const onChange = () => {
      setDocumentVisible(document.visibilityState !== "hidden" && document.hasFocus());
    };
    const onBlur = () => {
      setDocumentVisible(false);
    };
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const view = active?.view;
  const pollNeeded = view !== undefined && unsettledBuiltinTasks(view) > 0;
  // 目录只在「当前会话、窗口可见、不在设置里、连着后台」时查询，其余一概停止并丢弃在途响应
  useEffect(() => {
    directory.setContext({
      runtime,
      sessionId: hasSession ? sessionId : null,
      visible: documentVisible,
      settingsOpen,
      pollNeeded,
    });
  }, [directory, runtime, hasSession, sessionId, documentVisible, settingsOpen, pollNeeded]);
  // 父 task 的 started / progress / completed 触发合并查询；不解析 progress 文本
  useEffect(() => {
    if (client === undefined || !hasSession || sessionId === null) return;
    const taskCalls = new Set<string>();
    for (const entry of view?.entries ?? []) {
      if (isTaskEntry(entry) && entry.status === "running") taskCalls.add(entry.callId);
    }
    return client.onEvent((id, event) => {
      if (id !== sessionId) return;
      if (event.type === "tool.started" && event.payload.name === "task") {
        taskCalls.add(event.payload.callId);
        directory.trigger();
      } else if (event.type === "tool.completed" && event.payload.name === "task") {
        taskCalls.delete(event.payload.callId);
        directory.trigger();
      } else if (event.type === "tool.progress" && taskCalls.has(event.payload.callId)) {
        directory.trigger();
      }
    });
    // view 在原地变化；这里只在换会话/连接时按当时的运行中 task 初始化
  }, [client, hasSession, sessionId, directory]);
  const summaries = directory.summaries;
  /** 打开（或切到）一个子代理的标签；同一 child 在父会话内只有一个标签 */
  const openSubagent = useCallback(
    (summary: SubagentSummary) => {
      const existing = subagentTabFor(tabs, summary.childSessionId);
      const apply = () => {
        update((panel) => {
          const found = subagentTabFor(panel.tabs, summary.childSessionId);
          if (found !== undefined) return { ...panel, open: true, activeId: found.id };
          const tab: SubagentTab = {
            id: newTabId(),
            kind: "subagent",
            childSessionId: summary.childSessionId,
            parentCallId: summary.callId,
            profile: summary.profile,
            taskSummary: summary.taskSummary,
          };
          return withTab(panel, tab);
        });
      };
      // 由浏览器切过来：先藏起显示中的网页再改界面（第 3 轮安全规则）
      if (existing !== undefined && existing.id === activeTabRef.current) apply();
      else hideBrowserThen(apply);
    },
    [tabs, update, hideBrowserThen],
  );
  const openSubagentById = useCallback(
    (childSessionId: string) => {
      const summary = directory.summaries.find((s) => s.childSessionId === childSessionId);
      if (summary !== undefined) openSubagent(summary);
    },
    [directory, openSubagent],
  );
  const subagentLinks = useMemo<SubagentLinks | undefined>(
    () =>
      runtime === undefined || !hasSession
        ? undefined
        : {
            link: (entry) => linkFor(entry, summaries),
            open: openSubagentById,
          },
    [runtime, hasSession, summaries, openSubagentById],
  );
  /** 外部 agent 调用没有 child：概览里首次看到它运行的本地时刻，用来本地计时 */
  const externalSeen = useRef(new Map<string, number>());
  const externalRows = useMemo(() => {
    const runs = view === undefined ? [] : externalRuns(view);
    const seen = externalSeen.current;
    const now = Date.now();
    const live = new Set(runs.map((run) => run.callId));
    for (const callId of [...seen.keys()]) if (!live.has(callId)) seen.delete(callId);
    return runs.map((run) => {
      if (!seen.has(run.callId)) seen.set(run.callId, now);
      return { ...run, since: seen.get(run.callId) ?? now };
    });
    // view 在原地变化：每次渲染都重算（只是遍历 entries）
  }, [view, view?.revision]);

  // ── 浏览器（ADR-0060 第 5 节）：webview 池随宿主建一次，事件按标签 id 找到所在会话 ──
  /** 标签所在的会话面板：本次运行动过的，或只按偏好恢复、还没动过的 */
  const findPanel = useCallback(
    (map: ReadonlyMap<string, SessionPanel>, tabId: string) => {
      for (const id of new Set([...map.keys(), ...restored.current.keys()])) {
        const panel = panelFor(id, map);
        if (panel.tabs.some((t) => t.id === tabId)) return { id, panel };
      }
      return undefined;
    },
    [panelFor],
  );
  /** 改某个标签（可能属于后台会话）；没变化时不触发渲染 */
  const patchTab = useCallback(
    (tabId: string, fn: (tab: PanelTab) => PanelTab) => {
      setPanels((map) => {
        const hit = findPanel(map, tabId);
        const tab = hit?.panel.tabs.find((t) => t.id === tabId);
        if (hit === undefined || tab === undefined) return map;
        const next = fn(tab);
        if (next === tab) return map;
        return new Map(map).set(hit.id, {
          ...hit.panel,
          tabs: hit.panel.tabs.map((t) => (t.id === tabId ? next : t)),
        });
      });
    },
    [findPanel],
  );
  /** target=_blank / window.open：插在来源标签右边并选中 */
  const openFromBrowser = useCallback(
    (sourceId: string, url: string) => {
      setPanels((map) => {
        const hit = findPanel(map, sourceId);
        if (hit === undefined) return map;
        const tab: BrowserTab = { id: newTabId(), kind: "browser", url };
        const tabs = [...hit.panel.tabs];
        tabs.splice(tabs.findIndex((t) => t.id === sourceId) + 1, 0, tab);
        return new Map(map).set(hit.id, { ...hit.panel, tabs, activeId: tab.id, open: true });
      });
    },
    [findPanel],
  );
  const shortcutRef = useRef<(key: "b" | "t" | "p" | "backquote") => void>(() => undefined);
  const browserHost = host.browsers;
  const pool = useMemo(
    () =>
      browserHost === undefined
        ? undefined
        : new BrowserPool(browserHost, {
            onUrl: (tabId, url) => {
              patchTab(tabId, (t) => (t.kind === "browser" && t.url !== url ? { ...t, url } : t));
            },
            onTitle: (tabId, title) => {
              patchTab(tabId, (t) =>
                t.kind === "browser" && t.title !== title ? { ...t, title } : t,
              );
            },
            onNewWindow: openFromBrowser,
            onShortcut: (key) => {
              shortcutRef.current(key);
            },
          }),
    [browserHost, patchTab, openFromBrowser],
  );
  poolRef.current = pool;
  useEffect(
    () => () => {
      pool?.dispose();
    },
    [pool],
  );

  // ── 读取：rpc.md runtime.readFile，不经会话 ──
  const readFile = useCallback(
    (absolutePath: string): Promise<LocalFileContent> =>
      client === undefined
        ? // 后台还没连上：保持「正在读取…」，连上后 readerKey 变化触发重读
          new Promise<LocalFileContent>(() => undefined)
        : client.runtime.readFile(absolutePath),
    [client],
  );
  const readerKey = clientKey(client);

  // ── 终端 ──
  const ensureRef = useRef(ensureClient);
  ensureRef.current = ensureClient;
  /** shell 列表与设置里的 Shell（按终端工作区合并项目层） */
  const loadShells = useCallback(async (cwd: string): Promise<TerminalShellChoice> => {
    const rpc = await ensureRef.current();
    const [shells, setting] = await Promise.all([
      rpc.runtime.listShells({ workspaceRoot: cwd }),
      rpc.runtime
        .describeSettings({ workspaceRoot: cwd })
        .then(shellSetting)
        .catch(() => undefined),
    ]);
    return { shells, setting };
  }, []);
  const workspace = active?.workspace ?? sessionCwd;
  const openTerminal = useCallback(
    (reuse: boolean) => {
      if (host.terminals === undefined || workspace === undefined) return;
      if (reuse) {
        const existing = tabs.find((t) => t.kind === "terminal");
        if (existing !== undefined) {
          update((panel) => ({ ...panel, activeId: existing.id, open: true }));
          return;
        }
      }
      const tab: TerminalTab = {
        id: newTabId(),
        kind: "terminal",
        cwd: workspace,
        label:
          plainKey !== null && projectKey(workspace) === plainKey ? "对话" : projectName(workspace),
      };
      placeTab(tab);
    },
    [host.terminals, tabs, workspace, plainKey, placeTab, update],
  );
  /** 终端可能属于后台的会话：按标签 id 找到它所在的会话再改 */
  const onShellChange = useCallback(
    (tabId: string, executable: string) => {
      setPanels((map) => {
        for (const [id, panel] of map) {
          if (!panel.tabs.some((t) => t.id === tabId)) continue;
          return new Map(map).set(id, {
            ...panel,
            tabs: panel.tabs.map((t) =>
              t.id === tabId && t.kind === "terminal" ? { ...t, shell: executable } : t,
            ),
          });
        }
        return map;
      });
    },
    [setPanels],
  );

  const externalEditor = editors.vscode ? "vscode" : editors.cursor ? "cursor" : undefined;
  const fileActions = useMemo(
    () => ({
      externalLabel:
        externalEditor === "vscode"
          ? "用 VS Code 打开"
          : externalEditor === "cursor"
            ? "用 Cursor 打开"
            : "用系统程序打开",
      openExternal: (absolutePath: string, line?: number) =>
        externalEditor === undefined
          ? host.openPath(absolutePath)
          : host.openInEditor(externalEditor, absolutePath, line),
      reveal: (absolutePath: string) => host.revealItem(absolutePath),
      openInBrowser: async (absolutePath: string) => {
        if (pool === undefined) await host.openPath(absolutePath);
        else openHtml(absolutePath);
      },
      browserLabel: pool === undefined ? "在系统浏览器打开" : "在浏览器标签打开",
    }),
    [host, externalEditor, pool, openHtml],
  );
  const openExternalUrl = useCallback(
    async (url: string) => {
      const target = parseAddress(url, workspace);
      if (target.kind === "file") {
        await host.openPath(target.path);
        return;
      }
      const parsed = new URL(url);
      if (
        parsed.protocol === "http:" &&
        parsed.hostname !== "localhost" &&
        parsed.hostname !== "127.0.0.1"
      ) {
        throw new Error("系统浏览器只打开 https 网址或本机 http 地址");
      }
      await host.openUrl(url);
    },
    [host, workspace],
  );
  const onAddress = useCallback(
    async (text: string): Promise<string | undefined> => {
      const target = parseAddress(text, workspace);
      if (target.kind === "invalid") return target.message;
      // 有内置浏览器：新标签页就地变成浏览器标签
      if (pool !== undefined) {
        openBrowser(target.url);
        return undefined;
      }
      try {
        await openExternalUrl(target.url);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [workspace, pool, openBrowser, openExternalUrl],
  );

  const changes: PanelChangesSource | undefined = useMemo(() => {
    if (active === undefined) return undefined;
    return {
      workspace: active.workspace,
      turns: active.turnChanges,
      userSeqs: active.view.entries.filter((e) => e.kind === "user").map((e) => e.seq),
      loadDiff: (seq, path) => loadDiff(active, seq, path),
    };
    // turnChanges 每次刷新换新 Map；用户消息随 view 变化
  }, [active, active?.turnChanges, active?.view, loadDiff]);

  const loadIndex = useMemo(() => {
    const session = active?.session;
    return session === undefined ? undefined : () => session.fileIndex();
  }, [active?.session]);

  // 会话切走或进了设置页时快速打开跟着关掉：它列的是原会话的工作区
  useEffect(() => {
    setQuickOpen(false);
  }, [sessionId, settingsOpen]);

  // ── 快捷键（只有桌面窗口挂这个 hook）；没有面板（首页、新建会话页、设置页）时都不响应 ──
  const keyState = useRef({
    open,
    overview,
    quickOpen,
    settingsOpen,
    hasPanel: false,
    hasSession: false,
  });
  keyState.current = {
    open,
    overview,
    quickOpen,
    settingsOpen,
    hasPanel,
    hasSession: active !== undefined,
  };
  const actions = useRef({ newTab, openChanges, setPanelOpen, setOverviewOpen, openTerminal });
  actions.current = { newTab, openChanges, setPanelOpen, setOverviewOpen, openTerminal };
  /** 面板快捷键：焦点在主界面（keydown）和在网页里（外壳转发）走同一套 */
  const runPanelKey = useCallback((key: "b" | "t" | "p" | "g" | "backquote") => {
    const state = keyState.current;
    const act = actions.current;
    if (!state.hasPanel) return;
    if (key === "backquote") {
      // Ctrl+`：已有终端就切过去，没有就新开一个
      act.openTerminal(true);
    } else if (key === "b") {
      act.setPanelOpen(!state.open);
    } else if (key === "t") {
      act.newTab();
    } else if (key === "g") {
      act.openChanges();
    } else {
      setQuickOpen(true);
    }
  }, []);
  shortcutRef.current = runPanelKey;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = keyState.current;
      const act = actions.current;
      if (event.key === "Escape") {
        // 浮层由按钮和 Esc 开关；别处已消费的 Esc（输入框的补全与中断、菜单、提示、搜索框、
        // 终端）不算，所以输入框空闲时 Esc 也开关浮层。没有会话时按钮置灰，Esc 同样不开
        if (event.defaultPrevented || event.isComposing || state.quickOpen || state.settingsOpen)
          return;
        if (state.overview) act.setOverviewOpen(false);
        else if (state.hasSession) act.setOverviewOpen(true);
        return;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      const panelKey =
        (event.code === "Backquote" && !event.shiftKey) ||
        (!event.shiftKey && (key === "b" || key === "t" || key === "p")) ||
        (event.shiftKey && key === "g");
      if (!panelKey) return;
      // 仍然拦下浏览器默认行为（Ctrl+P 是打印）；没有面板时什么都不做
      event.preventDefault();
      runPanelKey(event.code === "Backquote" ? "backquote" : (key as "b" | "t" | "p" | "g"));
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [runPanelKey]);

  const overviewVisible = overview && active !== undefined && !settingsOpen;
  // ── 主界面向外壳报告 UI 状态：外壳据此把正在显示的 agent 标签放到占位区 ──
  const agentVisible = shown && agentInfo !== undefined ? agentInfo.tabId : undefined;
  useEffect(() => {
    if (agentHost === undefined) return;
    const snapshot = agents.get();
    const bounds =
      agentVisible !== undefined && agentSlot?.tabId === agentVisible
        ? agentSlot.bounds
        : undefined;
    layoutVersion.current += 1;
    const version = layoutVersion.current;
    const route: "session" | "settings" | "home" =
      sessionId === null ? "home" : settingsOpen ? "settings" : "session";
    void agents
      .uiState({
        shellGeneration: snapshot.shellGeneration,
        revision: snapshot.revision,
        route,
        ...(sessionId !== null ? { sessionId } : {}),
        panelOpen: shown,
        // 外壳按自己的 tabId 匹配；面板标签 id 是 `agent:` 前缀，不能原样送回去
        ...(agentInfo !== undefined
          ? { activeTabId: agentInfo.tabId }
          : activeId !== ""
            ? { activeTabId: activeId }
            : {}),
        covered: overviewVisible,
        ...(agentVisible !== undefined && bounds !== undefined
          ? { layout: { tabId: agentVisible, version, bounds } }
          : {}),
      })
      .then(() => {
        // present：这一代布局已经送到外壳，确认后外壳才把页面留在可见位置
        const pending = agents.pending();
        if (
          pending === undefined ||
          agentVisible === undefined ||
          pending.tabId !== agentVisible ||
          bounds === undefined
        ) {
          return;
        }
        agents.takePendingPresent();
        void agents.presented({
          shellGeneration: snapshot.shellGeneration,
          operationId: pending.operationId,
          tabId: pending.tabId,
          layoutVersion: version,
        });
      });
  }, [
    agentHost,
    agents,
    shown,
    sessionId,
    settingsOpen,
    activeId,
    overviewVisible,
    agentVisible,
    agentSlot,
    agentSnapshot.revision,
    presentTick,
  ]);
  // 打开浮层时查询一次；进入会话时本来就查过，挂载那一次不重复
  const overviewWasVisible = useRef(overviewVisible);
  useEffect(() => {
    if (overviewVisible && !overviewWasVisible.current) directory.trigger();
    overviewWasVisible.current = overviewVisible;
  }, [overviewVisible, directory]);
  const overviewSubagents: OverviewSubagents = {
    running: runningBuiltin(summaries),
    external: externalRows,
    onOpen: openSubagent,
  };
  // 面板关着且对话区让位后仍放得下才停靠，否则盖在对话区上（修订 2026-10-18（三））
  const overviewDocked =
    overviewVisible &&
    !shown &&
    bodySize.width > 0 &&
    overviewDocks(bodySize.width, bodySize.sidebar);
  const project =
    workspace === undefined
      ? ""
      : plainKey !== null && projectKey(workspace) === plainKey
        ? "对话"
        : projectName(workspace);

  /**
   * 要挂着的标签页：当前会话的全部标签，加上别的会话的终端和浏览器（隐藏，进程和网页
   * 继续）。按会话的固定顺序排，切换会话时它们的 DOM 不挪位置。
   */
  const panes = useMemo(() => {
    // 只按偏好恢复、没动过的会话也算：显示过的浏览器切走后要留在后台
    const ids = new Set([...panels.keys(), ...restored.current.keys()]);
    if (sessionId !== null) ids.add(sessionId);
    const list: PanelTab[] = [];
    for (const id of ids) {
      if (id === sessionId) list.push(...tabs);
      else {
        list.push(
          ...panelFor(id, panels).tabs.filter((t) => t.kind === "terminal" || t.kind === "browser"),
        );
      }
    }
    return list;
  }, [panels, sessionId, tabs, panelFor]);

  // 没有面板时整个隐藏（首页、新建会话页、设置页），但各会话的终端仍然挂着
  const panel = (
    <SidePanel
      hidden={!shown}
      tabs={tabs}
      panes={panes}
      activeId={activeId}
      overlay={overlay}
      width={shownWidth}
      onActivate={activate}
      onCloseTab={closeTab}
      onMoveTab={(from, to) => {
        update((p) => ({ ...p, tabs: moveTab(p.tabs, from, to) }));
      }}
      onNewTab={newTab}
      onResize={onResize}
      onOpenChanges={() => {
        openChanges();
      }}
      onQuickOpen={() => {
        setQuickOpen(true);
      }}
      onOpenTerminal={() => {
        openTerminal(false);
      }}
      onAddress={onAddress}
      changes={changes}
      treeWidth={current?.treeWidth}
      onTreeWidth={(next) => {
        update((p) => ({ ...p, treeWidth: clampTreeWidth(next) }));
      }}
      wrap={current?.wrap !== false}
      onWrap={(next) => {
        update((p) => ({ ...p, wrap: next }));
      }}
      canOpenFiles={active !== undefined}
      readFile={readFile}
      readerKey={readerKey}
      fileActions={fileActions}
      terminals={host.terminals}
      loadShells={loadShells}
      onShellChange={onShellChange}
      browsers={pool}
      workspace={workspace}
      openExternalUrl={openExternalUrl}
      subagents={
        sessionId === null
          ? undefined
          : {
              watcher,
              runtime,
              parentSessionId: sessionId,
              summaryFor: (childSessionId) =>
                summaries.find((summary) => summary.childSessionId === childSessionId),
              parentEntryFor: (callId) =>
                view?.entries.filter(isTaskEntry).find((entry) => entry.callId === callId),
              images: imageSource,
              openUrl: (url) => {
                void host.openUrl(url);
              },
            }
      }
      agents={
        agentHost === undefined
          ? undefined
          : {
              tabs: new Map(agentSnapshot.tabs.map((info) => [info.tabId, info])),
              onSlot: onAgentSlot,
              onControl: agentControl,
              onClose: (tabId) => {
                closeTab(agentPanelTabId(tabId));
              },
            }
      }
    />
  );

  const mainOverlays = (
    <>
      <TitlebarButtons
        overviewOpen={overviewVisible}
        overviewDisabled={active === undefined || settingsOpen}
        panelOpen={shown}
        panelDisabled={!hasPanel}
        onToggleOverview={() => {
          setOverviewOpen(!overview);
        }}
        onTogglePanel={() => {
          setPanelOpen(!open);
        }}
      />
      {overviewVisible && workspace !== undefined && (
        <SessionOverview
          project={project}
          workspace={workspace}
          totals={sessionChangeTotals(active.turnChanges.values())}
          docked={overviewDocked}
          rightOffset={shown && overlay ? shownWidth : 0}
          onOpenChanges={() => {
            openChanges();
          }}
          subagents={overviewSubagents}
        />
      )}
      {quickOpen && loadIndex !== undefined && active !== undefined && (
        <QuickOpen
          project={project}
          load={loadIndex}
          recent={(current?.recent ?? []).flatMap((path) => {
            const rel = relativeTo(active.workspace, path);
            // fileIndex 的相对路径用 / 分隔
            return rel === undefined ? [] : [rel.replaceAll("\\", "/")];
          })}
          onClose={() => {
            setQuickOpen(false);
          }}
          onPick={(relativePath) => {
            setQuickOpen(false);
            openFileTab({
              workspace: active.workspace,
              absolutePath: joinWorkspace(active.workspace, relativePath),
            });
          }}
        />
      )}
    </>
  );

  return {
    openFile,
    previewsHtml,
    viewSource,
    viewChanges: openChanges,
    subagentLinks,
    bodyClass: docked ? " panel-docked" : "",
    mainClass: overviewDocked ? " ov-docked" : "",
    bodyRef: setBody,
    panel,
    mainOverlays,
  };
}
