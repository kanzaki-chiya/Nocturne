import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PageLibraryItem,
  PageLibraryListResult,
  PageLibraryProject,
  PageLibraryProjectsResult,
} from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";

import { Dropdown } from "./Dropdown";
import { ICON_MD, ICON_SM, Icon } from "./ui";
import "./pages.css";
import "./page-library.css";

/** 页面库只用到的运行时方法，方便单测注入 */
export interface PageLibraryApi {
  listPages(input?: {
    workspaceRoot?: string | undefined;
    projectKey?: string | undefined;
  }): Promise<PageLibraryListResult>;
  listPageProjects(input?: {
    workspaceRoot?: string | undefined;
  }): Promise<PageLibraryProjectsResult>;
}

export interface PageLibraryPageProps {
  api: PageLibraryApi | RpcClient["runtime"] | undefined;
  /** 当前会话或默认工作区路径，用于确定默认选中的项目 */
  currentWorkspaceRoot?: string | undefined;
  /** 外部状态变化时递增，驱动页面库静默刷新 */
  version?: number | undefined;
  /** 已置顶的页面来源键（originKey） */
  pinnedOriginKeys: ReadonlySet<string>;
  onPin: (originKey: string) => void;
  onUnpin: (originKey: string) => void;
  onOpenPage: (item: PageLibraryItem) => void;
}

interface RowContextMenu {
  x: number;
  y: number;
  originKey: string;
  pinned: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 今天显示 HH:mm，否则显示 MM-DD（ADR-0114 第 4 节） */
export function formatPageUpdatedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function PageLibraryPage({
  api,
  currentWorkspaceRoot,
  version = 0,
  pinnedOriginKeys,
  onPin,
  onUnpin,
  onOpenPage,
}: PageLibraryPageProps) {
  const [projects, setProjects] = useState<PageLibraryProject[]>([]);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | undefined>(undefined);
  const [fallbackProjectName, setFallbackProjectName] = useState<string>("");
  const [items, setItems] = useState<PageLibraryItem[]>([]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<RowContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const userSelectedRef = useRef<string | undefined>(undefined);
  const reqGenRef = useRef(0);

  const load = useCallback(
    async (explicitProjectKey?: string) => {
      if (api === undefined) return;
      const gen = ++reqGenRef.current;
      try {
        const projRes = await api.listPageProjects(
          currentWorkspaceRoot !== undefined ? { workspaceRoot: currentWorkspaceRoot } : undefined,
        );
        if (gen !== reqGenRef.current) return;
        setProjects(projRes.projects);
        setFallbackProjectName(projRes.currentProjectName);

        const targetKey =
          explicitProjectKey ?? userSelectedRef.current ?? projRes.currentProjectKey;
        setSelectedProjectKey(targetKey);

        const listRes = await api.listPages({ projectKey: targetKey });
        if (gen !== reqGenRef.current) return;
        setItems(listRes.items);
      } catch {
        // 保持上一次成功的数据或空态，不额外展示说明文字（ADR-0114 第 4 节）
      }
    },
    [api, currentWorkspaceRoot],
  );

  useEffect(() => {
    void load();
    return () => {
      reqGenRef.current += 1;
    };
  }, [load, version]);

  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
      }
    };
    const onDismiss = () => {
      setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [menu]);

  const projectOptions = useMemo(
    () =>
      projects.map((proj) => ({
        value: proj.key,
        label: proj.name,
      })),
    [projects],
  );

  const { pinnedItems, recentItems } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered =
      q === ""
        ? items
        : items.filter(
            (item) =>
              item.title.toLowerCase().includes(q) || item.sessionTitle.toLowerCase().includes(q),
          );
    const byRecent = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return Number.isNaN(diff) ? 0 : diff;
    });
    const pinned: PageLibraryItem[] = [];
    const recent: PageLibraryItem[] = [];
    for (const item of byRecent) {
      if (pinnedOriginKeys.has(item.originKey)) pinned.push(item);
      else recent.push(item);
    }
    return { pinnedItems: pinned, recentItems: recent };
  }, [items, query, pinnedOriginKeys]);

  const handleSelectProject = (key: string) => {
    userSelectedRef.current = key;
    setSelectedProjectKey(key);
    setMenu(null);
    void load(key);
  };

  const openContextMenu = (event: React.MouseEvent<HTMLButtonElement>, item: PageLibraryItem) => {
    event.preventDefault();
    const menuWidth = 148;
    const menuHeight = 40;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
    setMenu({
      x,
      y,
      originKey: item.originKey,
      pinned: pinnedOriginKeys.has(item.originKey),
    });
  };

  const renderRow = (item: PageLibraryItem, pinned: boolean) => (
    <button
      key={item.originKey}
      type="button"
      className="plib-row"
      onClick={() => {
        onOpenPage(item);
      }}
      onContextMenu={(event) => {
        openContextMenu(event, item);
      }}
    >
      <Icon name={pinned ? "pin" : "file"} size={ICON_MD} className="plib-icon" />
      <span className="plib-title">{item.title}</span>
      <span className="plib-session">{item.sessionTitle}</span>
      <span className="plib-ver">v{item.version}</span>
      <span className="plib-time">{formatPageUpdatedAt(item.updatedAt)}</span>
    </button>
  );

  const hasRows = pinnedItems.length > 0 || recentItems.length > 0;

  return (
    <div className="page3 plib-page">
      <div className="spage flush">
        <header className="plib-head">
          <h1>页面</h1>
          <div className="plib-controls">
            <div className="plib-proj">
              <Dropdown
                label="项目"
                value={selectedProjectKey}
                options={projectOptions}
                placeholder={fallbackProjectName}
                emptyText={null}
                disabled={projectOptions.length === 0 ? "" : undefined}
                onChange={handleSelectProject}
              />
            </div>
            <label className="plib-search">
              <Icon name="search" size={ICON_SM} className="plib-search-icon" />
              <input
                type="search"
                aria-label="搜索"
                placeholder="搜索"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </label>
          </div>
        </header>
        {hasRows && (
          <div className="plib-body">
            {pinnedItems.length > 0 && (
              <section className="plib-section" aria-label="置顶">
                <div className="plib-group">置顶</div>
                <div className="plib-list">{pinnedItems.map((item) => renderRow(item, true))}</div>
              </section>
            )}
            {recentItems.length > 0 && (
              <section className="plib-section" aria-label="最近">
                <div className="plib-group">最近</div>
                <div className="plib-list">{recentItems.map((item) => renderRow(item, false))}</div>
              </section>
            )}
          </div>
        )}
      </div>
      {menu !== null && (
        <div className="ctxmenu" role="menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              if (menu.pinned) onUnpin(menu.originKey);
              else onPin(menu.originKey);
              setMenu(null);
            }}
          >
            {menu.pinned ? "取消置顶" : "置顶"}
          </button>
        </div>
      )}
    </div>
  );
}
