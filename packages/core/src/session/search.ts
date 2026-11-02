import path from "node:path";

import type { Platform } from "../platform/index.js";
import { decodeDurableEvent, userEntryText } from "../protocol/index.js";
import { effectiveEvents } from "../protocol/rewind.js";
import type { ContentBlock } from "../protocol/types.js";
import type { DurableEvent } from "../protocol/events.js";
import type {
  SessionSearchOptions,
  SessionSearchRange,
  SessionSearchResult,
  SessionStore,
  SessionSummary,
} from "./types.js";

const RESULT_LIMIT = 200;
const FILE_CONCURRENCY = 4;
const SNIPPET_BEFORE = 14;
const SNIPPET_AFTER = 160;

function abortError(): Error {
  const error = new Error("会话搜索已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function matchRanges(text: string, lowerQuery: string): SessionSearchRange[] {
  const lower = text.toLowerCase();
  const ranges: SessionSearchRange[] = [];
  let offset = 0;
  while (offset <= lower.length - lowerQuery.length) {
    const start = lower.indexOf(lowerQuery, offset);
    if (start < 0) break;
    ranges.push({ start, end: start + lowerQuery.length });
    offset = start + lowerQuery.length;
  }
  return ranges;
}

function snippet(text: string, query: string): { text: string; ranges: SessionSearchRange[] } {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lowerQuery = query.toLowerCase();
  const first = normalized.toLowerCase().indexOf(lowerQuery);
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(normalized.length, first + query.length + SNIPPET_AFTER);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  const body = normalized.slice(start, end);
  const ranges = matchRanges(body, lowerQuery).map((range) => ({
    start: range.start + prefix.length,
    end: range.end + prefix.length,
  }));
  return { text: `${prefix}${body}${suffix}`, ranges };
}

function textBlocks(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function eventText(event: DurableEvent): string | undefined {
  if (event.type === "message.user") return userEntryText(event.payload);
  if (event.type === "message.assistant") return textBlocks(event.payload.content);
  if (event.type === "tool.completed") return event.payload.modelContent;
  return undefined;
}

async function searchFile(
  platform: Platform,
  sessionsDir: string,
  summary: SessionSummary,
  query: string,
  signal: AbortSignal | undefined,
): Promise<SessionSearchResult | undefined> {
  throwIfAborted(signal);
  const titleMatches = summary.firstText?.toLowerCase().includes(query.toLowerCase()) === true;
  const lowerQuery = query.toLowerCase();
  // 回退只裁掉 targetSeq 之后的尾部：最早的命中被裁掉时，当时已有的命中都一起没了，
  // 所以任何时刻只需留一条，日志再大也不会把事件攒在内存里。
  let hit: DurableEvent | undefined;
  try {
    const file = path.join(sessionsDir, `${summary.id}.jsonl`);
    for await (const line of platform.fs.readLines(file, signal)) {
      throwIfAborted(signal);
      let event: DurableEvent;
      try {
        event = decodeDurableEvent(line);
      } catch {
        // 搜索不修复日志；单行损坏或较新的事件类型都不影响其它会话。
        continue;
      }
      if (hit === undefined) {
        if (eventText(event)?.toLowerCase().includes(lowerQuery) === true) hit = event;
      } else if (effectiveEvents([hit, event]).at(0) !== hit) {
        hit = undefined;
      }
    }
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw abortError();
    // 单个日志无法读取时仍保留可确定的标题命中，不让它拖垮整次搜索。
    return titleMatches ? { sessionId: summary.id, mtimeMs: summary.mtimeMs } : undefined;
  }
  const text = hit === undefined ? undefined : eventText(hit);
  if (hit !== undefined && text !== undefined) {
    const excerpt = snippet(text, query);
    return {
      sessionId: summary.id,
      mtimeMs: summary.mtimeMs,
      snippet: excerpt.text,
      ranges: excerpt.ranges,
      seq: hit.seq,
    };
  }
  return titleMatches ? { sessionId: summary.id, mtimeMs: summary.mtimeMs } : undefined;
}

/** 无索引的本地会话扫描；同时打开的日志数固定，结果按更新时间倒序。 */
export async function searchSessions(
  platform: Platform,
  store: Pick<SessionStore, "list">,
  sessionsDir: string,
  query: string,
  options?: SessionSearchOptions,
): Promise<SessionSearchResult[]> {
  if (query === "") return [];
  const signal = options?.signal;
  throwIfAborted(signal);
  const summaries = (await store.list())
    .filter((summary) => summary.id.length > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results: SessionSearchResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, summaries.length) }, async () => {
    // 按更新时间倒序取文件：够数后没开始的都更旧，不必再读。
    while (next < summaries.length && results.length < RESULT_LIMIT) {
      throwIfAborted(signal);
      const summary = summaries[next++];
      if (summary === undefined) return;
      const result = await searchFile(platform, sessionsDir, summary, query, signal);
      if (result !== undefined) results.push(result);
    }
  });
  await Promise.all(workers);
  throwIfAborted(signal);
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RESULT_LIMIT);
}
