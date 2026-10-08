import type { SessionRewoundPayload } from "./events.js";

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
  reverted?: { seq: number; files: RewindFileResult[] };
}
export interface TurnChangeDiff {
  diff: string;
  approximate?: boolean;
}
