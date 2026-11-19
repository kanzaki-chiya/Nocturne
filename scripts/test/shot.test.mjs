import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertSafeHomeDir,
  defaultDebugExePath,
  isLocalPortFree,
  parsePngDimensions,
  parseShotArgs,
  parseSize,
} from "../shot.mjs";

function makeFakePngHeader(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("shot helpers", () => {
  it("assertSafeHomeDir 拒绝真实 ~/.nocturne 及其子目录，放行隔离目录", () => {
    const fakeUserHome = resolve("Z:/fake-user-home");
    const realNocturne = join(fakeUserHome, ".nocturne");
    expect(() => assertSafeHomeDir(realNocturne, fakeUserHome)).toThrow(/禁止将 --home/);
    expect(() => assertSafeHomeDir(join(realNocturne, "sub"), fakeUserHome)).toThrow(
      /禁止将 --home/,
    );
    expect(() => assertSafeHomeDir("", fakeUserHome)).toThrow(/必须指定 --home/);

    const safe = assertSafeHomeDir(resolve("Z:/tmp/isolated-nocturne"), fakeUserHome);
    expect(safe).toBe(resolve("Z:/tmp/isolated-nocturne"));
  });

  it("parseSize 解析宽x高并校验范围", () => {
    expect(parseSize("1440x900")).toEqual({ width: 1440, height: 900 });
    expect(parseSize("1280×720")).toEqual({ width: 1280, height: 720 });
    expect(() => parseSize("abc")).toThrow(/无效的 --size/);
    expect(() => parseSize("10x10")).toThrow(/超出合理范围/);
  });

  it("parsePngDimensions 正确解析 PNG 宽高并拒绝非法数据", () => {
    expect(parsePngDimensions(makeFakePngHeader(1440, 900))).toEqual({ width: 1440, height: 900 });
    expect(() => parsePngDimensions(Buffer.from("not a png"))).toThrow(/有效的 PNG/);
    expect(() => parsePngDimensions(makeFakePngHeader(0, 900))).toThrow(/尺寸无效/);
  });

  it("parseShotArgs 与 defaultDebugExePath 正确处理 CARGO_TARGET_DIR 与各选项", () => {
    const withTarget = defaultDebugExePath("Z:/repo", { CARGO_TARGET_DIR: "Z:/cargo-out" });
    expect(withTarget).toBe(join("Z:/cargo-out", "debug", "nocturne-desktop.exe"));

    const withoutTarget = defaultDebugExePath("Z:/repo", {});
    expect(withoutTarget).toBe(
      join("Z:/repo", "apps", "desktop", "src-tauri", "target", "debug", "nocturne-desktop.exe"),
    );

    const parsed = parseShotArgs(
      [
        "--home",
        "Z:/tmp/home",
        "--fixture",
        "Z:/tmp/fix",
        "--port",
        "19334",
        "--size",
        "1280x800",
        "--theme",
        "dark",
        "--steps",
        "Z:/tmp/steps.mjs",
        "--exe",
        "Z:/tmp/app.exe",
      ],
      {},
    );
    expect(parsed).toMatchObject({
      home: "Z:/tmp/home",
      fixture: "Z:/tmp/fix",
      port: 19334,
      size: { width: 1280, height: 800 },
      theme: "dark",
      steps: "Z:/tmp/steps.mjs",
      exe: "Z:/tmp/app.exe",
    });

    expect(() => parseShotArgs(["--theme", "sepia"], {})).toThrow(/只支持 light 或 dark/);
    expect(() => parseShotArgs(["--port", "99999"], {})).toThrow(/超出范围/);
  });

  it("isLocalPortFree 能检出已占用端口并在释放后返回空闲", async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      expect(await isLocalPortFree(port)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await isLocalPortFree(port)).toBe(true);
  });
});
