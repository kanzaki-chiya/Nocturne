import type { DurableEvent } from "./events.js";

/**
 * 顶层会话只读快照观察结果（ADR-0099、rpc.md 4.2）。
 * 不打开会话、不取锁、不修复日志；返回快照高水位与工作区元数据。
 */
export interface SessionReadSnapshot {
  sessionId: string;
  lastSeq: number;
  cwd: string;
  workspaceRoot: string;
  /** 快照读取时该会话是否已在当前后台打开（为 true 时客户端可按 afterSeq 续接实时订阅） */
  openHere: boolean;
  /** 只读快照略过了不完整或无法解析的最后一行 */
  tailIgnored: boolean;
}

export interface SessionSnapshotObserver {
  onEvent(event: DurableEvent): void;
}
