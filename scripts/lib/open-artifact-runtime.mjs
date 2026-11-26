import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * 复制随包交付的固定版本 @open-artifact/cli 运行时以及上游 LICENSE/NOTICE 声明。
 * 保留 @open-artifact/cli 原样目录结构（scripts/、vendor/、reference/、SKILL.md、package.json、
 * LICENSE、NOTICE）并在 LICENSES/ 补充 @open-artifact/harness-kit 与 @open-artifact/protocol
 * 的 LICENSE / NOTICE（ADR-0125）。
 */
export function copyOpenArtifactRuntimeToDir(openArtifactPkgJsonPath, destRuntimeDir) {
  const req = createRequire(openArtifactPkgJsonPath);
  const cliPkgPath = req.resolve("@open-artifact/cli/package.json");
  const cliDir = dirname(cliPkgPath);
  const entry = join(cliDir, "scripts", "open-artifact.mjs");
  if (!existsSync(entry)) {
    throw new Error(`找不到 @open-artifact/cli 入口脚本：${entry}`);
  }

  rmSync(destRuntimeDir, { recursive: true, force: true });
  mkdirSync(destRuntimeDir, { recursive: true });
  cpSync(cliDir, destRuntimeDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(cliDir.length);
      return !rel.includes("node_modules");
    },
  });

  // 同时随包携带 harness-kit 与 protocol 的 LICENSE / NOTICE 声明
  const extraPkgs = [
    ["harness-kit", "@open-artifact/harness-kit/package.json"],
    ["protocol", "@open-artifact/protocol/package.json"],
  ];
  for (const [label, spec] of extraPkgs) {
    try {
      const pkgDir = dirname(req.resolve(spec));
      const targetDir = join(destRuntimeDir, "LICENSES", label);
      mkdirSync(targetDir, { recursive: true });
      for (const file of ["LICENSE", "NOTICE"]) {
        const src = join(pkgDir, file);
        if (existsSync(src)) {
          copyFileSync(src, join(targetDir, file));
        }
      }
    } catch {
      // ignore if optional package unavailable
    }
  }
}

/**
 * 将 bundle 产物旁的 open-artifact-runtime/ 目录复制到目标目录（供 pack-npm.mjs 复用）。
 * 若源目录不存在返回 false；复制时同样排除 node_modules。
 */
export function copyBundledOpenArtifactRuntimeFromDir(srcDir, destDir) {
  const srcRuntime = join(srcDir, "open-artifact-runtime");
  if (!existsSync(srcRuntime) || !statSync(srcRuntime).isDirectory()) {
    return false;
  }
  const entry = join(srcRuntime, "scripts", "open-artifact.mjs");
  if (!existsSync(entry)) {
    throw new Error(`bundle 旁 open-artifact-runtime 缺少入口脚本：${entry}`);
  }
  const destRuntime = join(destDir, "open-artifact-runtime");
  rmSync(destRuntime, { recursive: true, force: true });
  mkdirSync(destRuntime, { recursive: true });
  cpSync(srcRuntime, destRuntime, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(srcRuntime.length);
      return !rel.includes("node_modules");
    },
  });
  return true;
}
