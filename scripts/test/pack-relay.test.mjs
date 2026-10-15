import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";

import { packRelay, relayManifest } from "../pack-relay.mjs";

function untar(file) {
  const bytes = gunzipSync(readFileSync(file));
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const name = bytes
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString("utf8"), 8);
    offset += 512;
    files.set(name, bytes.subarray(offset, offset + size).toString("utf8"));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

let dir, distDir, webDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-pack-test-"));
  distDir = join(dir, "dist");
  webDir = join(dir, "web");
  mkdirSync(distDir);
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "main.mjs"), "console.log('relay');");
  writeFileSync(join(distDir, "main.mjs.map"), "map");
  writeFileSync(join(webDir, "index.html"), "<title>Nocturne</title>");
  writeFileSync(join(webDir, "manifest.webmanifest"), "{}");
  writeFileSync(join(webDir, "sw.js"), "// worker");
  writeFileSync(join(webDir, "assets", "app.js"), "// asset");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("打包 relay 构建全目录和手机网页，清除 workspace 依赖", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../apps/relay/package.json", import.meta.url)));
  const manifest = relayManifest(pkg);
  expect(manifest).toMatchObject({
    name: "nocturne-relay",
    version: pkg.version,
    private: true,
    bin: pkg.bin,
    type: pkg.type,
    engines: pkg.engines,
    license: pkg.license,
    dependencies: { ws: pkg.dependencies.ws },
  });
  expect(JSON.stringify(manifest)).not.toContain("workspace:");
  expect(manifest.files).toEqual([...pkg.files, "THIRD-PARTY-NOTICES.md"]);
  expect(manifest.dependencies).toEqual({ ws: pkg.dependencies.ws });
  const tgz = packRelay({ out: join(dir, "out"), distDir, webDir });
  expect(existsSync(tgz)).toBe(true);
  expect(tgz).toContain(`nocturne-relay-${pkg.version}.tgz`);
  const files = untar(tgz);
  for (const name of [
    "dist/main.mjs",
    "dist/main.mjs.map",
    "public/index.html",
    "public/manifest.webmanifest",
    "public/sw.js",
    "public/assets/app.js",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
  ]) {
    expect(files.has(`package/${name}`), name).toBe(true);
  }
  expect(files.get("package/dist/main.mjs.map")).toBe("map");
  expect(JSON.parse(files.get("package/package.json"))).toEqual(manifest);
});

it.each(["index.html", "manifest.webmanifest", "sw.js"])("缺少 %s 时提示构建并给出路径", (name) => {
  rmSync(join(webDir, name));
  expect(() => packRelay({ out: join(dir, "out"), distDir, webDir })).toThrow(join(webDir, name));
  expect(() => packRelay({ out: join(dir, "out"), distDir, webDir })).toThrow("先运行 pnpm build");
});

it("缺 relay 主入口提示先构建", () => {
  rmSync(join(distDir, "main.mjs"));
  expect(() => packRelay({ distDir, webDir, out: join(dir, "out") })).toThrow("先运行 pnpm build");
});
