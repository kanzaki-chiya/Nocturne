import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/**/*.smoke.test.ts"],
    exclude: [],
    testTimeout: 120_000,
    retry: 0,
  },
});
