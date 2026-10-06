import { useEffect, useRef, useState } from "react";

import type { PinnedRow, ProjectNode, SessionRow, SessionTree } from "./session-tree";

/** 设置区的导航项（ADR-0046 2026-10-05 修订第 1 条；logs = 后台日志页） */
export type SettingsSection =
  "general" | "models" | "providers" | "mcp" | "skills" | "appearance" | "logs";

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
  /** 设置区当前导航项；null = 会话/空状态（左栏显示会话树） */
  page?: SettingsSection | null;
  /** 进入设置区或在导航项之间切换 */
  onOpenPage?: (page: SettingsSection) => void;
  /** 「← 返回」：回到进入设置前的会话或空状态 */
  onLeaveSettings?: () => void;
}

const GLYPH_PROPS = {
  className: "glyph",
  viewBox: "0 0 16 16",
  width: 15,
  height: 15,
  "aria-hidden": true,
} as const;

const SETTINGS_NAV: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
  {
    key: "general",
    label: "常规",
    icon: (
      <svg {...GLYPH_PROPS}>
        <path
          d="M2.5 4.5h11M2.5 11.5h11"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle
          cx="10.5"
          cy="4.5"
          r="1.7"
          fill="var(--a-side)"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <circle
          cx="5.5"
          cy="11.5"
          r="1.7"
          fill="var(--a-side)"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
    ),
  },
  {
    key: "models",
    label: "模型",
    icon: (
      <svg {...GLYPH_PROPS}>
        <path
          d="M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8zM2.5 4.8 8 7.8l5.5-3M8 7.8v6.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: "providers",
    label: "服务商",
    icon: (
      <svg {...GLYPH_PROPS}>
        <path
          d="M5.5 1.8v3M10.5 1.8v3M3.5 4.8h9v2.6a4.5 4.5 0 0 1-9 0zM8 11.9v2.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: "mcp",
    label: "MCP",
    icon: (
      <svg {...GLYPH_PROPS}>
        <path d="M2 3h12v4H2zM2 10h12v4H2zM5 5h5M5 12h5" fill="none" stroke="currentColor" />
      </svg>
    ),
  },
  {
    key: "skills",
    label: "技能",
    icon: (
      <svg {...GLYPH_PROPS}>
        <path d="M3 2h7l3 3v9H3zM5 7h6M5 10h5" fill="none" stroke="currentColor" />
      </svg>
    ),
  },
  {
    key: "appearance",
    label: "外观",
    icon: (
      <svg {...GLYPH_PROPS}>
        <circle cx="8" cy="8" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    key: "logs",
    label: "后台日志",
    icon: (
      <svg {...GLYPH_PROPS}>
        <rect
          x="1.8"
          y="2.5"
          width="12.4"
          height="11"
          rx="1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path
          d="M4.4 6.2l2.3 1.9-2.3 1.9M7.8 10h3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

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

  // 设置区：左栏整列换成设置导航，会话树不显示
  if (props.page !== undefined && props.page !== null) {
    const page = props.page;
    return (
      <aside className="side snav">
        <button
          type="button"
          className="sback"
          onClick={() => {
            props.onLeaveSettings?.();
          }}
        >
          ← 返回<span className="k">Esc</span>
        </button>
        <h4>设置</h4>
        <nav className="nav" aria-label="设置">
          {SETTINGS_NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`item${page === item.key ? " on" : ""}`}
              aria-current={page === item.key ? "page" : undefined}
              onClick={() => {
                props.onOpenPage?.(item.key);
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="ver">设置保存在 ~/.nocturne，主题只存在本机</div>
      </aside>
    );
  }

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
      <nav className="nav foot" aria-label="页面">
        <button type="button" className="item" onClick={() => props.onOpenPage?.("general")}>
          <svg className="glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4-1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
          设置
        </button>
      </nav>
    </aside>
  );
}
