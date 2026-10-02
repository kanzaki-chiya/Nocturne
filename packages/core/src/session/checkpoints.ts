import { createHash } from "node:crypto";
import type { Platform } from "../platform/index.js";
import { fsErrorCode } from "../platform/index.js";
import type { CheckpointBefore, PermissionSubject } from "../protocol/index.js";
import type { Session } from "./types.js";

const MAX_BYTES = 10 * 1024 * 1024;

/** One recorder per root session, shared by all of its tool executors. */
export function createCheckpointRecorder(
  session: Session,
  platform: Platform,
  sessionsDir: string,
) {
  const { fs, paths } = platform;
  let queue = Promise.resolve();
  return (
    phase: "before" | "after",
    callId: string,
    subjects: readonly PermissionSubject[],
    sourceSessionId: string,
  ): Promise<void> => {
    const record = async () => {
      const events = session.durableEvents();
      const userSeq = events.findLast((e) => e.type === "message.user")?.seq ?? 0;
      const seen = new Set(
        events
          .filter(
            (e) => e.seq > userSeq && e.type === "checkpoint.file" && e.payload.phase === "before",
          )
          .map((e) => (e.type === "checkpoint.file" ? e.payload.path : "")),
      );
      const targets = new Set(
        subjects.filter((s) => s.kind === "edit").map((s) => s.resolved ?? s.target),
      );
      for (const path of targets) {
        if (phase === "before" && seen.has(path)) continue;
        let before: CheckpointBefore = null;
        let bytes: Uint8Array | undefined;
        try {
          const stat = await fs.stat(path);
          if (stat.type !== "file") before = { untracked: "不是普通文件" };
          else if (stat.size > MAX_BYTES) before = { untracked: "文件超过 10MB" };
          else {
            bytes = await fs.readFile(path);
            before =
              bytes.length > MAX_BYTES
                ? { untracked: "文件超过 10MB" }
                : { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
          }
        } catch (e) {
          if (fsErrorCode(e) !== "ENOENT")
            before = { untracked: e instanceof Error ? e.message : String(e) };
        }
        if (before !== null && "untracked" in before) {
          session.emitEphemeral("runtime.warning", {
            code: "checkpoint_untracked",
            message: `${path}：${before.untracked}`,
          });
        }
        if (phase === "before" && before !== null && "sha256" in before && bytes !== undefined) {
          const dir = paths.join(sessionsDir, "checkpoints", session.id);
          try {
            await fs.mkdir(dir);
            await fs.createExclusive(paths.join(dir, before.sha256), bytes);
          } catch (e) {
            if (fsErrorCode(e) !== "EEXIST") {
              before = { untracked: e instanceof Error ? e.message : String(e) };
              session.emitEphemeral("runtime.warning", {
                code: "checkpoint_untracked",
                message: `${path}：${before.untracked}`,
              });
            }
          }
        }
        await session.emit(
          "checkpoint.file",
          {
            callId,
            path,
            ...(sourceSessionId !== session.id ? { sessionId: sourceSessionId } : {}),
            ...(phase === "before"
              ? { phase, before }
              : { phase, sha256: before !== null && "sha256" in before ? before.sha256 : null }),
          },
          session.state().openTurn === undefined
            ? {}
            : { turnId: session.state().openTurn?.turnId },
        );
      }
    };
    const next = queue.then(record);
    queue = next.catch(() => undefined);
    return next;
  };
}
