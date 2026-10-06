import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyVersion,
  checkVersion,
  collectVersions,
  isValidVersion,
} from "../release-version.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

/** 建一个只含版本号位置的假仓库根目录 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "nctrn-ver-"));
  const jsonFiles = [
    "package.json",
    "packages/core/package.json",
    "packages/rpc/package.json",
    "packages/mcp/package.json",
    "apps/cli/package.json",
    "apps/tui/package.json",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
    "packaging/npm/package.json",
  ];
  for (const rel of jsonFiles) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `{\n  "name": "x",\n  "version": "0.5.0"\n}\n`);
  }
  const cargoDir = join(root, "apps/desktop/src-tauri");
  writeFileSync(
    join(cargoDir, "Cargo.toml"),
    [
      "[package]",
      'name = "nocturne-desktop"',
      'version = "0.5.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'serde = { version = "1" }',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cargoDir, "Cargo.lock"),
    [
      "version = 4",
      "",
      "[[package]]",
      'name = "nocturne-desktop"',
      'version = "0.5.0"',
      "dependencies = [",
      ' "serde",',
      "]",
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.0"',
      "",
    ].join("\n"),
  );
  return root;
}

let root;
beforeEach(() => {
  root = makeFixture();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("release-version", () => {
  it("一次改齐所有版本位置", () => {
    applyVersion(root, "0.6.0");
    const versions = collectVersions(root);
    for (const [file, v] of Object.entries(versions)) {
      expect(v, file).toBe("0.6.0");
    }
  });

  it("接受预发布号 0.6.0-rc.1", () => {
    applyVersion(root, "0.6.0-rc.1");
    expect(collectVersions(root)["package.json"]).toBe("0.6.0-rc.1");
    const lock = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8");
    expect(lock).toContain('name = "nocturne-desktop"\nversion = "0.6.0-rc.1"');
    expect(lock).toContain('name = "serde"\nversion = "1.0.0"');
  });

  it("Cargo.toml 只改 [package] 节，不动依赖的 version", () => {
    applyVersion(root, "0.6.0");
    const toml = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
    expect(toml).toContain('version = "0.6.0"');
    expect(toml).toContain('serde = { version = "1" }');
  });

  it("--check 全部一致时通过", () => {
    applyVersion(root, "0.6.0");
    expect(checkVersion(root, "0.6.0").ok).toBe(true);
  });

  it("--check 有一处不一致即失败", () => {
    applyVersion(root, "0.6.0");
    const file = join(root, "packages/core/package.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"0.6.0"', '"0.5.0"'));
    const result = checkVersion(root, "0.6.0");
    expect(result.ok).toBe(false);
    expect(result.versions["packages/core/package.json"]).toBe("0.5.0");
  });

  it("拒绝非法版本号", () => {
    expect(isValidVersion("0.6.0-rc.1")).toBe(true);
    expect(isValidVersion("v0.6.0")).toBe(false);
    expect(isValidVersion("0.6")).toBe(false);
    expect(() => applyVersion(root, "abc")).toThrow("非法版本号");
  });

  it("真实仓库当前所有版本号一致", () => {
    const versions = collectVersions(repoRoot);
    const unique = new Set(Object.values(versions));
    expect([...unique]).toHaveLength(1);
  });
});
