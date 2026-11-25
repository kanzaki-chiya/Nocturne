import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cliBuildStampPaths } from "./ensure-cli-build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * 为当次 Vitest 运行生成唯一构建轮次标识；本身不触发构建，仅由需要 dist 产物的
 * e2e 测试通过 `ensureCliBuilt` 协调单次构建并复用。
 */
export default function setup(): () => void {
  process.env.NOCTURNE_CLI_BUILD_RUN_ID = randomUUID();
  const { donePath } = cliBuildStampPaths(repoRoot);
  return () => {
    try {
      unlinkSync(donePath);
    } catch {
      // 未运行 e2e 构建时文件不存在
    }
  };
}
