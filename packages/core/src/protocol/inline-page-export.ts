/**
 * 内嵌页面兼容样式、CSP 与独立导出纯函数（ADR-0088 修订）。
 * 纯函数、无 Node 依赖，供 TUI 外壳与桌面/手机/安卓下载为独立 HTML 共用。
 */

/** 与 sandbox.html 空壳页一致，另加 form-action 与 base-uri（meta 不支持 frame-ancestors 与 sandbox） */
export const INLINE_PAGE_SHELL_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; img-src data: blob: https://cdnjs.cloudflare.com; font-src data: https://cdnjs.cloudflare.com; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const SANS =
  '"Inter Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono Variable", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace';

/** 桌面端默认主题（tokens.css 的 :root 与 prefers-color-scheme: light）对应的 12 个兼容页面变量 */
export const INLINE_PAGE_THEMES: Readonly<
  Record<"light" | "dark", Readonly<Record<string, string>>>
> = {
  light: {
    "--bg": "#ffffff",
    "--raised": "#f4f4f5",
    "--text": "#0d0d10",
    "--secondary": "#55555c",
    "--muted": "#75757d",
    "--border": "#ececef",
    "--accent": "#5d50b0",
    "--ok": "#2a7146",
    "--warn": "#8a5c10",
    "--bad": "#b02f3c",
    "--sans": SANS,
    "--mono": MONO,
  },
  dark: {
    "--bg": "#141417",
    "--raised": "#1a1a1f",
    "--text": "#ededef",
    "--secondary": "#a0a0a8",
    "--muted": "#7a7a83",
    "--border": "#1f1f24",
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
  return `:where(:root) { color-scheme: ${scheme}; ${decls.join("; ")}; }`;
}

/** sandbox.html 的零特异度默认样式（独立/全视口打开：背景设在 body 上以便页面 body 背景铺满整个画布） */
export const INLINE_PAGE_BASE_STYLE = [
  ":where(:root) { box-sizing: border-box; color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.5; }",
  ":where(*, *::before, *::after) { box-sizing: border-box; }",
  ":where(body) { margin: 0; padding: 20px; min-height: 100vh; display: flow-root; background: var(--bg); color: inherit; font: inherit; }",
  "@media (max-width: 560px) { :where(body) { padding: 14px; } }",
  ":where(code, pre, kbd, samp) { font-family: var(--mono); }",
].join("\n");

/** 兼容层样式：默认主题浅色、深色两组变量（按 prefers-color-scheme 切换）与零特异度默认样式 */
export const INLINE_PAGE_COMPAT_STYLE = `<style>${themeRule("light")}\n@media (prefers-color-scheme: dark) { ${themeRule("dark")} }\n${INLINE_PAGE_BASE_STYLE}</style>`;

const STANDALONE_PREFIX = `<meta http-equiv="Content-Security-Policy" content="${INLINE_PAGE_SHELL_CSP}"><meta charset="utf-8">${INLINE_PAGE_COMPAT_STYLE}`;

const DOCTYPE = /^(\uFEFF?\s*<!doctype[^>]*>)/i;

function insertAfterDoctype(html: string, snippet: string): string {
  const doctype = DOCTYPE.exec(html)?.[1];
  if (doctype !== undefined) {
    return `${doctype}${snippet}${html.slice(doctype.length)}`;
  }
  if (html.startsWith("\uFEFF")) {
    return `\uFEFF${snippet}${html.slice(1)}`;
  }
  return `${snippet}${html}`;
}

/** 仅注入兼容层样式（供已由外层 CSP 约束的 TUI srcdoc 使用） */
export function injectInlinePageTheme(html: string): string {
  return insertAfterDoctype(html, INLINE_PAGE_COMPAT_STYLE);
}

/** 组装可独立打开的 HTML 文件：在 doctype 之后依次插入 CSP、charset 与兼容层样式 */
export function buildStandaloneInlineHtml(html: string): string {
  return insertAfterDoctype(html, STANDALONE_PREFIX);
}
