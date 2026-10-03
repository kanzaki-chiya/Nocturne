import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/slash-catalog.ts",
    "src/text-format.ts",
    "src/provider-login.ts",
    "src/provider-setup-flow.ts",
    "src/provider-prompts.ts",
  ],
  format: "esm",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  platform: "node",
  target: "node24",
});
