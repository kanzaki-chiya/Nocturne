/**
 * 面板「文件」标签读取（ADR-0060 第 3 节）：session.readFile 只读工作区内的
 * 普通文件，拒绝 ..、越界绝对路径、链接逃逸与备用数据流；超过上限报错不截断。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlatform } from "../src/platform/index.js";
import { loadConfig } from "../src/config/index.js";
import { createRuntime, READ_FILE_MAX_BYTES, type RuntimeSession } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let root: string;
let ws: string;
let session: RuntimeSession;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "nct-readfile-"));
  const home = path.join(root, "home");
  ws = path.join(root, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(path.join(root, "outside"), { recursive: true });
  writeFileSync(path.join(ws, "src", "a.ts"), "const x = 1;\n中文\n");
  writeFileSync(path.join(ws, "logo.png"), PNG);
  writeFileSync(path.join(ws, "blob.bin"), Uint8Array.from([1, 0, 2, 0, 3]));
  writeFileSync(path.join(root, "outside", "secret.txt"), "secret");
  const platform = createPlatform();
  const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
  const runtime = await createRuntime({
    cwd: ws,
    providers: [new FakeProvider({})],
    interactive: false,
    config,
  });
  session = await runtime.createSession({ model: "fake/fake-1" });
});

afterEach(async () => {
  await session.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("session.readFile", () => {
  it("相对路径与工作区内的绝对路径读出文本", async () => {
    const file = await session.readFile("src/a.ts");
    expect(file).toMatchObject({ kind: "text", text: "const x = 1;\n中文\n" });
    expect(file.relativePath).toBe(path.join("src", "a.ts"));
    const absolute = await session.readFile(path.join(ws, "src", "a.ts"));
    expect(absolute.kind).toBe("text");
  });

  it("图片按扩展名返回字节与 mimeType", async () => {
    const file = await session.readFile("logo.png");
    expect(file.kind).toBe("image");
    if (file.kind !== "image") return;
    expect(file.mimeType).toBe("image/png");
    expect(Array.from(file.data)).toEqual(Array.from(PNG));
  });

  it("超过上限报 file_too_large，不截断", async () => {
    writeFileSync(path.join(ws, "big.txt"), "a".repeat(READ_FILE_MAX_BYTES + 1));
    await expect(session.readFile("big.txt")).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("二进制、目录、不存在的文件各有错误码", async () => {
    await expect(session.readFile("blob.bin")).rejects.toMatchObject({ code: "file_binary" });
    await expect(session.readFile("src")).rejects.toMatchObject({ code: "file_not_regular" });
    await expect(session.readFile("src/missing.ts")).rejects.toMatchObject({
      code: "file_not_found",
    });
  });

  it("拒绝 .. 与越界绝对路径", async () => {
    await expect(session.readFile("../outside/secret.txt")).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(session.readFile("src/../src/a.ts")).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(session.readFile(path.join(root, "outside", "secret.txt"))).rejects.toMatchObject({
      code: "file_outside_workspace",
    });
  });

  it("链接或 junction 指向工作区外时拒绝", async () => {
    // Windows 上 junction 不需要管理员权限；其他平台用目录符号链接
    symlinkSync(path.join(root, "outside"), path.join(ws, "escape"), "junction");
    await expect(session.readFile("escape/secret.txt")).rejects.toMatchObject({
      code: "file_outside_workspace",
    });
  });

  it.runIf(process.platform === "win32")("拒绝 Windows 备用数据流", async () => {
    await expect(session.readFile("src/a.ts:hidden")).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(session.readFile(`${path.join(ws, "src", "a.ts")}::$DATA`)).rejects.toMatchObject({
      code: "invalid_file_path",
    });
  });
});
