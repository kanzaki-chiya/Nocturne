import { useEffect, useRef, useState } from "react";

import type { PinnedRow, ProjectNode, ProjectSort, SessionRow, SessionTree } from "./session-tree";
import { ICON_LG, ICON_SM, Icon } from "./ui";

/** 设置区的导航项（ADR-0046 2026-10-05 修订第 1 条；logs = 后台日志页） */
export type SettingsSection =
  | "general"
  | "models"
  | "providers"
  | "mcp"
  | "grants"
  | "skills"
  | "agents"
  | "browser"
  | "computer"
  | "remote"
  | "archive"
  | "appearance"
  | "usage"
  | "logs";

export interface SidebarProps {
  tree: SessionTree;
  pinnedIds: ReadonlySet<string>;
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  chatsExpanded: boolean;
  /** 「定时任务」分组已展开 */
  scheduledExpanded?: boolean;
  /** 启用中的定时任务数；还没读到时不显示 */
  enabledScheduleCount?: number | undefined;
  /** 主区正在显示定时任务页 */
  schedulesOpen?: boolean;
  onOpenSchedules?: () => void;
  onSearch?: () => void;
  onToggleScheduled?: () => void;
  /** 项目排序（菜单「排序」选择）；只有 manual 能拖动、上移下移 */
  projectSort: ProjectSort;
  /** 已移除（隐藏）的项目路径，菜单里逐个恢复 */
  hiddenProjects: readonly { path: string; name: string }[];
  onSelectSession: (id: string) => void;
  onToggleCollapse: (key: string) => void;
  onToggleExpand: (key: string) => void;
  onToggleChats: () => void;
  onSetSort: (sort: ProjectSort) => void;
  /** 手动模式调整顺序：把 key 移到可见列表的插入位置 toIndex（移动前的下标，0..n） */
  onMoveProject: (key: string, toIndex: number) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  /** 归档会话（ADR-0080）；运行中/待发输入时菜单项禁用 */
  onArchive: (id: string) => void;
  /** 状态之外还要提前挡住的归档（例如待发输入、正在关闭） */
  archiveBlocked?: ReadonlySet<string>;
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

const SETTINGS_NAV: { key: SettingsSection; label: string; icon: React.ReactNode }[] = [
  {
    key: "general",
    label: "常规",
    icon: <Icon name="settings_6" size={ICON_LG} className="glyph" />,
  },
  {
    key: "appearance",
    label: "外观",
    icon: <Icon name="sun" size={ICON_LG} className="glyph" />,
  },
  {
    key: "providers",
    label: "服务商",
    icon: <Icon name="cloud" size={ICON_LG} className="glyph" />,
  },
  {
    key: "models",
    label: "模型",
    icon: <Icon name="box_3" size={ICON_LG} className="glyph" />,
  },
  {
    key: "agents",
    label: "子代理",
    icon: <Icon name="robot" size={ICON_LG} className="glyph" />,
  },
  {
    key: "skills",
    label: "技能",
    icon: <Icon name="file" size={ICON_LG} className="glyph" />,
  },
  {
    key: "mcp",
    label: "MCP",
    icon: <Icon name="server" size={ICON_LG} className="glyph" />,
  },
  {
    key: "browser",
    label: "浏览器",
    icon: <Icon name="earth" size={ICON_LG} className="glyph" />,
  },
  {
    key: "computer",
    label: "电脑操控",
    icon: <Icon name="computer" size={ICON_LG} className="glyph" />,
  },
  {
    key: "grants",
    label: "授权",
    icon: <Icon name="safe_shield" size={ICON_LG} className="glyph" />,
  },
  {
    key: "remote",
    label: "远程",
    icon: <Icon name="cellphone" size={ICON_LG} className="glyph" />,
  },
  {
    key: "archive",
    label: "已归档的会话",
    icon: <Icon name="archive" size={ICON_LG} className="glyph" />,
  },
  {
    key: "usage",
    label: "用量",
    icon: <Icon name="chart_bar" size={ICON_LG} className="glyph" />,
  },
  {
    key: "logs",
    label: "后台日志",
    icon: <Icon name="terminal_box" size={ICON_LG} className="glyph" />,
  },
];

type MenuState =
  | { kind: "session"; x: number; y: number; id: string; pinned: boolean }
  | { kind: "project"; x: number; y: number; key: string; path: string; index: number }
  | { kind: "projects"; x: number; y: number };

function dotClass(row: SessionRow): string {
  if (row.status === "running") return "dot run";
  if (row.status === "pending") return "dot warn";
  if (row.mark === "error") return "dot err";
  if (row.mark === "done") return "dot ok";
  return "dot";
}

/**
 * 会话行右侧的短标签（ADR-0056）：待确认来自会话状态（请求被处理即消失），
 * 出错 / 已完成是本次运行里「你没看到就结束了」的留痕，打开会话即清除。
 * 运行中（running/pending）不显示旧留痕：新 Turn 开始时 App 已清掉它，
 * 这里再挡一道——事件竞态下旧标签也不会盖住进行态。
 * 没有标签时按原来的 meta（相对时间）显示。
 */
function rowTag(row: SessionRow): { text: string; cls: string } | null {
  if (row.status === "pending") return { text: "待确认", cls: "need" };
  if (row.status === "running") return null;
  if (row.mark === "error") return { text: "出错", cls: "err" };
  if (row.mark === "done") return { text: "已完成", cls: "done" };
  return null;
}

function RowButton({
  row,
  pinned,
  selected,
  onSelect,
  onContext,
  onMenu,
  editing,
  onCommit,
  onCancel,
  error,
}: {
  row: SessionRow;
  pinned?: { project: string };
  selected: boolean;
  onSelect: () => void;
  onContext: (e: React.MouseEvent) => void;
  /** 「…」按钮点击：在同一行右侧锚点打开右键同款菜单 */
  onMenu: (e: React.MouseEvent<HTMLButtonElement>) => void;
  editing: boolean;
  onCommit: (title: string) => void;
  onCancel: () => void;
  error?: string | undefined;
}) {
  const tag = rowTag(row);
  const composing = useRef(false);
  const cancelled = useRef(false);
  return (
    /* .irow 是容器 div：按钮不能嵌套按钮（悬停的「…」是兄弟元素） */
    <div className="irow" data-client-name={row.client?.name}>
      {editing ? (
        <input
          className="rename-input"
          aria-label="重命名会话"
          defaultValue={row.title}
          autoFocus
          onFocus={(e) => {
            e.currentTarget.select();
          }}
          onClick={(e) => {
            e.stopPropagation();
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            if (e.nativeEvent.isComposing || composing.current || e.nativeEvent.keyCode === 229)
              return;
            if (e.key === "Escape") {
              e.preventDefault();
              cancelled.current = true;
              onCancel();
            } else if (e.key === "Enter") {
              e.preventDefault();
              onCommit(e.currentTarget.value);
            }
          }}
          onBlur={(e) => {
            if (!cancelled.current) onCommit(e.currentTarget.value);
          }}
        />
      ) : (
        <button
          className={`item${selected ? " on" : ""}`}
          onClick={onSelect}
          onContextMenu={onContext}
        >
          <span className={dotClass(row)} />
          {row.client !== undefined && (
            <span
              className="session-client-icon"
              title={row.client.name}
              aria-label={row.client.name}
            >
              <Icon name="terminal" size={ICON_SM} />
            </span>
          )}
          <span className="t">{row.title}</span>
          {pinned !== undefined && <span className="proj">{pinned.project}</span>}
          {tag !== null ? (
            <span className={`tag ${tag.cls}`}>{tag.text}</span>
          ) : (
            pinned === undefined && <span className="meta">{row.meta}</span>
          )}
        </button>
      )}
      <button
        type="button"
        className="imenu"
        title="会话菜单"
        aria-label="会话菜单"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e);
        }}
      >
        …
      </button>
      {error && (
        <span className="rename-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<{ id: string; message: string } | null>(null);
  const renamePending = useRef(false);
  const [subOpen, setSubOpen] = useState<"sort" | "removed" | null>(null);
  /** 拖动中的项目 key 与插入位置（可见列表下标 0..n）；只在手动模式出现 */
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
      }
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
          <Icon name="arrow_left" size={ICON_LG} />
          返回<span className="k">Esc</span>
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
      </aside>
    );
  }

  const sessionMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setMenu({ kind: "session", x: e.clientX, y: e.clientY, id, pinned: props.pinnedIds.has(id) });
  };

  const manual = props.projectSort === "manual";
  const projects = props.tree.projects;
  /** 归档：运行中/等待确认由行状态挡住；待发输入等提前状态由 App 传入 */
  const archiveDisabled = (id: string): boolean => {
    if (props.archiveBlocked?.has(id) === true) return true;
    const rows = [
      ...props.tree.pinned,
      ...props.tree.chats.rows,
      ...props.tree.scheduled.rows,
      ...props.tree.projects.flatMap((project) => project.sessions),
    ];
    const row = rows.find((entry) => entry.id === id);
    return row === undefined || row.locked || row.status !== "idle";
  };

  const projectMenu = (e: React.MouseEvent, project: ProjectNode, index: number) => {
    e.preventDefault();
    setMenu({
      kind: "project",
      x: e.clientX,
      y: e.clientY,
      key: project.key,
      path: project.path,
      index,
    });
  };

  const endDrag = () => {
    setDragKey(null);
    setDropIndex(null);
  };
  // 插入位置等于原位置或其后一位时不算移动，不显示指示线
  const from = dragKey === null ? -1 : projects.findIndex((p) => p.key === dragKey);
  const effectiveDrop =
    dropIndex !== null && from >= 0 && dropIndex !== from && dropIndex !== from + 1
      ? dropIndex
      : null;

  const renderRow = (row: SessionRow, pinned?: PinnedRow) => (
    <RowButton
      key={`${row.id}:${renaming === row.id ? "editing" : "view"}`}
      row={row}
      {...(pinned !== undefined ? { pinned: { project: pinned.project } } : {})}
      selected={props.selectedId === row.id}
      editing={renaming === row.id}
      error={renameError?.id === row.id ? renameError.message : undefined}
      onCancel={() => {
        setRenaming(null);
      }}
      onCommit={(title) => {
        if (renamePending.current) return;
        setRenaming(null);
        if (title === row.title) return;
        renamePending.current = true;
        void props
          .onRename(row.id, title)
          .then(
            () => {
              setRenameError(null);
            },
            (reason: unknown) => {
              const locked =
                reason !== null &&
                typeof reason === "object" &&
                "code" in reason &&
                reason.code === "session_locked";
              setRenameError({
                id: row.id,
                message: locked
                  ? "这个会话正在别处打开，关掉后再改名"
                  : reason instanceof Error
                    ? reason.message
                    : String(reason),
              });
            },
          )
          .finally(() => {
            renamePending.current = false;
          });
      }}
      onSelect={() => {
        props.onSelectSession(row.id);
      }}
      onContext={(e) => {
        sessionMenu(e, row.id);
      }}
      onMenu={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setSubOpen(null);
        setMenu({
          kind: "session",
          x: rect.left,
          y: rect.bottom + 4,
          id: row.id,
          pinned: props.pinnedIds.has(row.id),
        });
      }}
    />
  );

  const renderProject = (project: ProjectNode, index: number) => {
    const collapsed = props.collapsed.has(project.key);
    const expanded = props.expanded.has(project.key);
    let cls = "grp";
    if (dragKey === project.key) cls += " dragging";
    if (effectiveDrop === index) cls += " drop-before";
    if (effectiveDrop === projects.length && index === projects.length - 1) cls += " drop-after";
    return (
      <div
        className={cls}
        key={project.key}
        data-project-key={project.key}
        // 落点按整个项目组（标题 + 会话）计算：上半区插在它前面，下半区插在它后面
        onDragOver={(e) => {
          if (dragKey === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          setDropIndex(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
        }}
        onDrop={(e) => {
          if (dragKey === null) return;
          e.preventDefault();
          if (effectiveDrop !== null) props.onMoveProject(dragKey, effectiveDrop);
          endDrag();
        }}
      >
        {/* .gh 是容器 div：按钮不能嵌套按钮（悬停的「＋」是兄弟元素） */}
        <div
          className="gh"
          // HTML5 拖放：浏览器自带拖动阈值，单击标题仍是折叠/展开
          draggable={manual}
          onDragStart={
            manual
              ? (e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", project.key);
                  setMenu(null);
                  setDragKey(project.key);
                }
              : undefined
          }
          onDragEnd={manual ? endDrag : undefined}
        >
          <button
            className="gh-toggle"
            onClick={() => {
              props.onToggleCollapse(project.key);
            }}
            onContextMenu={(e) => {
              projectMenu(e, project, index);
            }}
          >
            <Icon
              name="right_small"
              size={ICON_SM}
              className={`tw fold-arrow${collapsed ? "" : " down"}`}
            />
            <Icon name="folder" size={ICON_LG} className="fold" />
            <span className="gname">{project.name}</span>
            <span className="gh-right">
              {collapsed && <span className="meta">{project.count}</span>}
            </span>
          </button>
          <button
            className="gmenu"
            title={`${project.name} 菜单`}
            aria-label="项目菜单"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setSubOpen(null);
              setMenu({
                kind: "project",
                x: rect.left,
                y: rect.bottom + 4,
                key: project.key,
                path: project.path,
                index,
              });
            }}
          >
            …
          </button>
          <button
            className="gadd"
            title={`在 ${project.name} 新建会话`}
            onClick={(e) => {
              e.stopPropagation();
              props.onNewSession(project.path);
            }}
          >
            <Icon name="add" size={ICON_SM} />
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
          <Icon name="add" size={ICON_LG} className="glyph" />
          新会话
        </button>
        <button type="button" className="item" onClick={props.onSearch}>
          <Icon name="search" size={ICON_LG} className="glyph" />
          <span className="t">搜索</span>
        </button>
        <button
          type="button"
          className={`item${props.schedulesOpen === true ? " on" : ""}`}
          aria-current={props.schedulesOpen === true ? "page" : undefined}
          onClick={() => {
            props.onOpenSchedules?.();
          }}
        >
          <Icon name="time" size={ICON_LG} className="glyph" />
          <span className="t">定时任务</span>
          {props.enabledScheduleCount !== undefined && (
            <span className="meta">{props.enabledScheduleCount}</span>
          )}
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
        {props.tree.scheduled.rows.length > 0 && (
          <>
            <h4>定时任务</h4>
            <nav className="nav" aria-label="定时任务会话">
              {props.tree.scheduled.rows.map((row) => renderRow(row))}
              {props.tree.scheduled.moreCount > 0 && (
                <button
                  className="item more flat"
                  onClick={() => {
                    props.onToggleScheduled?.();
                  }}
                >
                  展开显示（还有 {props.tree.scheduled.moreCount} 个）
                </button>
              )}
              {props.scheduledExpanded === true && (
                <button
                  className="item more flat"
                  onClick={() => {
                    props.onToggleScheduled?.();
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
              <Icon name="add" size={ICON_SM} />
            </button>
          </span>
        </div>
        {projects.map(renderProject)}
      </div>
      {menu !== null && (
        <div className="ctxmenu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menu.kind === "session" && (
            <>
              <button
                autoFocus
                onClick={() => {
                  if (menu.pinned) props.onUnpin(menu.id);
                  else props.onPin(menu.id);
                  setMenu(null);
                }}
              >
                {menu.pinned ? "取消置顶" : "置顶"}
              </button>
              <button
                onClick={() => {
                  setRenameError(null);
                  setRenaming(menu.id);
                  setMenu(null);
                }}
              >
                重命名
              </button>
              <button
                disabled={archiveDisabled(menu.id)}
                onClick={() => {
                  props.onArchive(menu.id);
                  setMenu(null);
                }}
              >
                归档
              </button>
            </>
          )}
          {menu.kind === "project" && (
            <>
              {manual && (
                <>
                  <button
                    autoFocus={menu.index > 0}
                    disabled={menu.index <= 0}
                    onClick={() => {
                      props.onMoveProject(menu.key, menu.index - 1);
                      setMenu(null);
                    }}
                  >
                    上移
                  </button>
                  <button
                    autoFocus={menu.index === 0 && projects.length > 1}
                    disabled={menu.index >= projects.length - 1}
                    onClick={() => {
                      props.onMoveProject(menu.key, menu.index + 2);
                      setMenu(null);
                    }}
                  >
                    下移
                  </button>
                </>
              )}
              <button
                autoFocus={!manual || projects.length <= 1}
                onClick={() => {
                  props.onHideProject(menu.path);
                  setMenu(null);
                }}
              >
                从列表移除
              </button>
            </>
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
                <Icon name="right_small" size={ICON_SM} className="arr fold-arrow" />
                <div className="ctxmenu sub">
                  {(
                    [
                      ["manual", "手动"],
                      ["name", "名称"],
                      ["activity", "最近活动"],
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
                <Icon name="right_small" size={ICON_SM} className="arr fold-arrow" />
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
          <Icon name="settings_1" size={ICON_LG} className="glyph" />
          设置
        </button>
      </nav>
    </aside>
  );
}
