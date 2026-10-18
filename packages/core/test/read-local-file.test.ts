/**
 * 面板「文件」标签读取（ADR-0060 第 3 节及 2026-10-18 修订）：runtime.readFile 只收绝对
 * 路径、不依赖会话、不限工作区；拒绝 ..、备用数据流、网络路径与链接到网络位置的路径；
 * 超过上限报错不截断。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlatform, type FileSystem, type FileStat } from "../src/platform/index.js";
import { loadConfig } from "../src/config/index.js";
import { createRuntime, READ_FILE_MAX_BYTES, type Runtime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { isNetworkPath, readLocalFile } from "../src/session/local-file.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const windows = process.platform === "win32";

let root: string;
let ws: string;
let runtime: Runtime;

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
  writeFileSync(path.join(root, "outside", "report.md"), "# 报告\n");
  const platform = createPlatform();
  const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
  runtime = await createRuntime({
    cwd: ws,
    providers: [new FakeProvider({})],
    interactive: false,
    config,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("runtime.readFile", () => {
  it("不打开会话也能读绝对路径的文本", async () => {
    const file = await runtime.readFile(path.join(ws, "src", "a.ts"));
    expect(file).toMatchObject({ kind: "text", text: "const x = 1;\n中文\n" });
    expect(file.absolutePath.toLowerCase()).toBe(path.join(ws, "src", "a.ts").toLowerCase());
  });

  it("工作区外的普通文件可读", async () => {
    const file = await runtime.readFile(path.join(root, "outside", "report.md"));
    expect(file).toMatchObject({ kind: "text", text: "# 报告\n" });
  });

  it("相对路径拒绝", async () => {
    await expect(runtime.readFile("src/a.ts")).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(runtime.readFile("")).rejects.toMatchObject({ code: "invalid_file_path" });
  });

  it("图片按扩展名返回字节与 mimeType", async () => {
    const file = await runtime.readFile(path.join(ws, "logo.png"));
    expect(file.kind).toBe("image");
    if (file.kind !== "image") return;
    expect(file.mimeType).toBe("image/png");
    expect(Array.from(file.data)).toEqual(Array.from(PNG));
  });

  it("超过上限报 file_too_large，不截断", async () => {
    writeFileSync(path.join(ws, "big.txt"), "a".repeat(READ_FILE_MAX_BYTES + 1));
    await expect(runtime.readFile(path.join(ws, "big.txt"))).rejects.toMatchObject({
      code: "file_too_large",
    });
  });

  it("二进制、目录、不存在的文件各有错误码", async () => {
    await expect(runtime.readFile(path.join(ws, "blob.bin"))).rejects.toMatchObject({
      code: "file_binary",
    });
    await expect(runtime.readFile(path.join(ws, "src"))).rejects.toMatchObject({
      code: "file_not_regular",
    });
    await expect(runtime.readFile(path.join(ws, "src", "missing.ts"))).rejects.toMatchObject({
      code: "file_not_found",
    });
  });

  it("拒绝 .. 段", async () => {
    await expect(
      runtime.readFile(`${path.join(ws, "src")}${path.sep}..${path.sep}logo.png`),
    ).rejects.toMatchObject({ code: "invalid_file_path" });
  });

  it("链接到本机其他位置的照常读出真实路径", async () => {
    symlinkSync(path.join(root, "outside"), path.join(ws, "linked"), "junction");
    const file = await runtime.readFile(path.join(ws, "linked", "report.md"));
    expect(file.kind).toBe("text");
    expect(file.absolutePath.toLowerCase()).toBe(
      path.join(root, "outside", "report.md").toLowerCase(),
    );
  });

  it.runIf(windows)("拒绝 Windows 备用数据流与设备名", async () => {
    const file = path.join(ws, "src", "a.ts");
    await expect(runtime.readFile(`${file}:hidden`)).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(runtime.readFile(`${file}::$DATA`)).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(runtime.readFile(path.join(ws, "nul"))).rejects.toMatchObject({
      code: "invalid_file_path",
    });
    await expect(runtime.readFile("\\\\.\\C:\\x.txt")).rejects.toMatchObject({
      code: "invalid_file_path",
    });
  });

  it.runIf(windows)("本地扩展前缀 \\\\?\\C:\\ 可读", async () => {
    const file = await runtime.readFile(`\\\\?\\${path.join(ws, "src", "a.ts")}`);
    expect(file.kind).toBe("text");
  });

  it.runIf(windows)("UNC 路径直接拒绝", async () => {
    for (const unc of [
      "\\\\127.0.0.1\\c$\\Windows\\win.ini",
      "//127.0.0.1/c$/Windows/win.ini",
      "\\\\?\\UNC\\127.0.0.1\\c$\\Windows\\win.ini",
      "\\??\\UNC\\127.0.0.1\\c$\\Windows\\win.ini",
    ]) {
      await expect(runtime.readFile(unc), unc).rejects.toMatchObject({
        code: "file_network_path",
      });
    }
  });

  it.runIf(windows)("指向 UNC 的 junction 拒绝，且不访问网络", async () => {
    // Node 能写出指向 \??\UNC\ 的 junction（mklink /J 不允许），但 lstat 读不了它：
    // 逐级解析在这一级就停下，按不存在拒绝，不会去打开目标
    symlinkSync("\\\\127.0.0.1\\nosuchshare\\dir", path.join(ws, "net"), "junction");
    await expect(runtime.readFile(path.join(ws, "net", "a.txt"))).rejects.toMatchObject({
      code: expect.stringMatching(/^file_(network_path|not_found)$/) as unknown as string,
    });
  });
});

describe("readLocalFile 的链接解析", () => {
  const platform = createPlatform();

  /** 只有一个链接的假文件系统：其余路径都是目录，stat/readFile 不该被调用 */
  function fakeFs(link: string, target: string): FileSystem {
    const directory: FileStat = { type: "directory", size: 0, mtimeMs: 0 };
    const fail = () => Promise.reject(new Error("不该访问链接目标"));
    return {
      ...platform.fs,
      lstat: (p) =>
        Promise.resolve(
          p.toLowerCase() === link.toLowerCase()
            ? { type: "symlink", size: 0, mtimeMs: 0 }
            : directory,
        ),
      readlink: () => Promise.resolve(target),
      stat: fail,
      readFile: fail,
      realpath: fail,
    };
  }

  it.runIf(windows)("链接目标是 UNC 时拒绝，不 stat 也不读", async () => {
    for (const target of [
      "\\\\server\\share\\dir",
      "\\\\?\\UNC\\server\\share\\dir",
      "\\??\\UNC\\server\\share\\dir",
    ]) {
      const fs = fakeFs("C:\\work\\net", target);
      await expect(
        readLocalFile(fs, platform.paths, "C:\\work\\net\\report.md"),
        target,
      ).rejects.toMatchObject({ code: "file_network_path" });
    }
  });

  it("isNetworkPath 只按词法判断", () => {
    expect(isNetworkPath("\\\\server\\share")).toBe(true);
    expect(isNetworkPath("//server/share")).toBe(true);
    expect(isNetworkPath("\\\\?\\UNC\\server\\share")).toBe(true);
    expect(isNetworkPath("\\\\?\\C:\\x")).toBe(false);
    expect(isNetworkPath("C:\\x")).toBe(false);
    expect(isNetworkPath("/home/x")).toBe(false);
  });
});
