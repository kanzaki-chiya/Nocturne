#!/usr/bin/env node
/**
 * 构建四个自包含内置文档插件到仓库根 plugins/{docx,xlsx,pptx,pdf}/：
 * - .nocturne-plugin/plugin.json
 * - icon.svg
 * - skills/<name>/SKILL.md
 * - server.mjs（单文件 ESM，全部第三方依赖内联，运行时无需 node_modules）
 * - engine.py（LibreOffice UNO 辅助脚本）
 * - viewer.html（四个插件共用的 pdf.js 单文件查看器，内联 pdf.js 与 Worker）
 * - viewer-assets/（合规的 cMap、Foxit 标准字体、jbig2/openjpeg WebAssembly 及 manifest.json）
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "..");
const outBase = join(repoRoot, "plugins");
const pythonSrc = join(pkgDir, "python", "engine.py");
const viewerTemplatePath = join(pkgDir, "viewer", "template.html");

const PLUGINS = ["docx", "xlsx", "pptx", "pdf"];
const MAX_VIEWER_HTML_BYTES = 8 * 1024 * 1024;

/** 仅打包符合 ADR-0100（MIT / Apache-2.0 / BSD）许可的 pdf.js 辅助资源 */
const LICENSED_WASM_FILES = ["jbig2.wasm", "openjpeg.wasm"];

const require = createRequire(import.meta.url);
const pdfjsPkgPath = require.resolve("pdfjs-dist/package.json");
const pdfjsRoot = dirname(pdfjsPkgPath);
const pdfjsVersion = JSON.parse(readFileSync(pdfjsPkgPath, "utf8")).version;
const pluginVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;

function stageViewerAssets(assetsOutDir) {
  const files = {};

  // 1. cMaps（cmaps/LICENSE: BSD-3-Clause）
  const cmapsSrc = join(pdfjsRoot, "cmaps");
  const cmapsDst = join(assetsOutDir, "cmaps");
  mkdirSync(cmapsDst, { recursive: true });
  for (const name of readdirSync(cmapsSrc).sort()) {
    if (!name.endsWith(".bcmap")) continue;
    const src = join(cmapsSrc, name);
    const dst = join(cmapsDst, name);
    copyFileSync(src, dst);
    files[`cmaps/${name}`] = {
      size: statSync(dst).size,
      mimeType: "application/octet-stream",
    };
  }

  // 2. 标准字体（仅打包 Foxit*.pfb，LICENSE_FOXIT: BSD-3-Clause；
  //    显式排除 LiberationSans-*.ttf，因 LICENSE_LIBERATION 为 GPL-2.0-only with font exception）
  const fontsSrc = join(pdfjsRoot, "standard_fonts");
  const fontsDst = join(assetsOutDir, "standard_fonts");
  mkdirSync(fontsDst, { recursive: true });
  for (const name of readdirSync(fontsSrc).sort()) {
    if (!/^Foxit.+\.pfb$/i.test(name)) continue;
    const src = join(fontsSrc, name);
    const dst = join(fontsDst, name);
    copyFileSync(src, dst);
    files[`standard_fonts/${name}`] = {
      size: statSync(dst).size,
      mimeType: "application/x-font-type1",
    };
  }

  // 3. WebAssembly 解码器（jbig2: BSD-3-Clause + Apache-2.0；openjpeg: BSD-2-Clause + BSD-3-Clause）
  const wasmSrc = join(pdfjsRoot, "wasm");
  const wasmDst = join(assetsOutDir, "wasm");
  mkdirSync(wasmDst, { recursive: true });
  for (const name of LICENSED_WASM_FILES) {
    const src = join(wasmSrc, name);
    const dst = join(wasmDst, name);
    copyFileSync(src, dst);
    files[`wasm/${name}`] = {
      size: statSync(dst).size,
      mimeType: "application/wasm",
    };
  }

  const manifest = {
    pdfjsVersion,
    files,
  };
  writeFileSync(
    join(assetsOutDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

async function buildSharedViewerHtml(stagingDir) {
  const viewerOutDir = join(stagingDir, "viewer-bundle");
  await build({
    cwd: pkgDir,
    config: false,
    name: "doc-plugin-viewer",
    entry: { viewer: "viewer/viewer.ts" },
    format: "esm",
    platform: "browser",
    target: "es2023",
    outDir: viewerOutDir,
    minify: true,
    sourcemap: false,
    dts: false,
    clean: true,
    hash: false,
    define: { __NOCTURNE_PLUGIN_VERSION__: JSON.stringify(pluginVersion) },
    deps: { alwaysBundle: () => true },
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { codeSplitting: false },
    logLevel: "warn",
  });

  const rawBundle = readFileSync(join(viewerOutDir, "viewer.js"), "utf8");
  // 防止内联脚本中出现 </script> 提前闭合 HTML 标签
  const safeBundle = rawBundle.replace(/<\/(script)/gi, "<\\/$1");

  // 把 pdf.worker.min.mjs 打包成经典 IIFE 脚本：
  // 在 sandbox="allow-scripts"（opaque origin "null"）的 iframe 中，Chromium 拒绝
  // { type: "module" } 的 blob Worker（CORS 校验失败），经典 blob Worker 可直接运行。
  const workerOutDir = join(stagingDir, "worker-bundle");
  await build({
    cwd: pkgDir,
    config: false,
    name: "doc-plugin-pdf-worker",
    entry: { worker: join(pdfjsRoot, "legacy", "build", "pdf.worker.min.mjs") },
    format: "iife",
    globalName: "__nocturnePdfWorkerExports",
    platform: "browser",
    target: "es2023",
    outDir: workerOutDir,
    minify: true,
    sourcemap: false,
    dts: false,
    clean: true,
    hash: false,
    define: { "import.meta": "{}" },
    deps: { alwaysBundle: () => true },
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { codeSplitting: false, entryFileNames: "worker.js" },
    logLevel: "warn",
  });
  const workerBase64 = readFileSync(join(workerOutDir, "worker.js")).toString("base64");

  const template = readFileSync(viewerTemplatePath, "utf8");
  const html = template
    .replace("__PDFJS_WORKER_BASE64__", () => workerBase64)
    .replace("__VIEWER_BUNDLE__", () => safeBundle);

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_VIEWER_HTML_BYTES) {
    throw new Error(
      `viewer.html size (${bytes} bytes) exceeds 8 MiB limit (${MAX_VIEWER_HTML_BYTES} bytes).`,
    );
  }
  return { html, bytes };
}

function collectPluginFiles(rootDir, relPrefix = "") {
  const out = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectPluginFiles(full, rel));
    } else if (entry.isFile()) {
      out.push({ rel, full });
    }
  }
  return out;
}

function computeBuildId(pluginDir) {
  const files = collectPluginFiles(pluginDir).sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.rel, "utf8");
    hash.update("\0");
    hash.update(readFileSync(file.full));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export async function buildDocPlugins(targetBase = outBase) {
  const staging = mkdtempSync(join(tmpdir(), "nocturne-doc-plugins-build-"));
  try {
    const assetsStaging = join(staging, "viewer-assets");
    stageViewerAssets(assetsStaging);
    const { html: viewerHtml } = await buildSharedViewerHtml(staging);

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
      writeFileSync(join(pluginOut, "viewer.html"), viewerHtml, "utf8");
      cpSync(assetsStaging, join(pluginOut, "viewer-assets"), { recursive: true });
      const buildId = computeBuildId(pluginOut);
      writeFileSync(join(pluginOut, ".nocturne-plugin", "build-id"), buildId, "utf8");
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  await buildDocPlugins();
}
