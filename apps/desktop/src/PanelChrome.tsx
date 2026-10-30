/**
 * 右侧面板周边（ADR-0060）：标题栏按钮插槽、Ctrl+P 快速打开、会话概览浮层。
 * 只在桌面窗口里渲染；手机端不挂 WindowFrame，插槽为空，这些入口都不出现。
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { SubagentSummary } from "@nocturne/core/protocol";

import type { FileIndexEntry } from "./file-refs";
import { rankQuickOpen, SUBAGENT_SUMMARY_MAX } from "./side-panel";
import { elapsedText, runningMs } from "./subagent-panel";
import { KeyHint } from "./KeyHint";
import { keyDiag } from "./key-diag";

/** WindowFrame 标题栏里给 App 放按钮的位置；没有标题栏（测试、手机）时为 null */
export const TitlebarSlot = createContext<HTMLElement | null>(null);

export function TitlebarPortal({ children }: { children: ReactNode }) {
  const slot = useContext(TitlebarSlot);
  return slot === null ? null : createPortal(children, slot);
}

export function TitlebarButtons({
  overviewOpen,
  overviewDisabled,
  panelOpen,
  panelDisabled = false,
  onToggleOverview,
  onTogglePanel,
}: {
  overviewOpen: boolean;
  overviewDisabled: boolean;
  panelOpen: boolean;
  /** 没有会话（首页、新建会话页）时面板不可用 */
  panelDisabled?: boolean;
  onToggleOverview: () => void;
  onTogglePanel: () => void;
}) {
  return (
    <TitlebarPortal>
      <button
        type="button"
        className="tb-btn"
        aria-label="会话概览"
        title={overviewDisabled ? "会话概览（先打开一个会话）" : "会话概览"}
        aria-haspopup="dialog"
        aria-expanded={overviewOpen}
        aria-pressed={overviewOpen}
        disabled={overviewDisabled}
        onClick={onToggleOverview}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
        </svg>
      </button>
      <button
        type="button"
        className="tb-btn"
        aria-label="右侧面板"
        title={panelDisabled ? "右侧面板（先打开一个会话）" : "右侧面板 (Ctrl+B)"}
        aria-pressed={panelOpen}
        disabled={panelDisabled}
        onClick={onTogglePanel}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M10 2.5v11" />
        </svg>
      </button>
    </TitlebarPortal>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q === "" ? -1 : text.toLowerCase().indexOf(q);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

/** Ctrl+P：在当前会话的工作区里按文件名找文件，回车在面板里打开 */
export function QuickOpen({
  project,
  load,
  recent = [],
  onPick,
  onClose,
}: {
  project: string;
  load: () => Promise<FileIndexEntry[]>;
  /** 最近在面板里打开过的文件（相对路径，新的在前）：空查询时排在前面 */
  recent?: readonly string[];
  onPick: (relativePath: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<FileIndexEntry[] | null>(null);
  const [error, setError] = useState<string>();
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // 点在对话框外任何地方（包括标题栏按钮）都关闭
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!dialog.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);
  useEffect(() => {
    input.current?.focus();
    keyDiag(`quickOpen rendered=${dialog.current !== null} hasFocus=${document.hasFocus()}`);
    return () => {
      keyDiag("quickOpen unmounted");
    };
  }, []);
  useEffect(() => {
    let alive = true;
    load()
      .then((value) => {
        if (alive) setEntries(value);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [load]);
  // recent 每次渲染都是新数组：按内容比较
  const recentKey = recent.join("\n");
  const hits = useMemo(
    () =>
      rankQuickOpen(query, entries ?? [], undefined, recentKey === "" ? [] : recentKey.split("\n")),
    [query, entries, recentKey],
  );
  const fileCount = useMemo(
    () => entries?.filter((entry) => entry.kind === "file").length ?? 0,
    [entries],
  );
  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // jsdom 没有 scrollIntoView
    if (node && "scrollIntoView" in node) node.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <div className="qopen-backdrop">
      <div className="qopen" role="dialog" aria-label="快速打开" ref={dialog}>
        <input
          ref={input}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="qopen-list"
          aria-label="搜索文件"
          placeholder="按文件名搜索"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((i) => Math.min(hits.length - 1, i + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const hit = hits[index];
              if (hit !== undefined) onPick(hit.path);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        {error !== undefined ? (
          <p className="qopen-note" role="alert">
            读取文件列表失败：{error}
          </p>
        ) : entries === null ? (
          <p className="qopen-note" role="status">
            正在读取文件列表…
          </p>
        ) : hits.length === 0 ? (
          <p className="qopen-note">没有匹配的文件</p>
        ) : (
          <ul id="qopen-list" role="listbox" ref={list}>
            {hits.map((hit, i) => (
              <li
                key={hit.path}
                role="option"
                aria-selected={i === index}
                onMouseMove={() => {
                  setIndex(i);
                }}
                onClick={() => {
                  onPick(hit.path);
                }}
              >
                <span className="qopen-name">
                  <Highlighted text={hit.name} query={query} />
                </span>
                <small>{hit.dir === "" ? "./" : hit.dir}</small>
              </li>
            ))}
          </ul>
        )}
        <div className="qopen-foot">
          <KeyHint
            groups={[
              { keys: ["↑", "↓"], label: "选择" },
              { keys: ["Enter"], label: "打开" },
              { keys: ["Esc"], label: "关闭" },
            ]}
          />
          <span className="qopen-count">
            {project}
            {entries !== null && <span className="muted-value">{fileCount} 个文件</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 概览里的外部 agent 行：只读展示，不可点击；since 是首次看到它运行的本地时刻 */
export interface OverviewExternal {
  callId: string;
  agent: string;
  summary: string;
  since: number;
}

/** 概览「子代理」分组的内容（ADR-0060 第 1 节与修订（五）第 3 条） */
export interface OverviewSubagents {
  /** 直接内置、仍在运行的子代理（可点击） */
  running: readonly SubagentSummary[];
  external: readonly OverviewExternal[];
  onOpen: (summary: SubagentSummary) => void;
  onCancel?: (summary: SubagentSummary) => void;
  cancelError?: string | undefined;
  retained?: readonly {
    childSessionId: string;
    branch: string;
    files: number;
    applied?: boolean | undefined;
  }[];
  onDelete?: (id: string) => void;
  isolated?: ReadonlySet<string>;
}

/** 每秒刷新的本地时钟：概览里的秒数靠它，不靠查询 */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}

function SubagentRows({ subagents }: { subagents: OverviewSubagents }) {
  const { running, external, onOpen } = subagents;
  const now = useNow(running.length + external.length > 0);
  return (
    <div className="ovpop-group thin-scroll" role="group" aria-label="子代理">
      <div className="ovpop-head">子代理</div>
      {subagents.cancelError !== undefined && <div role="alert">{subagents.cancelError}</div>}
      {running.map((agent) => {
        const ms = runningMs(agent.startedAt, now);
        const open = (
          <button
            key={agent.childSessionId}
            type="button"
            className="ovpop-agent"
            title={agent.taskSummary}
            onClick={() => {
              onOpen(agent);
            }}
          >
            <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="5" r="2.4" />
              <path d="M3.2 13.5c.4-2.6 2.3-4 4.8-4s4.4 1.4 4.8 4" />
            </svg>
            <span className="ovpop-agent-text">
              <span className="ovpop-agent-profile">
                {agent.profile}
                {agent.background === true && (
                  <span className="ovpop-bg">
                    {subagents.isolated?.has(agent.childSessionId) ? "后台 · 隔离" : "后台"}
                  </span>
                )}
              </span>
              <span className="ovpop-agent-summary">
                {Array.from(agent.taskSummary).slice(0, SUBAGENT_SUMMARY_MAX).join("")}
              </span>
            </span>
            <span className="ovpop-n ovpop-time">{ms === undefined ? "" : elapsedText(ms)}</span>
          </button>
        );
        const onCancel = subagents.onCancel;
        if (agent.background !== true || onCancel === undefined) return open;
        // 后台子代理（ADR-0073 §6）：打开与取消是同一行里的两个按钮，不嵌套
        return (
          <div key={agent.childSessionId} className="ovpop-agent-row">
            {open}
            <button
              type="button"
              className="ovpop-cancel"
              aria-label={`取消后台子代理 ${agent.profile}`}
              onClick={() => {
                onCancel(agent);
              }}
            >
              取消
            </button>
          </div>
        );
      })}
      {(subagents.retained?.length ?? 0) > 0 && <div className="ovpop-head">保留的副本与分支</div>}
      {subagents.retained?.map((record) => (
        <div className="ovpop-agent-row ovpop-retained" key={record.childSessionId}>
          <span className="ovpop-agent-text" title={record.branch}>
            <span className="ovpop-agent-profile ovpop-branch">{record.branch}</span>
            <span className="ovpop-agent-summary">
              改动 {record.files} 个文件{record.applied ? " · 已并回" : ""}
            </span>
          </span>
          <button
            type="button"
            className="ovpop-cancel"
            aria-label={`删除副本与分支 ${record.branch}`}
            onClick={() => {
              subagents.onDelete?.(record.childSessionId);
            }}
          >
            删除
          </button>
        </div>
      ))}
      {external.map((run) => (
        // 外部 agent 的过程只在主对话的进度里，没有 Nocturne 子会话可看：不可点击
        <div key={run.callId} className="ovpop-agent external" title={run.summary}>
          <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="5" r="2.4" />
            <path d="M3.2 13.5c.4-2.6 2.3-4 4.8-4s4.4 1.4 4.8 4" />
          </svg>
          <span className="ovpop-agent-text">
            <span className="ovpop-agent-profile">{run.agent}</span>
            <span className="ovpop-agent-summary">{run.summary}</span>
            <span className="ovpop-agent-note">
              外部 agent<span className="muted-value">仅主对话进度</span>
            </span>
          </span>
          <span className="ovpop-n ovpop-time">{elapsedText(Math.max(0, now - run.since))}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 会话概览浮层（ADR-0060 第 2 节）：项目行、「变更」行和「子代理」分组（没有运行项时隐藏）。
 * 开关只经标题栏按钮与 Esc，点「变更」不关浮层。docked 时停在对话区右侧
 * 空白（对话列让位），否则盖在对话上。
 */
export function SessionOverview({
  project,
  workspace,
  totals,
  docked,
  rightOffset,
  onOpenChanges,
  subagents,
}: {
  project: string;
  workspace: string;
  totals: { added: number; removed: number; files: number };
  docked: boolean;
  /** 面板盖在对话区上时浮层让到面板左边；对话区放不下时压在面板上，不盖侧边栏 */
  rightOffset: number;
  onOpenChanges: () => void;
  /** 子代理分组；没有运行项（或不传）时整组隐藏 */
  subagents?: OverviewSubagents | undefined;
}) {
  return (
    <div
      className={`ovpop${docked ? " docked" : ""}`}
      role="dialog"
      aria-label="会话概览"
      style={
        rightOffset > 0
          ? { right: `min(${rightOffset + 12}px, calc(100% - var(--ovpop-w) - 12px))` }
          : undefined
      }
    >
      <div className="ovpop-proj">
        <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
        </svg>
        <span>{project}</span>
        <small title={workspace}>{workspace}</small>
      </div>
      <button type="button" onClick={onOpenChanges}>
        <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M8 5.5v4M6 7.5h4M6 11h4" />
        </svg>
        <span>变更</span>
        <span className="ovpop-n">
          {totals.files === 0 ? (
            <span className="ovpop-none">无</span>
          ) : (
            <>
              <span className="diff-add">+{totals.added}</span>
              {/* 和改动卡片同一口径：没有删除行不写 −0 */}
              {totals.removed > 0 && (
                <>
                  {" "}
                  <span className="diff-del">−{totals.removed}</span>
                </>
              )}
            </>
          )}
        </span>
      </button>
      {subagents !== undefined &&
        subagents.running.length + subagents.external.length + (subagents.retained?.length ?? 0) >
          0 && <SubagentRows subagents={subagents} />}
    </div>
  );
}
