import type { DurableEvent, SessionRewoundPayload } from "./events.js";
import type { MessageUserPayload } from "./events.js";

export function firstUserText(payload: Pick<MessageUserPayload, "content">): string | undefined {
  const block = payload.content.find((b) => b.type === "text");
  if (block?.type !== "text") return undefined;
  // 第一个非空行：粘贴的长文常以空行开头，只取首行会得到空串，
  // 桌面端会把这样的会话当成空会话隐藏（仍不跳到下一个文本块）
  for (const raw of block.text.split("\n")) {
    const line = raw.trim();
    if (line !== "") return line;
  }
  return undefined;
}

export type RewindMode = "both" | "conversation" | "files";
export interface RewindFile {
  path: string;
  action: "restore" | "delete" | "untracked";
  reason?: string | undefined;
  external: boolean;
}
export interface RewindTarget {
  seq: number;
  firstLine: string;
  time: string;
  text: string;
  hasImages: boolean;
  files: RewindFile[];
  untrackedCalls: number;
}

/** Raw logs remain intact; only the effective conversation is cut. */
export function effectiveEvents(events: readonly DurableEvent[]): DurableEvent[] {
  let active: DurableEvent[] = [];
  for (const event of events) {
    if (event.type === "session.rewound" && event.payload.mode !== "files") {
      const target = active.find((e) => e.seq === event.payload.targetSeq);
      active = active.filter(
        (e) =>
          e.seq < event.payload.targetSeq &&
          !(
            e.type === "turn.started" &&
            target?.turnId !== undefined &&
            e.turnId === target.turnId
          ),
      );
    }
    active.push(event);
  }
  return active;
}

export function rewindNote(payload: SessionRewoundPayload): string | undefined {
  if (payload.mode === "conversation")
    return "对话已回退，但文件保持回退前的状态，可能包含已撤销对话中的改动";
  if (payload.mode === "files")
    return `用户把以下文件还原到了某一轮之前的状态：${payload.files
      .filter((f) => f.result === "restored" || f.result === "deleted")
      .map((f) => f.path)
      .join("、")}`;
  return undefined;
}

export function rewindNotification(
  payload: SessionRewoundPayload,
  events: readonly DurableEvent[],
): string {
  const target = events.find((e) => e.seq === payload.targetSeq);
  const line = target?.type === "message.user" ? (firstUserText(target.payload) ?? "") : "";
  const restored = payload.files.filter(
    (f) => f.result === "restored" || f.result === "deleted",
  ).length;
  const failed = payload.files.filter((f) => f.result === "failed").length;
  return `已回退到「${line}」之前 • 还原 ${restored} 个文件${failed ? ` • ${failed} 个失败` : ""}`;
}
