import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_WASM_FILES } from "../lib/image-wasm.mjs";
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
  it("输出到指定目录，产物带 shebang 且可直接运行；无 plugins/ 时跳过不报错并创建空目录", async () => {
    // tsdown 经 workspace 包的 dist 解析依赖，需要先跑过 pnpm build
    const coreDist = join(root, "packages", "core", "dist", "index.mjs");
    if (!existsSync(coreDist)) {
      throw new Error("缺少 packages/core/dist，请先运行 pnpm build");
    }
    const out = mkdtempSync(join(tmpdir(), "nctrn-bundle-test-"));
    directories.push(out);
    await run(
      process.execPath,
      [
        join(root, "scripts", "bundle-nctrn.mjs"),
        "--out-dir",
        out,
        "--plugins-dir",
        join(out, "missing-plugins"),
      ],
      {
        stdio: "pipe",
        timeout: 180_000,
      },
    );
    const file = join(out, "nctrn.mjs");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(out, "image-worker.mjs"))).toBe(true);
    expect(existsSync(join(out, "plugins"))).toBe(true);
    for (const [wasmFile] of IMAGE_WASM_FILES) {
      expect(existsSync(join(out, "wasm", wasmFile)), wasmFile).toBe(true);
    }
    expect(readFileSync(file, "utf8").startsWith("#!")).toBe(true);
    // 单文件自包含：无 node_modules 的临时目录里也能跑
    const version = await run(process.execPath, [file, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NOCTURNE_HOME: join(out, "home") },
    });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 240_000);

  it("源 plugins/ 存在时复制到输出目录并排除 test/、node_modules/ 与测试夹具", async () => {
    const coreDist = join(root, "packages", "core", "dist", "index.mjs");
    if (!existsSync(coreDist)) {
      throw new Error("缺少 packages/core/dist，请先运行 pnpm build");
    }
    const work = mkdtempSync(join(tmpdir(), "nctrn-bundle-plugins-"));
    directories.push(work);
    const srcPlugins = join(work, "src-plugins");
    const demoDir = join(srcPlugins, "demo");
    mkdirSync(join(demoDir, ".nocturne-plugin"), { recursive: true });
    mkdirSync(join(demoDir, "skills", "s1"), { recursive: true });
    mkdirSync(join(demoDir, "test"), { recursive: true });
    mkdirSync(join(demoDir, "fixtures"), { recursive: true });
    mkdirSync(join(demoDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(demoDir, ".nocturne-plugin", "plugin.json"), '{"name":"demo"}');
    writeFileSync(join(demoDir, "skills", "s1", "SKILL.md"), "---\ndescription: d\n---\nbody");
    writeFileSync(join(demoDir, "server.mjs"), "console.log('ok');");
    writeFileSync(join(demoDir, "server.test.mjs"), "test");
    writeFileSync(join(demoDir, "test", "a.test.mjs"), "test");
    writeFileSync(join(demoDir, "fixtures", "sample.txt"), "fixture");
    writeFileSync(join(demoDir, "node_modules", "pkg", "index.js"), "dep");

    const out = join(work, "out");
    await run(
      process.execPath,
      [join(root, "scripts", "bundle-nctrn.mjs"), "--out-dir", out, "--plugins-dir", srcPlugins],
      {
        stdio: "pipe",
        timeout: 180_000,
      },
    );
    expect(existsSync(join(out, "plugins", "demo", ".nocturne-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(out, "plugins", "demo", "skills", "s1", "SKILL.md"))).toBe(true);
    expect(existsSync(join(out, "plugins", "demo", "server.mjs"))).toBe(true);
    expect(existsSync(join(out, "plugins", "demo", "server.test.mjs"))).toBe(false);
    expect(existsSync(join(out, "plugins", "demo", "test"))).toBe(false);
    expect(existsSync(join(out, "plugins", "demo", "fixtures"))).toBe(false);
    expect(existsSync(join(out, "plugins", "demo", "node_modules"))).toBe(false);
  }, 240_000);
});
