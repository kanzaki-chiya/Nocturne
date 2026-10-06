import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
    // npm pack、bundle 等会起子进程：CI runner 上明显更慢（pack 实测约 9s），仅在 CI 放宽超时并重试
    testTimeout: process.env.CI === "true" ? 60_000 : 30_000,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
