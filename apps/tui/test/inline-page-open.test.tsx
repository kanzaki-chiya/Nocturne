import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider } from "@nocturne/core";
import { App } from "../src/app.js";
import {
  INLINE_PAGE_SHELL_CSP,
  INLINE_PAGE_THEMES,
  inlinePageShell,
  inlinePageShellName,
} from "../src/inline-page-open.js";
import type { MouseEvent, MouseSource } from "../src/mouse.js";

const roots: string[] = [];
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-page-open-"));
  roots.push(dir);
  return dir;
}
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  roots
    .splice(0)
    .forEach((dir) =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    );
});

/** 从 tokens.css 取一个规则块里的自定义属性 */
function cssBlock(css: string, opener: string): Record<string, string> {
  const start = css.indexOf(opener);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + opener.length, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    out[m[1] ?? ""] = (m[2] ?? "").replace(/\s+/g, " ").trim();
  return out;
}

describe("内嵌页面外壳文件", () => {
  const html = "<!doctype html><html><head><title>t</title></head><body><p>页</p></body></html>";
  const shell = inlinePageShell(html, '季度 "对比"');

  it("CSP meta 是 <head> 的第一个元素，策略除内联与 data:/blob: 外不放行任何来源", () => {
    expect(shell.startsWith("<!doctype html>")).toBe(true);
    const head = shell.slice(shell.indexOf("<head>") + "<head>".length).trimStart();
    expect(
      head.startsWith(
        `<meta http-equiv="Content-Security-Policy" content="${INLINE_PAGE_SHELL_CSP}">`,
      ),
    ).toBe(true);
    expect(INLINE_PAGE_SHELL_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'",
    );
    // 与 sandbox.html 空壳页的响应头策略同源（去掉 meta 不支持的 frame-ancestors 与 sandbox）
    const sandboxCsp =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
    expect(INLINE_PAGE_SHELL_CSP.startsWith(sandboxCsp)).toBe(true);
  });

  it("页面放在只有 allow-scripts 的 sandbox iframe 的 srcdoc 中，外壳本身没有脚本", () => {
    const iframes = [...shell.matchAll(/<iframe\b[^>]*>/g)];
    expect(iframes).toHaveLength(1);
    expect([...shell.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1])).toEqual(["allow-scripts"]);
    expect(shell).not.toMatch(/<script/i);
    const srcdoc = /srcdoc="([^"]*)"/.exec(shell)?.[1] ?? "";
    expect(srcdoc).not.toContain('"');
    expect(shell).toContain('title="季度 &quot;对比&quot;"');
  });

  it("注入两套主题变量（按 prefers-color-scheme）与默认样式，带 doctype 的页面 doctype 仍在最前", () => {
    const srcdoc = (/srcdoc="([^"]*)"/.exec(shell)?.[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    expect(srcdoc.startsWith("<!doctype html><style>")).toBe(true);
    expect(srcdoc).toContain(":root { color-scheme: light; --bg: #ffffff;");
    expect(srcdoc).toContain(
      "@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #1a1c23;",
    );
    expect(srcdoc).toContain(":where(body) { margin: 0; padding: 20px;");
    expect(srcdoc.endsWith("<p>页</p></body></html>")).toBe(true);
    for (const scheme of ["light", "dark"] as const)
      expect(Object.keys(INLINE_PAGE_THEMES[scheme])).toHaveLength(12);
    // 无 doctype 的片段只在前面加样式
    const bare = /srcdoc="([^"]*)"/.exec(inlinePageShell("<p>x</p>", "x"))?.[1] ?? "";
    expect(bare.startsWith("&lt;style>") || bare.startsWith("<style>")).toBe(true);
  });

  it("主题常量与桌面端默认主题的浅色、深色 token 一致", () => {
    const desktop = path.join(process.cwd(), "../desktop/src");
    const css = readFileSync(path.join(desktop, "tokens.css"), "utf8");
    const page = readFileSync(path.join(desktop, "InlinePage.tsx"), "utf8");
    const mapping = [...page.matchAll(/\["(--[\w-]+)", "(--[\w-]+)"\]/g)].map(
      (m): [string, string] => [m[1] ?? "", m[2] ?? ""],
    );
    expect(mapping).toHaveLength(12);
    const dark = cssBlock(css, ":root {");
    const light = {
      ...dark,
      ...cssBlock(css, "@media (prefers-color-scheme: light) {\n  :root {"),
    };
    for (const [target, source] of mapping) {
      expect(INLINE_PAGE_THEMES.dark[target], `${target} dark`).toBe(dark[source]);
      expect(INLINE_PAGE_THEMES.light[target], `${target} light`).toBe(light[source]);
    }
  });

  it("文件名由会话 id 与附件文件名组成，只保留安全字符", () => {
    expect(inlinePageShellName("abc-123", "file-1.html")).toBe("abc-123-file-1.html");
    expect(inlinePageShellName("a/b\\c:d", "f g.html")).toBe("a_b_c_d-f_g.html");
  });
});

function mouseSource(): MouseSource & { emit(event: MouseEvent): void } {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      listeners.forEach((fn) => fn(event));
    },
  };
}

describe("全屏单击内嵌页面行", () => {
  it("单击用浏览器打开外壳文件，拖选不触发", async () => {
    const tmp = temp();
    vi.stubEnv("TMP", tmp);
    vi.stubEnv("TEMP", tmp);
    vi.stubEnv("TMPDIR", tmp);
    let step = 0;
    const page = "<!doctype html><html><body><h1>耗时</h1></body></html>";
    const runtime = await createRuntime({
      cwd: temp(),
      sessionsDir: temp(),
      providers: [
        new FakeProvider({
          handler: () =>
            step++ === 0
              ? [
                  {
                    type: "tool_call",
                    toolCallId: "rh",
                    name: "render_html",
                    input: { title: "各包耗时", html: page },
                  },
                  { type: "finish", reason: "tool_calls" },
                ]
              : [
                  { type: "text_delta", text: "好" },
                  { type: "finish", reason: "stop" },
                ],
        }),
      ],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({ text: "画" });
    const mouse = mouseSource();
    const openFile = vi.fn((_file: string) => Promise.resolve(true));
    const screen = render(
      createElement(App, {
        runtime,
        session,
        env: { ascii: false, animated: false },
        mouse,
        openFile,
      }),
    );
    try {
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("▣ 各包耗时"));
      const lines = (screen.lastFrame() ?? "").split("\n");
      const y = lines.findIndex((line) => line.includes("▣ 各包耗时")) + 1;

      mouse.emit({ type: "press", button: 0, x: 3, y });
      mouse.emit({ type: "drag", button: 0, x: 5, y });
      mouse.emit({ type: "release", button: 0, x: 3, y });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(openFile).not.toHaveBeenCalled();

      mouse.emit({ type: "press", button: 0, x: 3, y });
      mouse.emit({ type: "release", button: 0, x: 3, y });
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
      const opened = openFile.mock.calls[0]?.[0] ?? "";
      expect(opened).toBe(path.join(tmp, "nocturne-pages", `${session.id}-file-1.html`));
      expect(existsSync(opened)).toBe(true);
      expect(readFileSync(opened, "utf8")).toBe(inlinePageShell(page, "各包耗时"));
      expect(screen.lastFrame()).not.toContain("浏览器");
    } finally {
      screen.unmount();
      await session.close();
    }
  });
});
