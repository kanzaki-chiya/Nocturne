import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@nocturne\/core\/plugin-check$/,
        replacement: path.resolve(here, "../packages/core/src/plugins/check.ts"),
      },
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../packages/core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../packages/core/src/index.ts"),
      },
    ],
  },
  test: {
    env: { NODE_ENV: "test" },
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    maxWorkers: 2,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
