/**
 * 右侧面板的状态与接线（ADR-0060 第 1 轮）：标签、宽度、开关、概览浮层、
 * 快捷键与偏好持久化。App 只拿回打开入口和要渲染的节点，状态不进 App。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TurnChangeDiff, WorkspaceFileContent } from "@nocturne/core/protocol";

import type { OpenConversation } from "./conversations";
import type { DesktopHost } from "./host";
import { QuickOpen, SessionOverview, TitlebarButtons } from "./PanelChrome";
import type { PrefsStore } from "./prefs";
import { projectKey, projectName } from "./session-tree";
import { SidePanel, type PanelChangesSource } from "./SidePanel";
import {
  baseName,
  clampPanelWidth,
  joinWorkspace,
  moveTab,
  nextActiveAfterClose,
  PANEL_DEFAULT_WIDTH,
  panelOverlays,
  parseAddress,
  restoreTabs,
  samePath,
  sessionChangeTotals,
  storedTabs,
  type FileTab,
  type PanelTab,
} from "./side-panel";

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `t${Date.now().toString(36)}${tabSeq.toString(36)}`;
}

/** 文件标签读取时没有这个工作区的已打开会话 */
class NoSessionError extends Error {
  readonly code = "session_unavailable";
}

export interface SidePanelController {
  /** 文件引用左键（打开文件用 = Nocturne 面板）：在文件标签里打开并定位 */
  openFile: (
    absolutePath: string,
    line?: number,
    ref?: { relativePath?: string | undefined; endLine?: number | undefined },
  ) => void;
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
  active,
  opened,
  loadDiff,
  editors,
  settingsOpen,
  plainKey,
}: {
  prefs: PrefsStore;
  host: DesktopHost;
  active: OpenConversation | undefined;
  opened: () => Iterable<OpenConversation>;
  loadDiff: (entry: OpenConversation, seq: number, path: string) => Promise<TurnChangeDiff>;
  editors: { vscode: boolean; cursor: boolean };
  /** 设置区盖住主区时概览浮层隐藏、Esc 归设置区 */
  settingsOpen: boolean;
  /** 普通对话的项目键：概览里显示「对话」而不是目录名 */
  plainKey: string | null;
}): SidePanelController {
  const initial = useMemo(() => {
    const p = prefs.get();
    return {
      open: p.panelOpen === true,
      width: p.panelWidth ?? PANEL_DEFAULT_WIDTH,
      overview: p.overviewOpen === true,
      ...restoreTabs(p.panelTabs, p.panelActiveTab, newTabId),
    };
  }, [prefs]);
  const [open, setOpen] = useState(initial.open);
  const [width, setWidth] = useState(initial.width);
  const [overview, setOverview] = useState(initial.overview);
  const [tabs, setTabs] = useState<PanelTab[]>(initial.tabs);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [quickOpen, setQuickOpen] = useState(false);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [bodySize, setBodySize] = useState({ width: 0, sidebar: 0 });

  // ── 持久化 ──
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    prefs.update({ panelTabs: storedTabs(tabs), panelActiveTab: activeId });
  }, [prefs, tabs, activeId]);
  const setPanelOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      prefs.update({ panelOpen: next });
    },
    [prefs],
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

  // ── 标签操作 ──
  /** 新增标签：选中的是新标签页时替换它，否则插在选中标签右边 */
  const placeTab = useCallback(
    (tab: PanelTab) => {
      setTabs((current) => {
        const index = current.findIndex((t) => t.id === activeId);
        const at = current[index];
        if (at?.kind === "new") return current.map((t) => (t.id === activeId ? tab : t));
        const next = [...current];
        next.splice(index < 0 ? next.length : index + 1, 0, tab);
        return next;
      });
      setActiveId(tab.id);
      setPanelOpen(true);
    },
    [activeId, setPanelOpen],
  );
  const newTab = useCallback(() => {
    const id = newTabId();
    setTabs((current) => {
      const index = current.findIndex((t) => t.id === activeId);
      const next = [...current];
      next.splice(index < 0 ? next.length : index + 1, 0, { id, kind: "new" });
      return next;
    });
    setActiveId(id);
    setPanelOpen(true);
  }, [activeId, setPanelOpen]);
  const closeTab = useCallback(
    (id: string) => {
      const rest = tabs.filter((t) => t.id !== id);
      if (rest.length === 0) {
        // 关掉最后一个标签：留一个新标签页，面板不收起
        const fresh = newTabId();
        setTabs([{ id: fresh, kind: "new" }]);
        setActiveId(fresh);
        return;
      }
      setTabs(rest);
      setActiveId(nextActiveAfterClose(tabs, id, activeId) ?? rest[0]?.id ?? "");
    },
    [tabs, activeId],
  );
  const openChanges = useCallback(
    (seq?: number) => {
      const existing = tabs.find((t) => t.kind === "changes");
      if (existing !== undefined) {
        setTabs((current) =>
          current.map((t) =>
            t.id === existing.id && t.kind === "changes"
              ? { ...t, focusSeq: seq, focusNonce: (t.focusNonce ?? 0) + 1 }
              : t,
          ),
        );
        setActiveId(existing.id);
        setPanelOpen(true);
        return;
      }
      placeTab({ id: newTabId(), kind: "changes", focusSeq: seq, focusNonce: 1 });
    },
    [tabs, placeTab, setPanelOpen],
  );
  const openFileTab = useCallback(
    (file: Omit<FileTab, "id" | "kind" | "focusNonce">) => {
      const existing = tabs.find(
        (t): t is FileTab => t.kind === "file" && samePath(t.absolutePath, file.absolutePath),
      );
      if (existing !== undefined) {
        setTabs((current) =>
          current.map((t) =>
            t.id === existing.id && t.kind === "file"
              ? {
                  ...t,
                  line: file.line,
                  endLine: file.endLine,
                  focusNonce: (t.focusNonce ?? 0) + 1,
                }
              : t,
          ),
        );
        setActiveId(existing.id);
        setPanelOpen(true);
        return;
      }
      placeTab({ id: newTabId(), kind: "file", ...file, focusNonce: 1 });
    },
    [tabs, placeTab, setPanelOpen],
  );

  const openFile = useCallback<SidePanelController["openFile"]>(
    (absolutePath, line, ref) => {
      if (active === undefined) return;
      const workspace = active.workspace;
      const relative =
        ref?.relativePath ??
        (absolutePath.toLowerCase().startsWith(workspace.toLowerCase())
          ? absolutePath.slice(workspace.length).replace(/^[\\/]+/, "")
          : baseName(absolutePath));
      openFileTab({
        workspace,
        sessionId: active.session.id,
        absolutePath,
        relativePath: relative,
        line,
        endLine: ref?.endLine,
      });
    },
    [active, openFileTab],
  );

  // ── 读取：经同一工作区的已打开会话 ──
  const sessionFor = useCallback(
    (tab: FileTab): OpenConversation | undefined => {
      if (active !== undefined && active.dead !== true && samePath(active.workspace, tab.workspace))
        return active;
      for (const entry of opened()) {
        if (entry.dead !== true && samePath(entry.workspace, tab.workspace)) return entry;
      }
      return undefined;
    },
    [active, opened],
  );
  const readFile = useCallback(
    async (tab: FileTab): Promise<WorkspaceFileContent> => {
      const entry = sessionFor(tab);
      if (entry === undefined) {
        throw new NoSessionError(
          `打开「${projectName(tab.workspace)}」里的一个会话后才能读取这个文件`,
        );
      }
      return entry.session.readFile(tab.absolutePath);
    },
    [sessionFor],
  );
  const readKey = useCallback((tab: FileTab) => sessionFor(tab)?.session.id ?? "", [sessionFor]);

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
      const target = parseAddress(text, active?.workspace);
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
    [host, active?.workspace],
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

  // ── 快捷键（只有桌面窗口挂这个 hook） ──
  const keyState = useRef({ open, overview, quickOpen, settingsOpen, hasSession: false });
  keyState.current = {
    open,
    overview,
    quickOpen,
    settingsOpen,
    hasSession: active !== undefined,
  };
  const actions = useRef({ newTab, openChanges, setPanelOpen, setOverviewOpen });
  actions.current = { newTab, openChanges, setPanelOpen, setOverviewOpen };
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
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        act.setPanelOpen(!state.open);
      } else if (key === "t" && !event.shiftKey) {
        event.preventDefault();
        act.newTab();
      } else if (key === "g" && event.shiftKey) {
        event.preventDefault();
        if (state.hasSession) act.openChanges();
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        if (state.hasSession) setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const overviewVisible = overview && active !== undefined && !settingsOpen;
  const overviewDocked = overviewVisible && !open;
  const workspace = active?.workspace;
  const project =
    workspace === undefined
      ? ""
      : plainKey !== null && projectKey(workspace) === plainKey
        ? "对话"
        : projectName(workspace);

  const panel = open ? (
    <SidePanel
      tabs={tabs}
      activeId={activeId}
      overlay={overlay}
      width={shownWidth}
      onActivate={setActiveId}
      onCloseTab={closeTab}
      onMoveTab={(from, to) => {
        setTabs((current) => moveTab(current, from, to));
      }}
      onNewTab={newTab}
      onResize={onResize}
      onOpenChanges={() => {
        openChanges();
      }}
      onQuickOpen={() => {
        setQuickOpen(true);
      }}
      onAddress={onAddress}
      changes={changes}
      canOpenFiles={active !== undefined}
      readFile={readFile}
      readKey={readKey}
      fileActions={fileActions}
    />
  ) : null;

  const mainOverlays = (
    <>
      <TitlebarButtons
        overviewOpen={overviewVisible}
        overviewDisabled={active === undefined}
        panelOpen={open}
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
      {quickOpen && loadIndex !== undefined && workspace !== undefined && (
        <QuickOpen
          project={project}
          load={loadIndex}
          onClose={() => {
            setQuickOpen(false);
          }}
          onPick={(relativePath) => {
            setQuickOpen(false);
            const session = active?.session;
            if (session === undefined) return;
            openFileTab({
              workspace,
              sessionId: session.id,
              absolutePath: joinWorkspace(workspace, relativePath),
              relativePath,
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
