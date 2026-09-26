/**
 * 状态栏片段（ADR-0020）：上下文是「百分比 / 上下文长度」，单位大写。
 * 模型段与 /model 一致：放得下就显示「服务商/模型 ID」，否则用模型简称，
 * 再不行按显示宽度截断。不要让整行换行把 id 拆成「command code/...」。
 */
import stringWidth from "string-width";

import type { ModelInfo, ModelRef } from "@nocturne/core";

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

export function modelRefText(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * 与模型选择页列表列一致的标签。
 * 全形放得进预算就用全形；否则用 displayName；再否则截断全形（省略号用 `...`，避免 conhost 歧义宽度）。
 */
export function formatModelLabel(
  ref: ModelRef | undefined,
  models: readonly ModelInfo[],
  maxWidth: number,
): string {
  if (ref === undefined) return "?";
  const full = modelRefText(ref);
  if (maxWidth <= 0) return "";
  if (stringWidth(full) <= maxWidth) return full;
  const info = models.find((m) => m.ref.provider === ref.provider && m.ref.model === ref.model);
  const short = info?.displayName;
  if (short !== undefined && short !== "" && stringWidth(short) <= maxWidth) return short;
  return truncateLine(full, maxWidth, "...");
}
