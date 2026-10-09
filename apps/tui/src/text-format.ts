/** 逐行 CLI 可静态加载的纯文本入口，不导入 React 或 Ink。 */
import {
  estimateCost,
  sessionUsageSoFar,
  type ModelPricing,
  type PricingSource,
  type SessionView,
  type UsageStats,
} from "@nocturne/core/protocol";
export { stripControls, truncateMiddle } from "./format.js";

/** 厂商价（ADR-0053 修订）的来源说明；桌面用量页同一措辞。 */
export const VENDOR_PRICE_NOTE =
  "厂商价：按模型厂商官方 API 价估算，不代表代理或中转服务的实际收费";

export function costLines(
  view: SessionView,
  price:
    { pricing?: ModelPricing | undefined; pricingSource?: PricingSource | undefined } | undefined,
  stats: UsageStats,
): string[] {
  const pricing = price?.pricing;
  const vendorTag = (source: PricingSource | undefined) =>
    source === "vendor" ? "（厂商价）" : "";
  const usage = sessionUsageSoFar(view);
  const ref = view.config.model;
  const money = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;
  const tokens = (n: number) => n.toLocaleString("en-US");
  const cost = estimateCost(usage, pricing);
  return [
    "当前会话",
    `  ${ref ? `${ref.provider}/${ref.model}` : "—"} · ${view.turnCount} Turns`,
    `  输入 ${tokens(usage.inputTokens)} · 缓存读取 ${tokens(usage.cacheReadTokens ?? 0)} · 命中率 ${usage.inputTokens ? (((usage.cacheReadTokens ?? 0) / usage.inputTokens) * 100).toFixed(1) : "0.0"}%`,
    `  输出 ${tokens(usage.outputTokens)} · 预估费用 ${cost ? `${money(cost.total)}${vendorTag(price?.pricingSource)}` : "未计价"}`,
    "",
    "近 30 天 · 本机全部会话（含子代理）",
    ...[...stats.models]
      // 与桌面用量页一致：未计价排在已计价之后，同费用按输入
      .sort(
        (a, b) =>
          Number(!a.pricing) - Number(!b.pricing) ||
          b.cost.total - a.cost.total ||
          b.inputTokens - a.inputTokens,
      )
      .map(
        (m) =>
          `  ${m.model.provider}/${m.model.model} · ${tokens(m.inputTokens + m.outputTokens)} tokens · ${m.pricing ? `${money(m.cost.total)}${vendorTag(m.pricingSource)}` : "未计价"}`,
      ),
    `  合计 ${tokens(stats.totals.inputTokens + stats.totals.outputTokens)} tokens · ${money(stats.totals.cost.total)} · ${stats.sessions} 会话 / ${stats.turns} Turns`,
    ...(stats.skippedFiles ? [`  跳过 ${stats.skippedFiles} 个损坏或无法读取的日志`] : []),
    "",
    "费用按模型声明价格估算，以服务商账单为准。完整统计见桌面端 设置 › 用量",
    ...(price?.pricingSource === "vendor" || stats.models.some((m) => m.pricingSource === "vendor")
      ? [VENDOR_PRICE_NOTE]
      : []),
  ];
}

export function providerCredentialDescription(p: {
  auth?: string | undefined;
  credentialStatus?: "valid" | "expiring" | "expired" | "missing" | undefined;
  credentialStorage?: "system" | "plaintext" | "memory" | undefined;
}): string {
  const status = { valid: "有效", expiring: "即将过期", expired: "已失效", missing: "缺少" };
  const storage = { system: "系统保存", plaintext: "明文保存", memory: "仅本次运行" };
  return [
    p.auth,
    p.credentialStatus && status[p.credentialStatus],
    p.credentialStorage && storage[p.credentialStorage],
  ]
    .filter(Boolean)
    .join(" • ");
}
