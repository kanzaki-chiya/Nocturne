import { useEffect, useRef, useState } from "react";

import type { PinnedRow, ProjectNode, SessionRow, SessionTree } from "./session-tree";

export interface SidebarProps {
  tree: SessionTree;
  pinnedIds: ReadonlySet<string>;
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  chatsExpanded: boolean;
  /** 项目排序（菜单「排序」选择） */
  projectSort: "activity" | "name";
  /** 已移除（隐藏）的项目路径，菜单里逐个恢复 */
  hiddenProjects: readonly { path: string; name: string }[];
  onSelectSession: (id: string) => void;
  onToggleCollapse: (key: string) => void;
  onToggleExpand: (key: string) => void;
  onToggleChats: () => void;
  onSetSort: (sort: "activity" | "name") => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onHideProject: (path: string) => void;
  onRestoreProject: (path: string) => void;
  onOpenProject: () => void;
  onNewSession: (workspace?: string) => void;
}

type MenuState =
  | { kind: "session"; x: number; y: number; id: string; pinned: boolean }
  | { kind: "project"; x: number; y: number; key: string; path: string }
  | { kind: "projects"; x: number; y: number };

function dotClass(row: SessionRow): string {
  if (row.status === "running") return "dot run";
  if (row.status === "pending") return "dot warn";
  return "dot";
}

const FOLD_OPEN = "M1.5 4.5v8h11l2-5.5H4l-2 5.5M1.5 4.5V3h4l1.5 1.5h5.5V7";
const FOLD_CLOSED = "M1.5 3h4l1.5 1.5h7.5v8h-13z";

function FoldIcon({ open }: { open: boolean }) {
  return (
    <svg className="fold" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={open ? FOLD_OPEN : FOLD_CLOSED}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RowButton({
  row,
  pinned,
  selected,
  onSelect,
  onContext,
}: {
  row: SessionRow;
  pinned?: { project: string };
  selected: boolean;
  onSelect: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  return (
    <button className={`item${selected ? " on" : ""}`} onClick={onSelect} onContextMenu={onContext}>
      <span className={dotClass(row)} />
      <span className="t">{row.title}</span>
      {pinned !== undefined ? (
        <>
          <span className="proj">{pinned.project}</span>
          {row.status === "pending" && <span className="meta pend">待确认</span>}
        </>
      ) : (
        <span className={`meta${row.status === "pending" ? " pend" : ""}`}>{row.meta}</span>
      )}
    </button>
  );
}

export function Sidebar(props: SidebarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [subOpen, setSubOpen] = useState<"sort" | "removed" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  const sessionMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setMenu({ kind: "session", x: e.clientX, y: e.clientY, id, pinned: props.pinnedIds.has(id) });
  };

  const projectMenu = (e: React.MouseEvent, project: ProjectNode) => {
    e.preventDefault();
    setMenu({ kind: "project", x: e.clientX, y: e.clientY, key: project.key, path: project.path });
  };

  const renderRow = (row: SessionRow, pinned?: PinnedRow) => (
    <RowButton
      key={row.id}
      row={row}
      {...(pinned !== undefined ? { pinned: { project: pinned.project } } : {})}
      selected={props.selectedId === row.id}
      onSelect={() => {
        props.onSelectSession(row.id);
      }}
      onContext={(e) => {
        sessionMenu(e, row.id);
      }}
    />
  );

  const renderProject = (project: ProjectNode) => {
    const collapsed = props.collapsed.has(project.key);
    const expanded = props.expanded.has(project.key);
    return (
      <div className="grp" key={project.key}>
        {/* .gh 是容器 div：按钮不能嵌套按钮（悬停的「＋」是兄弟元素） */}
        <div className="gh">
          <button
            className="gh-toggle"
            onClick={() => {
              props.onToggleCollapse(project.key);
            }}
            onContextMenu={(e) => {
              projectMenu(e, project);
            }}
          >
            <span className="tw">{collapsed ? "▸" : "▾"}</span>
            <FoldIcon open={!collapsed} />
            <span className="gname">{project.name}</span>
            <span className="gh-right">
              {collapsed && <span className="meta">{project.count}</span>}
            </span>
          </button>
          <button
            className="gadd"
            title={`在 ${project.name} 新建会话`}
            onClick={(e) => {
              e.stopPropagation();
              props.onNewSession(project.path);
            }}
          >
            ＋
          </button>
        </div>
        {!collapsed && (
          <nav className="nav sub">
            {project.sessions.map((row) => renderRow(row))}
            {project.moreCount > 0 && (
              <button
                className="item more"
                onClick={() => {
                  props.onToggleExpand(project.key);
                }}
              >
                展开显示（还有 {project.moreCount} 个）
              </button>
            )}
            {expanded && project.count > 0 && (
              <button
                className="item more"
                onClick={() => {
                  props.onToggleExpand(project.key);
                }}
              >
                收起
              </button>
            )}
          </nav>
        )}
      </div>
    );
  };

  return (
    <aside className="side">
      <div className="shead">
        <span className="brand">Nocturne</span>
      </div>
      <nav className="nav">
        <button
          className="item add"
          onClick={() => {
            props.onNewSession();
          }}
        >
          <span className="glyph">＋</span>新会话
        </button>
      </nav>
      <div className="tree">
        {props.tree.pinned.length > 0 && (
          <>
            <h4>置顶</h4>
            <nav className="nav">{props.tree.pinned.map((row) => renderRow(row, row))}</nav>
          </>
        )}
        {props.tree.chats.rows.length > 0 && (
          <>
            <h4>对话</h4>
            <nav className="nav">
              {props.tree.chats.rows.map((row) => renderRow(row))}
              {props.tree.chats.moreCount > 0 && (
                <button
                  className="item more flat"
                  onClick={() => {
                    props.onToggleChats();
                  }}
                >
                  展开显示（还有 {props.tree.chats.moreCount} 个）
                </button>
              )}
              {props.chatsExpanded && (
                <button
                  className="item more flat"
                  onClick={() => {
                    props.onToggleChats();
                  }}
                >
                  收起
                </button>
              )}
            </nav>
          </>
        )}
        <div className={`h4row${menu?.kind === "projects" ? " menu-open" : ""}`}>
          <h4>项目</h4>
          <span className="hbtns">
            <button
              className="hb"
              title="项目菜单"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setSubOpen(null);
                setMenu({ kind: "projects", x: rect.left, y: rect.bottom + 4 });
              }}
            >
              …
            </button>
            <button
              className="hb"
              title="打开项目…"
              onClick={() => {
                props.onOpenProject();
              }}
            >
              ＋
            </button>
          </span>
        </div>
        {props.tree.projects.map(renderProject)}
      </div>
      {menu !== null && (
        <div className="ctxmenu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menu.kind === "session" && (
            <button
              onClick={() => {
                if (menu.pinned) props.onUnpin(menu.id);
                else props.onPin(menu.id);
                setMenu(null);
              }}
            >
              {menu.pinned ? "取消置顶" : "置顶"}
            </button>
          )}
          {menu.kind === "project" && (
            <button
              onClick={() => {
                props.onHideProject(menu.path);
                setMenu(null);
              }}
            >
              从列表移除
            </button>
          )}
          {menu.kind === "projects" && (
            <>
              {/* .mi 是 div+tabIndex：子菜单里还有按钮，不能用 <button> 嵌套 */}
              <div
                className={`mi has-sub${subOpen === "sort" ? " open" : ""}`}
                role="button"
                tabIndex={0}
                autoFocus
                onMouseEnter={() => {
                  setSubOpen("sort");
                }}
                onClick={() => {
                  setSubOpen("sort");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSubOpen("sort");
                  }
                }}
              >
                <span>排序</span>
                <span className="arr">▸</span>
                <div className="ctxmenu sub">
                  {(
                    [
                      ["activity", "最近活动"],
                      ["name", "名称"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => {
                        props.onSetSort(value);
                        setMenu(null);
                      }}
                    >
                      <span className="ck">{props.projectSort === value ? "✓" : ""}</span>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div
                className={`mi has-sub${subOpen === "removed" ? " open" : ""}`}
                role="button"
                tabIndex={0}
                onMouseEnter={() => {
                  setSubOpen("removed");
                }}
                onClick={() => {
                  setSubOpen("removed");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSubOpen("removed");
                  }
                }}
              >
                <span>已移除的项目…</span>
                <span className="arr">▸</span>
                <div className="ctxmenu sub">
                  {props.hiddenProjects.length === 0 ? (
                    <button disabled>（没有已移除的项目）</button>
                  ) : (
                    props.hiddenProjects.map((p) => (
                      <button
                        key={p.path}
                        title={p.path}
                        onClick={() => {
                          props.onRestoreProject(p.path);
                          setMenu(null);
                        }}
                      >
                        {p.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
