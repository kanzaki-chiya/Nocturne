/**
 * 子会话只读观察的 DTO（rpc.md 4.1、subagent.md 12.1）：查询投影，不是新的
 * 会话状态或事件。不新增、不修改任何 RuntimeEvent。
 */
import type { RuntimeEvent } from "./events.js";
import type { ToolCallStatus } from "./types.js";

/** task 原文为空时摘要的兜底文案；Core 的 `summarizeSubagentTask` 与桌面端共用这一份 */
export const SUBAGENT_TASK_FALLBACK = "子代理";

export interface SubagentSummary {
  parentSessionId: string;
  callId: string;
  childSessionId: string;
  /** 启动参数 profile / agent / default，不读当前配置反推 */
  profile: string;
  /** task 原文压成单行，最多 120 个 Unicode 码点 */
  taskSummary: string;
  /** 子 session.created.time，ISO 8601 */
  startedAt: string;
  state: "running" | "ended" | "unsealed";
  /** 有终止事实才提供，不以读取时刻代替 */
  endedAt?: string | undefined;
  /** 父 task.completed.durationMs 优先；否则起止事件时间差（带 durationApproximate） */
  durationMs?: number | undefined;
  /** 仅在使用事件时间差时为 true */
  durationApproximate?: true | undefined;
  /** 只来自父调用已持久化的结算 */
  outcome?: { status: ToolCallStatus; error?: { code: string; message: string } | undefined };
}

/** 一次观察自然结束时交给客户端的终止信息 */
export interface SubagentReadEnd {
  lastSeq: number;
  summary: SubagentSummary;
  /** launcher：运行中的观察源正常收尾；snapshot：固定日志快照读完 */
  source: "launcher" | "snapshot";
  /** 只读快照略过不完整或无法解析的最后一行 */
  tailIgnored: boolean;
}

/** subscribe 的纯数据结果（RPC 响应形状） */
export interface SubagentObservationInfo {
  /** 回放与缓冲衔接后的持久高水位 */
  readonly lastSeq: number;
  readonly summary: SubagentSummary;
  readonly mode: "live" | "snapshot";
}

export interface SubagentObservation extends SubagentObservationInfo {
  /** 幂等；只撤观察，不关闭子会话，也不产生 onEnd */
  unsubscribe(): void;
}

export interface SubagentObserver {
  onEvent(event: RuntimeEvent): void;
  /** 本次观察自然结束，最后一条事件之后至多一次 */
  onEnd(end: SubagentReadEnd): void;
}
