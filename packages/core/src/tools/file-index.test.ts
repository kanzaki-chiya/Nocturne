import { describe, expect, it, vi } from "vitest";
import { createPlatform } from "../platform/index.js";
import { GitignoreChain } from "./builtin/gitignore.js";
import { buildFileIndex, completeFileRefs, type FileIndexEntry } from "./file-index.js";

const index: FileIndexEntry[] = [
  { path: "src/", kind: "directory" },
  { path: "src/main.ts", kind: "file" },
  { path: "src/deep/", kind: "directory" },
  { path: "src/deep/main.ts", kind: "file" },
  { path: "main.ts", kind: "file" },
  { path: "domain.ts", kind: "file" },
  { path: "main/other.ts", kind: "file" },
  { path: "my notes.md", kind: "file" },
  { path: "my docs/", kind: "directory" },
];

describe("文件补全", () => {
  it("匹配档位优先，档内短路径优先，忽略大小写", () => {
    expect(completeFileRefs("看看 @MAIN", 8, index)?.candidates.map((c) => c.path)).toEqual([
      "main.ts",
      "src/main.ts",
      "src/deep/main.ts",
      "domain.ts",
      "main/other.ts",
    ]);
  });
  it("目录选中保持引用打开，仅列直接下一级", () => {
    expect(completeFileRefs("@sr", 3, index)?.candidates[0]?.insert).toBe("@src/");
    expect(completeFileRefs("@src/", 5, index)?.candidates.map((c) => c.path)).toEqual([
      "src/deep/",
      "src/main.ts",
    ]);
    expect(completeFileRefs("@src/deep/", 10, index)?.candidates.map((c) => c.path)).toEqual([
      "src/deep/main.ts",
    ]);
  });
  it("空格路径加引号，目录保留开引号", () => {
    const matches = completeFileRefs('@"my ', 5, index)?.candidates;
    expect(matches?.map((c) => c.insert)).toEqual(['@"my docs/', '@"my notes.md" ']);
  });
  it("替换光标所在完整词，保留后文和已闭合引号后的词", () => {
    expect(completeFileRefs("看 @src/ma.ts 后文", 9, index)).toMatchObject({ start: 2, end: 12 });
    expect(completeFileRefs('@"my notes.md" 后文', 14, index)).toMatchObject({ start: 0, end: 14 });
    expect(completeFileRefs("user@example.com", 16, index)).toBeUndefined();
    expect(completeFileRefs("@main.ts ", 9, index)).toBeUndefined();
  });
});

describe("工作区索引", () => {
  it("缺少 .gitignore 的子目录 pop 不移除父层", () => {
    const chain = new GitignoreChain();
    chain.push("", "*.log");
    chain.push("child", undefined);
    chain.push("child/deep", undefined);
    chain.pop();
    chain.pop();
    expect(chain.ignores("sibling/output.log", false)).toBe(true);
    chain.pop();
    expect(chain.ignores("output.log", false)).toBe(false);
  });
  it("复用层级忽略，跳过隐藏文件与链接，不读取文件 stat", async () => {
    const { fs, paths } = createPlatform();
    const root = paths.resolve(".", "index-fixture");
    const entry = (name: string, type: "file" | "directory" | "symlink", parent = root) => ({
      name,
      type,
      path: paths.join(parent, name),
    });
    vi.spyOn(fs, "readTextFile").mockImplementation(async (p) => {
      if (p === paths.join(root, ".gitignore")) return "*.log\nignored/";
      throw new Error("ENOENT");
    });
    const read = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (p) =>
        p === root
          ? [
              entry("a", "directory"),
              entry("later.log", "file"),
              entry("ignored", "directory"),
              entry(".hidden", "file"),
              entry("link", "symlink"),
              entry("ok.ts", "file"),
            ]
          : [entry("inside.ts", "file", p), entry("inside.log", "file", p)],
      );
    const stat = vi.spyOn(fs, "lstat");
    expect(await buildFileIndex(fs, paths, root)).toEqual([
      { path: "a/", kind: "directory" },
      { path: "a/inside.ts", kind: "file" },
      { path: "ok.ts", kind: "file" },
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(stat).not.toHaveBeenCalled();
  });
  it("目录与文件共同计入 20000 上限，满额后不再递归", async () => {
    const { fs, paths } = createPlatform();
    const root = paths.resolve(".", "large-index");
    vi.spyOn(fs, "readTextFile").mockRejectedValue(new Error("ENOENT"));
    const read = vi
      .spyOn(fs, "readdir")
      .mockResolvedValue(
        Array.from({ length: 20_010 }, (_, i) => ({
          name: `${i}`,
          path: paths.join(root, `${i}`),
          type: i === 19_999 ? ("directory" as const) : ("file" as const),
        })),
      );
    const result = await buildFileIndex(fs, paths, root);
    expect(result).toHaveLength(20_000);
    expect(result.at(-1)).toEqual({ path: "19999/", kind: "directory" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
