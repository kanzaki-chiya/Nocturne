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
        replacement: path.resolve(here, "../core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // 仅 CI：失败重试 2 次，吸收慢速 runner 上的时序抖动；本地不重试，偶发问题照常暴露
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
