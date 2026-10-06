import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../core/src/protocol/index.ts"),
      },
      { find: /^@nocturne\/core$/, replacement: path.resolve(here, "../core/src/index.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.smoke.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
