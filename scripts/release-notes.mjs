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

/**
 * @param {string} changelog CHANGELOG.md 全文
 * @param {string} version   例如 0.6.0 或 0.6.0-rc.1
 * @returns {string} 该版本小节的正文（去掉标题与首尾空行）
 */
export function extractNotes(changelog, version) {
  const heading = `## ${version}`;
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`CHANGELOG.md 中找不到「${heading}」小节`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  if (body === "") throw new Error(`CHANGELOG.md 的「${heading}」小节没有内容`);
  return body;
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
