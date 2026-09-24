import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 冒烟测试：真实 OpenAI 兼容与 Anthropic 服务。需要环境变量：
//   NOCTURNE_SMOKE_BASE_URL  例如 https://api.deepseek.com/v1
//   NOCTURNE_SMOKE_API_KEY   服务凭据（只从环境变量读取，不写入任何文件）
//   NOCTURNE_SMOKE_MODEL     模型 id，例如 deepseek-chat
// 也可写在仓库根目录 .env（已被 .gitignore 忽略）；已设置的环境变量优先。
// 仅在不含敏感信息的测试仓库中运行——读取到的内容会发给模型服务。
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    include: ["test/**/*.smoke.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
