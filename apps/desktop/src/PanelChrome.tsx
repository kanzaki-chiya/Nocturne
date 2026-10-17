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

import type { FileIndexEntry } from "./file-refs";
import { rankQuickOpen } from "./side-panel";

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
  onToggleOverview,
  onTogglePanel,
}: {
  overviewOpen: boolean;
  overviewDisabled: boolean;
  panelOpen: boolean;
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
        title="右侧面板 (Ctrl+B)"
        aria-pressed={panelOpen}
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
  onPick,
  onClose,
}: {
  project: string;
  load: () => Promise<FileIndexEntry[]>;
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
  const hits = useMemo(() => rankQuickOpen(query, entries ?? []), [query, entries]);
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
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span className="qopen-count">
            {project}
            {entries !== null ? ` · ${fileCount} 个文件` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 会话概览浮层（ADR-0060 第 2 节）：第 1 轮只有项目行和「变更」行。
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
}: {
  project: string;
  workspace: string;
  totals: { added: number; removed: number; files: number };
  docked: boolean;
  /** 面板盖在对话区上时浮层让到面板左边；对话区放不下时压在面板上，不盖侧边栏 */
  rightOffset: number;
  onOpenChanges: () => void;
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
              <span className="diff-add">+{totals.added}</span>{" "}
              <span className="diff-del">−{totals.removed}</span>
            </>
          )}
        </span>
      </button>
    </div>
  );
}
