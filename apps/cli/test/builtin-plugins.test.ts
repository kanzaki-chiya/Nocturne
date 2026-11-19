import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
import { resolveBuiltinPluginsDir } from "../src/builtin-plugins.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  await removeTempDirs(tmpRoots.splice(0));
});

function makeTempDir(prefix = "nct-cli-plugins-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

describe("resolveBuiltinPluginsDir", () => {
  it("优先查找入口文件所在目录下的 plugins/", () => {
    const root = makeTempDir();
    const bundleEntry = path.join(root, "nctrn.mjs");
    const pluginsDir = path.join(root, "plugins");
    writeFileSync(bundleEntry, "");
    mkdirSync(pluginsDir, { recursive: true });

    expect(
      resolveBuiltinPluginsDir({
        entryPath: bundleEntry,
        fromUrl: pathToFileURL(bundleEntry).href,
      }),
    ).toBe(pluginsDir);
  });

  it("开发环境从 apps/cli/dist 或 apps/cli/src 运行时回落到仓库根 plugins/", () => {
    const fakeRepo = makeTempDir("nct-fake-repo-");
    const cliDist = path.join(fakeRepo, "apps", "cli", "dist");
    const cliPkg = path.join(fakeRepo, "apps", "cli", "package.json");
    const pluginsDir = path.join(fakeRepo, "plugins");
    mkdirSync(cliDist, { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(path.join(fakeRepo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    writeFileSync(cliPkg, '{"name":"@nocturne/cli"}');
    const distMain = path.join(cliDist, "main.js");
    writeFileSync(distMain, "");

    expect(
      resolveBuiltinPluginsDir({
        entryPath: distMain,
        fromUrl: pathToFileURL(distMain).href,
      }),
    ).toBe(pluginsDir);
  });

  it("入口旁和开发回落都没有 plugins/ 时返回 undefined", () => {
    const isolated = makeTempDir("nct-no-plugins-");
    const entry = path.join(isolated, "nctrn.mjs");
    writeFileSync(entry, "");

    expect(
      resolveBuiltinPluginsDir({
        entryPath: entry,
        fromUrl: pathToFileURL(entry).href,
      }),
    ).toBeUndefined();
  });
});
