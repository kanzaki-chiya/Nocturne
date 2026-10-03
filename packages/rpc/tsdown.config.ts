import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { server: "src/server/index.ts", client: "src/client/index.ts" },
  format: "esm",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  platform: "neutral",
  target: "node24",
  // 服务端要用 Node 内置模块；客户端入口不引用它们（由 depcheck 保证）
  external: [/^node:/],
});
