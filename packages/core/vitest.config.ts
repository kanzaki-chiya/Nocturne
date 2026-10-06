import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.smoke.ts"],
    environment: "node",
    setupFiles: ["test/setup-offline.ts"],
    // CI runner 明显慢于本机（发布流水线实测约 3 倍）：仅在 CI 放宽单测超时，本地保持默认 5s 以便发现变慢的用例
    testTimeout: process.env.CI === "true" ? 30_000 : 5_000,
    // 仅 CI：失败重试 2 次，吸收慢速 runner 上的时序抖动；本地不重试，偶发问题照常暴露
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
