import { createHash } from "node:crypto";
import { fsErrorCode, type Platform } from "../platform/index.js";
import {
  effectiveEvents,
  lineDiff,
  type CheckpointBefore,
  type DurableEvent,
  type TurnChangeFile,
  type TurnChanges,
  type TurnChangeDiff,
} from "../protocol/index.js";
import { isUntrackedCall, lastFileStates } from "./rewind.js";
import type { Session } from "./types.js";

interface Snapshot {
  path: string;
  before: CheckpointBefore;
  after?: string | null;
  afterSeq?: number;
  /** 精确结果不可用时，参与退回拼接的 tool.completed seq（按事件顺序） */
  fallbackSeqs: number[];
}
interface Calculation {
  file: Omit<TurnChangeFile, "external">;
  diff?: TurnChangeDiff;
}

/** 写文件类工具结果的两种形状（tool-api.md）：{ path, diff } 或 { files: [{ path, diff }] } */
function resultDiffs(output: unknown): { path: string; diff: string }[] {
  if (output === null || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  if (typeof record.path === "string" && typeof record.diff === "string")
    return [{ path: record.path, diff: record.diff }];
  if (!Array.isArray(record.files)) return [];
  return record.files.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const file = item as Record<string, unknown>;
    return typeof file.path === "string" && typeof file.diff === "string"
      ? [{ path: file.path, diff: file.diff }]
      : [];
  });
}

/** 只计 +/- 源码行，不含 ---/+++/@@ 头与 \ 标记行 */
function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-") && !line.startsWith("--")) removed++;
    // \ 标记行（CRLF / No newline）不计入
  }
  return { added, removed };
}

/** One read-only query/cache instance per RuntimeSession. Ownership uses the raw log. */
export function createTurnChanges(session: Session, platform: Platform, sessionsDir: string) {
  const cache = new Map<string, Promise<Calculation | undefined>>();
  const openedSeq = session.durableEvents().at(-1)?.seq ?? 0;
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const canonical = (path: string) => platform.paths.canonicalize(path);
  const checkpoint = (sha: string) =>
    platform.paths.join(sessionsDir, "checkpoints", session.id, sha);

  function collect(events: readonly DurableEvent[]) {
    const active = new Set(
      effectiveEvents(events)
        .filter((e) => e.type === "message.user")
        .map((e) => e.seq),
    );
    const rounds = new Map<number, { files: Map<string, Snapshot>; untrackedCalls: number }>();
    const lastAfter = lastFileStates(events, platform);
    let seq = 0;
    for (const e of events) {
      if (e.type === "message.user") {
        seq = e.seq;
        if (active.has(seq)) rounds.set(seq, { files: new Map(), untrackedCalls: 0 });
      }
      const round = rounds.get(seq);
      if (!round) continue;
      if (isUntrackedCall(e)) round.untrackedCalls++;
      if (e.type === "tool.completed" && e.payload.status === "ok") {
        for (const item of resultDiffs(e.payload.output)) {
          const snapshot = round.files.get(canonical(item.path));
          if (!snapshot) continue;
          snapshot.fallbackSeqs.push(e.seq);
        }
      }
      if (e.type !== "checkpoint.file") continue;
      const key = canonical(e.payload.path);
      if (e.payload.phase === "before") {
        if (!round.files.has(key))
          round.files.set(key, {
            path: e.payload.path,
            before: e.payload.before,
            fallbackSeqs: [],
          });
      } else {
        const snapshot = round.files.get(key);
        if (snapshot) {
          snapshot.after = e.payload.sha256;
          snapshot.afterSeq = e.seq;
        }
      }
    }
    return { rounds, lastAfter };
  }

  /** 精确检查点不可用时，按本轮 tool.completed 结果形状拼接 diff（不按工具名） */
  function fallback(events: readonly DurableEvent[], snapshot: Snapshot): Calculation | undefined {
    if (snapshot.fallbackSeqs.length === 0) return undefined;
    const parts: string[] = [];
    for (const seq of snapshot.fallbackSeqs) {
      const event = events.find((e) => e.seq === seq);
      if (event?.type !== "tool.completed") continue;
      const item = resultDiffs(event.payload.output).find(
        (entry) => canonical(entry.path) === canonical(snapshot.path),
      );
      if (item) parts.push(item.diff);
    }
    if (parts.length === 0) return undefined;
    const diff = parts.join("\n");
    const counts = diffCounts(diff);
    const { path, before, after } = snapshot;
    return {
      file: {
        path,
        status:
          before === null && after != null
            ? "added"
            : before !== null && after === null
              ? "deleted"
              : "modified",
        added: counts.added,
        removed: counts.removed,
        approximate: true,
        restorable: before === null || !("untracked" in before),
      },
      diff: { diff, approximate: true },
    };
  }

  async function calculate(
    snapshot: Snapshot,
    events: readonly DurableEvent[],
  ): Promise<Calculation | undefined> {
    const { path, before, after } = snapshot;
    const file: Calculation["file"] = {
      path,
      status:
        before === null && after != null
          ? "added"
          : before !== null && after === null
            ? "deleted"
            : "modified",
      restorable: before === null || !("untracked" in before),
    };
    const degrade = (reason: string): Calculation => ({
      file: { ...file, unavailable: reason },
    });
    const unavailable = (reason: string): Calculation =>
      fallback(events, snapshot) ?? degrade(reason);
    if (before !== null && "untracked" in before)
      return (
        fallback(events, snapshot) ?? {
          file: { path, status: "modified", unavailable: before.untracked, restorable: false },
        }
      );
    if (after === undefined) return unavailable("没有改动后的记录");
    if ((before === null ? null : before.sha256) === after) return undefined;
    let oldBytes: Uint8Array = new Uint8Array();
    let newBytes: Uint8Array = new Uint8Array();
    if (before !== null) {
      try {
        oldBytes = await platform.fs.readFile(checkpoint(before.sha256));
      } catch {
        return unavailable("检查点内容缺失");
      }
      if (hash(oldBytes) !== before.sha256 || oldBytes.length !== before.size)
        return unavailable("检查点内容缺失");
    }
    if (after !== null) {
      try {
        newBytes = await platform.fs.readFile(checkpoint(after));
      } catch (e) {
        return unavailable(
          fsErrorCode(e) === "ENOENT" && (snapshot.afterSeq ?? 0) <= openedSeq
            ? "旧会话没有保存改动后的内容"
            : "检查点内容缺失",
        );
      }
      if (hash(newBytes) !== after) return unavailable("检查点内容缺失");
    }
    if (oldBytes.length > 1024 * 1024 || newBytes.length > 1024 * 1024)
      return degrade("文件较大，不计算差异");
    if (oldBytes.includes(0) || newBytes.includes(0)) return degrade("二进制文件");
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    const result = lineDiff(decode(oldBytes), decode(newBytes));
    if (!result.diff) return undefined;
    return {
      file: {
        ...file,
        added: result.added,
        removed: result.removed,
        ...(result.approximate ? { approximate: true } : {}),
      },
      diff: { diff: result.diff, ...(result.approximate ? { approximate: true } : {}) },
    };
  }
  function cached(seq: number, key: string, snapshot: Snapshot, events: readonly DurableEvent[]) {
    const id = JSON.stringify([seq, key, snapshot.before, snapshot.after, snapshot.fallbackSeqs]);
    let pending = cache.get(id);
    if (!pending) {
      pending = calculate(snapshot, events);
      cache.set(id, pending);
    }
    return pending;
  }
  async function external(path: string, expected: string | null | undefined) {
    try {
      return hash(await platform.fs.readFile(path)) !== expected;
    } catch (e) {
      return fsErrorCode(e) !== "ENOENT" || expected !== null;
    }
  }
  return {
    async changes(): Promise<TurnChanges[]> {
      const events = session.durableEvents();
      const { rounds, lastAfter } = collect(events);
      const result: TurnChanges[] = [];
      for (const [seq, round] of rounds) {
        const files: TurnChangeFile[] = [];
        for (const [key, snapshot] of round.files) {
          const value = await cached(seq, key, snapshot, events);
          if (value)
            files.push({
              ...value.file,
              external: await external(snapshot.path, lastAfter.get(key)),
            });
        }
        if (!files.length && !round.untrackedCalls) continue;
        const reverted = events.findLast(
          (e) =>
            e.type === "session.rewound" &&
            e.payload.mode === "files" &&
            e.payload.targetSeq <= seq &&
            e.seq > seq,
        );
        result.push({
          seq,
          files,
          untrackedCalls: round.untrackedCalls,
          ...(reverted?.type === "session.rewound"
            ? { reverted: { seq: reverted.seq, files: reverted.payload.files } }
            : {}),
        });
      }
      return result;
    },
    async diff(seq: number, path: string): Promise<TurnChangeDiff | undefined> {
      const events = session.durableEvents();
      const { rounds } = collect(events);
      const key = canonical(path);
      const snapshot = rounds.get(seq)?.files.get(key);
      if (!snapshot) return undefined;
      return (await cached(seq, key, snapshot, events))?.diff;
    },
  };
}
