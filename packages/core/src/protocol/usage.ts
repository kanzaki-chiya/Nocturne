import type { AssistantTiming, ModelRef, Usage } from "./types.js";
import type { ModelPricing, PricingSource } from "./pricing.js";

export interface CostBreakdown {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
}

/** 按单次请求输入选最高适用档；缺缓存价回落输入价。未声明价格不编造。 */
export function estimateCost(
  usage: Usage,
  pricing: ModelPricing | undefined,
): CostBreakdown | undefined {
  if (pricing === undefined) return undefined;
  const tier = pricing.tiers
    ?.filter((t) => t.aboveInputTokens <= usage.inputTokens)
    .reduce<NonNullable<ModelPricing["tiers"]>[number] | undefined>(
      (best, t) => (best === undefined || t.aboveInputTokens > best.aboveInputTokens ? t : best),
      undefined,
    );
  const inputPrice = tier?.input ?? pricing.input ?? 0;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const input = (Math.max(0, usage.inputTokens - read - write) * inputPrice) / 1_000_000;
  const cacheRead = (read * (tier?.cacheRead ?? pricing.cacheRead ?? inputPrice)) / 1_000_000;
  const cacheWrite = (write * (tier?.cacheWrite ?? pricing.cacheWrite ?? inputPrice)) / 1_000_000;
  const output = (usage.outputTokens * (tier?.output ?? pricing.output ?? 0)) / 1_000_000;
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

/** 生成时长不足此值的请求不进 Tokens/s（与 TUI「不足 0.5 秒不显示」一致） */
export const MIN_GENERATION_MS = 500;
/** 性能序列每个模型最多保留的桶数（取最近的） */
export const PERFORMANCE_MAX_BUCKETS = 168;
/** days ≤ 此值按本地小时分桶 */
export const HOURLY_BUCKET_MAX_DAYS = 7;
/** days ≤ 此值按本地自然日分桶；更长或「全部」按本地自然周（周一起） */
export const DAILY_BUCKET_MAX_DAYS = 31;

export type PerformanceGranularity = "hour" | "day" | "week";

export function performanceGranularity(days: number | undefined): PerformanceGranularity {
  if (days !== undefined && days <= HOURLY_BUCKET_MAX_DAYS) return "hour";
  if (days !== undefined && days <= DAILY_BUCKET_MAX_DAYS) return "day";
  return "week";
}

/** 生成用时 = 总耗时 − TTFT；没有 TTFT（无内容事件）时无法区分，返回 undefined */
export function generationMs(timing: AssistantTiming): number | undefined {
  return timing.ttftMs === undefined ? undefined : Math.max(0, timing.durationMs - timing.ttftMs);
}

export interface UsageTotals extends Usage {
  cost: CostBreakdown;
}
/** 只用带 timing 的 message.assistant；旧日志不参与。 */
export interface ModelLatencyStats {
  /** 带 timing 的请求数 */
  samples: number;
  avgDurationMs: number;
  /** 有 ttftMs 的样本平均；没有时省略 */
  avgTtftMs?: number | undefined;
  /** Σ outputTokens ÷ Σ 生成用时，生成 ≥ MIN_GENERATION_MS 且带 usage 的样本；没有时省略 */
  tokensPerSecond?: number | undefined;
  /** 进入 Tokens/s 的样本数 */
  speedSamples: number;
}
export interface PerformancePoint {
  /** 桶起点（本地小时 / 自然日 / 周一 0 点），ISO 字符串 */
  start: string;
  samples: number;
  tokensPerSecond?: number | undefined;
  avgTtftMs?: number | undefined;
}
export interface ModelUsageStats extends UsageTotals {
  model: ModelRef;
  turns: number;
  /** 范围内带 usage 的请求数，口径同 DailyUsageStats.requests */
  requests: number;
  cacheHitRate: number;
  /** (全部输入按输入价 − 实际输入侧费用) ÷ 全部输入按输入价；未计价模型省略 */
  cacheSavings?: number | undefined;
  /** 范围内第一条与最后一条请求的时间（ISO） */
  firstUsedAt?: string | undefined;
  lastUsedAt?: string | undefined;
  latency?: ModelLatencyStats | undefined;
  /** 只列有带 timing 请求的桶，按时间升序，至多 PERFORMANCE_MAX_BUCKETS 个 */
  performance: PerformancePoint[];
  pricing?: ModelPricing | undefined;
  pricingSource?: PricingSource | undefined;
}
export interface DailyModelUsage {
  model: ModelRef;
  tokens: number;
  requests: number;
}
export interface DailyUsageStats {
  date: string;
  tokens: number;
  cost: number;
  turns: number;
  /** 以下两项只在 days 范围内的日期给出 */
  requests?: number | undefined;
  /** 按 tokens 降序；各模型之和等于 tokens */
  models?: DailyModelUsage[] | undefined;
}
export interface UsageStats {
  totals: UsageTotals;
  sessions: number;
  turns: number;
  subagentTurns: number;
  longestTurn?: { durationMs: number; date: string; sessionTitle: string } | undefined;
  /** 全日志逐日序列，不受 days 过滤，供一年热力图淡化范围外日期。 */
  daily: DailyUsageStats[];
  models: ModelUsageStats[];
  /** 本次性能序列的分桶粒度，由 days 决定 */
  performanceGranularity: PerformanceGranularity;
  tools: { name: string; count: number }[];
  skills: { name: string; count: number }[];
  unpricedModels: ModelRef[];
  skippedFiles: number;
}
