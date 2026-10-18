/**
 * 回答内文件引用（U-09）：splitCodeRef 拆分行号、session.resolveFiles
 * 按工作区解析存在性。只读，不产生事件。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatform } from "../src/platform/index.js";
import { loadConfig } from "../src/config/index.js";
import { createRuntime, splitCodeRef } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("splitCodeRef", () => {
  it("路径、行号、行范围拆分；盘符冒号不受影响", () => {
    expect(splitCodeRef("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(splitCodeRef("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(splitCodeRef("src/a.ts:12-20")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(splitCodeRef("C:\\a\\b.ts:3")).toEqual({ path: "C:\\a\\b.ts", line: 3 });
    expect(splitCodeRef("a:b/c")).toEqual({ path: "a:b/c" });
  });
  it("空、换行、行范围倒置时不是引用", () => {
    expect(splitCodeRef("")).toBeUndefined();
    expect(splitCodeRef("  ")).toBeUndefined();
    expect(splitCodeRef("a.ts\nb.ts")).toBeUndefined();
    expect(splitCodeRef("a.ts:20-12")).toEqual({ path: "a.ts:20-12" });
  });
});

describe("session.resolveFiles", () => {
  it("存在与不存在两种渲染依据；工作区外路径标记越界", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-resolve-"));
    roots.push(root);
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(ws, "src"), { recursive: true });
    writeFileSync(path.join(ws, "src", "a.ts"), "const x = 1;");
    const platform = createPlatform();
    const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
    const runtime = await createRuntime({
      cwd: ws,
      providers: [new FakeProvider({})],
      interactive: false,
      config,
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    try {
      const [hit, miss, outside] = await session.resolveFiles([
        "src/a.ts",
        "src/missing.ts",
        path.join(root, "elsewhere.ts"),
      ]);
      expect(hit).toMatchObject({ withinWorkspace: true, exists: true, isDirectory: false });
      expect(path.normalize(hit?.absolutePath ?? "")).toBe(
        // 工作区根取 realpath：Git Bash 下 TEMP 是 8.3 短路径（ADMINI~1）
        path.normalize(path.join(realpathSync.native(ws), "src", "a.ts")),
      );
      expect(hit?.relativePath).toBe(path.join("src", "a.ts"));
      expect(miss).toMatchObject({ withinWorkspace: true, exists: false });
      expect(outside?.withinWorkspace).toBe(false);
      expect(outside?.relativePath).toBeUndefined();
      expect(outside?.exists).toBe(false);
    } finally {
      await session.close();
    }
  });

  it.runIf(process.platform === "win32")(
    "网络路径与指向 UNC 的 junction 按不存在返回，不访问网络（ADR-0060 修订）",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nct-resolve-unc-"));
      roots.push(root);
      const home = path.join(root, "home");
      const ws = path.join(root, "ws");
      mkdirSync(home, { recursive: true });
      mkdirSync(ws, { recursive: true });
      symlinkSync("\\\\127.0.0.1\\nosuchshare\\dir", path.join(ws, "net"), "junction");
      const platform = createPlatform();
      const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
      const runtime = await createRuntime({
        cwd: ws,
        providers: [new FakeProvider({})],
        interactive: false,
        config,
      });
      const session = await runtime.createSession({ model: "fake/fake-1" });
      const stat = vi.spyOn(fsPromises, "stat");
      const lstat = vi.spyOn(fsPromises, "lstat");
      try {
        const results = await session.resolveFiles([
          "\\\\127.0.0.1\\c$\\Windows\\win.ini",
          "//127.0.0.1/c$/Windows/win.ini",
          "\\\\?\\UNC\\127.0.0.1\\c$\\Windows\\win.ini",
          "net/a.txt",
        ]);
        for (const result of results) expect(result, result.input).toMatchObject({ exists: false });
        const touched = [...stat.mock.calls, ...lstat.mock.calls].map((call) => String(call[0]));
        // 只允许本地路径被 stat / lstat：\\ 或 // 开头（网络）的都不该出现
        expect(touched.filter((p) => p.startsWith("\\\\") || p.startsWith("//"))).toEqual([]);
      } finally {
        stat.mockRestore();
        lstat.mockRestore();
        await session.close();
      }
    },
  );
});
