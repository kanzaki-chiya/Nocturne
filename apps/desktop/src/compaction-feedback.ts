import { createContext, useContext, useState, useSyncExternalStore } from "react";

import type { ViewEntry } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

/**
 * 桌面会话手动 `/compact` 的即时反馈与耗时状态（ADR-0123）。
 *
 * 状态与已记录的摘要耗时按 `sessionId` 归属，独立于单次组件挂载和会话空闲关闭，
 * 以便切走会话或切换右侧面板标签后返回时仍能显示正确的进行中秒数或结束结果。
 */
export type ManualCompactionActive =
  | {
      readonly id: number;
      readonly status: "running";
      readonly startedAt: number;
      readonly baselineCompactedSeq: number;
    }
  | {
      readonly id: number;
      readonly status: "succeeded";
      readonly startedAt: number;
      readonly durationSeconds: number;
      readonly baselineCompactedSeq: number;
      readonly matchedSeq?: number | undefined;
    }
  | {
      readonly id: number;
      readonly status: "stopped";
      readonly startedAt: number;
      readonly durationSeconds: number;
      readonly afterEntryCount: number;
    }
  | {
      readonly id: number;
      readonly status: "failed";
      readonly startedAt: number;
      readonly durationSeconds: number;
      readonly message: string;
      readonly afterEntryCount: number;
    };

export interface SessionCompactionFeedback {
  readonly active?: ManualCompactionActive | undefined;
  readonly durationsBySeq: ReadonlyMap<number, number>;
}

export function isCompactionInterrupted(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === "compaction_interrupted") return true;
    const data = (error as { data?: unknown }).data;
    if (typeof data === "object" && data !== null) {
      if ((data as { code?: unknown }).code === "compaction_interrupted") return true;
    }
  }
  return false;
}

export function latestCompactedSeq(entries: readonly ViewEntry[]): number {
  let latest = 0;
  for (const entry of entries) {
    if (entry.kind === "notice" && entry.subtype === "compacted" && entry.seq > latest) {
      latest = entry.seq;
    }
  }
  return latest;
}

export function firstCompactedSeqAfter(
  entries: readonly ViewEntry[],
  baselineSeq: number,
): number | undefined {
  let matched: number | undefined;
  for (const entry of entries) {
    if (
      entry.kind === "notice" &&
      entry.subtype === "compacted" &&
      entry.seq > baselineSeq &&
      (matched === undefined || entry.seq < matched)
    ) {
      matched = entry.seq;
    }
  }
  return matched;
}

export function elapsedCompactionSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function compactionRunningText(seconds: number): string {
  return `正在压缩上下文 · ${String(seconds)} 秒`;
}

export function compactionSucceededText(seconds: number): string {
  return `上下文已压缩 · 用时 ${String(seconds)} 秒`;
}

export function compactionStoppedText(): string {
  return "压缩已停止";
}

export function compactionFailedText(message: string): string {
  const trimmed = message.trim();
  if (trimmed === "") return "压缩失败";
  if (trimmed.startsWith("压缩失败") || trimmed.startsWith("上下文压缩失败")) return trimmed;
  return `压缩失败：${trimmed}`;
}

export class CompactionFeedbackStore {
  private readonly sessions = new Map<string, SessionCompactionFeedback>();
  private readonly listeners = new Set<() => void>();
  private nextRunId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(sessionId: string): SessionCompactionFeedback | undefined {
    return this.sessions.get(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active?.status === "running";
  }

  begin(sessionId: string, entries: readonly ViewEntry[]): { id: number; startedAt: number } {
    const id = this.nextRunId++;
    const startedAt = this.now();
    const prev = this.sessions.get(sessionId);
    const durationsBySeq = prev?.durationsBySeq ?? new Map<number, number>();
    this.sessions.set(sessionId, {
      active: {
        id,
        status: "running",
        startedAt,
        baselineCompactedSeq: latestCompactedSeq(entries),
      },
      durationsBySeq,
    });
    this.emit();
    return { id, startedAt };
  }

  succeed(sessionId: string, runId: number, entries: readonly ViewEntry[]): void {
    const prev = this.sessions.get(sessionId);
    if (prev?.active?.id !== runId || prev.active.status !== "running") return;
    const durationSeconds = elapsedCompactionSeconds(prev.active.startedAt, this.now());
    const matchedSeq = firstCompactedSeqAfter(entries, prev.active.baselineCompactedSeq);
    const durationsBySeq =
      matchedSeq !== undefined
        ? new Map([...prev.durationsBySeq, [matchedSeq, durationSeconds]])
        : prev.durationsBySeq;
    this.sessions.set(sessionId, {
      active: {
        id: runId,
        status: "succeeded",
        startedAt: prev.active.startedAt,
        durationSeconds,
        baselineCompactedSeq: prev.active.baselineCompactedSeq,
        ...(matchedSeq !== undefined ? { matchedSeq } : {}),
      },
      durationsBySeq,
    });
    this.emit();
  }

  stop(sessionId: string, runId: number, afterEntryCount: number): void {
    const prev = this.sessions.get(sessionId);
    if (prev?.active?.id !== runId || prev.active.status !== "running") return;
    const durationSeconds = elapsedCompactionSeconds(prev.active.startedAt, this.now());
    this.sessions.set(sessionId, {
      active: {
        id: runId,
        status: "stopped",
        startedAt: prev.active.startedAt,
        durationSeconds,
        afterEntryCount,
      },
      durationsBySeq: prev.durationsBySeq,
    });
    this.emit();
  }

  fail(sessionId: string, runId: number, message: string, afterEntryCount: number): void {
    const prev = this.sessions.get(sessionId);
    if (prev?.active?.id !== runId || prev.active.status !== "running") return;
    const durationSeconds = elapsedCompactionSeconds(prev.active.startedAt, this.now());
    this.sessions.set(sessionId, {
      active: {
        id: runId,
        status: "failed",
        startedAt: prev.active.startedAt,
        durationSeconds,
        message,
        afterEntryCount,
      },
      durationsBySeq: prev.durationsBySeq,
    });
    this.emit();
  }

  /**
   * 视图出现新的 `compacted` 回执时（实时送达或切回会话重放），补齐尚未绑定的手动压缩耗时。
   */
  reconcile(sessionId: string, entries: readonly ViewEntry[]): void {
    const prev = this.sessions.get(sessionId);
    if (prev?.active?.status !== "succeeded" || prev.active.matchedSeq !== undefined) {
      return;
    }
    const matchedSeq = firstCompactedSeqAfter(entries, prev.active.baselineCompactedSeq);
    if (matchedSeq === undefined) return;
    this.sessions.set(sessionId, {
      active: {
        ...prev.active,
        matchedSeq,
      },
      durationsBySeq: new Map([...prev.durationsBySeq, [matchedSeq, prev.active.durationSeconds]]),
    });
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function runSessionCompaction(
  store: CompactionFeedbackStore,
  session: Pick<RpcSession, "id" | "compact">,
  getEntries: () => readonly ViewEntry[],
  onSettled?: () => void | Promise<void>,
): { runId: number; done: Promise<void> } {
  const { id: runId } = store.begin(session.id, getEntries());
  const done = (async () => {
    try {
      await session.compact();
      store.succeed(session.id, runId, getEntries());
    } catch (error) {
      const count = getEntries().length;
      if (isCompactionInterrupted(error)) {
        store.stop(session.id, runId, count);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        store.fail(session.id, runId, message, count);
      }
    } finally {
      await onSettled?.();
    }
  })();
  return { runId, done };
}

export const CompactionFeedbackContext = createContext<CompactionFeedbackStore | null>(null);

export function useCompactionFeedbackStore(
  override?: CompactionFeedbackStore,
): CompactionFeedbackStore {
  const fromContext = useContext(CompactionFeedbackContext);
  const [fallback] = useState(() => new CompactionFeedbackStore());
  return override ?? fromContext ?? fallback;
}

export function useCompactionFeedback(
  store: CompactionFeedbackStore,
  sessionId: string | undefined,
): SessionCompactionFeedback | undefined {
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => (sessionId === undefined ? undefined : store.get(sessionId)),
  );
}
