/**
 * 跨会话搜索浮层（ADR-0077 修订、tui.md §6）：
 * 未输入列最近会话（同 /resume 口径、不限目录、最多 8 条）；
 * 输入后 150 ms 防抖调用 runtime.searchSessions，增量替换/追加并按会话 id 保持选中。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Runtime,
  SessionSearchRange,
  SessionSearchResult,
  SessionSummary,
} from "@nocturne/core";

import { searchSessionLabel } from "../resume-label.js";
import { PickList, type PickItem, type PickSpan } from "./pick-list.js";

const DEBOUNCE_MS = 150;
const RECENT_LIMIT = 8;

export interface SessionSearchTarget {
  sessionId: string;
  seq?: number | undefined;
  query?: string | undefined;
}

type SearchSource =
  | { kind: "recent"; searching: boolean }
  | { kind: "matches"; matches: readonly SessionSearchResult[]; settled: boolean };

export function snippetSpans(
  snippet: string,
  ranges: readonly SessionSearchRange[] | undefined,
): PickSpan[] {
  if (ranges === undefined || ranges.length === 0) {
    return [{ text: snippet }];
  }
  const out: PickSpan[] = [];
  let pos = 0;
  for (const r of ranges) {
    const start = Math.max(pos, Math.min(snippet.length, r.start));
    const end = Math.max(start, Math.min(snippet.length, r.end));
    if (start > pos) out.push({ text: snippet.slice(pos, start) });
    if (end > start) out.push({ text: snippet.slice(start, end), accent: true });
    pos = end;
  }
  if (pos < snippet.length) out.push({ text: snippet.slice(pos) });
  return out;
}

export function SessionSearch({
  runtime,
  currentCwd,
  initialQuery = "",
  width,
  maxRows,
  cursorY,
  active = true,
  onOpen,
  onCancel,
}: {
  runtime: Runtime;
  currentCwd: string;
  initialQuery?: string | undefined;
  width: number;
  maxRows: number;
  cursorY?: number | undefined;
  active?: boolean | undefined;
  onOpen: (target: SessionSearchTarget) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const initialTrimmed = initialQuery.trim();
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(initialQuery.length);
  const [summariesState, setSummariesState] = useState<{
    loaded: boolean;
    items: readonly SessionSummary[];
  }>({ loaded: false, items: [] });
  const [source, setSource] = useState<SearchSource>(() =>
    initialTrimmed === ""
      ? { kind: "recent", searching: false }
      : { kind: "matches", matches: [], settled: false },
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const reqIdRef = useRef(0);
  const lastTrimmedRef = useRef(initialTrimmed);

  const startSearch = useCallback(
    (q: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const reqId = ++reqIdRef.current;
      let firstBatch = true;
      let accumulated: SessionSearchResult[] = [];

      void runtime
        .searchSessions(q, {
          signal: controller.signal,
          includeArchived: true,
          onProgress: (batch) => {
            if (reqIdRef.current !== reqId || controller.signal.aborted || batch.length === 0) {
              return;
            }
            if (firstBatch) {
              firstBatch = false;
              accumulated = [...batch];
            } else {
              accumulated = [...accumulated, ...batch];
            }
            setSource({ kind: "matches", matches: accumulated, settled: false });
          },
        })
        .then(
          (finalResults) => {
            if (reqIdRef.current !== reqId || controller.signal.aborted) return;
            setSource({ kind: "matches", matches: finalResults, settled: true });
          },
          () => {
            if (reqIdRef.current !== reqId || controller.signal.aborted) return;
            setSource({ kind: "matches", matches: [], settled: true });
          },
        );
    },
    [runtime],
  );

  useEffect(() => {
    let alive = true;
    void runtime
      .listSessions({ includeArchived: true })
      .then((rows) => {
        if (alive) setSummariesState({ loaded: true, items: rows });
      })
      .catch(() => {
        if (alive) setSummariesState({ loaded: true, items: [] });
      });
    return () => {
      alive = false;
    };
  }, [runtime]);

  useEffect(() => {
    if (initialTrimmed !== "") {
      startSearch(initialTrimmed);
    }
    return () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
      reqIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const handleQueryChange = useCallback(
    (next: string, nextCursor: number) => {
      setQuery(next);
      setCursor(nextCursor);
      setSelectedSessionId(undefined);

      const trimmed = next.trim();
      if (trimmed === lastTrimmedRef.current) return;
      lastTrimmedRef.current = trimmed;

      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
      reqIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = undefined;

      if (trimmed === "") {
        setSource({ kind: "recent", searching: false });
        return;
      }

      setSource((prev) =>
        prev.kind === "recent"
          ? { kind: "recent", searching: true }
          : { kind: "matches", matches: prev.matches, settled: false },
      );
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        startSearch(trimmed);
      }, DEBOUNCE_MS);
    },
    [startSearch],
  );

  const summaryById = useMemo(
    () => new Map(summariesState.items.map((s) => [s.id, s])),
    [summariesState.items],
  );

  const recentSessions = useMemo(
    () =>
      summariesState.items
        .filter((s) => s.archivedAt === undefined)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, RECENT_LIMIT),
    [summariesState.items],
  );

  const labelWidth = Math.max(10, width - 10);

  const items: PickItem<SessionSearchTarget>[] = useMemo(() => {
    if (source.kind === "recent") {
      return recentSessions.map((s) => ({
        key: s.id,
        label: searchSessionLabel(s, currentCwd, labelWidth),
        value: { sessionId: s.id },
      }));
    }
    const activeQuery = lastTrimmedRef.current;
    const out: PickItem<SessionSearchTarget>[] = [];
    for (const match of source.matches) {
      const summary = summaryById.get(match.sessionId);
      if (summary === undefined) continue;
      out.push({
        key: match.sessionId,
        label: searchSessionLabel(summary, currentCwd, labelWidth),
        ...(match.snippet !== undefined
          ? { detail: snippetSpans(match.snippet, match.ranges) }
          : {}),
        value: {
          sessionId: match.sessionId,
          ...(match.seq !== undefined ? { seq: match.seq } : {}),
          ...(activeQuery !== "" ? { query: activeQuery } : {}),
        },
      });
    }
    return out;
  }, [source, recentSessions, summaryById, currentCwd, labelWidth]);

  const selectedIndex = useMemo(() => {
    if (items.length === 0 || selectedSessionId === undefined) return 0;
    const idx = items.findIndex((item) => item.value.sessionId === selectedSessionId);
    return idx >= 0 ? idx : 0;
  }, [items, selectedSessionId]);

  const handleSelectIndex = useCallback(
    (index: number) => {
      const picked = items[index];
      setSelectedSessionId(picked?.value.sessionId);
    },
    [items],
  );

  const empty =
    summariesState.loaded &&
    items.length === 0 &&
    ((source.kind === "recent" && !source.searching) ||
      (source.kind === "matches" && source.settled));

  return (
    <PickList
      items={items}
      selectedIndex={selectedIndex}
      onSelectIndex={handleSelectIndex}
      query={{
        value: query,
        cursor,
        onChange: handleQueryChange,
        onCursor: setCursor,
        cursorY,
      }}
      emptyText={empty ? "  没有结果" : null}
      showFooter={false}
      maxRows={maxRows}
      width={width}
      active={active}
      onPick={onOpen}
      onCancel={onCancel}
    />
  );
}
