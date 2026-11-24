/**
 * 全屏单击内嵌页面行时在系统浏览器里打开（ADR-0088 第二版第 2 节）。
 * 打开的是写到 os.tmpdir()/nocturne-pages 下的外壳文件：CSP 元素在 <head>
 * 第一个，页面放在只有 allow-scripts 的 sandbox iframe 的 srcdoc 中，
 * srcdoc 继承外壳的策略，页面脚本不会早于策略生效。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INLINE_PAGE_SHELL_CSP,
  INLINE_PAGE_THEMES,
  injectInlinePageTheme,
} from "@nocturne/core/protocol";

export { INLINE_PAGE_SHELL_CSP, INLINE_PAGE_THEMES, injectInlinePageTheme };

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlinePageShell(html: string, title: string): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${INLINE_PAGE_SHELL_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeText(title)}</title>`,
    "<style>html, body { margin: 0; height: 100%; overflow: hidden; } iframe { display: block; border: 0; width: 100%; height: 100%; }</style>",
    "</head>",
    "<body>",
    `<iframe sandbox="allow-scripts" title="${escapeAttr(title)}" srcdoc="${escapeAttr(injectInlinePageTheme(html))}"></iframe>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function inlinePageShellName(sessionId: string, file: string): string {
  return `${sessionId}-${file}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

export const inlinePagesDir = (): string => join(tmpdir(), "nocturne-pages");

/** 写外壳文件（同名覆盖），返回绝对路径 */
export async function writeInlinePageShell(
  sessionId: string,
  file: string,
  html: string,
  title: string,
  dir: string = inlinePagesDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, inlinePageShellName(sessionId, file));
  await writeFile(target, inlinePageShell(html, title), "utf8");
  return target;
}
