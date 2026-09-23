/**
 * L2 摘要请求的构建（context.md 6.2/6.6）。
 * 手动 /compact 的模型调用由 runtime 层发起；这里只做纯数据的请求组装与边界选择。
 */
import type { DurableEvent, HistoryEntry } from "../protocol/index.js";
import type { ModelInfo, ModelRequest } from "../provider/index.js";
import { closedBoundaries, estimateTokens, inputBudgetTokens, renderTranscript } from "./build.js";

/** 摘要输出上限（context.md 6.6：默认约 4,000 token） */
export const SUMMARY_MAX_OUTPUT_TOKENS = 4_000;

const SUMMARY_SYSTEM = `你是 Nocturne 会话的压缩器。把给定的会话转录压缩为一段结构化中文摘要，供后续模型继续任务时阅读。
摘要必须包含：用户的总体目标、已完成的工作及结论、关键文件与工具调用结果、未决事项与下一步建议。
只输出摘要正文，不要寒暄、不要复述指令。`;

export interface BuildSummaryRequestInput {
  /** 折叠后的历史（SessionState.history），函数内部按 throughSeq 截断 */
  history: readonly HistoryEntry[];
  model: ModelInfo;
  /** 摘要覆盖到该 seq 为止（必须是闭合步骤边界） */
  throughSeq: number;
}

/**
 * 组装一次摘要请求：上一个摘要 + 其后到边界的历史（应用既有修剪/摘要规则）
 * 渲染为转录文本，附上摘要指令。
 */
export function buildSummaryRequest(input: BuildSummaryRequestInput): ModelRequest {
  const { model, throughSeq } = input;
  const covered = input.history.filter((e) => e.seq <= throughSeq);
  const transcript = renderTranscript(covered, model.ref.provider);
  const userText = `以下是会话历史转录，请按系统提示压缩为摘要。\n\n${transcript}`;
  return {
    model: model.ref.model,
    system: [{ text: SUMMARY_SYSTEM }],
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [],
    maxOutputTokens: Math.min(model.maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS),
  };
}

/**
 * 6.6 边界回退：从最新闭合边界向前找第一个"摘要请求装得进窗口"的边界；
 * 不存在任何可行边界时返回 undefined（调用方按 compaction_failed 处理）。
 */
export function chooseSummaryBoundary(
  events: readonly DurableEvent[],
  history: readonly HistoryEntry[],
  model: ModelInfo,
): number | undefined {
  const budget = inputBudgetTokens(model, SUMMARY_MAX_OUTPUT_TOKENS);
  const boundaries = closedBoundaries(events);
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const b = boundaries[i];
    if (b === undefined) continue;
    const req = buildSummaryRequest({ history, model, throughSeq: b });
    const chars =
      req.system.reduce((a, s) => a + s.text.length, 0) +
      req.messages.reduce(
        (a, m) =>
          a +
          (m.role === "tool" ? m.content.length : m.content.reduce((n, b) => n + b.text.length, 0)),
        0,
      );
    if (estimateTokens(chars) <= budget) return b;
  }
  return undefined;
}
