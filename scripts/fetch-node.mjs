#!/usr/bin/env node
/**
 * 下载桌面端随附的 Node.js（Windows x64），校验 SHA-256，只解出
 * node.exe 与 LICENSE 到 apps/desktop/src-tauri/resources/node/。
 *
 * 版本与哈希固定在 scripts/node-version.json，SHA-256 来自
 * nodejs.org 对应版本的 SHASUMS256.txt。已下载且 node.exe 哈希
 * 与记录一致时跳过下载。校验失败直接中止，不提供跳过选项。
 *
 * 用法：node scripts/fetch-node.mjs
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./lib/proc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "scripts", "node-version.json"), "utf8"));
const targetDir = join(root, "apps", "desktop", "src-tauri", "resources", "node");
const marker = join(targetDir, "node.exe.sha256");

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${response.status}`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

function extract(zipFile, dest) {
  // 产物固定为 win-x64.zip，只在 Windows 构建机使用：直接走 Expand-Archive。
  // 其他平台若误调用，尝试系统 bsdtar（GNU tar 不支持 zip）。
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zipFile)} -DestinationPath ${JSON.stringify(dest)}`,
    ]);
  } else {
    run("tar", ["-xf", zipFile, "-C", dest]);
  }
}

async function main() {
  const nodeExe = join(targetDir, "node.exe");
  if (existsSync(nodeExe) && existsSync(marker)) {
    const recorded = readFileSync(marker, "utf8").trim();
    if (recorded !== "" && sha256File(nodeExe) === recorded) {
      console.log(`随附 Node 已就绪（node.exe 哈希与记录一致），跳过下载`);
      return;
    }
  }

  const work = mkdtempSync(join(tmpdir(), "nctrn-node-"));
  try {
    const zip = join(work, "node.zip");
    console.log(`下载 ${spec.url}`);
    await download(spec.url, zip);
    const actual = sha256File(zip);
    if (actual !== spec.sha256) {
      throw new Error(`SHA-256 校验失败：期望 ${spec.sha256}，实际 ${actual}`);
    }

    extract(zip, work);
    const dir = join(work, `node-v${spec.version}-win-x64`);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(join(dir, "node.exe"), nodeExe);
    copyFileSync(join(dir, "LICENSE"), join(targetDir, "LICENSE"));
    writeFileSync(marker, `${sha256File(nodeExe)}\n`);
    console.log(`随附 Node v${spec.version} 已写入 ${targetDir}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
