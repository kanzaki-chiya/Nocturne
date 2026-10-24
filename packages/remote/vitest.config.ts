import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 不管外层环境是什么（例如继承来的 NODE_ENV=production），测试都按测试环境跑；
    // vitest 只在 NODE_ENV 未设置时才默认 test
    env: { NODE_ENV: "test" },
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
