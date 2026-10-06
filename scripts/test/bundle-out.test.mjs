import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("bundle-nctrn --out-dir", () => {
  it("输出到指定目录，产物带 shebang 且可直接运行", () => {
    // tsdown 经 workspace 包的 dist 解析依赖，需要先跑过 pnpm build
    const coreDist = join(root, "packages", "core", "dist", "index.mjs");
    if (!existsSync(coreDist)) {
      throw new Error("缺少 packages/core/dist，请先运行 pnpm build");
    }
    const out = mkdtempSync(join(tmpdir(), "nctrn-bundle-test-"));
    try {
      execFileSync(
        process.execPath,
        [join(root, "scripts", "bundle-nctrn.mjs"), "--out-dir", out],
        { stdio: "pipe", timeout: 180_000 },
      );
      const file = join(out, "nctrn.mjs");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8").startsWith("#!")).toBe(true);
      // 单文件自包含：无 node_modules 的临时目录里也能跑
      const version = execFileSync(process.execPath, [file, "--version"], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, NOCTURNE_HOME: join(out, "home") },
      }).trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 240_000);
});
