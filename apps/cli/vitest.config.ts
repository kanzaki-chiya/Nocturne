import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // 离线测试直接对 core 源码运行（cli.md 第 9 节），不需要先构建 dist
    alias: [
      {
        find: /^@nocturne\/tui\/provider-login$/,
        replacement: path.resolve(here, "../tui/src/provider-login.ts"),
      },
      {
        find: /^@nocturne\/tui\/text-format$/,
        replacement: path.resolve(here, "../tui/src/text-format.ts"),
      },
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../../packages/core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../../packages/core/src/index.ts"),
      },
      {
        find: /^@nocturne\/tui\/slash-catalog$/,
        replacement: path.resolve(here, "../tui/src/slash-catalog.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
