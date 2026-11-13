import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const cliRoot = dirname(fileURLToPath(import.meta.url));
const coreDist = resolve(cliRoot, "../../packages/core/dist");

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: "esm",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  platform: "node",
  target: "node24",
  // bin 入口需要 .js 扩展名
  outExtensions: () => ({ js: ".js" }),
  onSuccess() {
    const outDist = join(cliRoot, "dist");
    mkdirSync(join(outDist, "wasm"), { recursive: true });
    copyFileSync(join(coreDist, "image-worker.mjs"), join(outDist, "image-worker.mjs"));
    cpSync(join(coreDist, "wasm"), join(outDist, "wasm"), { recursive: true });
  },
});
