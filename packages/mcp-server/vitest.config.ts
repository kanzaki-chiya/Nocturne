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
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../core/src/index.ts"),
      },
      {
        find: /^@nocturne\/remote$/,
        replacement: path.resolve(here, "../remote/src/index.ts"),
      },
      {
        find: /^@nocturne\/rpc\/client$/,
        replacement: path.resolve(here, "../rpc/src/client/index.ts"),
      },
      {
        find: /^@nocturne\/rpc\/server$/,
        replacement: path.resolve(here, "../rpc/src/server/index.ts"),
      },
    ],
  },
  test: {
    env: { NODE_ENV: "test" },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
