import { describe, expect, it } from "vitest";
import { userEntryText, type UserEntry } from "../src/protocol/view.js";

const base: UserEntry = { kind: "user", key: "u:1", seq: 1, turnId: "t", content: [] };
const text = (value: string) => ({ type: "text" as const, text: value });
const fileRef = {
  path: "a.ts",
  kind: "file" as const,
  chars: 10,
  lines: 1,
  totalLines: 1,
  truncated: false,
};

describe("userEntryText", () => {
  it("无快照时拼接全部 text 块", () => {
    expect(userEntryText({ ...base, content: [text("hi"), text(" there")] })).toBe("hi there");
  });

  it("只有文件引用时切掉非图片引用的快照块，图片引用不算快照", () => {
    expect(
      userEntryText({
        ...base,
        content: [text("看 @a.ts @p.png"), text("a.ts 快照")],
        fileRefs: [fileRef, { path: "p.png", kind: "image", chars: 0, truncated: false }],
      }),
    ).toBe("看 @a.ts @p.png");
  });

  it("只有技能时切掉技能正文块", () => {
    expect(
      userEntryText({
        ...base,
        content: [text("/alpha file"), text('<skill name="alpha">正文</skill>')],
        skill: { name: "alpha", body: "正文" },
      }),
    ).toBe("/alpha file");
  });

  it("只有委派时切掉委派指令块", () => {
    expect(
      userEntryText({
        ...base,
        content: [text("/claude2 总结"), text("委派指令")],
        delegate: { agent: "claude2", task: "总结" },
      }),
    ).toBe("/claude2 总结");
  });

  it("文件引用和委派同时存在时两类快照都切掉", () => {
    expect(
      userEntryText({
        ...base,
        content: [text("/claude2 看 @a.ts"), text("a.ts 快照"), text("委派指令")],
        fileRefs: [fileRef],
        delegate: { agent: "claude2", task: "看 @a.ts" },
      }),
    ).toBe("/claude2 看 @a.ts");
  });
});
