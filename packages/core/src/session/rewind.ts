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
} from "../protocol/index.js";
import type { Session } from "./types.js";

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

export async function rewindTargets(
  session: Session,
  platform: Platform,
  sessionsDir: string,
): Promise<RewindTarget[]> {
  const events = session.durableEvents();
  const targets: RewindTarget[] = [];
  for (const event of effectiveEvents(events).toReversed()) {
    if (event.type !== "message.user") continue;
    const { before, after } = rewindCheckpoints(events, event.seq, platform);
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
        external: after.has(key) && current !== after.get(key),
      });
    }
    targets.push({
      seq: event.seq,
      firstLine: firstUserText(event.payload) ?? "",
      time: event.time,
      text: event.payload.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      hasImages: (event.payload.attachments?.length ?? 0) > 0,
      files,
      untrackedCalls: events.filter(
        (e) =>
          e.seq > event.seq &&
          e.type === "tool.started" &&
          e.payload.mutates === true &&
          !e.payload.subjects.some((s) => s.kind === "edit"),
      ).length,
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
