/**
 * 结果预算（tools.md 第 4 节）。
 * modelContent 超限保留开头与结尾，中间标注省略字符数；
 * 结构化 output 有独立上限，超限时不写入事件。
 */
import type { ToolResult } from "./types.js";

export const DEFAULT_MAX_MODEL_CHARS = 30_000;
export const MAX_OUTPUT_CHARS = 100_000;

export function truncateModelContent(
  text: string,
  maxChars: number = DEFAULT_MAX_MODEL_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = (n: number) => `\n…[已省略 ${n} 字符]…\n`;
  // 为标记预留空间后均分给头尾
  const budget = Math.max(0, maxChars - marker(0).length - 8);
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);
  const omitted = text.length - headLen - tailLen;
  return {
    text: text.slice(0, headLen) + marker(omitted) + text.slice(text.length - tailLen),
    truncated: true,
  };
}

/** 返回写入事件的 output：超出独立上限则丢弃并说明 */
export function capOutput(output: unknown): { output: unknown; dropped: boolean } {
  if (output === undefined) return { output: undefined, dropped: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    return { output: undefined, dropped: true };
  }
  if (serialized.length <= MAX_OUTPUT_CHARS) {
    return { output, dropped: false };
  }
  return { output: undefined, dropped: true };
}

export function applyBudget(
  result: ToolResult,
  maxModelChars: number = DEFAULT_MAX_MODEL_CHARS,
): { result: ToolResult; truncated: boolean; outputDropped: boolean } {
  const { text, truncated } = truncateModelContent(result.modelContent, maxModelChars);
  const { output, dropped } = capOutput(result.output);
  let modelContent = text;
  if (dropped) {
    modelContent += "\n[结构化 output 超过大小上限，已省略]";
  }
  return {
    result: { ...result, modelContent, output },
    truncated,
    outputDropped: dropped,
  };
}
