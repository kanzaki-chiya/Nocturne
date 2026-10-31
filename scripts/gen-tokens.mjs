import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");

function formatDecl(indent, name, val) {
  const single = `${indent}${name}: ${val};`;
  if (single.length > 100) {
    return `${indent}${name}:\n${indent}  ${val};`;
  }
  return single;
}

/**
 * 将 design/tokens.json 对象渲染为 apps/desktop/src/tokens.css 文本。
 * 四块结构与原 styles.css 完全一致：
 *   1. :root（深色默认 + 非主题共用变量）
 *   2. @media (prefers-color-scheme: light) { :root { ... } }
 *   3. :root[data-theme="light"] { ... }
 *   4. :root[data-theme="dark"] { ... }
 */
export function renderTokensCss(tokensJson) {
  const rootLines = [];
  const mediaLightLines = [];
  const themeLightLines = [];
  const themeDarkLines = [];

  for (const [group, entries] of Object.entries(tokensJson)) {
    if (group.startsWith("$") || !entries || typeof entries !== "object") continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (!name.startsWith("--") || !spec || typeof spec !== "object") continue;
      if ("light" in spec && "dark" in spec) {
        rootLines.push(formatDecl("  ", name, spec.dark));
        mediaLightLines.push(formatDecl("    ", name, spec.light));
        themeLightLines.push(formatDecl("  ", name, spec.light));
        themeDarkLines.push(formatDecl("  ", name, spec.dark));
      } else if ("value" in spec) {
        rootLines.push(formatDecl("  ", name, spec.value));
      } else {
        throw new Error(`Invalid token spec for ${name} in group ${group}`);
      }
    }
  }

  rootLines.push("  color-scheme: dark;");
  mediaLightLines.push("    color-scheme: light;");
  themeLightLines.push("  color-scheme: light;");
  themeDarkLines.push("  color-scheme: dark;");

  return [
    "/* 由 scripts/gen-tokens.mjs 生成，勿手改 */",
    "",
    ":root {",
    ...rootLines,
    "}",
    "",
    "@media (prefers-color-scheme: light) {",
    "  :root {",
    ...mediaLightLines,
    "  }",
    "}",
    "",
    ':root[data-theme="light"] {',
    ...themeLightLines,
    "}",
    "",
    ':root[data-theme="dark"] {',
    ...themeDarkLines,
    "}",
    "",
  ].join("\n");
}

export function generateTokens({ repoRoot = defaultRoot, check = false } = {}) {
  const tokensPath = join(repoRoot, "design", "tokens.json");
  const outPath = join(repoRoot, "apps", "desktop", "src", "tokens.css");
  const raw = readFileSync(tokensPath, "utf8");
  const parsed = JSON.parse(raw);
  const expected = renderTokensCss(parsed);

  if (check) {
    if (!existsSync(outPath)) {
      return { ok: false, reason: `Missing ${outPath}`, outPath, expected };
    }
    const actual = readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
    if (actual !== expected) {
      return {
        ok: false,
        reason: `${outPath} is out of date with design/tokens.json (run: node scripts/gen-tokens.mjs)`,
        outPath,
        expected,
        actual,
      };
    }
    return { ok: true, outPath, expected };
  }

  writeFileSync(outPath, expected, "utf8");
  return { ok: true, outPath, expected };
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  const check = process.argv.includes("--check");
  const res = generateTokens({ check });
  if (!res.ok) {
    console.error(res.reason);
    process.exit(1);
  }
}
