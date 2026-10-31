import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkCssVars } from "../check-css-vars.mjs";
import { generateTokens, renderTokensCss } from "../gen-tokens.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

describe("gen-tokens", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("仓库 design/tokens.json 与 apps/desktop/src/tokens.css 保持同步", () => {
    const res = generateTokens({ repoRoot, check: true });
    expect(res.ok).toBe(true);
  });

  it("按四块主题结构渲染 CSS，并在文件被篡改或缺失时通过 --check 检出", () => {
    const root = mkdtempSync(join(tmpdir(), "nctrn-tokens-"));
    dirs.push(root);
    mkdirSync(join(root, "design"), { recursive: true });
    mkdirSync(join(root, "apps", "desktop", "src"), { recursive: true });

    const sampleTokens = {
      $meta: { name: "test" },
      color: {
        "--a-bg": { light: "#ffffff", dark: "#000000" },
      },
      font: {
        "--fs-1": { value: "12px" },
      },
    };
    writeFileSync(join(root, "design", "tokens.json"), JSON.stringify(sampleTokens, null, 2));

    // 未生成 tokens.css 时 check 失败
    expect(generateTokens({ repoRoot: root, check: true }).ok).toBe(false);

    // 生成后 check 通过
    const gen = generateTokens({ repoRoot: root, check: false });
    expect(gen.ok).toBe(true);
    expect(gen.expected).toContain("/* 由 scripts/gen-tokens.mjs 生成，勿手改 */");
    expect(gen.expected).toContain(":root {");
    expect(gen.expected).toContain("@media (prefers-color-scheme: light) {");
    expect(gen.expected).toContain(':root[data-theme="light"] {');
    expect(gen.expected).toContain(':root[data-theme="dark"] {');
    expect(generateTokens({ repoRoot: root, check: true }).ok).toBe(true);

    // 手改 tokens.css 后 check 失败
    writeFileSync(join(root, "apps", "desktop", "src", "tokens.css"), "/* tampered */\n");
    expect(generateTokens({ repoRoot: root, check: true }).ok).toBe(false);
  });

  it("非法 token 项抛出明确错误", () => {
    expect(() =>
      renderTokensCss({
        color: { "--bad-token": { foo: "bar" } },
      }),
    ).toThrow(/Invalid token spec/);
  });
});

describe("check-css-vars", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("apps/desktop/src 中所有 var(--x) 引用均有定义", () => {
    const res = checkCssVars({ srcDir: join(repoRoot, "apps", "desktop", "src") });
    expect(res.undefinedRefs).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("检出未定义的 CSS 变量（含带回退字面量的引用），忽略注释并识别 TS 内联属性定义", () => {
    const srcDir = mkdtempSync(join(tmpdir(), "nctrn-cssvars-"));
    dirs.push(srcDir);

    writeFileSync(
      join(srcDir, "tokens.css"),
      [":root {", "  --a-text: #d8dce3;", "  --a-warning: #e5bd77;", "}"].join("\n"),
    );
    writeFileSync(
      join(srcDir, "comp.css"),
      [
        "/* 注释里的 var(--a-ghost) 不应报错 */",
        ".ok {",
        "  color: var(--a-text);",
        "  width: var(--dyn-width, 100px);",
        "  height: var(--dyn-style, 20px);",
        "}",
        ".bad {",
        "  color: var(--a-warn, #b26a00);",
        "  border-color: var(--a-fg);",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(srcDir, "View.tsx"),
      [
        "// 单行注释里的 var(--a-comment-only)",
        "export function View(el: HTMLElement) {",
        '  el.style.setProperty("--dyn-width", "240px");',
        '  const style = { ["--dyn-style" as string]: "40px", color: "var(--a-missing-tsx)" };',
        "  return style;",
        "}",
      ].join("\n"),
    );

    const res = checkCssVars({ srcDir });
    expect(res.ok).toBe(false);
    expect(res.undefinedRefs).toEqual([
      { file: "View.tsx", line: 4, name: "--a-missing-tsx" },
      { file: "comp.css", line: 8, name: "--a-warn" },
      { file: "comp.css", line: 9, name: "--a-fg" },
    ]);
  });
});
