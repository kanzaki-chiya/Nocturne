#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./lib/proc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "packages/mcp/src/computer-release.json"), "utf8"));
const cache = join(root, "apps/desktop/src-tauri/target/computer-cache", spec.version);
const destination = join(root, "apps/desktop/src-tauri/resources/computer");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
const ps = (text) => `'${text.replaceAll("'", "''")}'`;

/** 删除目标目录里清单以外的旧文件，免得本地残留被打进安装包 */
function prune(dir) {
  const allowed = new Set(Object.keys(spec.files));
  for (const existing of readdirSync(dir))
    if (!allowed.has(existing)) rmSync(join(dir, existing), { recursive: true, force: true });
}

async function main() {
  if (process.platform !== "win32") throw new Error("电脑操控驱动目前仅打包 Windows x64");
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, "package.zip");
  if (!existsSync(archive)) {
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`computer download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex").toUpperCase() !== spec.sha256)
      throw new Error("computer archive SHA-256 mismatch");
    writeFileSync(archive, bytes);
  }
  if (hash(archive) !== spec.sha256) throw new Error("computer cached archive SHA-256 mismatch");
  const work = mkdtempSync(join(cache, "extract-"));
  try {
    run(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${ps(archive)} -DestinationPath ${ps(work)}`,
      ],
      { cwd: root },
    );
    const packageDir = join(work, `cua-driver-rs-${spec.version}-windows-x86_64`);
    for (const [name, expected] of Object.entries(spec.files))
      if (hash(join(packageDir, name)) !== expected)
        throw new Error(`computer file SHA-256 mismatch: ${name}`);
    const signed = Object.keys(spec.files)
      .filter((name) => /\.(exe|dll)$/.test(name))
      .map((name) => ps(join(packageDir, name)))
      .join(",");
    run(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; @(${signed}) | ForEach-Object { $signature=Get-AuthenticodeSignature -LiteralPath $_; if ($signature.Status -ne 'Valid') { throw ('computer signature: ' + $_) } }`,
      ],
      { cwd: root },
    );
    mkdirSync(destination, { recursive: true });
    prune(destination);
    for (const name of Object.keys(spec.files))
      copyFileSync(join(packageDir, name), join(destination, name));
    console.log(
      `cua-driver ${spec.version}: archive SHA-256, file SHA-256 and Authenticode verified; ${destination}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
// 测试入口：只清理指定目录，不下载
const run$ = process.argv[2] === "--prune-only" ? async () => prune(process.argv[3]) : main;
run$().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
