import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { NODE_ENV: "test" },
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    maxWorkers: 2,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
