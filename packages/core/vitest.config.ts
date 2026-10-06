import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.smoke.ts"],
    environment: "node",
    setupFiles: ["test/setup-offline.ts"],
    // CI runner 明显慢于本机（发布流水线实测约 3 倍）：仅在 CI 放宽单测超时，本地保持默认 5s 以便发现变慢的用例
    testTimeout: process.env.CI === "true" ? 30_000 : 5_000,
  },
});
