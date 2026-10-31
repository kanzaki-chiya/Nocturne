import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultSrcDir = resolve(scriptDir, "..", "apps", "desktop", "src");

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (/\.(css|tsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** 剥离注释但保留换行符，使行号准确 */
function stripCommentsPreservingLines(text, isCode) {
  let cleaned = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (isCode) {
    cleaned = cleaned.replace(/(^|[^:])\/\/[^\n]*/gm, (m, prefix) => prefix + " ");
  }
  return cleaned;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * 检查 srcDir 下所有 .css/.ts/.tsx 文件中引用的 var(--x) 是否均有定义。
 */
export function checkCssVars({ srcDir = defaultSrcDir } = {}) {
  const files = walkFiles(srcDir);
  const defined = new Set();
  const refs = [];

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const isCode = /\.(tsx?)$/.test(file);
    const cleaned = stripCommentsPreservingLines(raw, isCode);

    if (file.endsWith(".css")) {
      for (const m of cleaned.matchAll(/(?:^|[{;\s])(--[a-zA-Z0-9_-]+)\s*:/g)) {
        defined.add(m[1]);
      }
    } else {
      for (const m of cleaned.matchAll(/setProperty\(\s*["'](--[a-zA-Z0-9_-]+)["']/g)) {
        defined.add(m[1]);
      }
      for (const m of cleaned.matchAll(
        /(?:\[\s*)?["'](--[a-zA-Z0-9_-]+)["'](?:\s*as\s+[^\]\n]+)?(?:\s*\])?\s*:/g,
      )) {
        defined.add(m[1]);
      }
    }

    for (const m of cleaned.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\b/g)) {
      refs.push({
        file: relative(srcDir, file).replace(/\\/g, "/"),
        line: lineNumberAt(cleaned, m.index ?? 0),
        name: m[1],
      });
    }
  }

  const undefinedRefs = refs.filter((r) => !defined.has(r.name));
  const referencedNames = new Set(refs.map((r) => r.name));

  return {
    ok: undefinedRefs.length === 0,
    definedCount: defined.size,
    referencedCount: referencedNames.size,
    undefinedRefs,
  };
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  const res = checkCssVars();
  if (!res.ok) {
    for (const u of res.undefinedRefs) {
      console.error(`apps/desktop/src/${u.file}:${u.line}: undefined CSS variable var(${u.name})`);
    }
    process.exit(1);
  }
}
