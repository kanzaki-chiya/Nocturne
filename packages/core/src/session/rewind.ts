import { createHash } from "node:crypto";
import { fsErrorCode, resolveRealPath, type Platform } from "../platform/index.js";
import {
  effectiveEvents,
  firstUserText,
  type CheckpointBefore,
  type DurableEvent,
  type RewindFile,
  type RewindTarget,
  type SessionRewoundPayload,
  type UntrackedCallCount,
  type UntrackedCallKind,
} from "../protocol/index.js";
import type { Session } from "./types.js";

/**
 * 可能改动文件却不被检查点追踪的调用：声明 mutates、没有 edit 主体、且没有声明
 * fileEffects: "none"。只看事件里保存的工具声明，不按工具名判断。
 */
export function isUntrackedCall(event: DurableEvent): boolean {
  return (
    event.type === "tool.started" &&
    event.payload.mutates === true &&
    event.payload.fileEffects !== "none" &&
    !event.payload.subjects.some((s) => s.kind === "edit")
  );
}

/** 类别显示顺序固定，界面不必再排序 */
const UNTRACKED_KIND_ORDER: readonly UntrackedCallKind[] = [
  "shell",
  "mcp",
  "subagent",
  "schedule",
  "network",
  "read",
  "other",
];

/** 按类别统计未追踪调用；只保留计数大于 0 的类别 */
export function countUntrackedCalls(events: Iterable<DurableEvent>): {
  total: number;
  byKind: UntrackedCallCount[];
} {
  const counts = new Map<UntrackedCallKind, number>();
  let total = 0;
  for (const event of events) {
    if (event.type !== "tool.started" || !isUntrackedCall(event)) continue;
    let kind: UntrackedCallKind = "other";
    for (const subject of event.payload.subjects) {
      if (subject.kind === "edit") continue;
      kind = subject.kind;
      break;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    total++;
  }
  return {
    total,
    byKind: UNTRACKED_KIND_ORDER.flatMap((kind) => {
      const count = counts.get(kind);
      return count === undefined ? [] : [{ kind, count }];
    }),
  };
}

export function rewindCheckpoints(
  events: readonly DurableEvent[],
  targetSeq: number,
  platform: Platform,
) {
  const before = new Map<string, { path: string; before: CheckpointBefore }>();
  const after = new Map<string, string | null>();
  for (const event of events) {
    if (event.seq <= targetSeq || event.type !== "checkpoint.file") continue;
    const key = platform.paths.canonicalize(event.payload.path);
    if (event.payload.phase === "before") {
      if (!before.has(key))
        before.set(key, { path: event.payload.path, before: event.payload.before });
    } else after.set(key, event.payload.sha256);
  }
  return { before, after };
}

/** 日志顺序中的最后一次实际写入状态，包含文件回退的成功结果。 */
export function lastFileStates(
  events: readonly DurableEvent[],
  platform: Platform,
): Map<string, string | null> {
  const states = new Map<string, string | null>();
  for (const [index, event] of events.entries()) {
    if (event.type === "checkpoint.file" && event.payload.phase === "after") {
      states.set(platform.paths.canonicalize(event.payload.path), event.payload.sha256);
    } else if (event.type === "session.rewound" && event.payload.mode !== "conversation") {
      const { before } = rewindCheckpoints(
        events.slice(0, index),
        event.payload.targetSeq,
        platform,
      );
      for (const file of event.payload.files) {
        const key = platform.paths.canonicalize(file.path);
        if (file.result === "deleted") states.set(key, null);
        else if (file.result === "restored") {
          const snapshot = before.get(key)?.before;
          if (snapshot === null) states.set(key, null);
          else if (snapshot && "sha256" in snapshot) states.set(key, snapshot.sha256);
        }
      }
    }
  }
  return states;
}

export async function rewindTargets(
  session: Session,
  platform: Platform,
  sessionsDir: string,
): Promise<RewindTarget[]> {
  const events = session.durableEvents();
  const baseline = lastFileStates(events, platform);
  const targets: RewindTarget[] = [];
  for (const event of effectiveEvents(events).toReversed()) {
    if (event.type !== "message.user") continue;
    // ADR-0070 §7：插话不是回退目标——回退到一条插话会把 Turn 截成半截
    if (event.payload.steer === true) continue;
    const { before } = rewindCheckpoints(events, event.seq, platform);
    const files: RewindFile[] = [];
    for (const [key, snapshot] of before) {
      let reason =
        snapshot.before !== null && "untracked" in snapshot.before
          ? snapshot.before.untracked
          : undefined;
      if (!platform.paths.isAbsolute(snapshot.path)) reason = "检查点路径不是绝对路径";
      if (
        snapshot.before !== null &&
        "sha256" in snapshot.before &&
        !(await platform.fs.exists(
          platform.paths.join(sessionsDir, "checkpoints", session.id, snapshot.before.sha256),
        ))
      )
        reason = "检查点内容缺失";
      let current: string | null | undefined;
      try {
        current = createHash("sha256")
          .update(await platform.fs.readFile(snapshot.path))
          .digest("hex");
      } catch (e) {
        current = fsErrorCode(e) === "ENOENT" ? null : undefined;
      }
      files.push({
        path: snapshot.path,
        action:
          reason !== undefined ? "untracked" : snapshot.before === null ? "delete" : "restore",
        reason,
        external: baseline.has(key) && current !== baseline.get(key),
      });
    }
    const untracked = countUntrackedCalls(events.filter((e) => e.seq > event.seq));
    targets.push({
      seq: event.seq,
      firstLine: firstUserText(event.payload) ?? "",
      time: event.time,
      text: event.payload.content
        .slice(
          0,
          event.payload.content.length -
            (event.payload.fileRefs?.filter((ref) => ref.kind !== "image").length ?? 0),
        )
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      hasImages: (event.payload.attachments?.length ?? 0) > 0,
      files,
      untrackedCalls: untracked.total,
      untrackedByKind: untracked.byKind,
    });
  }
  return targets;
}

export async function restoreCheckpointFiles(
  session: Session,
  platform: Platform,
  sessionsDir: string,
  targetSeq: number,
): Promise<SessionRewoundPayload["files"]> {
  const { before } = rewindCheckpoints(session.durableEvents(), targetSeq, platform);
  const results: SessionRewoundPayload["files"] = [];
  for (const { path, before: snapshot } of before.values()) {
    try {
      if (!platform.paths.isAbsolute(path)) throw new Error("检查点路径不是绝对路径");
      if (snapshot !== null && "untracked" in snapshot) throw new Error(snapshot.untracked);
      if (!platform.paths.equals(path, await resolveRealPath(platform.fs, platform.paths, path)))
        throw new Error("当前路径已指向其他位置");
      // Reject changed symlinks: restoring a recorded path must not overwrite a new target.
      if ((await platform.fs.exists(path)) && (await platform.fs.lstat(path)).type !== "file")
        throw new Error("当前路径不是普通文件");
      if (snapshot === null) {
        try {
          await platform.fs.unlink(path);
          results.push({ path, result: "deleted" });
        } catch (e) {
          if (fsErrorCode(e) !== "ENOENT") throw e;
          results.push({ path, result: "skipped" });
        }
      } else {
        const bytes = await platform.fs.readFile(
          platform.paths.join(sessionsDir, "checkpoints", session.id, snapshot.sha256),
        );
        if (
          createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256 ||
          bytes.length !== snapshot.size
        )
          throw new Error("检查点内容校验失败");
        await platform.fs.mkdir(platform.paths.dirname(path));
        await platform.fs.writeFile(path, bytes);
        results.push({ path, result: "restored" });
      }
    } catch (e) {
      results.push({ path, result: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
