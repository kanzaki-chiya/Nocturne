import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packNpm } from "../pack-npm.mjs";

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
    const out = join(dir, "out");

    const tgz = packNpm({ bundleFile: bundle, out });
    expect(existsSync(tgz)).toBe(true);
    expect(tgz).toMatch(/nctrn-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/);

    const files = untar(tgz);
    const entries = ["package.json", "README.md", "nctrn.mjs", "LICENSE", "THIRD-PARTY-NOTICES.md"];
    for (const name of entries) {
      expect(files.has(`package/${name}`), name).toBe(true);
    }
    const manifest = JSON.parse(files.get("package/package.json"));
    expect(manifest.name).toBe("nctrn");
    expect(manifest.bin).toEqual({ nctrn: "nctrn.mjs" });
    expect(manifest.engines.node).toBe(">=24.14");
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("scripts");
    // 单文件内容原样进入包
    expect(files.get("package/nctrn.mjs")).toContain("fake");
  });

  it("bundle 文件不存在时报错", () => {
    expect(() => packNpm({ bundleFile: join(dir, "none.mjs"), out: join(dir, "o") })).toThrow(
      "找不到单文件",
    );
  });
});
