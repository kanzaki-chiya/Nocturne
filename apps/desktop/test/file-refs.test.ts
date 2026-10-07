import { describe, expect, it } from "vitest";
import type { UserEntry } from "@nocturne/core/protocol";

import {
  completeFileRefs,
  fileRefDeleteRange,
  fileRefToken,
  fileRefTitle,
  userText,
  type FileIndexEntry,
} from "../src/file-refs";

const entry = (path: string, kind: FileIndexEntry["kind"] = "file"): FileIndexEntry => ({
  path,
  kind,
});

const INDEX: FileIndexEntry[] = [
  entry("src/main.ts"),
  entry("docs/main.md"),
  entry("src/map.ts"),
  entry("my file.txt"),
  entry("src/", "directory"),
  entry("src/sub.ts"),
];

const paths = (text: string, cursor: number) =>
  completeFileRefs(text, cursor, INDEX)?.candidates.map((row) => row.path);

describe("fileRefToken", () => {
  it("行首或空白后的 @ 片段才算引用", () => {
    expect(fileRefToken("@sr", 3)).toEqual({ start: 0, end: 3, query: "sr" });
    expect(fileRefToken("see @sr", 7)).toEqual({ start: 4, end: 7, query: "sr" });
    expect(fileRefToken("see @", 5)).toEqual({ start: 4, end: 5, query: "" });
    expect(fileRefToken("a@b", 3)).toBeUndefined();
    expect(fileRefToken("see @sr tail", 9)).toBeUndefined(); // 光标后还有词
    expect(fileRefToken("see @sr tail", 12)).toBeUndefined();
    expect(fileRefToken('看 @"my fi', 9)).toMatchObject({ query: "my fi" });
  });
});

describe("completeFileRefs", () => {
  it("名字前缀 > 名字包含 > 路径包含，同级更短优先", () => {
    expect(paths("@main", 5)).toEqual(["src/main.ts", "docs/main.md"]);
    expect(paths("@ma", 3)).toEqual(["src/map.ts", "src/main.ts", "docs/main.md"]);
    expect(paths("@src/", 5)).toEqual(["src/map.ts", "src/sub.ts", "src/main.ts"]);
    expect(paths("@none", 5)).toEqual([]);
    expect(paths("@", 1)).toHaveLength(INDEX.length);
    expect(completeFileRefs("a@b", 3, INDEX)).toBeUndefined();
  });

  it("文件插入带尾随空格；目录不带空格让列表继续展开；含空格路径加引号", () => {
    const completion = completeFileRefs("@", 1, INDEX);
    const file = completion?.candidates.find((row) => row.path === "src/main.ts");
    const dir = completion?.candidates.find((row) => row.path === "src/");
    const spaced = completion?.candidates.find((row) => row.path === "my file.txt");
    expect(file).toMatchObject({ insert: "@src/main.ts ", directory: false });
    expect(dir).toMatchObject({ insert: "@src/", directory: true });
    expect(spaced).toMatchObject({ insert: '@"my file.txt" ', directory: false });
  });
});

describe("fileRefDeleteRange（U-05 整删 @引用）", () => {
  const back = (text: string, cursor: number) => fileRefDeleteRange(text, cursor, "backward");
  const fwd = (text: string, cursor: number) => fileRefDeleteRange(text, cursor, "forward");
  // "check @src/a.ts tail": @ 在 6，token 结束 15，空格 15，tail 16
  const text = "check @src/a.ts tail";

  it("Backspace：光标在引用后或分隔空格后，整删并连吞一个空格", () => {
    expect(back(text, 15)).toEqual({ start: 6, end: 16 }); // @src/a.ts|
    expect(back(text, 16)).toEqual({ start: 6, end: 16 }); // @src/a.ts |
  });

  it("Backspace：词中、未终止裸词、非边界 @ 均不整删", () => {
    expect(back(text, 14)).toBeUndefined(); // 词中 @src/a.t|s
    expect(back("check @src/a.ts", 15)).toBeUndefined(); // 行尾裸词＝可能在键入
    expect(back("check @fo", 9)).toBeUndefined(); // 正在键入的补全词
    expect(back("a@b c", 4)).toBeUndefined(); // @ 前不是空白
    expect(back("check @src/a.ts  x", 17)).toBeUndefined(); // 两个空格＝用户键入的分隔
  });

  it("Backspace：引号形式须收尾引号；目录引用被空格终止也算完整", () => {
    const quoted = 'check @"my file.txt" x'; // @ 在 6，收尾引号在 19，空格 20
    expect(back(quoted, 20)).toEqual({ start: 6, end: 21 }); // @"…"|
    expect(back(quoted, 21)).toEqual({ start: 6, end: 21 }); // @"…" |
    expect(back('check @"my file.txt"', 20)).toEqual({ start: 6, end: 20 }); // 行尾收尾引号即完整
    expect(back('check @"my file.txt', 19)).toBeUndefined(); // 未收尾引号＝键入中
    expect(back(quoted, 19)).toBeUndefined(); // 光标在引号内
    expect(back("check @src/ x", 12)).toEqual({ start: 6, end: 12 }); // 目录+空格
  });

  it("Delete：光标在引用前整删；非边界或未完成引用不整删", () => {
    expect(fwd(text, 6)).toEqual({ start: 6, end: 16 });
    expect(fwd('check @"my file.txt"', 6)).toEqual({ start: 6, end: 20 });
    expect(fwd("check @src/a.ts", 6)).toBeUndefined(); // 行尾裸词
    expect(fwd("xa@b c", 1)).toBeUndefined(); // @ 前不是空白
    expect(fwd(text, 7)).toBeUndefined(); // 光标在词中不在 @ 上
  });
});

describe("userText", () => {
  const makeEntry = (content: UserEntry["content"], fileRefs?: UserEntry["fileRefs"]): UserEntry =>
    ({ kind: "user", content, fileRefs }) as UserEntry;

  it("去掉尾部与文件引用对应的快照块", () => {
    const entry = makeEntry(
      [
        { type: "text", text: "看 @a.ts" },
        { type: "text", text: "snapshot a" },
        { type: "text", text: "snapshot b" },
      ],
      [
        { path: "a.ts", kind: "file", chars: 10, truncated: false },
        { path: "b.txt", kind: "file", chars: 10, truncated: false },
      ],
    );
    expect(userText(entry)).toBe("看 @a.ts");
  });

  it("图片引用不吃尾部文本块；无 fileRefs 不截断", () => {
    const withImage = makeEntry(
      [
        { type: "text", text: "hi" },
        { type: "text", text: "keep me" },
      ],
      [{ path: "pic.png", kind: "image", chars: 1, truncated: false }],
    );
    expect(userText(withImage)).toBe("hikeep me");
    expect(userText(makeEntry([{ type: "text", text: "hi" }]))).toBe("hi");
  });
});

describe("fileRefTitle", () => {
  it("文件 / 截断 / 目录 / 图片的说明文案", () => {
    expect(
      fileRefTitle({
        path: "a",
        kind: "file",
        chars: 1,
        lines: 36,
        totalLines: 120,
        truncated: false,
      }),
    ).toBe("已附带 36/120 行");
    expect(fileRefTitle({ path: "a", kind: "file", chars: 1, truncated: true })).toBe(
      "已附带文件 · 已截断",
    );
    expect(fileRefTitle({ path: "d/", kind: "directory", chars: 1, truncated: false })).toBe(
      "目录",
    );
    expect(fileRefTitle({ path: "p.png", kind: "image", chars: 1, truncated: false })).toBe("图片");
  });
});
