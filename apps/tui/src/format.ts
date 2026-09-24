/**
 * 展示格式化：宽度安全截断（string-width，宽字符不掰断）、
 * token/时长摘要、工具输入摘要。纯函数。
 */
import stringWidth from "string-width";

import type { Usage } from "@nocturne/core/protocol";

/** 按显示宽度截断为单行；超宽时截断并加省略号 */
export function truncateLine(text: string, width: number, ellipsis = "…"): string {
  const oneLine = text.replace(/\r?\n/g, " ");
  if (width <= 0) return "";
  if (stringWidth(oneLine) <= width) return oneLine;
  const budget = Math.max(0, width - stringWidth(ellipsis));
  let out = "";
  let w = 0;
  for (const ch of oneLine) {
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** 多行文本尾部 n 行（liveOutput / 结果摘要展示用） */
export function tailLines(text: string, n: number): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - n));
}

export function formatTokens(usage: Usage): string {
  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `↑${k(usage.inputTokens)} ↓${k(usage.outputTokens)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const inputString = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

/** 工具输入单行摘要：shell→command；read/write/edit→path；grep/glob→pattern */
export function summarizeToolInput(name: string | undefined, input: unknown): string {
  const byKey =
    name === "shell"
      ? inputString(input, "command")
      : name === "grep" || name === "glob"
        ? inputString(input, "pattern")
        : (inputString(input, "path") ?? inputString(input, "command"));
  return byKey ?? (input === undefined ? "" : JSON.stringify(input));
}
