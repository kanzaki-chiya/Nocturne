#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");

const LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** 代码块与行内代码里的内容不算链接：替换成等长空白，保留行号。 */
function blankCode(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank).replace(/`[^`\n]*`/g, blank);
}

function trackedMarkdown(repoRoot) {
  return execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/**
 * 校验 Markdown 里的相对链接指向的文件或目录存在。
 * 外部链接（带协议）、页内锚点、以 / 开头的站点路径不检查；锚点本身不检查。
 */
export function checkDocLinks({ repoRoot = defaultRepoRoot, files } = {}) {
  const list = files ?? trackedMarkdown(repoRoot);
  let checkedCount = 0;
  const missing = [];
  for (const file of list) {
    const abs = resolve(repoRoot, file);
    const lines = blankCode(readFileSync(abs, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const match of line.matchAll(LINK_RE)) {
        const raw = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/")) {
          continue;
        }
        let target = raw.split("#")[0].split("?")[0];
        try {
          target = decodeURIComponent(target);
        } catch {
          // 非法转义按原样检查
        }
        if (!target) continue;
        checkedCount++;
        if (!existsSync(resolve(dirname(abs), target))) {
          missing.push({ file: file.replace(/\\/g, "/"), line: i + 1, link: raw });
        }
      }
    });
  }
  return { ok: missing.length === 0, fileCount: list.length, checkedCount, missing };
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  const res = checkDocLinks();
  if (!res.ok) {
    for (const m of res.missing) {
      console.error(`${m.file}:${m.line}: 链接目标不存在：${m.link}`);
    }
    process.exit(1);
  }
}
