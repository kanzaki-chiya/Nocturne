import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 冒烟测试：fixture 仓库 + 非交互 nctrn --yes -p（cli.md 第 8 节）。
// 需要环境变量 NOCTURNE_SMOKE_BASE_URL / NOCTURNE_SMOKE_API_KEY /
// NOCTURNE_SMOKE_MODEL；也可写在仓库根目录 .env；未设置时跳过。
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    include: ["test/**/*.smoke.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
