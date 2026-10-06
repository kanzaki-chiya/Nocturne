#!/usr/bin/env node
/**
 * 一次改齐仓库内所有版本号，或只校验不修改：
 *
 *   node scripts/release-version.mjs <version>          # 写入所有版本位置
 *   node scripts/release-version.mjs --check <version>  # 全部一致才返回 0
 *
 * 覆盖：根与各 workspace package.json、apps/desktop/src-tauri/tauri.conf.json、
 * Cargo.toml（[package] version）、Cargo.lock（nocturne-desktop 条目）、
 * packaging/npm/package.json，以及源码里的版本常量（CONST_VERSION_FILES）。
 * 接受 0.6.0-rc.1 这类预发布号。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = "nocturne-desktop";

/** 与 package.json / tauri.conf.json 顶层 version 字段对应的文件 */
const JSON_VERSION_FILES = [
  "package.json",
  "packages/core/package.json",
  "packages/rpc/package.json",
  "packages/mcp/package.json",
  "packages/acp/package.json",
  "apps/cli/package.json",
  "apps/tui/package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
  "packaging/npm/package.json",
];

/** 源码里的版本常量：文件 → 常量名（`[export ]const <名> = "<版本>";`） */
const CONST_VERSION_FILES = {
  "packages/core/src/protocol/version.ts": "NOCTURNE_VERSION",
  "packages/mcp/src/connector.ts": "CLIENT_VERSION",
  "packages/acp/src/connector.ts": "CLIENT_VERSION",
  "apps/cli/src/main.ts": "VERSION",
  "apps/tui/src/version.ts": "APP_VERSION",
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidVersion(version) {
  return SEMVER.test(version);
}

function readJsonVersion(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed.version !== "string") throw new Error(`${file} 缺少 version 字段`);
  return parsed.version;
}

function writeJsonVersion(file, version) {
  const text = readFileSync(file, "utf8");
  const pattern = /^(\s*)"version":\s*"[^"]*"/m;
  if (!pattern.test(text)) throw new Error(`${file} 中找不到 version 字段`);
  writeFileSync(file, text.replace(pattern, `$1"version": "${version}"`));
}

function constPattern(name) {
  return new RegExp(`^((?:export )?const ${name} = ")([^"]*)(";)`, "m");
}

function readConstVersion(file, name) {
  const match = constPattern(name).exec(readFileSync(file, "utf8"));
  if (match === null) throw new Error(`${file} 中找不到常量 ${name}`);
  return match[2];
}

function writeConstVersion(file, name, version) {
  const text = readFileSync(file, "utf8");
  if (!constPattern(name).test(text)) throw new Error(`${file} 中找不到常量 ${name}`);
  writeFileSync(file, text.replace(constPattern(name), `$1${version}$3`));
}

/** Cargo.toml：只动 [package] 节里的 version 行（[^[] 保证不越出本节） */
function readCargoVersion(file) {
  const text = readFileSync(file, "utf8");
  const match = /\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(text);
  if (match === null) throw new Error(`${file} 缺少 [package] version`);
  return match[1];
}

function writeCargoVersion(file, version) {
  const text = readFileSync(file, "utf8");
  const pattern = /(\[package\][^[]*?^version\s*=\s*")[^"]*(")/m;
  if (!pattern.test(text)) throw new Error(`${file} 中找不到 [package] version`);
  writeFileSync(file, text.replace(pattern, `$1${version}$2`));
}

/** Cargo.lock：只动 [[package]] name = "<crate>" 那一节的 version 行 */
function lockBlock(text, crate) {
  const pattern = new RegExp(
    `^\\[\\[package\\]\\]\\nname\\s*=\\s*"${crate}"\\nversion\\s*=\\s*"([^"]+)"`,
    "m",
  );
  return pattern.exec(text);
}

function readLockVersion(file, crate) {
  const text = readFileSync(file, "utf8");
  const match = lockBlock(text, crate);
  if (match === null) throw new Error(`${file} 中找不到 ${crate} 条目`);
  return match[1];
}

function writeLockVersion(file, crate, version) {
  const text = readFileSync(file, "utf8");
  const match = lockBlock(text, crate);
  if (match === null) throw new Error(`${file} 中找不到 ${crate} 条目`);
  writeFileSync(file, text.replace(match[0], match[0].replace(/"[^"]*"$/, `"${version}"`)));
}

/** 读取所有版本位置 → { 相对路径: version } */
export function collectVersions(root) {
  const versions = {};
  for (const rel of JSON_VERSION_FILES) {
    versions[rel] = readJsonVersion(join(root, rel));
  }
  versions["apps/desktop/src-tauri/Cargo.toml"] = readCargoVersion(
    join(root, "apps/desktop/src-tauri/Cargo.toml"),
  );
  versions["apps/desktop/src-tauri/Cargo.lock"] = readLockVersion(
    join(root, "apps/desktop/src-tauri/Cargo.lock"),
    CRATE,
  );
  for (const [rel, name] of Object.entries(CONST_VERSION_FILES)) {
    versions[rel] = readConstVersion(join(root, rel), name);
  }
  return versions;
}

export function applyVersion(root, version) {
  if (!isValidVersion(version)) throw new Error(`非法版本号: ${version}`);
  for (const rel of JSON_VERSION_FILES) {
    writeJsonVersion(join(root, rel), version);
  }
  writeCargoVersion(join(root, "apps/desktop/src-tauri/Cargo.toml"), version);
  writeLockVersion(join(root, "apps/desktop/src-tauri/Cargo.lock"), CRATE, version);
  for (const [rel, name] of Object.entries(CONST_VERSION_FILES)) {
    writeConstVersion(join(root, rel), name, version);
  }
}

/** @returns {{ ok: boolean, versions: Record<string, string> }} */
export function checkVersion(root, version) {
  const versions = collectVersions(root);
  const mismatched = Object.entries(versions).filter(([, v]) => v !== version);
  for (const [file, v] of mismatched) {
    console.error(`${file}: ${v}（期望 ${version}）`);
  }
  return { ok: mismatched.length === 0, versions };
}

function main() {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  const version = check ? args[1] : args[0];
  if (version === undefined || !isValidVersion(version)) {
    console.error("用法: node scripts/release-version.mjs [--check] <semver 版本号>");
    process.exit(1);
  }
  try {
    if (check) {
      const { ok } = checkVersion(ROOT, version);
      if (!ok) process.exit(1);
      console.log(`所有版本号均为 ${version}`);
    } else {
      applyVersion(ROOT, version);
      console.log(`版本号已更新为 ${version}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
