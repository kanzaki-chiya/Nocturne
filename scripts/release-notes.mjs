#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本那一节的正文（不含标题行），
 * 供 GitHub Release 说明与 latest.json 的 notes 使用。
 * 找不到对应小节或小节为空时失败退出。
 *
 * 用法：node scripts/release-notes.mjs <version> [--changelog <路径>]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER_HEADING_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/**
 * 将 CHANGELOG.md 按 `## ` 二级标题切分为 `{ heading, body }` 列表。
 * @param {string} changelog
 * @returns {{ heading: string; body: string }[]}
 */
function splitSections(changelog) {
  const lines = changelog.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      starts.push({ index: i, heading: lines[i].trim() });
    }
  }
  return starts.map((item, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].index : lines.length;
    return {
      heading: item.heading,
      body: lines
        .slice(item.index + 1, end)
        .join("\n")
        .trim(),
    };
  });
}

/**
 * @param {string} changelog CHANGELOG.md 全文
 * @param {string} version   例如 0.6.0 或 0.6.0-rc.1
 * @returns {string} 该版本小节的正文（去掉标题与首尾空行）
 */
export function extractNotes(changelog, version) {
  const heading = `## ${version}`;
  const section = splitSections(changelog).find((item) => item.heading === heading);
  if (section === undefined) throw new Error(`CHANGELOG.md 中找不到「${heading}」小节`);
  if (section.body === "") throw new Error(`CHANGELOG.md 的「${heading}」小节没有内容`);
  return section.body;
}

/**
 * 解析 CHANGELOG.md 中的全部版本号小节，保留文档顺序（从新到旧）。
 * 非版本号小节（如 `## 未发布`）与空小节跳过。
 * @param {string} changelog CHANGELOG.md 全文
 * @returns {{ version: string; notes: string }[]}
 */
export function extractChangelog(changelog) {
  const entries = [];
  for (const section of splitSections(changelog)) {
    const version = section.heading.slice(2).trim();
    if (!SEMVER_HEADING_RE.test(version) || section.body === "") continue;
    entries.push({ version, notes: section.body });
  }
  return entries;
}

function main() {
  const args = process.argv.slice(2);
  const version = args[0];
  const flagIndex = args.indexOf("--changelog");
  const changelogPath = resolve(flagIndex >= 0 ? args[flagIndex + 1] : join(root, "CHANGELOG.md"));
  if (version === undefined || version.startsWith("-")) {
    console.error("用法: node scripts/release-notes.mjs <version> [--changelog <路径>]");
    process.exit(1);
  }
  try {
    process.stdout.write(`${extractNotes(readFileSync(changelogPath, "utf8"), version)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
