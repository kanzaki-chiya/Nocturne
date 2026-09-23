import { defineConfig } from "tsdown";

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
});
