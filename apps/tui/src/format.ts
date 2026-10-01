/**
 * 展示格式化：宽度安全截断（string-width，宽字符不掰断）、
 * token/时长摘要、工具输入摘要。纯函数。
 */
import stringWidth from "string-width";

import type { PermissionReviewedPayload, Usage } from "@nocturne/core/protocol";

/**
 * conhost（GBK 代码页）把歧义宽度字符渲染为 2 列，与 string-width 的 1 列不一致：
 * 带边框的行会被 Ink 按 string-width 补齐到整宽，框内每混入一个歧义字符实际
 * 宽度就 +1，超过终端列数即折行——备用屏下表现为整屏滚动、页头被裁。
 * 框内文本（含用户输入回显、外部传入的标题/详情）统一过 boxSafe，
 * 把歧义字符换成实测 1 列的近形字符（conhost 80/120 列实测：
 * 1 列=│ ─ ╭ █ ✓ ✗ ⚠ • › ⠋；2 列=· ● ○ ↑ ↓ ← → … — ｜ ◆ ◇）。
 */
const BOX_AMBIG_MAP: Record<string, string> = {
  "·": "•",
  "●": "•",
  "○": "o",
  "◆": "•",
  "◇": "o",
  "↑": "^",
  "↓": "v",
  "←": "<",
  "→": ">",
  "—": "-",
  "–": "-",
  "｜": "|",
  "…": "...",
};
const BOX_AMBIG_RE = /[·●○◆◇↑↓←→—–｜…]/g;

export function boxSafe(text: string): string {
  return text.replace(BOX_AMBIG_RE, (c) => BOX_AMBIG_MAP[c] ?? c);
}

// CSI / OSC / 其他 ESC 序列，以及除换行、Tab 外的 C0 控制字符与 DEL
const CONTROL_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * 去掉工具输出、文件内容里夹带的终端控制序列（命令自带的颜色码等）。
 * 它们在全屏行里会打乱宽度计算，退出时原样打印到主屏还会让颜色一直漏到
 * 后面的输出（例如整屏变红）。
 */
export function stripControls(text: string): string {
  return text.replace(CONTROL_RE, "");
}

/** 按显示宽度向右补齐空格（宽字符按 string-width 计；超长不截断） */
export function padToWidth(text: string, width: number): string {
  const w = stringWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

/** 按显示宽度截断为单行；超宽时截断并加省略号 */
export function truncateLine(text: string, width: number, ellipsis = "…"): string {
  const oneLine = text.replace(/\r\n?|\n/g, " ");
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

/** 按显示宽度截断为单行，截掉头部保留尾部（如长路径保留文件名）；超宽时前缀省略号 */
export function truncateLineHead(text: string, width: number, ellipsis = "…"): string {
  const oneLine = text.replace(/\r\n?|\n/g, " ");
  if (width <= 0) return "";
  if (stringWidth(oneLine) <= width) return oneLine;
  const budget = Math.max(0, width - stringWidth(ellipsis));
  let out = "";
  let w = 0;
  for (const ch of Array.from(oneLine).reverse()) {
    const cw = stringWidth(ch);
    if (w + cw > budget) break;
    out = ch + out;
    w += cw;
  }
  return ellipsis + out;
}

export function truncateMiddle(text: string, width: number, ellipsis = "…"): string {
  const safe = boxSafe(stripControls(text).replace(/[\r\n\t]/g, " "));
  if (stringWidth(safe) <= width) return safe;
  const half = Math.max(0, Math.floor((width - stringWidth(ellipsis)) / 2));
  return (
    truncateLine(safe, half, "") +
    ellipsis +
    truncateLineHead(safe, Math.max(0, width - half - stringWidth(ellipsis)), "")
  );
}

/** 多行文本尾部 n 行（liveOutput / 结果摘要展示用） */
export function tailLines(text: string, n: number): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
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

/** 工具输入单行摘要：shell→command；read/write/edit→path；grep/glob→pattern；apply_patch→文件清单 */
export function summarizeToolInput(name: string | undefined, input: unknown): string {
  if (name === "todo_write") {
    const items =
      typeof input === "object" && input !== null && "items" in input ? input.items : undefined;
    return Array.isArray(items) ? `${items.length} 项` : "";
  }
  if (name === "apply_patch") {
    // ADR-0035：摘要列出补丁涉及的文件（不整段回显补丁原文）
    const text = inputString(input, "input");
    if (text === undefined) return "";
    const files = [...text.matchAll(/^\*\*\* (?:Add|Delete|Update) File:\s*(\S+)/gm)].map(
      (m) => m[1] ?? "",
    );
    if (files.length === 0) return "";
    return files.length <= 3
      ? files.join(", ")
      : `${files.slice(0, 3).join(", ")} 等 ${files.length} 个文件`;
  }
  const byKey =
    name === "web_fetch"
      ? inputString(input, "url")
      : name === "shell"
        ? inputString(input, "command")
        : name === "grep" || name === "glob"
          ? inputString(input, "pattern")
          : (inputString(input, "path") ?? inputString(input, "command"));
  return byKey ?? (input === undefined ? "" : JSON.stringify(input));
}

/** ADR-0036：审查来源及用量与主模型输出分开标注。 */
export function permissionReviewLine(review: PermissionReviewedPayload): string {
  const label = { allow: "放行", block: "拦截", unsure: "拿不准" }[review.verdict];
  const usage = review.usage;
  return `审查：${label} — ${review.reason.replace(/\s+/g, " ")}${review.cached ? "（缓存）" : ""}${usage ? `（审查用量：${usage.inputTokens} 输入 / ${usage.outputTokens} 输出）` : ""}`;
}
