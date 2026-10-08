import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessCleanup, removeTempDirs } from "./process-cleanup.mjs";

const processes = createProcessCleanup();
const directories = [];
afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs(directories.splice(0));
});
const run = (...args) => {
  const result = promisify(execFile)(...args);
  processes.trackChild(result.child);
  return result;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("bundle-nctrn --out-dir", () => {
  it("输出到指定目录，产物带 shebang 且可直接运行", async () => {
    // tsdown 经 workspace 包的 dist 解析依赖，需要先跑过 pnpm build
    const coreDist = join(root, "packages", "core", "dist", "index.mjs");
    if (!existsSync(coreDist)) {
      throw new Error("缺少 packages/core/dist，请先运行 pnpm build");
    }
    const out = mkdtempSync(join(tmpdir(), "nctrn-bundle-test-"));
    directories.push(out);
    await run(process.execPath, [join(root, "scripts", "bundle-nctrn.mjs"), "--out-dir", out], {
      stdio: "pipe",
      timeout: 180_000,
    });
    const file = join(out, "nctrn.mjs");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").startsWith("#!")).toBe(true);
    // 单文件自包含：无 node_modules 的临时目录里也能跑
    const version = await run(process.execPath, [file, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NOCTURNE_HOME: join(out, "home") },
    });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 240_000);
});
