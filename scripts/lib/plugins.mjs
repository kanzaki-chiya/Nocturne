import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const EXCLUDED_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "node_modules",
]);

const EXCLUDED_FILE_RE = /\.(test|spec)\.[^/\\]+$/i;

export function shouldIncludePluginAsset(srcPath) {
  const name = basename(srcPath);
  try {
    const stat = statSync(srcPath);
    if (stat.isDirectory()) return !EXCLUDED_DIRS.has(name);
  } catch {
    return false;
  }
  return !EXCLUDED_FILE_RE.test(name);
}

/**
 * 复制内置插件目录（排除 test/、node_modules/ 与测试夹具）。
 * `ensureDestDir: true` 时即使源目录不存在也会创建空目标目录（供 Tauri bundle.resources 使用）。
 * 返回是否复制了源目录内容。
 */
export function copyBuiltinPluginsDir(srcPluginsDir, destPluginsDir, options = {}) {
  const ensureDestDir = options.ensureDestDir === true;
  rmSync(destPluginsDir, { recursive: true, force: true });

  const hasSrc =
    srcPluginsDir !== undefined &&
    existsSync(srcPluginsDir) &&
    statSync(srcPluginsDir).isDirectory();
  if (!hasSrc) {
    if (ensureDestDir) mkdirSync(destPluginsDir, { recursive: true });
    return false;
  }

  mkdirSync(destPluginsDir, { recursive: true });
  cpSync(srcPluginsDir, destPluginsDir, {
    recursive: true,
    filter: (src) => src === srcPluginsDir || shouldIncludePluginAsset(src),
  });
  return true;
}

export function copyBundledPluginsFromDir(srcDir, destDir) {
  const srcPlugins = join(srcDir, "plugins");
  return copyBuiltinPluginsDir(srcPlugins, join(destDir, "plugins"), { ensureDestDir: false });
}
