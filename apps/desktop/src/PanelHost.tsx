/**
 * 右侧面板的状态与接线（ADR-0060 及 2026-10-18（二）修订）：每个会话有自己的一套标签、
 * 当前标签、开关、文件树宽度与换行；面板宽度和概览浮层是全局的。没有会话（首页、
 * 新建会话页）就没有面板。切到别的会话时，原会话的终端在后台继续运行（隐藏，不卸载）；
 * 会话被删除时结束它的终端并清掉面板记录。App 只拿回打开入口和要渲染的节点。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LocalFileContent, TurnChangeDiff } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";

import type { OpenConversation } from "./conversations";
import type { DesktopHost } from "./host";
import { QuickOpen, SessionOverview, TitlebarButtons } from "./PanelChrome";
import type { PrefsStore } from "./prefs";
import { projectKey, projectName } from "./session-tree";
import { SidePanel, type PanelChangesSource, type TerminalShellChoice } from "./SidePanel";
import {
  clampPanelWidth,
  clampTreeWidth,
  joinWorkspace,
  migrateGlobalPanel,
  moveTab,
  nextActiveAfterClose,
  PANEL_DEFAULT_WIDTH,
  panelOverlays,
  parseAddress,
  relativeTo,
  restoreSessionPanel,
  samePath,
  sessionChangeTotals,
  storeSessionPanel,
  vanishedSessions,
  type FileTab,
  type PanelTab,
  type SessionPanel,
  type TerminalTab,
} from "./side-panel";

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

export interface SidePanelController {
  /** 文件引用左键（打开文件用 = Nocturne 面板）：在当前会话的文件标签里打开并定位 */
  openFile: (absolutePath: string, line?: number, ref?: { endLine?: number | undefined }) => void;
  /** 改动卡片「查看变更」 */
  viewChanges: (seq: number) => void;
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
  const open = current?.open === true;
  const tabs = useMemo(() => current?.tabs ?? [], [current]);
  const activeId = current?.activeId ?? "";

  /** 改当前会话的面板；没有会话时什么都不做 */
  const update = useCallback(
    (fn: (panel: SessionPanel) => SessionPanel) => {
      if (sessionId === null) return;
      setPanels((map) => new Map(map).set(sessionId, fn(panelFor(sessionId, map))));
    },
    [sessionId, panelFor],
  );

  // ── 持久化：动过的会话面板写回偏好（终端、新标签页不存） ──
  useEffect(() => {
    if (panels.size === 0) return;
    const stored = { ...(prefs.get().panelSessions ?? {}) };
    for (const [id, panel] of panels) stored[id] = storeSessionPanel(panel);
    prefs.update({ panelSessions: stored });
  }, [prefs, panels]);

  // ── 会话列表到了：一次性迁移旧全局标签；被删除的会话结束终端、清掉记录 ──
  const knownIds = useRef(new Set<string>());
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
    const keep = new Set(openIds);
    if (sessionId !== null) keep.add(sessionId);
    const gone = vanishedSessions(
      new Set([...knownIds.current, ...Object.keys(stored), ...panels.keys()]),
      sessions,
      keep,
    );
    knownIds.current = new Set(sessions.map((s) => s.id));
    if (gone.length === 0) return;
    for (const id of gone) restored.current.delete(id);
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
  }, [sessions, prefs]);

  const setPanelOpen = useCallback(
    (next: boolean) => {
      update((panel) => ({ ...panel, open: next }));
    },
    [update],
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
  const docked = open && !overlay;
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
      update((panel) => {
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
      });
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
    },
    [update],
  );
  const activate = useCallback(
    (id: string) => {
      update((panel) => ({ ...panel, activeId: id }));
    },
    [update],
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
    },
    [tabs, update, placeTab],
  );

  const openFile = useCallback<SidePanelController["openFile"]>(
    (absolutePath, line, ref) => {
      // 工作区外的文件不记工作区：标签显示所在目录名
      const workspace =
        active !== undefined && relativeTo(active.workspace, absolutePath) !== undefined
          ? active.workspace
          : undefined;
      openFileTab({ absolutePath, workspace, line, endLine: ref?.endLine });
    },
    [active, openFileTab],
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
      openInBrowser: (absolutePath: string) => host.openPath(absolutePath),
    }),
    [host, externalEditor],
  );
  const onAddress = useCallback(
    async (text: string): Promise<string | undefined> => {
      const target = parseAddress(text, workspace);
      if (target.kind === "invalid") return target.message;
      try {
        if (target.kind === "url") {
          const url = new URL(target.url);
          if (
            url.protocol === "http:" &&
            url.hostname !== "localhost" &&
            url.hostname !== "127.0.0.1"
          ) {
            return "只能打开 https 网址或本机 http 地址";
          }
          await host.openUrl(target.url);
        } else {
          await host.openPath(target.path);
        }
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [host, workspace],
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

  // 会话切走时快速打开跟着关掉：它列的是原会话的工作区
  useEffect(() => {
    setQuickOpen(false);
  }, [sessionId]);

  // ── 快捷键（只有桌面窗口挂这个 hook）；没有会话时面板相关快捷键都不响应 ──
  const keyState = useRef({ open, overview, quickOpen, settingsOpen, hasSession: false });
  keyState.current = {
    open,
    overview,
    quickOpen,
    settingsOpen,
    hasSession: sessionId !== null,
  };
  const actions = useRef({ newTab, openChanges, setPanelOpen, setOverviewOpen, openTerminal });
  actions.current = { newTab, openChanges, setPanelOpen, setOverviewOpen, openTerminal };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = keyState.current;
      const act = actions.current;
      if (event.key === "Escape") {
        // 浮层只由按钮和 Esc 关闭；别处已消费的 Esc（中断、菜单、搜索框）不算
        if (event.defaultPrevented || state.quickOpen || state.settingsOpen) return;
        if (state.overview) act.setOverviewOpen(false);
        return;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      const panelKey =
        (event.code === "Backquote" && !event.shiftKey) ||
        (!event.shiftKey && (key === "b" || key === "t" || key === "p")) ||
        (event.shiftKey && key === "g");
      if (!panelKey) return;
      // 仍然拦下浏览器默认行为（Ctrl+P 是打印）；没有会话时什么都不做
      event.preventDefault();
      if (!state.hasSession) return;
      if (event.code === "Backquote") {
        // Ctrl+`：已有终端就切过去，没有就新开一个
        act.openTerminal(true);
      } else if (key === "b") {
        act.setPanelOpen(!state.open);
      } else if (key === "t") {
        act.newTab();
      } else if (key === "g") {
        act.openChanges();
      } else if (key === "p") {
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const overviewVisible = overview && active !== undefined && !settingsOpen;
  const overviewDocked = overviewVisible && !open;
  const project =
    workspace === undefined
      ? ""
      : plainKey !== null && projectKey(workspace) === plainKey
        ? "对话"
        : projectName(workspace);

  /**
   * 要挂着的标签页：当前会话的全部标签，加上别的会话的终端（隐藏，进程继续跑）。
   * 按会话的固定顺序排，切换会话时终端的 DOM 不挪位置。
   */
  const panes = useMemo(() => {
    const ids = new Set(panels.keys());
    if (sessionId !== null) ids.add(sessionId);
    const list: PanelTab[] = [];
    for (const id of ids) {
      if (id === sessionId) list.push(...tabs);
      else list.push(...(panels.get(id)?.tabs ?? []).filter((t) => t.kind === "terminal"));
    }
    return list;
  }, [panels, sessionId, tabs]);

  // 没有会话时面板整个隐藏（首页、新建会话页），但别的会话的终端仍然挂着
  const panel = (
    <SidePanel
      hidden={!open}
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
    />
  );

  const mainOverlays = (
    <>
      <TitlebarButtons
        overviewOpen={overviewVisible}
        overviewDisabled={active === undefined}
        panelOpen={open}
        panelDisabled={sessionId === null}
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
          rightOffset={open && overlay ? shownWidth : 0}
          onOpenChanges={() => {
            openChanges();
          }}
        />
      )}
      {quickOpen && loadIndex !== undefined && active !== undefined && (
        <QuickOpen
          project={project}
          load={loadIndex}
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
    viewChanges: openChanges,
    bodyClass: docked ? " panel-docked" : "",
    mainClass: overviewDocked ? " ov-docked" : "",
    bodyRef: setBody,
    panel,
    mainOverlays,
  };
}
