#!/usr/bin/env node
/**
 * 组装 npm 包 nctrn：<tmp>/staging 里放 nctrn.mjs、packaging/npm 模板、
 * LICENSE、THIRD-PARTY-NOTICES.md，然后 npm pack 出 nctrn-<version>.tgz。
 *
 * 用法：node scripts/pack-npm.mjs [--bundle <nctrn.mjs 路径>] [--out <输出目录>]
 * 默认 bundle 用 src-tauri/resources/nctrn.mjs（即 bundle-nctrn.mjs 的默认产物），
 * 默认输出 dist/npm/。包版本号取自 packaging/npm/package.json。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./lib/proc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(root, "packaging", "npm");

export function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const bundle = resolve(
  argValue("--bundle") ?? join(root, "apps", "desktop", "src-tauri", "resources", "nctrn.mjs"),
);
const outDir = resolve(argValue("--out") ?? join(root, "dist", "npm"));

export function packNpm({ bundleFile, out }) {
  if (!existsSync(bundleFile)) {
    throw new Error(`找不到单文件 ${bundleFile}；先运行 node scripts/bundle-nctrn.mjs`);
  }
  const manifest = JSON.parse(readFileSync(join(templateDir, "package.json"), "utf8"));
  const tgzName = `${manifest.name}-${manifest.version}.tgz`;

  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "nctrn-npm-"));
  try {
    copyFileSync(bundleFile, join(staging, "nctrn.mjs"));
    copyFileSync(join(templateDir, "package.json"), join(staging, "package.json"));
    copyFileSync(join(templateDir, "README.md"), join(staging, "README.md"));
    copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
    copyFileSync(join(root, "THIRD-PARTY-NOTICES.md"), join(staging, "THIRD-PARTY-NOTICES.md"));
    run("npm", ["pack", "--pack-destination", out], { cwd: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const tgz = join(out, tgzName);
  if (!existsSync(tgz)) throw new Error(`npm pack 未产出 ${tgz}`);
  return tgz;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const tgz = packNpm({ bundleFile: bundle, out: outDir });
    console.log(`npm 包: ${tgz}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
