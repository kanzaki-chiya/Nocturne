/**
 * Context Builder 的输入与输出（context.md 第 2 节）。
 * 纯数据、不做 I/O：指令文件与环境信息由调用方（agent / 会话装配层）预先读取传入。
 */
import type { DurableEvent, HistoryEntry, ImageAttachment, ToolSpec } from "../protocol/index.js";
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
  /**
   * 覆盖基础系统提示段（context.md 第 3 节第 1 项）；缺省为内置提示。
   * 唯一用户是子会话（subagent.md 第 8 节）。
   */
  basePrompt?: string | undefined;
  /**
   * 图片附件数据（ADR-0023）：sha256 → base64，由 Agent Loop 在构建前
   * 从 AttachmentStore 读入（Builder 不做 I/O）。
   * undefined = 估算模式（describeContext 等报告场景）：模型支持看图时
   * 按引用计数估算，不产生 images，也不计入 missingAttachments。
   */
  attachmentData?: ReadonlyMap<string, string> | undefined;
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
  /**
   * ADR-0016：模型限额未声明时本地预算使用的兜底值标注
   * （/context 报告据此显示"哪些值是默认的"）
   */
  modelDefaults?:
    | {
        contextWindow?: boolean | undefined;
        maxOutputTokens?: boolean | undefined;
      }
    | undefined;
  /**
   * 本次请求以图片形式发出的附件（ADR-0023）：仅在 count > 0 时出现；
   * estimatedTokens = count × 1600，已计入上方 estimatedTokens 总数。
   * 估算模式下同样给出（按将发送的引用数）。
   */
  images?: { count: number; estimatedTokens: number } | undefined;
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
  /**
   * 引用了但未能取回字节的附件（ADR-0023）：Builder 不做诊断，
   * 由调用方（Agent Loop）记 context.attachment_missing。
   */
  missingAttachments?: ImageAttachment[] | undefined;
}
