#!/usr/bin/env node
/**
 * 把 apps/cli 打成单个 ESM 文件 apps/desktop/src-tauri/resources/nctrn.mjs，
 * 供桌面版 release 构建作为后台进程脚本（不打包 Node 本体）。
 *
 * 所有运行时依赖（含 workspace 包和 npm 依赖，以及 @nocturne/tui 的动态
 * import）全部内联；产物自包含，可在没有 node_modules 的目录里直接
 * `node nctrn.mjs` 运行。脚本可重复执行，输出覆盖写。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "apps", "cli");
const resourcesDir = join(root, "apps", "desktop", "src-tauri", "resources");
const outFile = join(resourcesDir, "nctrn.mjs");

/**
 * 运行时走不到、但静态打包必须能解析的可选依赖：
 * - react-devtools-core：ink 的可选 peer dep，只有 DEV=true 才探测；
 * - bufferutil / utf-8-validate：ws 的 try/catch 可选加速包
 *   （ws 只有 ink devtools 路径会触达）。
 * 解析成空模块即可；WS_NO_* define 同时让 ws 的 require 分支被 DCE 掉。
 */
const stubOptionalDeps = {
  name: "nocturne-stub-optional-deps",
  resolveId(id) {
    if (id === "react-devtools-core" || id === "bufferutil" || id === "utf-8-validate") {
      return `\0stub:${id}`;
    }
    return null;
  },
  load(id) {
    if (id.startsWith("\0stub:")) return "export default {};";
    return null;
  },
};

const outDir = mkdtempSync(join(tmpdir(), "nctrn-bundle-"));
try {
  await build({
    cwd: cliDir,
    config: false,
    name: "nctrn-bundle",
    entry: { nctrn: "src/main.ts" },
    format: "esm",
    platform: "node",
    target: "node24",
    outDir,
    sourcemap: false,
    dts: false,
    clean: true,
    hash: false,
    deps: { alwaysBundle: () => true },
    define: {
      "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
      "process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
    },
    plugins: [stubOptionalDeps],
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: false },
    logLevel: "warn",
  });

  const built = join(outDir, "nctrn.mjs");
  // 保留 bin 入口语义：确保首行是 shebang（构建器可能剥离）
  const code = readFileSync(built, "utf8");
  const withShebang = code.startsWith("#!") ? code : `#!/usr/bin/env node\n${code}`;

  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(outFile, withShebang);
  const mib = (statSync(outFile).size / 1024 / 1024).toFixed(2);
  console.log(`nctrn.mjs: ${outFile} (${mib} MiB)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
