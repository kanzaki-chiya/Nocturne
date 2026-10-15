import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
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
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    testTimeout: 30_000,
    retry: process.env.CI === "true" ? 2 : 0,
  },
});
