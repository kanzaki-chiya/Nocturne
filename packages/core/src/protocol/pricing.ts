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

/** vendor：按模型厂商官方 API 价兜底（ADR-0053 修订），不代表代理或中转服务的实际收费。 */
export type PricingSource = "config" | "upstream" | "models.dev" | "vendor";
