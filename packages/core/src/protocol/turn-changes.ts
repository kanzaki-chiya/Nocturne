import type { SessionRewoundPayload } from "./events.js";
import type { UntrackedCallCount } from "./rewind.js";

export type RewindFileResult = SessionRewoundPayload["files"][number];
export interface TurnChangeFile {
  path: string;
  status: "added" | "modified" | "deleted";
  added?: number;
  removed?: number;
  approximate?: boolean;
  unavailable?: string;
  /** 撤销时这个文件能否被还原或删除（口径同 rewind 的 action !== "untracked"） */
  restorable: boolean;
  external: boolean;
}
export interface TurnChanges {
  seq: number;
  files: TurnChangeFile[];
  untrackedCalls: number;
  /** untrackedCalls 按类别拆分（见 UntrackedCallKind）；旧后台不给 */
  untrackedByKind?: UntrackedCallCount[] | undefined;
  reverted?: { seq: number; files: RewindFileResult[] };
}
export interface TurnChangeDiff {
  diff: string;
  approximate?: boolean;
}
