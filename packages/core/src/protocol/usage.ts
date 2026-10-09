import type { ModelRef, Usage } from "./types.js";
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

export interface UsageTotals extends Usage {
  cost: CostBreakdown;
}
export interface ModelUsageStats extends UsageTotals {
  model: ModelRef;
  turns: number;
  cacheHitRate: number;
  pricing?: ModelPricing | undefined;
  pricingSource?: PricingSource | undefined;
}
export interface DailyUsageStats {
  date: string;
  tokens: number;
  cost: number;
  turns: number;
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
  tools: { name: string; count: number }[];
  skills: { name: string; count: number }[];
  unpricedModels: ModelRef[];
  skippedFiles: number;
}
