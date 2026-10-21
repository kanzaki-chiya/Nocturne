/**
 * 子会话只读发现与观察（rpc.md 4.1、subagent.md 12.1）。
 *
 * - list：登记簿里的活动项 ∪ 日志头索引找到的 `session.created.parent` 映射；
 * - observe：活动 child 直接接已提交事件（先监听、后取前缀、按 seq 去重），
 *   其余读固定字节快照；两条路径都不取锁、不 resume、不修复、不写任何文件；
 * - readAttachment：以 child 自己的持久事件为授权集合，复用附件校验。
 *
 * 观察者抛错被吞掉，不影响运行；取消（unsubscribe / AbortSignal）后异步工作
 * 返回时检查标记并立即退订，不会复活。
 */
import {
  decodeDurableEvent,
  isDurableEvent,
  type DurableEvent,
  type RuntimeEvent,
  type SubagentObservation,
  type SubagentObserver,
  type SubagentReadEnd,
  type SubagentSummary,
  type ToolCallStatus,
  type TurnEndReason,
} from "../protocol/index.js";
import { fsErrorCode, type Platform } from "../platform/index.js";
import { readSessionAttachment, type ReadAttachmentResult } from "./attachment-read.js";
import { SessionError } from "./errors.js";
import { assertSafeSessionId, readLogReadonly } from "./readonly-log.js";
import type { ActiveSubagent, ObservedSignal, SubagentRegistry } from "./subagent-registry.js";

/** 回放每批推送的事件数，批间让出事件循环（与 RPC session.subscribe 回放同一数值） */
const REPLAY_CHUNK = 256;
const TASK_SUMMARY_MAX = 120;
const FALLBACK_TASK = "子任务";
/** 日志头索引先读的字节数：够装 session.created 首行 */
const HEAD_BYTES = 4096;
const INDEX_BATCH = 32;
const CACHE_LIMIT = 512;

/** task 原文压成单行，最多 120 个 Unicode 码点；空文本回退「子任务」 */
export function summarizeSubagentTask(text: string): string {
  const flat = text.slice(0, 20_000).replace(/\s+/g, " ").trim();
  return flat === "" ? FALLBACK_TASK : Array.from(flat).slice(0, TASK_SUMMARY_MAX).join("");
}

export interface SubagentObservationDeps {
  platform: Pick<Platform, "fs" | "paths">;
  sessionsDir: string;
  registry: SubagentRegistry;
}

export interface SubagentObservationService {
  list(input: { parentSessionId: string }): Promise<SubagentSummary[]>;
  observe(
    input: {
      parentSessionId: string;
      childSessionId: string;
      afterSeq?: number | undefined;
      /** 取消正在建立中的观察（RPC 连接断开、替换、父会话关闭等） */
      signal?: AbortSignal | undefined;
    },
    observer: SubagentObserver,
  ): Promise<SubagentObservation>;
  readAttachment(input: {
    parentSessionId: string;
    childSessionId: string;
    file: string;
  }): Promise<ReadAttachmentResult>;
}

interface ChildAnalysis {
  startedAt: string;
  parent: { sessionId: string; callId: string } | undefined;
  firstUserText: string | undefined;
  openTurn: boolean;
  finishOk: boolean;
  lastTurn: { reason: TurnEndReason; time: string } | undefined;
}

interface ParentCall {
  profile: string;
  task: string | undefined;
  completed:
    | {
        time: string;
        status: ToolCallStatus;
        durationMs: number | undefined;
        error: { code: string; message: string } | undefined;
      }
    | undefined;
}

function analyzeChild(events: readonly DurableEvent[]): ChildAnalysis {
  const first = events[0];
  const analysis: ChildAnalysis = {
    startedAt: first?.time ?? "",
    parent: first?.type === "session.created" ? first.payload.parent : undefined,
    firstUserText: undefined,
    openTurn: false,
    finishOk: false,
    lastTurn: undefined,
  };
  for (const event of events) {
    if (event.type === "turn.started") analysis.openTurn = true;
    else if (event.type === "turn.completed") {
      analysis.openTurn = false;
      analysis.lastTurn = { reason: event.payload.reason, time: event.time };
    } else if (event.type === "message.user" && analysis.firstUserText === undefined) {
      analysis.firstUserText = event.payload.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    } else if (
      event.type === "tool.completed" &&
      event.payload.name === "finish" &&
      event.payload.status === "ok"
    ) {
      analysis.finishOk = true;
    }
  }
  return analysis;
}

function extractParentCalls(events: Iterable<DurableEvent>): Map<string, ParentCall> {
  const calls = new Map<string, ParentCall>();
  for (const event of events) {
    if (event.type === "tool.started" && event.payload.name === "task") {
      const input = event.payload.input;
      const record =
        typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
      const named = record.profile ?? record.agent;
      const previous = calls.get(event.payload.callId);
      calls.set(event.payload.callId, {
        profile: typeof named === "string" && named !== "" ? named : "default",
        task: typeof record.task === "string" ? record.task : undefined,
        completed: previous?.completed,
      });
    } else if (event.type === "tool.completed" && event.payload.name === "task") {
      const previous = calls.get(event.payload.callId);
      calls.set(event.payload.callId, {
        profile: previous?.profile ?? "default",
        task: previous?.task,
        completed: {
          time: event.time,
          status: event.payload.status,
          durationMs: event.payload.durationMs,
          error: event.payload.error,
        },
      });
    }
  }
  return calls;
}

function msBetween(from: string, to: string): number | undefined {
  const delta = Date.parse(to) - Date.parse(from);
  return Number.isFinite(delta) ? Math.max(0, delta) : undefined;
}

function outcomeOf(call: ParentCall | undefined): Pick<SubagentSummary, "outcome"> {
  const completed = call?.completed;
  if (completed === undefined) return {};
  return {
    outcome: {
      status: completed.status,
      ...(completed.error !== undefined ? { error: completed.error } : {}),
    },
  };
}

/** 终止事实 → endedAt / durationMs（父 task 耗时优先，否则起止事件时间差并标近似） */
function durationFields(
  startedAt: string,
  endedAt: string | undefined,
  call: ParentCall | undefined,
): Pick<SubagentSummary, "endedAt" | "durationMs" | "durationApproximate"> {
  const exact = call?.completed?.durationMs;
  if (exact !== undefined)
    return { ...(endedAt !== undefined ? { endedAt } : {}), durationMs: exact };
  if (endedAt === undefined) return {};
  const delta = msBetween(startedAt, endedAt);
  return {
    endedAt,
    ...(delta !== undefined ? { durationMs: delta, durationApproximate: true as const } : {}),
  };
}

/**
 * 没有活动观察源时能否证明子代理已结束（rpc.md 4.1 第 4 点）：尚有未闭合 Turn 时
 * 始终 unsealed；否则有父结算、已闭合的成功 finish、或最后一轮以非 done 原因结束才算 ended。
 */
function sealed(analysis: ChildAnalysis, call: ParentCall | undefined): boolean {
  if (analysis.openTurn) return false;
  if (call?.completed !== undefined) return true;
  if (analysis.finishOk) return true;
  return analysis.lastTurn !== undefined && analysis.lastTurn.reason !== "done";
}

function snapshotSummary(
  parentSessionId: string,
  childSessionId: string,
  analysis: ChildAnalysis,
  call: ParentCall | undefined,
): SubagentSummary {
  const callId = analysis.parent?.callId ?? "";
  const ended = sealed(analysis, call);
  const endedAt = ended ? (call?.completed?.time ?? analysis.lastTurn?.time) : undefined;
  return {
    parentSessionId,
    callId,
    childSessionId,
    profile: call?.profile ?? "default",
    taskSummary: summarizeSubagentTask(call?.task ?? analysis.firstUserText ?? ""),
    startedAt: analysis.startedAt,
    state: ended ? "ended" : "unsealed",
    ...(ended ? durationFields(analysis.startedAt, endedAt, call) : {}),
    ...outcomeOf(call),
  };
}

function runningSummary(entry: ActiveSubagent): SubagentSummary {
  return {
    parentSessionId: entry.parentSessionId,
    callId: entry.callId,
    childSessionId: entry.childSessionId,
    profile: entry.profile,
    taskSummary: entry.taskSummary,
    startedAt: entry.startedAt,
    state: "running",
  };
}

/** launcher 收尾时的摘要：此刻父调用尚未结算，没有 outcome，耗时按事件时间差标近似 */
function launcherEndSummary(entry: ActiveSubagent): SubagentSummary {
  const analysis = analyzeChild(entry.durableEvents());
  return {
    ...snapshotSummary(entry.parentSessionId, entry.childSessionId, analysis, undefined),
    profile: entry.profile,
    taskSummary: entry.taskSummary,
  };
}

const lastSeqOf = (events: readonly DurableEvent[]): number => events.at(-1)?.seq ?? 0;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 观察者回调抛错一律吞掉，不能影响运行、锁或回放 */
function guarded(fn: () => void): void {
  try {
    fn();
  } catch {
    // 观察者自己的错误不属于观察源
  }
}

function checkAfterSeq(afterSeq: number | undefined, highWater: number): number {
  const value = afterSeq ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > highWater) {
    throw new SessionError(
      "invalid_after_seq",
      `afterSeq 必须是不大于持久高水位 ${highWater} 的非负整数`,
    );
  }
  return value;
}

export function createSubagentObservation(
  deps: SubagentObservationDeps,
): SubagentObservationService {
  const { registry } = deps;
  const { fs, paths } = deps.platform;
  const logPath = (id: string): string => paths.join(deps.sessionsDir, `${id}.jsonl`);

  // ── 缓存（只是读取加速，不是事实源；指纹变化即重读） ──────────
  /** 日志首行（session.created）不可变：id → parent 映射；null 表示顶层会话 */
  const heads = new Map<string, { sessionId: string; callId: string } | null>();
  const analyses = new Map<string, { size: number; mtimeMs: number; analysis: ChildAnalysis }>();
  const parentCallCache = new Map<
    string,
    { size: number; mtimeMs: number; calls: Map<string, ParentCall> }
  >();

  function capped<V>(map: Map<string, V>): void {
    if (map.size > CACHE_LIMIT) map.clear();
  }

  async function statOf(id: string): Promise<{ size: number; mtimeMs: number }> {
    try {
      const stat = await fs.stat(logPath(id));
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (e) {
      const code = fsErrorCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new SessionError("session_not_found", `会话不存在: ${id}`);
      }
      throw new SessionError("session_read_failed", `读取会话日志失败: ${id}`, { cause: e });
    }
  }

  /** 读文件首行；尚未写完整（还没有换行）返回 undefined，不缓存 */
  async function readHead(id: string): Promise<DurableEvent | undefined> {
    const path = logPath(id);
    const slice = await fs.readFileSlice(path, HEAD_BYTES);
    let end = slice.indexOf(0x0a);
    let bytes = slice;
    if (end < 0 && slice.length >= HEAD_BYTES) {
      bytes = await fs.readFile(path);
      end = bytes.indexOf(0x0a);
    }
    if (end < 0) return undefined;
    return decodeDurableEvent(new TextDecoder().decode(bytes.subarray(0, end)));
  }

  /** 日志头索引：parentSessionId 的全部直接子会话（含已结束） */
  async function childrenOf(parentSessionId: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(deps.sessionsDir);
    } catch (e) {
      if (fsErrorCode(e) === "ENOENT") return [];
      throw new SessionError("session_read_failed", "读取会话目录失败", { cause: e });
    }
    const ids = entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(0, -".jsonl".length));
    const present = new Set(ids);
    for (const id of heads.keys()) if (!present.has(id)) heads.delete(id);
    const unknown = ids.filter((id) => !heads.has(id));
    for (let i = 0; i < unknown.length; i += INDEX_BATCH) {
      await Promise.all(
        unknown.slice(i, i + INDEX_BATCH).map(async (id) => {
          try {
            const head = await readHead(id);
            if (head === undefined) return;
            heads.set(id, head.type === "session.created" ? (head.payload.parent ?? null) : null);
          } catch {
            // 单个不可读候选按既有列表规则跳过
          }
        }),
      );
    }
    return ids.filter((id) => heads.get(id)?.sessionId === parentSessionId);
  }

  /** 子日志的只读分析（按文件指纹缓存）；不可读、损坏时抛错，由调用方决定跳过或上报 */
  async function analysisOf(childSessionId: string): Promise<ChildAnalysis> {
    const stat = await statOf(childSessionId);
    const cached = analyses.get(childSessionId);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.analysis;
    }
    const log = await readLogReadonly(fs, logPath(childSessionId), childSessionId);
    const analysis = analyzeChild(log.events);
    capped(analyses);
    analyses.set(childSessionId, { ...stat, analysis });
    return analysis;
  }

  /** 父会话的 task 调用事实：已有 Session 读其已提交事件，否则只读父日志 */
  async function parentCallsOf(parentSessionId: string): Promise<Map<string, ParentCall>> {
    const live = registry.liveSession(parentSessionId);
    if (live !== undefined) return extractParentCalls(live.durableEvents());
    const stat = await statOf(parentSessionId);
    const cached = parentCallCache.get(parentSessionId);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.calls;
    }
    const log = await readLogReadonly(fs, logPath(parentSessionId), parentSessionId);
    const calls = extractParentCalls(log.events);
    capped(parentCallCache);
    parentCallCache.set(parentSessionId, { ...stat, calls });
    return calls;
  }

  async function parentCallsOrEmpty(parentSessionId: string): Promise<Map<string, ParentCall>> {
    try {
      return await parentCallsOf(parentSessionId);
    } catch {
      return new Map();
    }
  }

  function assertParent(actual: string | undefined, expected: string): void {
    if (actual !== expected) {
      throw new SessionError("subagent_parent_mismatch", "指定的会话不是该父会话的直接子会话");
    }
  }

  async function snapshotOf(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<{ events: DurableEvent[]; tailIgnored: boolean }> {
    const log = await readLogReadonly(fs, logPath(childSessionId), childSessionId);
    const created = log.events[0];
    assertParent(
      created?.type === "session.created" ? created.payload.parent?.sessionId : undefined,
      parentSessionId,
    );
    return { events: log.events, tailIgnored: log.tailIgnored };
  }

  // ── list ────────────────────────────────────────────────────

  async function list(input: { parentSessionId: string }): Promise<SubagentSummary[]> {
    assertSafeSessionId(input.parentSessionId, "parentSessionId");
    const parentSessionId = input.parentSessionId;
    const calls = await parentCallsOf(parentSessionId);
    const summaries = new Map<string, SubagentSummary>();
    for (const entry of registry.activeOf(parentSessionId)) {
      summaries.set(entry.childSessionId, runningSummary(entry));
    }
    for (const childSessionId of await childrenOf(parentSessionId)) {
      if (summaries.has(childSessionId)) continue;
      try {
        const analysis = await analysisOf(childSessionId);
        // 扫描期间刚被登记的活动项以登记簿为准
        const live = registry.find(childSessionId);
        summaries.set(
          childSessionId,
          live?.parentSessionId === parentSessionId
            ? runningSummary(live)
            : snapshotSummary(
                parentSessionId,
                childSessionId,
                analysis,
                calls.get(analysis.parent?.callId ?? ""),
              ),
        );
      } catch {
        // 单个不可读候选按既有列表规则跳过
      }
    }
    return [...summaries.values()].sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.childSessionId.localeCompare(b.childSessionId),
    );
  }

  // ── observe ─────────────────────────────────────────────────

  async function observe(
    input: Parameters<SubagentObservationService["observe"]>[0],
    observer: SubagentObserver,
  ): Promise<SubagentObservation> {
    assertSafeSessionId(input.parentSessionId, "parentSessionId");
    assertSafeSessionId(input.childSessionId, "childSessionId");
    const { parentSessionId, childSessionId, signal } = input;
    const abortError = (): Error =>
      signal?.reason instanceof Error ? signal.reason : new Error("观察已取消");
    if (signal?.aborted === true) throw abortError();

    const active = registry.find(childSessionId);
    if (active !== undefined) {
      assertParent(active.parentSessionId, parentSessionId);
      return observeLive(active, input.afterSeq, observer, signal, abortError);
    }
    return observeSnapshot(
      parentSessionId,
      childSessionId,
      input.afterSeq,
      observer,
      signal,
      abortError,
    );
  }

  async function observeLive(
    entry: ActiveSubagent,
    afterSeq: number | undefined,
    observer: SubagentObserver,
    signal: AbortSignal | undefined,
    abortError: () => Error,
  ): Promise<SubagentObservation> {
    // 状态集中在一个对象里：回调与异步流程共同读写，避免被控制流收窄成常量
    const state: {
      lastSeq: number;
      replaying: boolean;
      cancelled: boolean;
      ended: SubagentReadEnd | undefined;
    } = { lastSeq: 0, replaying: true, cancelled: false, ended: undefined };
    const buffer: ObservedSignal[] = [];
    const isCancelled = (): boolean => state.cancelled;

    const emitEvent = (event: RuntimeEvent): void => {
      if (state.cancelled || state.ended !== undefined) return;
      if (isDurableEvent(event)) {
        if (event.seq <= state.lastSeq) return;
        state.lastSeq = event.seq;
      }
      guarded(() => {
        observer.onEvent(event);
      });
    };
    const handle = (item: ObservedSignal): void => {
      if (state.cancelled || state.ended !== undefined) return;
      if (item.kind === "event") {
        emitEvent(item.event);
        return;
      }
      const end: SubagentReadEnd = {
        lastSeq: lastSeqOf(entry.durableEvents()),
        summary: launcherEndSummary(entry),
        source: "launcher",
        tailIgnored: false,
      };
      state.ended = end;
      signal?.removeEventListener("abort", cancel);
      guarded(() => {
        observer.onEnd(end);
      });
    };

    // 登记簿查找、挂监听、取前缀之间没有异步间隙（attach 内同步完成）
    const attachment = entry.attach((item) => {
      if (state.cancelled) return;
      if (state.replaying) buffer.push(item);
      else handle(item);
    });
    if (attachment === undefined) {
      // 登记项恰在查找后结束：落到只读快照（日志已全部提交）
      return observeSnapshot(
        entry.parentSessionId,
        entry.childSessionId,
        afterSeq,
        observer,
        signal,
        abortError,
      );
    }
    const cancel = (): void => {
      state.cancelled = true;
      attachment.detach();
      buffer.length = 0;
      signal?.removeEventListener("abort", cancel);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const highWater = lastSeqOf(attachment.prefix);
      try {
        state.lastSeq = checkAfterSeq(afterSeq, highWater);
      } catch (e) {
        cancel();
        throw e;
      }
      const replay = attachment.prefix.filter((event) => event.seq > state.lastSeq);
      for (let i = 0; i < replay.length; i += REPLAY_CHUNK) {
        if (isCancelled()) throw abortError();
        for (const event of replay.slice(i, i + REPLAY_CHUNK)) emitEvent(event);
        if (i + REPLAY_CHUNK < replay.length) await yieldToEventLoop();
      }
      if (isCancelled()) throw abortError();
      // 缓冲也可能很长：继续让新事件排队，按批冲刷完才切实时，维持通知顺序。
      while (buffer.length > 0) {
        for (const item of buffer.splice(0, REPLAY_CHUNK)) handle(item);
        if (isCancelled()) throw abortError();
        if (buffer.length > 0) await yieldToEventLoop();
      }
      if (isCancelled()) throw abortError();
      state.replaying = false;
      state.lastSeq = Math.max(state.lastSeq, highWater);
    } catch (error) {
      cancel();
      throw error;
    }
    return {
      lastSeq: state.lastSeq,
      summary: state.ended?.summary ?? runningSummary(entry),
      mode: "live",
      unsubscribe: cancel,
    };
  }

  async function observeSnapshot(
    parentSessionId: string,
    childSessionId: string,
    afterSeq: number | undefined,
    observer: SubagentObserver,
    signal: AbortSignal | undefined,
    abortError: () => Error,
  ): Promise<SubagentObservation> {
    const isAborted = (): boolean => signal?.aborted === true;
    const snapshot = await snapshotOf(parentSessionId, childSessionId);
    if (isAborted()) throw abortError();
    const highWater = lastSeqOf(snapshot.events);
    const start = checkAfterSeq(afterSeq, highWater);
    const calls = await parentCallsOrEmpty(parentSessionId);
    if (isAborted()) throw abortError();
    const analysis = analyzeChild(snapshot.events);
    const summary = snapshotSummary(
      parentSessionId,
      childSessionId,
      analysis,
      calls.get(analysis.parent?.callId ?? ""),
    );

    const replay = snapshot.events.filter((event) => event.seq > start);
    for (let i = 0; i < replay.length; i += REPLAY_CHUNK) {
      if (isAborted()) throw abortError();
      for (const event of replay.slice(i, i + REPLAY_CHUNK)) {
        if (isAborted()) throw abortError();
        guarded(() => {
          observer.onEvent(event);
        });
      }
      if (i + REPLAY_CHUNK < replay.length) await yieldToEventLoop();
    }
    if (isAborted()) throw abortError();
    guarded(() => {
      observer.onEnd({
        lastSeq: highWater,
        summary,
        source: "snapshot",
        tailIgnored: snapshot.tailIgnored,
      });
    });
    return {
      lastSeq: highWater,
      summary,
      mode: "snapshot",
      // 快照读完即自然结束，没有任何持续的订阅可撤
      unsubscribe: () => undefined,
    };
  }

  // ── readAttachment ──────────────────────────────────────────

  async function readAttachment(input: {
    parentSessionId: string;
    childSessionId: string;
    file: string;
  }): Promise<ReadAttachmentResult> {
    assertSafeSessionId(input.parentSessionId, "parentSessionId");
    assertSafeSessionId(input.childSessionId, "childSessionId");
    const active = registry.find(input.childSessionId);
    let events: readonly DurableEvent[];
    if (active !== undefined) {
      assertParent(active.parentSessionId, input.parentSessionId);
      events = active.durableEvents();
    } else {
      events = (await snapshotOf(input.parentSessionId, input.childSessionId)).events;
    }
    return readSessionAttachment(
      deps.platform,
      deps.sessionsDir,
      input.childSessionId,
      events,
      input.file,
    );
  }

  return { list, observe, readAttachment };
}
