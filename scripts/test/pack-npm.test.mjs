import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IMAGE_WASM_FILES } from "../lib/image-wasm.mjs";
import { packNpm } from "../pack-npm.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 最小 tar 读取（tgz 只有普通文件；返回 name → 文本） */
function untar(tgzPath) {
  const data = gunzipSync(readFileSync(tgzPath));
  const files = new Map();
  for (let offset = 0; offset + 512 <= data.length;) {
    const name = data
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (name === "") break;
    const size = parseInt(data.subarray(offset + 124, offset + 136).toString("utf8"), 8);
    offset += 512;
    files.set(name, data.subarray(offset, offset + size).toString("utf8"));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nctrn-pack-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pack-npm", () => {
  it("打出 nctrn-<version>.tgz，内容与模板一致", () => {
    const bundle = join(dir, "nctrn.mjs");
    writeFileSync(bundle, "#!/usr/bin/env node\nconsole.log('fake');\n");
    writeFileSync(join(dir, "image-worker.mjs"), "console.log('worker');\n");
    mkdirSync(join(dir, "wasm"), { recursive: true });
    for (const [wasmFile] of IMAGE_WASM_FILES) {
      writeFileSync(join(dir, "wasm", wasmFile), "wasm");
    }
    const out = join(dir, "out");

    const tgz = packNpm({ bundleFile: bundle, out });
    expect(existsSync(tgz)).toBe(true);
    expect(tgz).toMatch(/nctrn-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/);

    const files = untar(tgz);
    const entries = [
      "package.json",
      "README.md",
      "nctrn.mjs",
      "image-worker.mjs",
      ...IMAGE_WASM_FILES.map(([f]) => `wasm/${f}`),
      "LICENSE",
      "THIRD-PARTY-NOTICES.md",
    ];
    for (const name of entries) {
      expect(files.has(`package/${name}`), name).toBe(true);
    }
    const manifest = JSON.parse(files.get("package/package.json"));
    expect(manifest.name).toBe("nctrn");
    expect(manifest.bin).toEqual({ nctrn: "nctrn.mjs" });
    expect(manifest.engines.node).toBe(">=24.16");
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("scripts");
    // 单文件内容原样进入包
    expect(files.get("package/nctrn.mjs")).toContain("fake");
  });

  it("bundle 旁存在 plugins/ 时一起打进 npm 包，且排除 test/ 与 node_modules/", () => {
    const bundle = join(dir, "nctrn.mjs");
    writeFileSync(bundle, "#!/usr/bin/env node\nconsole.log('fake');\n");
    writeFileSync(join(dir, "image-worker.mjs"), "console.log('worker');\n");
    mkdirSync(join(dir, "wasm"), { recursive: true });
    for (const [wasmFile] of IMAGE_WASM_FILES) {
      writeFileSync(join(dir, "wasm", wasmFile), "wasm");
    }
    const demoDir = join(dir, "plugins", "demo");
    mkdirSync(join(demoDir, ".nocturne-plugin"), { recursive: true });
    mkdirSync(join(demoDir, "test"), { recursive: true });
    mkdirSync(join(demoDir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(demoDir, ".nocturne-plugin", "plugin.json"), '{"name":"demo"}');
    writeFileSync(join(demoDir, ".nocturne-plugin", "build-id"), "0123456789abcdef");
    writeFileSync(join(demoDir, "server.mjs"), "export {};");
    writeFileSync(join(demoDir, "test", "a.test.mjs"), "test");
    writeFileSync(join(demoDir, "node_modules", "dep", "index.js"), "dep");

    const tgz = packNpm({ bundleFile: bundle, out: join(dir, "out") });
    const files = untar(tgz);
    expect(files.has("package/plugins/demo/.nocturne-plugin/plugin.json")).toBe(true);
    expect(files.get("package/plugins/demo/.nocturne-plugin/build-id")).toBe("0123456789abcdef");
    expect(files.has("package/plugins/demo/server.mjs")).toBe(true);
    expect(files.has("package/plugins/demo/test/a.test.mjs")).toBe(false);
    expect(files.has("package/plugins/demo/node_modules/dep/index.js")).toBe(false);
  });

  it("真实构建的内置插件 plugin-creator 随 npm 包一起打包", () => {
    const builtCreator = join(repoRoot, "plugins", "plugin-creator");
    if (!existsSync(join(builtCreator, "server.mjs"))) {
      execFileSync(process.execPath, [join(repoRoot, "plugins-src", "scripts", "build.mjs")], {
        cwd: join(repoRoot, "plugins-src"),
        stdio: "pipe",
      });
    }

    const bundle = join(dir, "nctrn.mjs");
    writeFileSync(bundle, "#!/usr/bin/env node\nconsole.log('fake');\n");
    writeFileSync(join(dir, "image-worker.mjs"), "console.log('worker');\n");
    mkdirSync(join(dir, "wasm"), { recursive: true });
    for (const [wasmFile] of IMAGE_WASM_FILES) {
      writeFileSync(join(dir, "wasm", wasmFile), "wasm");
    }
    cpSync(builtCreator, join(dir, "plugins", "plugin-creator"), { recursive: true });

    const tgz = packNpm({ bundleFile: bundle, out: join(dir, "out") });
    const files = untar(tgz);
    const expected = [
      "package/plugins/plugin-creator/.nocturne-plugin/plugin.json",
      "package/plugins/plugin-creator/.nocturne-plugin/build-id",
      "package/plugins/plugin-creator/icon.svg",
      "package/plugins/plugin-creator/server.mjs",
      "package/plugins/plugin-creator/skills/plugin-creator/SKILL.md",
      "package/plugins/plugin-creator/skills/plugin-creator/references/manifest-spec.md",
      "package/plugins/plugin-creator/skills/plugin-creator/references/hooks-and-mcp-examples.md",
      "package/plugins/plugin-creator/skills/plugin-creator/references/install-update-uninstall.md",
    ];
    for (const entry of expected) {
      expect(files.has(entry), entry).toBe(true);
    }
  });

  it("bundle 文件不存在时报错", () => {
    expect(() => packNpm({ bundleFile: join(dir, "none.mjs"), out: join(dir, "o") })).toThrow(
      "找不到单文件",
    );
  });
});
