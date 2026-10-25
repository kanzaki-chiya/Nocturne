import type { DurableEvent, SessionRewoundPayload } from "./events.js";
import type { MessageUserPayload } from "./events.js";
import type { SubjectKind } from "./types.js";

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

/**
 * 未追踪调用的类别（ADR-0041 修订 2026-10-24）：取调用的第一个非 edit 权限主体的
 * kind，没有主体时为 other。界面据此说明「哪类调用」的改动没进统计。
 */
export type UntrackedCallKind = Exclude<SubjectKind, "edit"> | "other";
export interface UntrackedCallCount {
  kind: UntrackedCallKind;
  count: number;
}

const UNTRACKED_KIND_LABELS: Record<UntrackedCallKind, string> = {
  shell: "命令",
  mcp: "MCP 工具",
  subagent: "子代理",
  schedule: "定时任务",
  network: "网络请求",
  read: "读取",
  other: "其他工具",
};

/**
 * 「命令 2 次、MCP 工具 1 次」：各客户端说明未追踪调用时共用的写法。
 * 旧后台不给类别时退回「工具调用 N 次」，不猜测类别。
 */
export function untrackedCallsText(
  total: number,
  byKind: readonly UntrackedCallCount[] | undefined,
): string {
  if (byKind === undefined || byKind.length === 0) return `工具调用 ${total} 次`;
  return byKind.map((item) => `${UNTRACKED_KIND_LABELS[item.kind]} ${item.count} 次`).join("、");
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
  /** untrackedCalls 按类别拆分，计数之和等于 untrackedCalls；旧后台不给 */
  untrackedByKind?: UntrackedCallCount[] | undefined;
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
