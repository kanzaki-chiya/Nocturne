import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 离线测试直接对 rpc 与 core 源码运行，不需要先构建 dist
    alias: [
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../../packages/core/src/index.ts"),
      },
      {
        find: /^@nocturne\/rpc\/server$/,
        replacement: path.resolve(here, "../../packages/rpc/src/server/index.ts"),
      },
      {
        find: /^@nocturne\/remote$/,
        replacement: path.resolve(here, "../../packages/remote/src/index.ts"),
      },
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../../packages/core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/rpc\/client$/,
        replacement: path.resolve(here, "../../packages/rpc/src/client/index.ts"),
      },
    ],
  },
  test: {
    // 不管外层环境是什么（例如继承来的 NODE_ENV=production），测试都按测试环境跑；
    // vitest 只在 NODE_ENV 未设置时才默认 test
    env: { NODE_ENV: "test" },
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    testTimeout: 30_000,
    // 仅 CI：失败重试 2 次，吸收慢速 runner 上的时序抖动；本地不重试，偶发问题照常暴露
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
