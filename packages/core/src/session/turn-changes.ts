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
import { isUntrackedCall } from "./rewind.js";
import type { Session } from "./types.js";

interface Snapshot {
  path: string;
  before: CheckpointBefore;
  after?: string | null;
  afterSeq?: number;
}
interface Calculation {
  file: Omit<TurnChangeFile, "external">;
  diff?: TurnChangeDiff;
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
    const lastAfter = new Map<string, string | null>();
    let seq = 0;
    for (const e of events) {
      if (e.type === "message.user") {
        seq = e.seq;
        if (active.has(seq)) rounds.set(seq, { files: new Map(), untrackedCalls: 0 });
      }
      if (e.type === "checkpoint.file" && e.payload.phase === "after")
        lastAfter.set(canonical(e.payload.path), e.payload.sha256);
      const round = rounds.get(seq);
      if (!round) continue;
      if (isUntrackedCall(e)) round.untrackedCalls++;
      if (e.type !== "checkpoint.file") continue;
      const key = canonical(e.payload.path);
      if (e.payload.phase === "before") {
        if (!round.files.has(key))
          round.files.set(key, { path: e.payload.path, before: e.payload.before });
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

  async function calculate(snapshot: Snapshot): Promise<Calculation | undefined> {
    const { path, before, after } = snapshot;
    const file: Calculation["file"] = {
      path,
      status:
        before === null && after != null
          ? "added"
          : before !== null && after === null
            ? "deleted"
            : "modified",
    };
    const unavailable = (reason: string): Calculation => ({
      file: { ...file, unavailable: reason },
    });
    if (before !== null && "untracked" in before)
      return { file: { path, status: "modified", unavailable: before.untracked } };
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
      return unavailable("文件较大，不计算差异");
    if (oldBytes.includes(0) || newBytes.includes(0)) return unavailable("二进制文件");
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
  function cached(seq: number, key: string, snapshot: Snapshot) {
    const id = JSON.stringify([seq, key, snapshot.before, snapshot.after]);
    let pending = cache.get(id);
    if (!pending) {
      pending = calculate(snapshot);
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
          const value = await cached(seq, key, snapshot);
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
      const { rounds } = collect(session.durableEvents());
      const key = canonical(path);
      const snapshot = rounds.get(seq)?.files.get(key);
      if (!snapshot) return undefined;
      return (await cached(seq, key, snapshot))?.diff;
    },
  };
}
