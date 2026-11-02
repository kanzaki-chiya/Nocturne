import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { describeSchedulePlan, type ScheduleTaskOverview } from "@nocturne/core/protocol";
import type { RpcClient, RpcResult, RpcRuntime } from "@nocturne/rpc/client";

import { formatRelative, projectKey, type ProjectNode, type SessionSummary } from "./session-tree";
import "./search.css";

export type SearchTab = "all" | "sessions" | "projects" | "designs" | "schedules";
type ItemKind = Exclude<SearchTab, "all">;
export type SessionMatch = RpcResult<"runtime.searchSessions">[number];

export interface SettledSearch {
  query: string;
  matches: SessionMatch[];
  complete?: boolean;
}

let nextSearchId = 0;

export interface SearchItem {
  key: string;
  kind: ItemKind;
  title: string;
  info: string;
  snippet?: string | undefined;
  ranges?: { start: number; end: number }[] | undefined;
  sessionId?: string | undefined;
  seq?: number | undefined;
  projectKey?: string | undefined;
  scheduleId?: string | undefined;
  timeMs: number;
}

const TABS: { id: SearchTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "sessions", label: "会话" },
  { id: "projects", label: "项目" },
  { id: "designs", label: "设计" },
  { id: "schedules", label: "定时任务" },
];
const GROUPS: { id: ItemKind; label: string }[] = [
  { id: "sessions", label: "会话" },
  { id: "projects", label: "项目" },
  { id: "designs", label: "设计" },
  { id: "schedules", label: "定时任务" },
];

function itemIcon(kind: ItemKind): ReactNode {
  if (kind === "sessions") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
      >
        <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "projects") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
      >
        <path
          d="M2 4.2c0-.5.4-.9.9-.9h3.2l1.5 1.7h5.5c.5 0 .9.4.9.9v6.3c0 .5-.4.9-.9.9H2.9a.9.9 0 0 1-.9-.9z"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "designs") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
      >
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="M2.5 6h11M6.5 6v7.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8.6" r="5.6" />
      <path d="M8 5.6v3.2l2.2 1.4M5.4 1.6h5.2" strokeLinecap="round" />
    </svg>
  );
}

function matchRanges(text: string, query: string): { start: number; end: number }[] {
  if (query === "") return [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const ranges: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= lower.length - needle.length) {
    const start = lower.indexOf(needle, from);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    from = start + needle.length;
  }
  return ranges;
}

export function promptSnippet(
  text: string,
  query: string,
): { text: string; ranges: { start: number; end: number }[] } | undefined {
  if (query === "") return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  const first = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (first < 0) return undefined;
  const start = Math.max(0, first - 14);
  const end = Math.min(normalized.length, first + query.length + 160);
  const prefix = start > 0 ? "…" : "";
  const body = normalized.slice(start, end);
  return {
    text: `${prefix}${body}${end < normalized.length ? "…" : ""}`,
    ranges: matchRanges(body, query).map((range) => ({
      start: range.start + prefix.length,
      end: range.end + prefix.length,
    })),
  };
}

/** 设计工作区尚未存在；此接缝保持空结果，不在界面放示例数据。 */
export function designResults(): SearchItem[] {
  return [];
}

function Highlighted({
  text,
  query,
  ranges,
}: {
  text: string;
  query: string;
  ranges?: { start: number; end: number }[] | undefined;
}): ReactNode {
  const marks = ranges ?? matchRanges(text, query);
  if (marks.length === 0) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [index, range] of marks.entries()) {
    if (range.start < from) continue;
    parts.push(text.slice(from, range.start));
    parts.push(<mark key={index}>{text.slice(range.start, range.end)}</mark>);
    from = range.end;
  }
  parts.push(text.slice(from));
  return parts;
}

function includes(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function scheduleLastRunMs(schedule: ScheduleTaskOverview): number {
  const raw = schedule.lastRun?.startedAt ?? schedule.lastRun?.scheduledAt;
  if (raw === undefined) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function SearchDialog({
  api,
  client,
  sessions,
  projects,
  hiddenProjects,
  plainKey,
  schedules,
  query,
  settled,
  onQueryChange,
  onSettledChange,
  onClose,
  onOpen,
}: {
  api: Pick<RpcRuntime, "searchSessions">;
  client?: Pick<RpcClient, "onNotification"> | undefined;
  sessions: SessionSummary[];
  projects: ProjectNode[];
  hiddenProjects: Set<string>;
  plainKey?: string | null | undefined;
  schedules: ScheduleTaskOverview[];
  query: string;
  settled: SettledSearch;
  onQueryChange: (query: string) => void;
  onSettledChange: (settled: SettledSearch) => void;
  onClose: () => void;
  onOpen: (item: SearchItem) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const previousFocus = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const request = useRef(0);
  const [compositionVersion, setCompositionVersion] = useState(0);
  const [tab, setTab] = useState<SearchTab>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState(query.trim());
  const [completedQuery, setCompletedQuery] = useState<string | undefined>(
    settled.complete === false ? undefined : settled.query,
  );
  const settledRef = useRef(settled);
  settledRef.current = settled;
  const onSettledRef = useRef(onSettledChange);
  onSettledRef.current = onSettledChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    input.current?.select();
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onWindowKey, true);
    return () => {
      window.removeEventListener("keydown", onWindowKey, true);
      request.current += 1;
      previousFocus.current?.focus();
    };
  }, []);

  const settledQuery = settled.query;
  const sessionMatches = settled.matches;

  useEffect(() => {
    if (!composing.current) setFilterQuery(query.trim());
  }, [query, compositionVersion]);

  useEffect(() => {
    const version = ++request.current;
    if (filterQuery === "") {
      if (settledRef.current.query !== "" || settledRef.current.matches.length > 0) {
        onSettledRef.current({ query: "", matches: [] });
      }
      setCompletedQuery("");
      return;
    }
    if (composing.current) return;
    if (filterQuery === settledRef.current.query && settledRef.current.complete !== false) {
      setCompletedQuery(filterQuery);
      return;
    }
    setCompletedQuery(undefined);
    const searchId = `search-${++nextSearchId}`;
    let matches: SessionMatch[] = [];
    const unsubscribe = client?.onNotification("runtime.sessionSearchProgress", (progress) => {
      if (request.current !== version || progress.searchId !== searchId) return;
      matches = [...matches, ...progress.results];
      onSettledRef.current({ query: filterQuery, matches, complete: false });
    });
    const timer = window.setTimeout(() => {
      void api.searchSessions({ query: filterQuery, searchId }).then(
        (matches) => {
          if (request.current !== version) return;
          unsubscribe?.();
          setCompletedQuery(filterQuery);
          onSettledRef.current({ query: filterQuery, matches });
        },
        () => {
          if (request.current !== version) return;
          unsubscribe?.();
          setCompletedQuery(filterQuery);
          onSettledRef.current({ query: filterQuery, matches: [] });
        },
      );
    }, 150);
    return () => {
      window.clearTimeout(timer);
      unsubscribe?.();
      request.current += 1;
    };
  }, [api, client, compositionVersion, filterQuery]);

  const { sessionItems, projectItems, designItems, scheduleItems } = useMemo(() => {
    const now = Date.now();
    const visibleSessions = sessions.filter((session) => {
      if (session.parent !== undefined) return false;
      const hasText = session.firstText !== undefined && session.firstText.trim() !== "";
      if (!hasText && session.locked !== true && session.client === undefined) return false;
      const key = projectKey(session.cwd);
      return !hiddenProjects.has(key);
    });
    const sessionById = new Map(visibleSessions.map((session) => [session.id, session]));
    const projectTimes = new Map<string, number>();
    for (const session of visibleSessions) {
      const key = projectKey(session.cwd);
      projectTimes.set(key, Math.max(projectTimes.get(key) ?? 0, session.mtimeMs));
    }
    const projectNames = new Map(projects.map((project) => [project.key, project.name]));
    const sessionInfo = (session: SessionSummary): string => {
      const key = projectKey(session.cwd);
      const isPlain = plainKey !== null && plainKey !== undefined && key === plainKey;
      const project = isPlain ? undefined : projectNames.get(key);
      const time = formatRelative(session.mtimeMs, now);
      return project === undefined ? time : `${project} · ${time}`;
    };

    const nextSessions: SearchItem[] =
      settledQuery === ""
        ? [...visibleSessions]
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .map((session) => ({
              key: `session:${session.id}`,
              kind: "sessions",
              title: session.firstText ?? session.id,
              info: sessionInfo(session),
              sessionId: session.id,
              timeMs: session.mtimeMs,
            }))
        : sessionMatches.flatMap((match): SearchItem[] => {
            const session = sessionById.get(match.sessionId);
            if (session === undefined) return [];
            return [
              {
                key: `session:${session.id}`,
                kind: "sessions",
                title: session.firstText ?? session.id,
                info: sessionInfo(session),
                ...(match.snippet !== undefined
                  ? { snippet: match.snippet, ranges: match.ranges }
                  : {}),
                ...(match.seq !== undefined ? { seq: match.seq } : {}),
                sessionId: session.id,
                timeMs: session.mtimeMs,
              },
            ];
          });

    const visibleProjects = projects.filter((project) => !hiddenProjects.has(project.key));
    const nextProjects: SearchItem[] = visibleProjects
      .filter(
        (project) =>
          filterQuery === "" ||
          includes(project.name, filterQuery) ||
          includes(project.path, filterQuery),
      )
      .map((project): SearchItem => ({
        key: `project:${project.key}`,
        kind: "projects",
        title: project.name,
        info: project.path,
        projectKey: project.key,
        timeMs: projectTimes.get(project.key) ?? 0,
      }))
      .sort((a, b) => b.timeMs - a.timeMs);

    const nextSchedules: SearchItem[] = schedules
      .filter(
        (schedule) =>
          filterQuery === "" ||
          includes(schedule.name, filterQuery) ||
          includes(schedule.prompt, filterQuery),
      )
      .map((schedule): SearchItem => {
        const excerpt =
          filterQuery === "" ? undefined : promptSnippet(schedule.prompt, filterQuery);
        return {
          key: `schedule:${schedule.id}`,
          kind: "schedules",
          title: schedule.name,
          info: describeSchedulePlan(schedule.schedule),
          ...(excerpt === undefined ? {} : { snippet: excerpt.text, ranges: excerpt.ranges }),
          scheduleId: schedule.id,
          timeMs: scheduleLastRunMs(schedule),
        };
      })
      .sort((a, b) => b.timeMs - a.timeMs);

    const nextDesigns = designResults().filter(
      (item) =>
        filterQuery === "" ||
        includes(item.title, filterQuery) ||
        (item.snippet !== undefined && includes(item.snippet, filterQuery)),
    );

    return {
      sessionItems: nextSessions,
      projectItems: nextProjects,
      designItems: nextDesigns,
      scheduleItems: nextSchedules,
    };
  }, [
    filterQuery,
    hiddenProjects,
    plainKey,
    projects,
    schedules,
    sessionMatches,
    sessions,
    settledQuery,
  ]);

  const visible = useMemo<SearchItem[]>(() => {
    const byKind: Record<ItemKind, SearchItem[]> = {
      sessions: sessionItems,
      projects: projectItems,
      designs: designItems,
      schedules: scheduleItems,
    };
    if (tab !== "all") return byKind[tab];
    if (filterQuery === "") {
      return [...sessionItems, ...projectItems, ...designItems, ...scheduleItems]
        .sort((a, b) => b.timeMs - a.timeMs)
        .slice(0, 8);
    }
    return GROUPS.flatMap((group) => byKind[group.id]);
  }, [designItems, filterQuery, projectItems, scheduleItems, sessionItems, tab]);

  useEffect(() => {
    setSelectedKey(null);
    rows.current[0]?.scrollIntoView({ block: "nearest" });
  }, [filterQuery, tab]);
  const selected = Math.max(
    0,
    visible.findIndex((item) => item.key === selectedKey),
  );
  useEffect(() => {
    if (!visible.some((item) => item.key === selectedKey)) {
      setSelectedKey(visible[0]?.key ?? null);
    }
  }, [selectedKey, visible]);

  const openSelected = () => {
    const item = visible[selected];
    if (item !== undefined) onOpen(item);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.key === "Process") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length > 0) {
        const next =
          event.key === "ArrowDown"
            ? (selected + 1) % visible.length
            : (selected - 1 + visible.length) % visible.length;
        setSelectedKey(visible[next]?.key ?? null);
        rows.current[next]?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openSelected();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const field = input.current;
    if (field === null || document.activeElement !== field) return;
    const atStart = field.selectionStart === 0 && field.selectionEnd === 0;
    const atEnd =
      field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
    if ((event.key === "ArrowLeft" && !atStart) || (event.key === "ArrowRight" && !atEnd)) return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % TABS.length
        : (index - 1 + TABS.length) % TABS.length;
    setTab(TABS[next]?.id ?? "all");
  };

  let rowIndex = 0;
  const renderRow = (item: SearchItem) => {
    const index = rowIndex++;
    const active = selected === index;
    const itemQuery = item.kind === "sessions" ? settledQuery : filterQuery;
    return (
      <button
        type="button"
        role="option"
        aria-selected={active}
        className={`search-row${active ? " selected" : ""}`}
        key={item.key}
        ref={(element) => {
          rows.current[index] = element;
        }}
        onMouseMove={() => {
          if (selected !== index) setSelectedKey(item.key);
        }}
        onClick={() => {
          onOpen(item);
        }}
      >
        <span className="search-row-icon">{itemIcon(item.kind)}</span>
        <span className="search-row-main">
          <span className="search-row-title">
            <Highlighted text={item.title} query={itemQuery} />
          </span>
          {item.snippet !== undefined && (
            <span className="search-row-snippet">
              <Highlighted text={item.snippet} query={itemQuery} ranges={item.ranges} />
            </span>
          )}
        </span>
        <span className={`search-row-info${item.kind === "projects" ? " mono" : ""}`}>
          {item.kind === "projects" ? (
            <Highlighted text={item.info} query={itemQuery} />
          ) : (
            item.info
          )}
        </span>
      </button>
    );
  };

  return (
    <div
      className="search-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        onKeyDown={onKeyDown}
      >
        <div className="search-input-row">
          <input
            ref={input}
            type="text"
            placeholder="搜索"
            aria-label="搜索"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              if (composing.current || event.target.value.trim() !== filterQuery) {
                request.current += 1;
              }
              if (!composing.current) setSelectedKey(null);
              onQueryChange(event.target.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              setCompositionVersion((version) => version + 1);
            }}
          />
          <button type="button" className="search-close" aria-label="关闭" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="m2.5 2.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </div>
        <div className="search-tabs" role="tablist">
          {TABS.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`search-tab${tab === item.id ? " active" : ""}`}
              key={item.id}
              onClick={() => {
                setTab(item.id);
                input.current?.focus();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="search-results" role="listbox">
          {visible.length === 0 ? (
            (filterQuery === "" ||
              completedQuery === filterQuery ||
              (tab !== "all" && tab !== "sessions")) && <div className="search-empty">没有结果</div>
          ) : filterQuery === "" ? (
            <>
              <div className="search-section-title">最近使用</div>
              {visible.map(renderRow)}
            </>
          ) : tab === "all" ? (
            GROUPS.map((group) => {
              const grouped = visible.filter((item) => item.kind === group.id);
              if (grouped.length === 0) return null;
              return (
                <section key={group.id}>
                  <div className="search-section-title">{group.label}</div>
                  {grouped.map(renderRow)}
                </section>
              );
            })
          ) : (
            visible.map(renderRow)
          )}
        </div>
      </div>
    </div>
  );
}
