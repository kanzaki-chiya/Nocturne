import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // 离线测试直接对 core 源码运行，不需要先构建 dist
    alias: [
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../../packages/core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/core$/,
        replacement: path.resolve(here, "../../packages/core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["test/setup-isolated-home.ts"],
    testTimeout: process.env.CI === "true" ? 60_000 : 15_000,
    // 仅 CI：失败重试 2 次，吸收慢速 runner 上的时序抖动；本地不重试，偶发问题照常暴露
    retry: process.env.CI === "true" ? 2 : 0,
    // Ink 帧渲染吃 CPU；按核数默认并发时多线程低主频机器上互相拖慢，大批用例超时。
    maxWorkers: 4,
    // Ink 测试断言的是可见文本；不让宿主 FORCE_COLOR 改写帧里的 ANSI 序列。
    // CI 环境变量会让 Ink（is-in-ci）关闭增量渲染、只输出最后一帧，测试断言的中间帧就不存在了；
    // CI=false 让 is-in-ci 判为非 CI，测试在 GitHub runner 上与本机一致。
    env: { FORCE_COLOR: "0", CI: "false" },
  },
});
