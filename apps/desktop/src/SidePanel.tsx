/**
 * 右侧面板（ADR-0060）：标签栏、新标签页、「变更」「文件」「终端」「浏览器」四种标签。
 * 面板只读：撤销仍在对话里的改动卡片上，文件第一版不能编辑。
 * 状态（按会话的标签、开关、文件树宽度、换行；全局宽度）由 PanelHost 持有并存进本机
 * 偏好；这里只管渲染与交互。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { LocalFileContent, TurnChangeDiff, TurnChanges } from "@nocturne/core/protocol";
import type { SubagentSummary, ToolEntry } from "@nocturne/core/protocol";
import { RpcError } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { AgentBrowserPane } from "./AgentBrowserPane";
import type { BrowserPool } from "./browser-pool";
import { BrowserPane, BrowserTabIcon } from "./BrowserPane";
import { DiffBody } from "./Conversation";
import type { CodeViewer } from "./code-viewer";
import type { AgentTabInfo, BrowserBounds, TerminalHost } from "./host";
import { displayPath } from "./paths";
import {
  browserTabName,
  buildChangeTree,
  CHANGE_TREE_DEFAULT_WIDTH,
  CHANGE_TREE_MAX_WIDTH,
  CHANGE_TREE_MIN_WIDTH,
  clampTreeWidth,
  collectChanges,
  fileTabLabel,
  groupChanges,
  isHtmlPath,
  isWindowsPath,
  nativeSeparators,
  projectFits,
  subagentTabName,
  type ChangeFile,
  type ChangeItem,
  type ChangeTreeDir,
  type ChangesTab,
  type FileTab,
  type PanelTab,
} from "./side-panel";
import { SubagentPane, type SubagentRuntime } from "./SubagentPane";
import type { SubagentWatcher } from "./subagent-watch";
import { TerminalPane, type TerminalShellChoice } from "./TerminalPane";
import "./side-panel.css";

export type { TerminalShellChoice };

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
  /** HTML：在面板浏览器标签里打开（没有内置浏览器时用系统浏览器） */
  openInBrowser: (absolutePath: string) => Promise<void>;
  /** openInBrowser 按钮的文字 */
  browserLabel: string;
}

/** 子代理标签的数据与能力（ADR-0060 第 6 节）；缺省（手机、没有子代理的测试）时子代理标签只显示说明 */
export interface PanelSubagents {
  watcher: SubagentWatcher;
  /** 后台还没连上时 undefined */
  runtime: SubagentRuntime | undefined;
  /** 标签所属的父会话（即当前会话） */
  parentSessionId: string;
  /** 目录里这个 child 的最新摘要 */
  summaryFor: (childSessionId: string) => SubagentSummary | undefined;
  /** 父视图里的 task 调用（持久结算与耗时） */
  parentEntryFor: (callId: string) => ToolEntry | undefined;
  images: AttachmentImageSource;
  openUrl: (url: string) => void;
}

export interface SidePanelProps {
  /** 面板收起时仍然挂着（终端进程不随面板收起结束），只是隐藏 */
  hidden?: boolean;
  /** 当前会话的标签（标签栏） */
  tabs: readonly PanelTab[];
  /**
   * 要挂着的标签页：当前会话的全部标签，加上别的会话的终端（隐藏，进程继续跑）。
   * 不传时等于 tabs。
   */
  panes?: readonly PanelTab[];
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
  onOpenTerminal: () => void;
  /** 新标签页地址栏；返回错误文案或 undefined */
  onAddress: (text: string) => Promise<string | undefined>;
  /** 当前会话的改动；没有打开会话时 undefined */
  changes: PanelChangesSource | undefined;
  /** 「变更」右侧文件树宽度（按会话记住）；缺省 CHANGE_TREE_DEFAULT_WIDTH */
  treeWidth?: number | undefined;
  onTreeWidth?: (width: number) => void;
  /** 「变更」差异是否自动换行（按会话记住）；缺省换行 */
  wrap?: boolean;
  onWrap?: (wrap: boolean) => void;
  /** 没有打开会话时文件入口置灰 */
  canOpenFiles: boolean;
  /** rpc.md runtime.readFile：按绝对路径读取，不依赖会话 */
  readFile: (absolutePath: string) => Promise<LocalFileContent>;
  /** 后台连接的标识：后台（重新）连上时读取失败或还在等待的文件标签重读 */
  readerKey: string;
  fileActions: PanelFileActions;
  /** 面板终端；没有时「终端」入口置灰 */
  terminals: TerminalHost | undefined;
  loadShells: (cwd: string) => Promise<TerminalShellChoice>;
  onShellChange: (tabId: string, executable: string) => void;
  /** 面板内置浏览器；没有时浏览器标签显示说明 */
  browsers?: BrowserPool | undefined;
  /** 当前会话的工作区：浏览器地址栏里的相对 HTML 路径按它拼 */
  workspace?: string | undefined;
  /** 浏览器工具栏「在系统浏览器打开」 */
  openExternalUrl?: (url: string) => Promise<void>;
  /** 子代理标签；没有时子代理标签显示说明 */
  subagents?: PanelSubagents | undefined;
  /** agent 自己的浏览器标签（外壳建立）；没有时 agent 标签显示说明 */
  agents?: PanelAgents | undefined;
}

/** agent 标签的显示与操作；标签信息来自外壳的 watch 快照 */
export interface PanelAgents {
  tabs: ReadonlyMap<string, AgentTabInfo>;
  onSlot: (tabId: string, bounds: BrowserBounds) => void;
  onControl: (tabId: string, action: "takeover" | "return") => void;
  onClose: (tabId: string) => void;
}

/** 标签上活动状态点的说明（与 AgentBrowserPane 的状态文案同一口径） */
const AGENT_TAB_STATE: Record<AgentTabInfo["state"], string> = {
  agent: "agent 控制中",
  busy: "agent 正在操作",
  taken_over: "已被你接管",
  ended: "已关闭",
};

function Glyph({
  kind,
}: {
  kind: "changes" | "file" | "terminal" | "globe" | "plus" | "close" | "agent";
}) {
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
    agent: (
      <>
        <circle cx="8" cy="5" r="2.4" />
        <path d="M3.2 13.5c.4-2.6 2.3-4 4.8-4s4.4 1.4 4.8 4" />
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
  if (tab.kind === "terminal") return { name: "终端", project: tab.label, title: tab.cwd };
  if (tab.kind === "browser") {
    if (tab.agent !== undefined) {
      const name = tab.agent.title !== "" ? tab.agent.title : browserTabName(tab);
      return { name, project: tab.agent.child ? "子代理" : "agent", title: tab.agent.url };
    }
    return { name: browserTabName(tab), title: tab.url };
  }
  if (tab.kind === "subagent") {
    const name = subagentTabName(tab);
    return { name, title: name };
  }
  const { name, scope } = fileTabLabel(tab);
  return { name, project: scope, title: tab.absolutePath };
}

/**
 * 标签上的文件名 + 项目名：项目名整段放得下才显示（projectFits），放不下时只占位不显示，
 * 不出现「一个字母加省略号」。占位保持标签宽度不变，显示与否不会来回切换。
 */
function TabLabel({ name, project }: { name: string; project: string | undefined }) {
  const label = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const node = label.current;
    if (node === null || project === undefined) return;
    const measure = () => {
      const nameNode = node.querySelector<HTMLElement>(".sp-tab-name");
      const projectNode = node.querySelector<HTMLElement>(".sp-tab-project");
      if (nameNode === null || projectNode === null || node.clientWidth === 0) return;
      setFits(projectFits(node.clientWidth, nameNode.scrollWidth, projectNode.scrollWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [name, project]);
  return (
    <span className={`sp-tab-label${fits ? "" : " no-project"}`} ref={label}>
      <span className="sp-tab-name">{name}</span>
      {project !== undefined && (
        <span className="sp-tab-project" aria-hidden={fits ? undefined : true}>
          {project}
        </span>
      )}
    </span>
  );
}

function TabBar(props: SidePanelProps) {
  const { tabs, activeId, onActivate, onCloseTab, onMoveTab, onNewTab } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  // 选中的标签滚进可见区；拖窄面板时也要重新滚，不然选中的标签会被挤到右边看不见
  useEffect(() => {
    const reveal = () => {
      const node = bar.current?.querySelector<HTMLElement>(
        `[data-tab-id="${CSS.escape(activeId)}"]`,
      );
      // jsdom 没有 scrollIntoView
      if (node && "scrollIntoView" in node)
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    reveal();
    const node = bar.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
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
              className={`sp-tab${active ? " on" : ""}${tab.kind === "browser" && tab.agent !== undefined ? " agent" : ""}${tab.kind === "browser" && tab.agent?.state === "busy" ? " busy" : ""}${dragging === tab.id ? " dragging" : ""}`}
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
              {tab.kind === "browser" && tab.agent !== undefined ? (
                <Glyph kind="agent" />
              ) : tab.kind === "browser" && props.browsers !== undefined ? (
                <BrowserTabIcon pool={props.browsers} tab={tab} globe={<Glyph kind="globe" />} />
              ) : (
                <Glyph
                  kind={
                    tab.kind === "new" || tab.kind === "browser"
                      ? "globe"
                      : tab.kind === "subagent"
                        ? "agent"
                        : tab.kind
                  }
                />
              )}
              <TabLabel name={name} project={project} />
              {tab.kind === "browser" && tab.agent !== undefined && (
                <span
                  className={`sp-agent-dot${tab.agent.state === "busy" ? " busy" : ""}${
                    tab.agent.state === "taken_over" ? " taken" : ""
                  }`}
                  title={AGENT_TAB_STATE[tab.agent.state]}
                  aria-label={AGENT_TAB_STATE[tab.agent.state]}
                />
              )}
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
  onOpenTerminal,
  onAddress,
  canOpenFiles,
  hasSession,
  hasTerminal,
  hasBrowser,
}: Pick<
  SidePanelProps,
  "onOpenChanges" | "onQuickOpen" | "onOpenTerminal" | "onAddress" | "canOpenFiles"
> & {
  hasSession: boolean;
  hasTerminal: boolean;
  hasBrowser: boolean;
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
          <button
            type="button"
            className="sp-tool"
            disabled={!hasTerminal}
            title={hasTerminal ? undefined : "这个环境没有终端"}
            onClick={onOpenTerminal}
          >
            <Glyph kind="terminal" />
            <span className="sp-tool-text">
              <span className="sp-tool-head">
                <span className="sp-tool-name">终端</span>
                <Kbd>Ctrl+`</Kbd>
              </span>
              <span className="sp-tool-desc">在项目目录里开一个终端</span>
            </span>
          </button>
        </div>
        <p className="sp-hint">
          {hasBrowser ? "网址和 HTML 文件在这个标签里打开。" : "网址和 HTML 文件用系统浏览器打开。"}
        </p>
      </div>
    </div>
  );
}

// ── 变更 ──

/** 和对话里的改动卡片同一口径：没有删除行时只写 +N，不写 −0 */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="sp-counts">
      <span className="diff-add">+{added}</span>
      {removed > 0 && <span className="diff-del">−{removed}</span>}
    </span>
  );
}

function ChangeSection({
  item,
  label,
  title,
  loadDiff,
  highlighted,
  wrap,
  onWrap,
}: {
  item: ChangeItem;
  label: string;
  /** 悬停显示的完整路径 */
  title: string;
  loadDiff: PanelChangesSource["loadDiff"];
  highlighted: boolean;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
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
        {/* 从左边省略、保留文件名：rtl 容器里放 ltr 的 bdi */}
        <span className="sp-change-path" title={title}>
          <bdi>{label}</bdi>
        </span>
        {item.status === "added" && <span className="turn-change-tag">新建</span>}
        {item.status === "deleted" && <span className="turn-change-tag">已删除</span>}
        {item.reverted && <span className="turn-change-tag">已撤销</span>}
        <span className="sp-change-round">第 {item.round} 轮</span>
        {item.unavailable === undefined && <Counts added={item.added} removed={item.removed} />}
        <button
          type="button"
          className="sp-wrap-btn"
          aria-pressed={wrap}
          title={wrap ? "长行自动换行（点击改为横向滚动）" : "长行横向滚动（点击改为自动换行）"}
          onClick={() => {
            onWrap(!wrap);
          }}
        >
          换行
        </button>
      </header>
      {item.unavailable !== undefined ? (
        <p className="turn-change-note">{item.unavailable}</p>
      ) : error !== undefined ? (
        <p className="conversation-error" role="alert">
          {error}
        </p>
      ) : result !== undefined ? (
        <DiffBody diff={result.diff} wrap={wrap} />
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
  expanded,
  onToggle,
  onToggleFile,
  onPick,
  selected,
  fullPath,
}: {
  dir: ChangeTreeDir;
  depth: number;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onToggleFile: (file: ChangeFile) => void;
  onPick: (item: ChangeItem) => void;
  selected: string | undefined;
  /** 悬停显示的完整路径（系统写法） */
  fullPath: (path: string) => string;
}) {
  return (
    <>
      {dir.children.map((child) => {
        if (child.kind === "file") {
          const { file } = child;
          const multi = file.rounds.length > 1;
          const open = multi && expanded.has(file.key);
          const only = file.rounds[0];
          const on = file.rounds.some((round) => round.key === selected);
          return (
            <div key={file.key} className="sp-tree-group">
              <button
                type="button"
                className={`sp-tree-file${on && !open ? " on" : ""}${file.reverted ? " reverted" : ""}`}
                style={{ paddingLeft: 8 + depth * 12 }}
                title={`${fullPath(file.path)} · ${String(file.rounds.length)} 轮`}
                aria-expanded={multi ? open : undefined}
                onClick={() => {
                  if (multi) onToggleFile(file);
                  else if (only !== undefined) onPick(only);
                }}
              >
                {multi ? (
                  <span className={`fold-arrow${open ? " down" : ""}`} aria-hidden="true">
                    ▶
                  </span>
                ) : (
                  <span className="sp-tree-spacer" aria-hidden="true" />
                )}
                <span className="sp-tree-name">{child.name}</span>
                {multi && <span className="sp-tree-round">{file.rounds.length} 轮</span>}
                {file.unavailable === undefined && (
                  <Counts added={file.added} removed={file.removed} />
                )}
              </button>
              {open &&
                file.rounds.map((round) => (
                  <button
                    key={round.key}
                    type="button"
                    className={`sp-tree-file sp-tree-roundrow${selected === round.key ? " on" : ""}${round.reverted ? " reverted" : ""}`}
                    style={{ paddingLeft: 8 + (depth + 1) * 12 + 12 }}
                    title={`${fullPath(file.path)} · 第 ${String(round.round)} 轮`}
                    onClick={() => {
                      onPick(round);
                    }}
                  >
                    <span className="sp-tree-name">
                      第 {round.round} 轮{round.reverted ? " · 已撤销" : ""}
                    </span>
                    {round.unavailable === undefined && (
                      <Counts added={round.added} removed={round.removed} />
                    )}
                  </button>
                ))}
            </div>
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
                expanded={expanded}
                onToggle={onToggle}
                onToggleFile={onToggleFile}
                onPick={onPick}
                selected={selected}
                fullPath={fullPath}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * diff 和文件树之间的分隔条（ADR-0060 修订 2026-10-18（二））：拖动或 ← → 调整树宽，
 * 范围 CHANGE_TREE_MIN_WIDTH–CHANGE_TREE_MAX_WIDTH。树在右边：往左拖、按 ← 变宽。
 * 拖动中只改本地宽度，松手才交给 onCommit（写进会话面板）。
 */
export function TreeSplitter({
  width,
  onLive,
  onCommit,
}: {
  width: number;
  onLive: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`sp-tree-split${dragging ? " drag" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整文件树宽度"
      aria-valuenow={width}
      aria-valuemin={CHANGE_TREE_MIN_WIDTH}
      aria-valuemax={CHANGE_TREE_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={(event) => {
        // preventDefault 防止拖动时选中文字，但也拦掉了默认聚焦：手动聚焦，点过就能用 ← →
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (state === null) return;
        state.width = clampTreeWidth(state.startWidth + (state.startX - event.clientX));
        onLive(state.width);
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        if (state === null) return;
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onCommit(state.width);
      }}
      onPointerCancel={() => {
        const state = drag.current;
        if (state === null) return;
        drag.current = null;
        setDragging(false);
        onCommit(state.width);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        let next: number;
        if (event.key === "ArrowLeft") next = width + step;
        else if (event.key === "ArrowRight") next = width - step;
        else if (event.key === "Home") next = CHANGE_TREE_MIN_WIDTH;
        else if (event.key === "End") next = CHANGE_TREE_MAX_WIDTH;
        else return;
        event.preventDefault();
        onCommit(clampTreeWidth(next));
      }}
    />
  );
}

function ChangesView({
  tab,
  source,
  treeWidth,
  onTreeWidth,
  wrap,
  onWrap,
}: {
  tab: ChangesTab;
  source: PanelChangesSource | undefined;
  treeWidth: number;
  onTreeWidth: (width: number) => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
}) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  /** 拖动中的树宽；松手后回到会话记住的宽度 */
  const [live, setLive] = useState<number>();
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => (source === undefined ? [] : collectChanges(source.turns.values(), source.userSeqs)),
    [source],
  );
  const files = useMemo(() => groupChanges(items), [items]);
  // Windows 工作区按 Windows 写法显示路径（工作区外的分组是 Z:\nocturne-mockups）
  const windows = source !== undefined && isWindowsPath(source.workspace);
  const label = (path: string) => nativeSeparators(displayPath(path, source?.workspace), windows);
  const fullPath = (path: string) => nativeSeparators(path, windows);
  const query = filter.trim().toLowerCase();
  const matches = (path: string) => query === "" || label(path).toLowerCase().includes(query);
  const shownFiles = files.filter((file) => matches(file.path));
  const shown = items.filter((item) => matches(item.path));
  const tree = buildChangeTree(shownFiles, (file) => label(file.path), windows ? "\\" : "/");
  const rounds = new Set(items.map((item) => item.seq)).size;
  const scrollTo = (key: string | undefined) => {
    if (key === undefined) return;
    const node = list.current?.querySelector<HTMLElement>(`[data-change-key="${CSS.escape(key)}"]`);
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
  const pick = (item: ChangeItem) => {
    setSelected(item.key);
    scrollTo(item.key);
  };
  const width = live ?? treeWidth;
  return (
    <div className="sp-changes" style={{ ["--sp-tree-width" as string]: `${String(width)}px` }}>
      <div className="sp-changes-diff" ref={list}>
        {shown.map((item) => (
          <ChangeSection
            key={item.key}
            item={item}
            label={label(item.path)}
            title={fullPath(item.path)}
            loadDiff={source.loadDiff}
            highlighted={selected === item.key}
            wrap={wrap}
            onWrap={onWrap}
          />
        ))}
        {shown.length === 0 && <div className="sp-empty">没有匹配的文件</div>}
      </div>
      <TreeSplitter
        width={width}
        onLive={setLive}
        onCommit={(next) => {
          setLive(undefined);
          onTreeWidth(next);
        }}
      />
      <aside className="sp-changes-tree" aria-label="改动的文件">
        <div className="sp-tree-summary">
          本会话 · {rounds} 轮 · {files.length} 个文件
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
            expanded={expanded}
            selected={selected}
            fullPath={fullPath}
            onToggle={(path) => {
              setCollapsed((current) => toggled(current, path));
            }}
            onToggleFile={(file) => {
              const opening = !expanded.has(file.key);
              setExpanded((current) => toggled(current, file.key));
              // 展开时顺带跳到最新一轮
              const newest = file.rounds[0];
              if (opening && newest !== undefined) pick(newest);
            }}
            onPick={pick}
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
    case "file_network_path":
      return "不读取网络路径上的文件";
    case "file_not_regular":
      return "这不是普通文件";
    case "file_read_timeout":
      return "读取超时，所在磁盘可能不可用";
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
  readerKey,
  actions,
}: {
  tab: FileTab;
  readFile: SidePanelProps["readFile"];
  readerKey: string;
  actions: PanelFileActions;
}) {
  const [state, setState] = useState<FileState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [actionError, setActionError] = useState<string>();
  const reader = useRef(readFile);
  reader.current = readFile;
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setState({ kind: "loading" });
    reader
      .current(tab.absolutePath)
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
    // 后台重新连上（readerKey 变化）也重读：启动时恢复的标签要等后台就绪
  }, [tab.absolutePath, reload, readerKey]);
  const run = (action: () => Promise<void>) => {
    setActionError(undefined);
    void action().catch((e: unknown) => {
      setActionError(e instanceof Error ? e.message : String(e));
    });
  };
  const { scope: project, path: rel } = fileTabLabel(tab);
  const missing = state.kind === "error" && state.code === "file_not_found";
  const externalOnly =
    state.kind === "error" && (state.code === "file_too_large" || state.code === "file_binary");
  const timedOut = state.kind === "error" && state.code === "file_read_timeout";
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
            {actions.browserLabel}
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
            {timedOut && (
              <div className="sp-file-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setReload((n) => n + 1);
                  }}
                >
                  重试
                </button>
              </div>
            )}
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
  const { tabs, activeId, overlay, width, onResize, changes, hidden = false } = props;
  const panes = props.panes ?? tabs;
  const current = new Set(tabs.map((tab) => tab.id));
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 同 TreeSplitter：preventDefault 拦掉了默认聚焦，手动聚焦后才能用 ← →
    event.preventDefault();
    event.currentTarget.focus();
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
      className={`side-panel thin-scroll${overlay ? " overlay" : ""}`}
      style={{ width }}
      aria-label="右侧面板"
      hidden={hidden}
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
        {panes.map((tab) => (
          <div
            key={tab.id}
            className="sp-pane"
            role="tabpanel"
            hidden={tab.id !== activeId || !current.has(tab.id)}
          >
            {tab.kind === "new" ? (
              <NewTabPage
                onOpenChanges={props.onOpenChanges}
                onQuickOpen={props.onQuickOpen}
                onOpenTerminal={props.onOpenTerminal}
                onAddress={props.onAddress}
                canOpenFiles={props.canOpenFiles}
                hasSession={changes !== undefined}
                hasTerminal={props.terminals !== undefined}
                hasBrowser={props.browsers !== undefined}
              />
            ) : tab.kind === "changes" ? (
              <ChangesView
                tab={tab}
                source={changes}
                treeWidth={props.treeWidth ?? CHANGE_TREE_DEFAULT_WIDTH}
                onTreeWidth={(next) => props.onTreeWidth?.(next)}
                wrap={props.wrap !== false}
                onWrap={(next) => props.onWrap?.(next)}
              />
            ) : tab.kind === "terminal" ? (
              props.terminals === undefined ? (
                <div className="sp-empty">这个环境没有终端</div>
              ) : (
                <TerminalPane
                  tab={tab}
                  host={props.terminals}
                  loadShells={props.loadShells}
                  visible={!hidden && tab.id === activeId && current.has(tab.id)}
                  onShellChange={props.onShellChange}
                />
              )
            ) : tab.kind === "browser" ? (
              tab.agent !== undefined ? (
                props.agents === undefined ? (
                  <div className="sp-empty">这个环境不能查看 agent 标签</div>
                ) : (
                  <AgentBrowserPane
                    tab={tab}
                    info={props.agents.tabs.get(tab.agent.tabId) ?? tab.agent}
                    visible={!hidden && tab.id === activeId && current.has(tab.id)}
                    onSlot={props.agents.onSlot}
                    onControl={props.agents.onControl}
                    onClose={props.agents.onClose}
                  />
                )
              ) : props.browsers === undefined ? (
                <div className="sp-empty">这个环境没有内置浏览器</div>
              ) : (
                <BrowserPane
                  tab={tab}
                  pool={props.browsers}
                  visible={!hidden && tab.id === activeId && current.has(tab.id)}
                  workspace={props.workspace}
                  openExternal={props.openExternalUrl ?? (() => Promise.resolve())}
                />
              )
            ) : tab.kind === "subagent" ? (
              props.subagents === undefined ? (
                <div className="sp-empty">这个环境不能查看子代理</div>
              ) : (
                <SubagentPane
                  tab={tab}
                  parentSessionId={props.subagents.parentSessionId}
                  visible={!hidden && tab.id === activeId && current.has(tab.id)}
                  watcher={props.subagents.watcher}
                  runtime={props.subagents.runtime}
                  summary={props.subagents.summaryFor(tab.childSessionId)}
                  parentEntry={props.subagents.parentEntryFor(tab.parentCallId)}
                  workspace={props.workspace ?? ""}
                  images={props.subagents.images}
                  openUrl={props.subagents.openUrl}
                />
              )
            ) : (
              <FileView
                tab={tab}
                readFile={props.readFile}
                readerKey={props.readerKey}
                actions={props.fileActions}
              />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
