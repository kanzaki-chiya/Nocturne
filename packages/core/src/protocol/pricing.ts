/** USD / 每百万 token；分档缺失的字段回落基础价（ADR-0053）。 */
export interface TokenPrices {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

export interface ModelPricing extends TokenPrices {
  tiers?: readonly (TokenPrices & { aboveInputTokens: number })[] | undefined;
}

export type PricingSource = "config" | "upstream" | "models.dev";
