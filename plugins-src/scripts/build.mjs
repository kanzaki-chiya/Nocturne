#!/usr/bin/env node
/**
 * 构建四个自包含内置文档插件到仓库根 plugins/{docx,xlsx,pptx,pdf}/：
 * - .nocturne-plugin/plugin.json
 * - icon.svg
 * - skills/<name>/SKILL.md
 * - server.mjs（单文件 ESM，全部第三方依赖内联，运行时无需 node_modules）
 * - engine.py（LibreOffice UNO 辅助脚本）
 */
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "..");
const outBase = join(repoRoot, "plugins");
const pythonSrc = join(pkgDir, "python", "engine.py");

const PLUGINS = ["docx", "xlsx", "pptx", "pdf"];

export async function buildDocPlugins(targetBase = outBase) {
  const staging = mkdtempSync(join(tmpdir(), "nocturne-doc-plugins-build-"));
  try {
    for (const name of PLUGINS) {
      const bundleDir = join(staging, name);
      await build({
        cwd: pkgDir,
        config: false,
        name: `doc-plugin-${name}`,
        entry: { server: `src/entries/${name}-entry.ts` },
        format: "esm",
        platform: "node",
        target: "node24",
        outDir: bundleDir,
        sourcemap: false,
        dts: false,
        clean: true,
        hash: false,
        deps: { alwaysBundle: () => true },
        outExtensions: () => ({ js: ".mjs" }),
        outputOptions: { codeSplitting: false },
        logLevel: "warn",
      });

      const pluginOut = join(targetBase, name);
      rmSync(pluginOut, { recursive: true, force: true });
      mkdirSync(pluginOut, { recursive: true });

      const manifestSrc = join(pkgDir, "manifests", name);
      cpSync(manifestSrc, pluginOut, { recursive: true });

      const rawServer = readFileSync(join(bundleDir, "server.mjs"), "utf8");
      writeFileSync(join(pluginOut, "server.mjs"), `/* eslint-disable */\n${rawServer}`, "utf8");
      copyFileSync(pythonSrc, join(pluginOut, "engine.py"));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  await buildDocPlugins();
}
