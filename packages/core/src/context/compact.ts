/**
 * L2 摘要的模型调用（context.md 6.6）。请求组装与边界选择在 build.js；
 * 本文件做 provider 侧调用及沿用前缀失败时退回文本转录——手动 /compact 与自动 L2 共用。
 */
import {
  isProviderError,
  timedStream,
  type ModelRequest,
  type ResolvedModel,
} from "../provider/index.js";
import type { Diagnostics, HistoryEntry, Usage } from "../protocol/index.js";
import { buildTranscriptSummaryRequest } from "./build.js";
import type { CompactionPlan } from "./types.js";

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function recordSummaryFailure(
  diagnostics: Diagnostics | undefined,
  opts: {
    sessionId: string;
    turnId?: string | undefined;
    model: ResolvedModel;
    throughSeq: number;
    phase: "prefix" | "transcript";
    error: unknown;
  },
): void {
  const e = opts.error;
  diagnostics?.record("context.summary_failed", {
    sessionId: opts.sessionId,
    ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
    phase: opts.phase,
    throughSeq: opts.throughSeq,
    provider: opts.model.model.ref.provider,
    model: opts.model.model.ref.model,
    error: e instanceof Error ? e.message : String(e),
    ...(isProviderError(e)
      ? {
          errorKind: e.kind,
          retryable: e.retryable,
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.providerMessage !== undefined ? { providerMessage: e.providerMessage } : {}),
        }
      : {}),
  });
}

/**
 * 执行一次摘要调用（context.md 6.6：只尝试一轮，不嵌套压缩）。
 * 返回摘要正文（空白视为失败，抛错）。
 */
export async function runSummaryCall(
  model: ResolvedModel,
  request: ModelRequest,
  signal: AbortSignal,
  firstEventTimeoutMs = 30_000,
  idleTimeoutMs = 300_000,
): Promise<{ summary: string; usage?: Usage | undefined }> {
  let summary = "";
  let usage: Usage | undefined;
  for await (const ev of timedStream(
    model.provider,
    request,
    signal,
    firstEventTimeoutMs,
    idleTimeoutMs,
  )) {
    if (ev.type === "text_delta") summary += ev.text;
    if (ev.type === "usage") usage = ev.usage;
    if (ev.type === "finish") break;
  }
  if (summary.trim().length === 0) {
    throw new Error("摘要结果为空");
  }
  if (signal.aborted) throw signal.reason ?? new Error("摘要被中断");
  return { summary, ...(usage !== undefined ? { usage } : {}) };
}

export interface RunSummaryWithFallbackInput {
  model: ResolvedModel;
  plan: CompactionPlan;
  history: readonly HistoryEntry[];
  sessionId: string;
  signal: AbortSignal;
  firstEventTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  diagnostics?: Diagnostics | undefined;
  turnId?: string | undefined;
}

/**
 * 执行一次 L2 摘要计划：先发计划中的请求；若沿用前缀形式失败（且未被中断），
 * 立刻以同一 throughSeq 构造文本转录形式再试一次。每次失败都记录诊断日志。
 * 手动 /compact 与自动 L2 共用。
 */
export async function runSummaryWithFallback(
  input: RunSummaryWithFallbackInput,
): Promise<{ summary: string; usage?: Usage | undefined }> {
  const {
    model,
    plan,
    history,
    sessionId,
    signal,
    firstEventTimeoutMs,
    idleTimeoutMs,
    diagnostics,
    turnId,
  } = input;
  const primaryBase =
    plan.summaryRequest ??
    buildTranscriptSummaryRequest({
      history,
      model: model.model,
      throughSeq: plan.throughSeq,
    });
  // ADR-0031 §3：摘要请求同属本会话，同样携带会话 ID
  const primary: ModelRequest = { ...primaryBase, sessionId };
  const isPrefix = primaryBase.cachePrefix !== undefined;

  async function attempt(
    request: ModelRequest,
    phase: "prefix" | "transcript",
  ): Promise<{ summary: string; usage?: Usage | undefined }> {
    try {
      return await runSummaryCall(model, request, signal, firstEventTimeoutMs, idleTimeoutMs);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      recordSummaryFailure(diagnostics, {
        sessionId,
        turnId,
        model,
        throughSeq: plan.throughSeq,
        phase,
        error,
      });
      throw error;
    }
  }

  try {
    return await attempt(primary, isPrefix ? "prefix" : "transcript");
  } catch (primaryError) {
    if (!isPrefix || signal.aborted || isAbortError(primaryError)) throw primaryError;
  }

  const fallback: ModelRequest = {
    ...buildTranscriptSummaryRequest({
      history,
      model: model.model,
      throughSeq: plan.throughSeq,
    }),
    sessionId,
  };
  return await attempt(fallback, "transcript");
}
