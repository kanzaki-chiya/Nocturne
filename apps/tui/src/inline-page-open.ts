/**
 * 全屏单击内嵌页面行时在系统浏览器里打开（ADR-0088 第二版第 2 节）。
 * 打开的是写到 os.tmpdir()/nocturne-pages 下的外壳文件：CSP 元素在 <head>
 * 第一个，页面放在只有 allow-scripts 的 sandbox iframe 的 srcdoc 中，
 * srcdoc 继承外壳的策略，页面脚本不会早于策略生效。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 与 sandbox.html 空壳页一致，另加 form-action 与 base-uri（meta 不支持 frame-ancestors 与 sandbox） */
export const INLINE_PAGE_SHELL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

/** 桌面端默认主题（tokens.css 的 :root 与 prefers-color-scheme: light）对应的 12 个页面变量 */
const SANS =
  '"Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace';
export const INLINE_PAGE_THEMES: Readonly<
  Record<"light" | "dark", Readonly<Record<string, string>>>
> = {
  light: {
    "--bg": "#ffffff",
    "--raised": "#f2f2f6",
    "--text": "#20232b",
    "--secondary": "#464c58",
    "--muted": "#6b7180",
    "--border": "#e5e6ec",
    "--accent": "#5d50b0",
    "--ok": "#2a7146",
    "--warn": "#8a5c10",
    "--bad": "#b02f3c",
    "--sans": SANS,
    "--mono": MONO,
  },
  dark: {
    "--bg": "#1a1c23",
    "--raised": "#22242d",
    "--text": "#dcdfe6",
    "--secondary": "#b3b9c5",
    "--muted": "#858c99",
    "--border": "#262833",
    "--accent": "#a8a5ec",
    "--ok": "#86c69c",
    "--warn": "#e3bc76",
    "--bad": "#e8919a",
    "--sans": SANS,
    "--mono": MONO,
  },
};

function themeRule(scheme: "light" | "dark"): string {
  const decls = Object.entries(INLINE_PAGE_THEMES[scheme]).map(([k, v]) => `${k}: ${v}`);
  return `:root { color-scheme: ${scheme}; ${decls.join("; ")}; }`;
}

/** sandbox.html 的零特异度默认样式（不含内嵌框专用的高度与滚动规则） */
const BASE_STYLE = [
  ":where(:root) { box-sizing: border-box; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.5; }",
  ":where(*, *::before, *::after) { box-sizing: border-box; }",
  ":where(body) { margin: 0; padding: 20px; display: flow-root; background: transparent; color: inherit; font: inherit; }",
  "@media (max-width: 560px) { :where(body) { padding: 14px; } }",
  ":where(code, pre, kbd, samp) { font-family: var(--mono); }",
].join("\n");

const INJECTED = `<style>${themeRule("light")}\n@media (prefers-color-scheme: dark) { ${themeRule("dark")} }\n${BASE_STYLE}</style>`;

const DOCTYPE = /^(\uFEFF?\s*<!doctype[^>]*>)/i;

/** 主题样式插在 doctype 之后：带 doctype 的页面仍是标准模式 */
export function injectInlinePageTheme(html: string): string {
  const doctype = DOCTYPE.exec(html)?.[1];
  return doctype === undefined
    ? `${INJECTED}${html}`
    : `${doctype}${INJECTED}${html.slice(doctype.length)}`;
}

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
