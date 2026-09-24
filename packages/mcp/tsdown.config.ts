import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  platform: "node",
  target: "node24",
});
