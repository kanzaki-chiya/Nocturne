import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@nocturne\/remote$/,
        replacement: fileURLToPath(new URL("../../packages/remote/src/index.ts", import.meta.url)),
      },
      {
        find: /^@nocturne\/rpc\/server$/,
        replacement: fileURLToPath(
          new URL("../../packages/rpc/src/server/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@nocturne\/rpc\/client$/,
        replacement: fileURLToPath(
          new URL("../../packages/rpc/src/client/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/protocol/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@nocturne\/core$/,
        replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    // 不管外层环境是什么（例如继承来的 NODE_ENV=production），测试都按测试环境跑
    env: { NODE_ENV: "test" },
  },
});
