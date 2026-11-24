import { describe, expect, it } from "vitest";
import {
  buildStandaloneInlineHtml,
  injectInlinePageTheme,
  INLINE_PAGE_BASE_STYLE,
  INLINE_PAGE_COMPAT_STYLE,
  INLINE_PAGE_SHELL_CSP,
  INLINE_PAGE_THEMES,
} from "./inline-page-export.js";

describe("inline-page-export（独立 HTML 与兼容样式注入）", () => {
  const expectedPrefix = `<meta http-equiv="Content-Security-Policy" content="${INLINE_PAGE_SHELL_CSP}"><meta charset="utf-8">${INLINE_PAGE_COMPAT_STYLE}`;

  it("CSP 仅放行 cdnjs 资源并禁止网络连接与表单/base 劫持", () => {
    expect(INLINE_PAGE_SHELL_CSP.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'unsafe-inline' https://cdnjs.cloudflare.com",
      "img-src data: blob: https://cdnjs.cloudflare.com",
      "font-src data: https://cdnjs.cloudflare.com",
      "media-src data: blob:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]);
  });

  it("兼容层包含浅色与深色 12 个零特异度变量及基础样式", () => {
    expect(Object.keys(INLINE_PAGE_THEMES.light)).toHaveLength(12);
    expect(Object.keys(INLINE_PAGE_THEMES.dark)).toHaveLength(12);
    expect(INLINE_PAGE_COMPAT_STYLE).toContain(
      ":where(:root) { color-scheme: light; --bg: #ffffff;",
    );
    expect(INLINE_PAGE_COMPAT_STYLE).toContain(
      "@media (prefers-color-scheme: dark) { :where(:root) { color-scheme: dark; --bg: #141417;",
    );
    expect(INLINE_PAGE_COMPAT_STYLE).toContain(INLINE_PAGE_BASE_STYLE);
  });

  it("有 doctype 时把 CSP、charset 与兼容样式插在 doctype 之后，正文原样保留", () => {
    const html =
      "<!doctype html>\n<html><head><title>A</title></head><body><p>hi</p></body></html>";
    const out = buildStandaloneInlineHtml(html);
    expect(out).toBe(
      `<!doctype html>${expectedPrefix}\n<html><head><title>A</title></head><body><p>hi</p></body></html>`,
    );
  });

  it("无 doctype 时插在最前，不改页面正文", () => {
    const html = "<div>hello</div>";
    expect(buildStandaloneInlineHtml(html)).toBe(`${expectedPrefix}${html}`);
    expect(injectInlinePageTheme(html)).toBe(`${INLINE_PAGE_COMPAT_STYLE}${html}`);
  });

  it("带 BOM（有或无 doctype）时保留 BOM 在首位", () => {
    const withDoctype = "\uFEFF<!DOCTYPE html><html><body>x</body></html>";
    expect(buildStandaloneInlineHtml(withDoctype)).toBe(
      `\uFEFF<!DOCTYPE html>${expectedPrefix}<html><body>x</body></html>`,
    );
    const withoutDoctype = "\uFEFF<p>bare</p>";
    expect(buildStandaloneInlineHtml(withoutDoctype)).toBe(`\uFEFF${expectedPrefix}<p>bare</p>`);
    expect(injectInlinePageTheme(withoutDoctype)).toBe(
      `\uFEFF${INLINE_PAGE_COMPAT_STYLE}<p>bare</p>`,
    );
  });

  it("页面已有 <head> 和 charset 时不改动原 <head> 内容，CSP 仍在最前", () => {
    const html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>:root{--bg:#faf6ef}</style><script>window.x=1</script></head><body>ok</body></html>';
    const out = buildStandaloneInlineHtml(html);
    expect(out.startsWith(`<!doctype html>${expectedPrefix}`)).toBe(true);
    expect(out.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
      out.indexOf('<meta charset="utf-8">'),
    );
    expect(out.indexOf('<meta charset="utf-8">')).toBeLessThan(out.indexOf("<style>"));
    expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<html"));
    expect(out.endsWith(html.slice("<!doctype html>".length))).toBe(true);
  });
});
