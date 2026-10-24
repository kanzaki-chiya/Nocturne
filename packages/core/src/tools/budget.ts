/**
 * 结果预算（tools.md 第 4 节）。
 * modelContent 超限保留开头与结尾，中间标注省略字符数；
 * 结构化 output 有独立上限，超限时不写入事件。
 */
import type { ToolResult } from "./types.js";

export const DEFAULT_MAX_MODEL_CHARS = 30_000;
export const MAX_OUTPUT_CHARS = 100_000;

/** 截断的位置信息：头尾各保留多少字符，中间省略多少（供给模型的后续读法提示） */
export interface TruncationSpan {
  headChars: number;
  tailChars: number;
  omittedChars: number;
}

export function truncateModelContent(
  text: string,
  maxChars: number = DEFAULT_MAX_MODEL_CHARS,
): { text: string; truncated: boolean; span?: TruncationSpan } {
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
    span: { headChars: headLen, tailChars: tailLen, omittedChars: omitted },
  };
}

const countBreaks = (text: string): number => text.split("\n").length - 1;
const countLines = (text: string): number => countBreaks(text) + 1;

/**
 * 截断后附在 modelContent 末尾的"后续怎么读"说明：总长、保留与省略的位置（字符与行号）、
 * 完整输出的落盘路径和可直接用于 read 的 offset/limit。行号按完整输出的换行分行计，
 * 与 read 工具的行号一致；落盘文件内容就是完整输出（超过 1 MB 只写头部）。
 */
export function truncationNote(
  original: string,
  span: TruncationSpan,
  maxChars: number,
  spillPath: string | undefined,
): string {
  const totalLines = countLines(original);
  // 头部最后一行可能被从中间截断，从那一行开始算省略区
  const fromLine = countBreaks(original.slice(0, span.headChars)) + 1;
  const toLine = totalLines - countBreaks(original.slice(original.length - span.tailChars));
  const omittedRange =
    toLine >= fromLine
      ? `第 ${fromLine}–${toLine} 行（共 ${span.omittedChars} 字符）`
      : `第 ${fromLine} 行附近（共 ${span.omittedChars} 字符）`;
  const head = `输出共 ${original.length} 字符、${totalLines} 行，超过 ${maxChars} 字符预算：只保留开头 ${span.headChars} 字符和结尾 ${span.tailChars} 字符，中间${omittedRange}已省略`;
  if (spillPath === undefined) return `[${head}。完整输出未保留：落盘不可用或写入失败]`;
  const limit = Math.max(toLine - fromLine + 1, 1);
  return `[${head}。完整输出已写入 ${spillPath}（本会话内可用）：用 read 的 offset=${fromLine}、limit=${limit} 读取被省略的部分，行很长时再缩小 limit]`;
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
): {
  result: ToolResult;
  truncated: boolean;
  outputDropped: boolean;
  span?: TruncationSpan;
  maxChars: number;
} {
  const { text, truncated, span } = truncateModelContent(result.modelContent, maxModelChars);
  const { output, dropped } = capOutput(result.output);
  let modelContent = text;
  if (dropped) {
    modelContent += "\n[结构化 output 超过大小上限，已省略]";
  }
  return {
    result: { ...result, modelContent, output },
    truncated,
    outputDropped: dropped,
    maxChars: maxModelChars,
    ...(span !== undefined ? { span } : {}),
  };
}
