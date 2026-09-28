/**
 * 思考档位的声明链解析与适配器辅助（ADR-0018、provider-api.md 第 2–3 节）。
 * 纯函数：可用档位集合的解析、就近降档、anthropic 预算表都在这里，
 * 供两个适配器与 registry 共用；不写 provider 名分支。
 */
import {
  isReasoningEffortLevel,
  normalizeReasoningEffortLevels,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
  type ReasoningEffortLevel,
} from "../protocol/index.js";
import { MAX_OUTPUT_FALLBACK } from "./catalog.js";
import type { ModelCapabilities, ModelInfo } from "./types.js";

/**
 * 可用档位声明链（ADR-0018 第 2 节），返回 undefined = 无可用档位：
 * 推理为 none 时无档位；否则逐模型声明（含空数组）> 推导全档。
 */
export function resolveReasoningEfforts(
  capabilities: Pick<ModelCapabilities, "reasoning" | "reasoningEffort">,
): ReasoningEffortLevel[] | undefined {
  if (capabilities.reasoning === "none") return undefined;
  const perModel = normalizeReasoningEffortLevels(capabilities.reasoningEffort);
  if (perModel !== undefined) return perModel;
  return [...REASONING_EFFORT_LEVELS];
}

/**
 * 把档位解析结果烙进 ModelInfo：逐模型声明缺失时按能力推导全档；
 * 已声明（含空数组）时只归一化，不覆盖。
 * 注意：capabilities.reasoningEffort 在声明空间允许任意字符串，
 * 这里归一化为合法的 ReasoningEffortLevel[]。
 */
export function withReasoningEfforts(model: ModelInfo): ModelInfo {
  const caps = model.capabilities;
  const efforts = resolveReasoningEfforts(caps);
  return { ...model, capabilities: { ...caps, reasoningEffort: efforts } };
}

/**
 * 就近降档（ADR-0018 第 4 节）：请求/会话档位映射到可用集合——
 * 命中原档返回原档；否则取不超过它的最高可用档；都比它高时取最低
 * 可用档。off / 无可用集合 → undefined（发送侧省略思考参数）。
 */
export function clampReasoningEffort(
  effort: ReasoningEffort | undefined,
  available: readonly ReasoningEffortLevel[] | undefined,
): ReasoningEffortLevel | undefined {
  if (
    effort === undefined ||
    effort === "off" ||
    available === undefined ||
    available.length === 0
  ) {
    return undefined;
  }
  if (!isReasoningEffortLevel(effort)) return undefined;
  if (available.includes(effort)) return effort;
  const rank = REASONING_EFFORT_LEVELS.indexOf(effort);
  const sorted = [...available].sort(
    (a, b) => REASONING_EFFORT_LEVELS.indexOf(a) - REASONING_EFFORT_LEVELS.indexOf(b),
  );
  const below = sorted.filter((l) => REASONING_EFFORT_LEVELS.indexOf(l) < rank);
  return below.length > 0 ? below[below.length - 1] : sorted[0];
}

// ── anthropic：档位 → thinking.budget_tokens（ADR-0018 第 3 节） ──

/** 默认预算表（与 omp 相同，可经 provider 条目 thinking.budgets 覆盖） */
export const ANTHROPIC_EFFORT_BUDGETS: Readonly<Record<ReasoningEffortLevel, number>> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
};

/** thinking 要求 max_tokens > budget_tokens；为实际输出预留的余量 */
export const ANTHROPIC_OUTPUT_MARGIN = 1024;
/** anthropic 协议下限：budget_tokens 最小 1024 */
export const ANTHROPIC_MIN_BUDGET = 1024;

export interface AnthropicThinkingPlan {
  /** thinking.budget_tokens 发送值 */
  budgetTokens: number;
  /** max_tokens 发送值（可能因预算被抬升） */
  maxTokens: number;
}

/**
 * 计算 anthropic 请求的思考参数（ADR-0018 第 3 节）：
 * - 预算取 thinking.budgets 覆盖值，缺省查表；
 * - wireMax = 模型声明上限（declared）?? 兜底 8192；wireMax < 预算+余量时
 *   抬升到 预算+余量（有声明上限时不超过声明值——声明值即 wireMax，此时不可抬升）；
 * - 仍不够则压低预算到 wireMax-余量；压到协议下限以下 → 返回 undefined
 *   （本轮不发送 thinking 参数，由适配器记 diagnostics）。
 */
export function planAnthropicThinking(
  effort: ReasoningEffortLevel,
  declaredMaxOutput: number | undefined,
  budgets: Partial<Record<ReasoningEffortLevel, number>> | undefined,
): AnthropicThinkingPlan | undefined {
  let budget = budgets?.[effort] ?? ANTHROPIC_EFFORT_BUDGETS[effort];
  if (!Number.isFinite(budget) || budget <= 0) budget = ANTHROPIC_EFFORT_BUDGETS[effort];
  let maxTokens = declaredMaxOutput ?? MAX_OUTPUT_FALLBACK;
  if (maxTokens < budget + ANTHROPIC_OUTPUT_MARGIN) {
    // 有声明上限时 wireMax==上限无法抬升；未声明时抬到预算+余量
    if (declaredMaxOutput === undefined) {
      maxTokens = budget + ANTHROPIC_OUTPUT_MARGIN;
    }
  }
  if (maxTokens < budget + ANTHROPIC_OUTPUT_MARGIN) {
    budget = maxTokens - ANTHROPIC_OUTPUT_MARGIN;
  }
  if (budget < ANTHROPIC_MIN_BUDGET) return undefined;
  return { budgetTokens: budget, maxTokens };
}
