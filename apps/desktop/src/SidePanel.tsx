/**
 * 右侧面板（ADR-0060）：标签栏、新标签页、「变更」「文件」两种标签。
 * 面板只读：撤销仍在对话里的改动卡片上，文件第一版不能编辑。
 * 状态（标签、宽度、开关）由 App 持有并存进本机偏好；这里只管渲染与交互。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { TurnChangeDiff, TurnChanges, WorkspaceFileContent } from "@nocturne/core/protocol";
import { RpcError } from "@nocturne/rpc/client";

import { DiffBody } from "./Conversation";
import type { CodeViewer } from "./code-viewer";
import { displayPath } from "./paths";
import {
  baseName,
  buildChangeTree,
  collectChanges,
  isHtmlPath,
  type ChangeItem,
  type ChangeTreeDir,
  type ChangesTab,
  type FileTab,
  type PanelTab,
} from "./side-panel";
import "./side-panel.css";

export interface PanelChangesSource {
  workspace: string;
  turns: ReadonlyMap<number, TurnChanges>;
  /** 会话里用户消息的 seq（旧→新），用来给轮编号 */
  userSeqs: readonly number[];
  loadDiff: (seq: number, path: string) => Promise<TurnChangeDiff>;
}

export interface PanelFileActions {
  /** 「在外部编辑器打开」按钮文字里的程序名 */
  externalLabel: string;
  openExternal: (absolutePath: string, line?: number) => Promise<void>;
  reveal: (absolutePath: string) => Promise<void>;
  /** HTML：内置浏览器做好之前用系统浏览器打开 */
  openInBrowser: (absolutePath: string) => Promise<void>;
}

export interface SidePanelProps {
  tabs: readonly PanelTab[];
  activeId: string;
  overlay: boolean;
  width: number;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onMoveTab: (fromId: string, toId: string) => void;
  onNewTab: () => void;
  /** 拖动分隔条：commit 为 true 时是松手，写入偏好 */
  onResize: (width: number, commit: boolean) => void;
  onOpenChanges: () => void;
  onQuickOpen: () => void;
  /** 新标签页地址栏；返回错误文案或 undefined */
  onAddress: (text: string) => Promise<string | undefined>;
  /** 当前会话的改动；没有打开会话时 undefined */
  changes: PanelChangesSource | undefined;
  /** 没有打开会话时文件入口置灰 */
  canOpenFiles: boolean;
  readFile: (tab: FileTab) => Promise<WorkspaceFileContent>;
  /** 读取文件经过的会话；读取失败后它变化（如打开了同项目的会话）就重读 */
  readKey: (tab: FileTab) => string;
  fileActions: PanelFileActions;
}

function Glyph({ kind }: { kind: "changes" | "file" | "terminal" | "globe" | "plus" | "close" }) {
  const paths: Record<typeof kind, ReactNode> = {
    changes: (
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
        <path d="M8 5.5v4M6 7.5h4M6 11h4" />
      </>
    ),
    file: (
      <path d="M4 1.5h5l3.5 3.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1ZM9 1.5V5h3.5" />
    ),
    terminal: (
      <>
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="m4.5 6 2 2-2 2M8 10.5h3.5" />
      </>
    ),
    globe: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M1.8 8h12.4M8 1.8c2 2.2 2 10.2 0 12.4M8 1.8c-2 2.2-2 10.2 0 12.4" />
      </>
    ),
    plus: <path d="M8 3v10M3 8h10" />,
    close: <path d="m4 4 8 8m0-8-8 8" />,
  };
  return (
    <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function tabTitle(tab: PanelTab): { name: string; project?: string; title: string } {
  if (tab.kind === "changes") return { name: "变更", title: "当前会话改过的文件" };
  if (tab.kind === "new") return { name: "新标签页", title: "新标签页" };
  const name = baseName(tab.relativePath || tab.absolutePath);
  return { name, project: baseName(tab.workspace), title: tab.absolutePath };
}

function TabBar(props: SidePanelProps) {
  const { tabs, activeId, onActivate, onCloseTab, onMoveTab, onNewTab } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  // 选中的标签滚进可见区
  useEffect(() => {
    const node = bar.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    // jsdom 没有 scrollIntoView
    if (node && "scrollIntoView" in node)
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);
  return (
    <div className="sp-tabbar">
      <div className="sp-tabs" role="tablist" aria-label="面板标签" ref={bar}>
        {tabs.map((tab) => {
          const { name, project, title } = tabTitle(tab);
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`sp-tab${active ? " on" : ""}${dragging === tab.id ? " dragging" : ""}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={title}
              draggable
              onDragStart={(event) => {
                setDragging(tab.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/x-nocturne-tab", tab.id);
              }}
              onDragEnd={() => {
                setDragging(null);
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                if (dragging !== tab.id) onMoveTab(dragging, tab.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(null);
              }}
              onClick={() => {
                onActivate(tab.id);
              }}
              onMouseDown={(event) => {
                // 中键关闭
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onKeyDown={(event) => {
                const index = tabs.findIndex((t) => t.id === tab.id);
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  const next = tabs[index + (event.key === "ArrowRight" ? 1 : -1)];
                  if (next !== undefined) onActivate(next.id);
                } else if (event.key === "Delete") {
                  onCloseTab(tab.id);
                }
              }}
            >
              <Glyph
                kind={tab.kind === "changes" ? "changes" : tab.kind === "file" ? "file" : "globe"}
              />
              <span className="sp-tab-label">
                <span className="sp-tab-name">{name}</span>
                {project !== undefined && <span className="sp-tab-project">{project}</span>}
              </span>
              <button
                type="button"
                className="sp-tab-close"
                aria-label={`关闭 ${name}`}
                title="关闭"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <Glyph kind="close" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="sp-newtab"
        aria-label="新标签页"
        title="新标签页 (Ctrl+T)"
        onClick={onNewTab}
      >
        <Glyph kind="plus" />
      </button>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="sp-kbd">{children}</kbd>;
}

function NewTabPage({
  onOpenChanges,
  onQuickOpen,
  onAddress,
  canOpenFiles,
  hasSession,
}: Pick<SidePanelProps, "onOpenChanges" | "onQuickOpen" | "onAddress" | "canOpenFiles"> & {
  hasSession: boolean;
}) {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div className="sp-newpage">
      <form
        className="sp-address"
        onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          void onAddress(address).then((message) => {
            if (message === undefined) setAddress("");
            setError(message);
          });
        }}
      >
        <input
          ref={input}
          value={address}
          aria-label="地址栏"
          placeholder="输入网址或 HTML 文件路径"
          spellCheck={false}
          onChange={(event) => {
            setAddress(event.target.value);
            setError(undefined);
          }}
        />
      </form>
      {error !== undefined && (
        <p className="sp-address-error" role="alert">
          {error}
        </p>
      )}
      <div className="sp-tools">
        <h4>工具</h4>
        <div className="sp-tool-grid">
          <button
            type="button"
            className="sp-tool"
            disabled={!hasSession}
            title={hasSession ? undefined : "先打开一个会话"}
            onClick={onOpenChanges}
          >
            <Glyph kind="changes" />
            <span className="sp-tool-text">
              <span className="sp-tool-head">
                <span className="sp-tool-name">变更</span>
                <Kbd>Ctrl+Shift+G</Kbd>
              </span>
              <span className="sp-tool-desc">当前会话改过的文件</span>
            </span>
          </button>
          <button
            type="button"
            className="sp-tool"
            disabled={!canOpenFiles}
            title={canOpenFiles ? undefined : "先打开一个会话"}
            onClick={onQuickOpen}
          >
            <Glyph kind="file" />
            <span className="sp-tool-text">
              <span className="sp-tool-head">
                <span className="sp-tool-name">文件</span>
                <Kbd>Ctrl+P</Kbd>
              </span>
              <span className="sp-tool-desc">搜索并查看工作区文件</span>
            </span>
          </button>
          <button type="button" className="sp-tool" disabled aria-describedby="sp-term-note">
            <Glyph kind="terminal" />
            <span className="sp-tool-text">
              <span className="sp-tool-name">终端</span>
              <span className="sp-tool-desc" id="sp-term-note">
                下个版本提供
              </span>
            </span>
          </button>
        </div>
        <p className="sp-hint">网址和 HTML 文件暂时用系统浏览器打开。</p>
      </div>
    </div>
  );
}

// ── 变更 ──

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="sp-counts">
      <span className="diff-add">+{added}</span>
      <span className="diff-del">−{removed}</span>
    </span>
  );
}

function ChangeSection({
  item,
  label,
  loadDiff,
  highlighted,
}: {
  item: ChangeItem;
  label: string;
  loadDiff: PanelChangesSource["loadDiff"];
  highlighted: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<TurnChangeDiff>();
  const [error, setError] = useState<string>();
  const loader = useRef(loadDiff);
  loader.current = loadDiff;
  // 进入可视区附近再读差异；没有 IntersectionObserver 的环境直接读
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  const fingerprint = `${item.added}:${item.removed}:${item.unavailable ?? ""}`;
  useEffect(() => {
    if (!visible || item.unavailable !== undefined) return;
    let alive = true;
    setResult(undefined);
    setError(undefined);
    loader
      .current(item.seq, item.path)
      .then((value) => {
        if (alive) setResult(value);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [visible, item.seq, item.path, item.unavailable, fingerprint]);
  return (
    <section
      ref={ref}
      className={`sp-change${highlighted ? " focus" : ""}${item.reverted ? " reverted" : ""}`}
      data-change-key={item.key}
      data-change-seq={item.seq}
      aria-label={`${label} 第 ${item.round} 轮`}
    >
      <header className="sp-change-head">
        <span className="sp-change-path" title={item.path}>
          {label}
        </span>
        {item.status === "added" && <span className="turn-change-tag">新建</span>}
        {item.status === "deleted" && <span className="turn-change-tag">已删除</span>}
        {item.reverted && <span className="turn-change-tag">已撤销</span>}
        <span className="sp-change-round">第 {item.round} 轮</span>
        {item.unavailable === undefined && <Counts added={item.added} removed={item.removed} />}
      </header>
      {item.unavailable !== undefined ? (
        <p className="turn-change-note">{item.unavailable}</p>
      ) : error !== undefined ? (
        <p className="conversation-error" role="alert">
          {error}
        </p>
      ) : result !== undefined ? (
        <DiffBody diff={result.diff} />
      ) : (
        <p className="turn-change-note" role="status">
          正在读取差异…
        </p>
      )}
    </section>
  );
}

function TreeDir({
  dir,
  depth,
  collapsed,
  onToggle,
  onPick,
  selected,
}: {
  dir: ChangeTreeDir;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onPick: (item: ChangeItem) => void;
  selected: string | undefined;
}) {
  return (
    <>
      {dir.children.map((child) => {
        if (child.kind === "file") {
          const { item } = child;
          return (
            <button
              key={item.key}
              type="button"
              className={`sp-tree-file${selected === item.key ? " on" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={`${item.path} · 第 ${item.round} 轮`}
              onClick={() => {
                onPick(item);
              }}
            >
              <span className="sp-tree-name">{child.name}</span>
              <span className="sp-tree-round">{item.round}</span>
              {item.unavailable === undefined && (
                <Counts added={item.added} removed={item.removed} />
              )}
            </button>
          );
        }
        const open = !collapsed.has(child.path);
        return (
          <div key={child.path} className="sp-tree-group">
            <button
              type="button"
              className="sp-tree-dir"
              style={{ paddingLeft: 8 + depth * 12 }}
              aria-expanded={open}
              onClick={() => {
                onToggle(child.path);
              }}
            >
              <span className={`fold-arrow${open ? " down" : ""}`} aria-hidden="true">
                ▶
              </span>
              <span className="sp-tree-name">{child.name}</span>
            </button>
            {open && (
              <TreeDir
                dir={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                onPick={onPick}
                selected={selected}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function ChangesView({ tab, source }: { tab: ChangesTab; source: PanelChangesSource | undefined }) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => (source === undefined ? [] : collectChanges(source.turns.values(), source.userSeqs)),
    [source],
  );
  const label = (item: ChangeItem) => displayPath(item.path, source?.workspace);
  const query = filter.trim().toLowerCase();
  const shown = query === "" ? items : items.filter((i) => label(i).toLowerCase().includes(query));
  const tree = buildChangeTree(shown, label);
  const rounds = new Set(items.map((item) => item.seq)).size;
  const files = new Set(items.map((item) => item.path)).size;
  const scrollTo = (key: string | undefined, seq?: number) => {
    const node =
      key !== undefined
        ? list.current?.querySelector<HTMLElement>(`[data-change-key="${CSS.escape(key)}"]`)
        : list.current?.querySelector<HTMLElement>(`[data-change-seq="${String(seq)}"]`);
    if (node && "scrollIntoView" in node) node.scrollIntoView({ block: "start" });
  };
  // 「查看变更」定位到那一轮
  useEffect(() => {
    if (tab.focusSeq === undefined) return;
    const first = items.find((item) => item.seq === tab.focusSeq);
    setSelected(first?.key);
    // 等差异区渲染出来再滚
    const timer = setTimeout(() => {
      scrollTo(first?.key);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
    // items 变化不重新定位，避免轮次刷新时跳动
  }, [tab.focusSeq, tab.focusNonce, items.length > 0]);
  if (source === undefined) {
    return <div className="sp-empty">没有打开的会话</div>;
  }
  if (items.length === 0) {
    return <div className="sp-empty">本会话还没有文件改动</div>;
  }
  return (
    <div className="sp-changes">
      <div className="sp-changes-diff" ref={list}>
        {shown.map((item) => (
          <ChangeSection
            key={item.key}
            item={item}
            label={label(item)}
            loadDiff={source.loadDiff}
            highlighted={selected === item.key}
          />
        ))}
        {shown.length === 0 && <div className="sp-empty">没有匹配的文件</div>}
      </div>
      <aside className="sp-changes-tree" aria-label="改动的文件">
        <div className="sp-tree-summary">
          本会话 · {rounds} 轮 · {files} 个文件
        </div>
        <input
          className="sp-filter"
          value={filter}
          placeholder="筛选文件"
          aria-label="筛选文件"
          spellCheck={false}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <div className="sp-tree">
          <TreeDir
            dir={tree}
            depth={0}
            collapsed={collapsed}
            selected={selected}
            onToggle={(path) => {
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            onPick={(item) => {
              setSelected(item.key);
              scrollTo(item.key);
            }}
          />
        </div>
      </aside>
    </div>
  );
}

// ── 文件 ──

type FileState =
  | { kind: "loading" }
  | { kind: "text"; text: string; bytes: number }
  | { kind: "image"; url: string; bytes: number }
  | { kind: "error"; code: string | undefined; message: string };

function fileErrorText(code: string | undefined, message: string): string {
  switch (code) {
    case "file_not_found":
      return "文件已不存在";
    case "file_too_large":
      return "文件超过 2 MB，面板里不显示";
    case "file_binary":
      return "二进制文件，面板里无法预览";
    case "file_outside_workspace":
      return "文件在工作区之外";
    case "file_not_regular":
      return "这不是普通文件";
    default:
      return message;
  }
}

function CodeArea({ tab, text }: { tab: FileTab; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<CodeViewer | null>(null);
  const [error, setError] = useState<string>();
  const target = useRef(tab);
  target.current = tab;
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    let disposed = false;
    // 编辑器模块按需加载：不打开文件标签就不进首屏包
    void import("./code-viewer")
      .then(({ mountCodeViewer }) =>
        mountCodeViewer(parent, {
          text,
          path: target.current.absolutePath,
          line: target.current.line,
          endLine: target.current.endLine,
        }),
      )
      .then((mounted) => {
        if (disposed) mounted.destroy();
        else viewer.current = mounted;
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      disposed = true;
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [text]);
  useEffect(() => {
    viewer.current?.reveal(tab.line, tab.endLine);
  }, [tab.line, tab.endLine, tab.focusNonce]);
  if (error !== undefined) {
    return <pre className="sp-code-fallback">{text}</pre>;
  }
  return <div className="sp-code" ref={host} />;
}

function FileView({
  tab,
  readFile,
  readKey,
  actions,
}: {
  tab: FileTab;
  readFile: SidePanelProps["readFile"];
  readKey: string;
  actions: PanelFileActions;
}) {
  const [state, setState] = useState<FileState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [actionError, setActionError] = useState<string>();
  const reader = useRef(readFile);
  reader.current = readFile;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setState({ kind: "loading" });
    reader
      .current(tabRef.current)
      .then((file) => {
        if (!alive) return;
        if (file.kind === "text") {
          setState({ kind: "text", text: file.text, bytes: file.bytes });
        } else {
          url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.mimeType }));
          setState({ kind: "image", url, bytes: file.bytes });
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setState({
          kind: "error",
          code: e instanceof RpcError ? e.code : undefined,
          message: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      alive = false;
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [tab.absolutePath, reload]);
  const failed = state.kind === "error";
  useEffect(() => {
    if (failed) setReload((n) => n + 1);
    // 只在读取会话变化时重试
  }, [readKey]);
  const run = (action: () => Promise<void>) => {
    setActionError(undefined);
    void action().catch((e: unknown) => {
      setActionError(e instanceof Error ? e.message : String(e));
    });
  };
  const project = baseName(tab.workspace);
  const rel = (tab.relativePath || tab.absolutePath).replaceAll("\\", "/");
  const missing = state.kind === "error" && state.code === "file_not_found";
  const externalOnly =
    state.kind === "error" && (state.code === "file_too_large" || state.code === "file_binary");
  return (
    <div className="sp-file">
      <header className="sp-file-head">
        <span className="sp-crumb" title={tab.absolutePath}>
          <span className="sp-crumb-project">{project}</span>
          <span className="sp-crumb-sep">/</span>
          <span className="sp-crumb-path">{rel}</span>
        </span>
        <span className="sp-badge">只读</span>
        {isHtmlPath(tab.absolutePath) && !missing && (
          <button
            type="button"
            className="sp-btn"
            onClick={() => {
              run(() => actions.openInBrowser(tab.absolutePath));
            }}
          >
            在系统浏览器打开
          </button>
        )}
        {!missing && !externalOnly && (
          <button
            type="button"
            className="sp-btn"
            title="在外部编辑器打开"
            onClick={() => {
              run(() => actions.openExternal(tab.absolutePath, tab.line));
            }}
          >
            {actions.externalLabel}
          </button>
        )}
        <button
          type="button"
          className="sp-icon-btn"
          aria-label="重新读取"
          title="重新读取"
          onClick={() => {
            setReload((n) => n + 1);
          }}
        >
          <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
          </svg>
        </button>
      </header>
      {actionError !== undefined && (
        <p className="sp-file-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="sp-file-body">
        {state.kind === "loading" ? (
          <div className="sp-empty" role="status">
            正在读取…
          </div>
        ) : state.kind === "text" ? (
          <CodeArea tab={tab} text={state.text} />
        ) : state.kind === "image" ? (
          <div className="sp-image">
            <img src={state.url} alt={rel} />
          </div>
        ) : (
          <div className="sp-empty sp-file-missing">
            <p>{fileErrorText(state.code, state.message)}</p>
            {externalOnly && (
              <div className="sp-file-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    run(() => actions.openExternal(tab.absolutePath));
                  }}
                >
                  在外部编辑器打开
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    run(() => actions.reveal(tab.absolutePath));
                  }}
                >
                  在资源管理器中显示
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 面板 ──

export function SidePanel(props: SidePanelProps) {
  const { tabs, activeId, overlay, width, onResize, changes } = props;
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, width };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null) return;
    // 分隔条在面板左边：往左拖变宽
    state.width = state.startWidth + (state.startX - event.clientX);
    onResize(state.width, false);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onResize(state.width, true);
  };
  const onSplitterKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") onResize(width + step, true);
    else if (event.key === "ArrowRight") onResize(width - step, true);
    else return;
    event.preventDefault();
  };
  return (
    <aside
      className={`side-panel${overlay ? " overlay" : ""}`}
      style={{ width }}
      aria-label="右侧面板"
    >
      <div
        className="sp-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onSplitterKey}
      />
      <TabBar {...props} />
      <div className="sp-content">
        {tabs.map((tab) => (
          <div key={tab.id} className="sp-pane" role="tabpanel" hidden={tab.id !== activeId}>
            {tab.kind === "new" ? (
              <NewTabPage
                onOpenChanges={props.onOpenChanges}
                onQuickOpen={props.onQuickOpen}
                onAddress={props.onAddress}
                canOpenFiles={props.canOpenFiles}
                hasSession={changes !== undefined}
              />
            ) : tab.kind === "changes" ? (
              <ChangesView tab={tab} source={changes} />
            ) : (
              <FileView
                tab={tab}
                readFile={props.readFile}
                readKey={props.readKey(tab)}
                actions={props.fileActions}
              />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
