import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // 离线测试直接对 core 源码运行，不需要先构建 dist
    alias: [
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../../packages/core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../../packages/core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
