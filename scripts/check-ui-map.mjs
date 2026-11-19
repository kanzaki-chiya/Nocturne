#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");
const defaultMapRelPath = "docs/development/ui-map.md";

const FILE_PATH_RE =
  /^(?:(?:apps|packages|scripts|docs|design|site|site-docs)\/[^\s`]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)$/;

function isSeparatorRow(line) {
  return /^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/**
 * 校验界面功能地图表格中的全部文件路径均真实存在。
 */
export function checkUiMap({
  repoRoot = defaultRepoRoot,
  mapPath = resolve(repoRoot, defaultMapRelPath),
} = {}) {
  const displayMap = relative(repoRoot, mapPath).replace(/\\/g, "/");
  if (!existsSync(mapPath)) {
    return {
      ok: false,
      rowCount: 0,
      checkedCount: 0,
      missing: [{ file: displayMap, line: 0, path: displayMap }],
    };
  }

  const lines = readFileSync(mapPath, "utf8").split(/\r?\n/);
  let inTable = false;
  let rowCount = 0;
  let checkedCount = 0;
  const missing = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("|")) {
      inTable = false;
      continue;
    }
    if (isSeparatorRow(trimmed)) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      // 表头行，等下一行分隔符确认进入数据行
      continue;
    }

    rowCount++;
    const lineNo = i + 1;
    // 取主组件文件列与测试文件列（同时兼容整行所有反引号路径引用）
    for (const match of trimmed.matchAll(/`([^`]+)`/g)) {
      const token = match[1].trim();
      if (!FILE_PATH_RE.test(token)) continue;
      checkedCount++;
      const full = resolve(repoRoot, token);
      if (!existsSync(full)) {
        missing.push({ file: displayMap, line: lineNo, path: token });
      }
    }
  }

  const ok = rowCount > 0 && checkedCount > 0 && missing.length === 0;
  return { ok, rowCount, checkedCount, missing };
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  const res = checkUiMap();
  if (!res.ok) {
    if (res.rowCount === 0 || res.checkedCount === 0) {
      console.error(`${defaultMapRelPath}: 未解析到有效的界面表格路径`);
    }
    for (const m of res.missing) {
      console.error(`${m.file}:${m.line}: 路径不存在：${m.path}`);
    }
    process.exit(1);
  }
}
