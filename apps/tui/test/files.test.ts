import { describe, expect, it } from "vitest";
import { createFileStore, fileTokenAt, fileTokenBefore, LARGE_PASTE_BYTES } from "../src/files.js";

describe("TUI 文件占位", () => {
  it("按 UTF-8 字节阈值转附件，历史回填还原原文", () => {
    const files = createFileStore();
    expect(files.addPaste("中".repeat(10_922))).toBeUndefined();
    const original = "中".repeat(10_923);
    expect(Buffer.byteLength(original)).toBeGreaterThanOrEqual(LARGE_PASTE_BYTES);
    const token = files.addPaste(original);
    expect(token).toBeDefined();
    if (token === undefined) throw new Error("missing token");
    expect(token).toBe("[File #1 pasted-1.txt 33 KB]");
    expect(files.in(`前${token}后`)).toMatchObject([
      { label: "pasted-1.txt", mimeType: "text/plain", source: "paste" },
    ]);
    expect(files.expandPaste(`前${token}后`)).toBe(`前${original}后`);
    expect(fileTokenBefore(`前${token}`)).toBe(token.length);
    expect(fileTokenAt(`${token}后`)).toBe(token.length);
    files.prune("");
    expect(files.in(token)).toEqual([]);
  });

  it("剪贴板文件只在当前草稿引用时保留，不写入历史", () => {
    const files = createFileStore();
    const token = files.add({
      data: Buffer.from("log"),
      mimeType: "text/plain",
      label: "a.log",
      source: "upload",
    });
    expect(files.expandPaste(token)).toBe(token);
    expect(files.strip(`看 ${token}`)).toBe("看");
    files.prune("无占位");
    expect(files.in(token)).toEqual([]);
  });
});
