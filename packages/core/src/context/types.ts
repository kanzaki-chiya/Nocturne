/**
 * Context Builder 的输入与输出（context.md 第 2 节）。
 * 纯数据、不做 I/O：指令文件与环境信息由调用方（agent / 会话装配层）预先读取传入。
 */
import type { DurableEvent, HistoryEntry, ToolSpec } from "../protocol/index.js";
import type { ModelInfo, ModelMessage, ModelRequest } from "../provider/index.js";

/** 一份已加载的指令文件（AGENTS.md 等） */
export interface InstructionFile {
  /** 来源路径（用于报告与调试） */
  source: string;
  content: string;
  /** 加载时已按上限截断 */
  truncated?: boolean | undefined;
}

/** 项目指令集（context.md 第 3 节第 3 项） */
export interface InstructionSet {
  /** 用户级 <NOCTURNE_HOME>/AGENTS.md */
  user?: InstructionFile | undefined;
  /** 从 workspaceRoot 到 cwd 各级目录的 AGENTS.md，按层级顺序 */
  project: InstructionFile[];
}

/** 环境信息（会话级取值，不随 Step 刷新） */
export interface EnvironmentInfo {
  os: string;
  shell?: string | undefined;
  cwd: string;
  workspaceRoot: string;
  /** 会话创建日期（ISO），非当前时间 */
  sessionDate: string;
}

export interface BuildContextInput {
  /** 折叠后的历史（SessionState.history 结构） */
  history: readonly HistoryEntry[];
  model: ModelInfo;
  /** 由 agent 从 ToolRegistry 取得后作为数据传入 */
  tools: ToolSpec[];
  instructions: InstructionSet;
  environment: EnvironmentInfo;
  /** 本次 Turn 尚未持久化的即时消息（进行中 Step 的增量历史） */
  pendingMessages?: readonly ModelMessage[] | undefined;
  /**
   * 会话持久化事件（session.durableEvents()）；提供后用于计算
   * 闭合步骤边界，从而给出压缩计划（context.md 6.3/6.5）。
   * 缺省时 Builder 无法给出压缩计划。
   */
  events?: readonly DurableEvent[] | undefined;
}

/** Builder 给出的压缩计划（context.md 6.2） */
export interface CompactionPlan {
  kind: "prune" | "summary";
  /** 闭合步骤边界的 seq（context.md 6.3） */
  throughSeq: number;
  /** kind="summary" 时已组装好的摘要请求；执行方直接交给 Provider */
  summaryRequest?: ModelRequest | undefined;
}

/** ContextReport 中的一个部分（context.md 第 4 节"可解释"） */
export interface ContextSection {
  name: "system" | "tools" | "instructions" | "environment" | "history";
  /** 来源说明（版本、文件路径、条目数） */
  source: string;
  chars: number;
  estimatedTokens: number;
  truncated?: boolean | undefined;
}

export interface ContextReport {
  sections: ContextSection[];
  totalChars: number;
  estimatedTokens: number;
  /** 本次请求可用输入预算（token） */
  budgetTokens: number;
}

export interface BuiltContext {
  request: ModelRequest;
  report: ContextReport;
  /** 当前请求超出可用预算 */
  overBudget: boolean;
  /**
   * 建议或必须执行的压缩（context.md 6.5）：估算超过阈值时给出。
   * 调用方执行后应重新构建。
   */
  compaction?: CompactionPlan | undefined;
  /**
   * 不压缩就无法发出请求（context.md 6.5）。
   * 调用方在无可行压缩计划时遇到它必须明确报错（6.6），
   * 不得静默截断历史。
   */
  mustCompact: boolean;
}
