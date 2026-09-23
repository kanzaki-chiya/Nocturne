import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.smoke.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
