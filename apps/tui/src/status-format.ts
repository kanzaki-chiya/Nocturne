/**
 * 状态栏片段（ADR-0020）：上下文是「百分比 / 上下文长度」，单位大写。
 * 模型段只显示模型 ID（服务商名可能带空格，如「command code」，放进来既长又易误读；
 * 服务商在 /model 页里看），放不下用模型简称，再不行按显示宽度截断。
 */
import stringWidth from "string-width";

import type { ModelInfo, ModelRef } from "@nocturne/core";
import type { Usage } from "@nocturne/core/protocol";

import { truncateLine } from "./format.js";

function trimNum(n: number): string {
  return n.toFixed(n >= 10 ? 0 : 1).replace(/\.0$/, "");
}

/** 1M / 128K / 1.5K；不足 1000 原样。单位大写。 */
export function formatContextUnit(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}M`;
  if (n >= 1000) return `${trimNum(n / 1000)}K`;
  return String(Math.round(n));
}

/**
 * 已用 / 声明长度。长度未知时只显示已用量。
 * 例：1000 / 1_000_000 → `0.1% / 1M`。
 */
export function formatContextOccupancy(used: number, limit: number | undefined): string {
  if (limit === undefined || !(limit > 0)) return formatContextUnit(used);
  const pct = (used / limit) * 100;
  const pctText = pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
  return `${pctText} / ${formatContextUnit(limit)}`;
}

export function contextBar(
  used: number,
  limit: number | undefined,
  ascii: boolean,
): { filled: string; empty: string; warning: boolean } | undefined {
  if (limit === undefined || !(limit > 0)) return undefined;
  const ratio = Math.max(0, used / limit);
  const cells = Math.min(8, Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * 8)));
  return {
    filled: (ascii ? "[" : "") + (ascii ? "#" : "█").repeat(cells),
    empty: (ascii ? "-" : "░").repeat(8 - cells) + (ascii ? "]" : ""),
    warning: ratio >= 0.8,
  };
}

/**
 * 状态栏与欢迎区的模型标签：模型 ID 放得进预算就用 ID；否则用 displayName；
 * 再否则截断 ID（省略号用 `...`，避免 conhost 歧义宽度）。
 */
export function formatModelLabel(
  ref: ModelRef | undefined,
  models: readonly ModelInfo[],
  maxWidth: number,
): string {
  if (ref === undefined) return "?";
  const full = ref.model;
  if (maxWidth <= 0) return "";
  if (stringWidth(full) <= maxWidth) return full;
  const info = models.find((m) => m.ref.provider === ref.provider && m.ref.model === ref.model);
  const short = info?.displayName;
  if (short !== undefined && short !== "" && stringWidth(short) <= maxWidth) return short;
  return truncateLine(full, maxWidth, "...");
}

/**
 * 本会话累计缓存命中率：累计 cacheReadTokens / 累计 inputTokens（包含口径，events.md Usage）。
 * 尚无用量或服务商未返回缓存数据时显示 0%（一眼可知是上游没缓存，不隐藏该段）。
 */
export function formatCacheHitRate(usage: Usage): string {
  const read = usage.cacheReadTokens ?? 0;
  if (!(usage.inputTokens > 0) || !(read > 0)) return "缓存 0%";
  const pct = Math.min(100, (read / usage.inputTokens) * 100);
  return `缓存 ${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}
