#!/usr/bin/env node
/** Build-independent packaging of the relay bundle and phone web distribution. */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./lib/proc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Keep only deployable metadata; workspace dependencies must never reach npm. */
export function relayManifest(pkg) {
  if (typeof pkg.dependencies?.ws !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.dependencies.ws))
    throw new Error("relay 的 ws 依赖必须是精确版本");
  return {
    name: "nocturne-relay",
    version: pkg.version,
    description: pkg.description,
    private: true,
    bin: pkg.bin,
    type: pkg.type,
    engines: pkg.engines,
    license: pkg.license,
    files: [...pkg.files, "THIRD-PARTY-NOTICES.md"],
    dependencies: { ws: pkg.dependencies.ws },
  };
}

export function packRelay({
  out = join(root, "dist", "relay"),
  distDir = join(root, "apps", "relay", "dist"),
  webDir = join(root, "apps", "desktop", "dist-web"),
} = {}) {
  for (const file of ["main.mjs"]) {
    if (!existsSync(join(distDir, file)))
      throw new Error(`缺少 relay 构建产物 ${join(distDir, file)}；先运行 pnpm build`);
  }
  for (const file of ["index.html", "manifest.webmanifest", "sw.js"]) {
    if (!existsSync(join(webDir, file)))
      throw new Error(`缺少手机网页 ${join(webDir, file)}；先运行 pnpm build`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "apps", "relay", "package.json"), "utf8"));
  const manifest = relayManifest(pkg);
  const destination = resolve(out);
  mkdirSync(destination, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "nocturne-relay-pack-"));
  try {
    cpSync(distDir, join(staging, "dist"), { recursive: true });
    cpSync(webDir, join(staging, "public"), { recursive: true });
    writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(join(root, "apps", "relay", "deploy", "README.md"), join(staging, "README.md"));
    copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
    copyFileSync(join(root, "THIRD-PARTY-NOTICES.md"), join(staging, "THIRD-PARTY-NOTICES.md"));
    run("npm", ["pack", "--pack-destination", destination], { cwd: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const tgz = join(destination, `${manifest.name}-${manifest.version}.tgz`);
  if (!existsSync(tgz)) throw new Error(`npm pack 未产出 ${tgz}`);
  return tgz;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf("--out");
    if (index >= 0 && !process.argv[index + 1]) throw new Error("--out 需要目录");
    console.log(`中继包: ${packRelay({ out: index >= 0 ? process.argv[index + 1] : undefined })}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
