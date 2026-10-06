import { describe, expect, it } from "vitest";

import { extractNotes } from "../release-notes.mjs";

const CHANGELOG = [
  "# 更新日志",
  "",
  "## 未发布",
  "",
  "- 某条未发布说明",
  "",
  "## 0.6.0",
  "",
  "### 功能",
  "",
  "- 新功能 A",
  "- 新功能 B",
  "",
  "## 0.5.0",
  "",
  "- 旧版本条目",
  "",
].join("\n");

describe("release-notes", () => {
  it("提取指定版本小节的正文（不含标题）", () => {
    const notes = extractNotes(CHANGELOG, "0.6.0");
    expect(notes).toContain("### 功能");
    expect(notes).toContain("- 新功能 A");
    expect(notes).not.toContain("## 0.6.0");
    expect(notes).not.toContain("旧版本条目");
  });

  it("支持预发布号小节", () => {
    const text = `${CHANGELOG}## 0.7.0-rc.1\n\n- 候选版条目\n`;
    expect(extractNotes(text, "0.7.0-rc.1")).toBe("- 候选版条目");
  });

  it("找不到小节时报错", () => {
    expect(() => extractNotes(CHANGELOG, "9.9.9")).toThrow("找不到");
  });

  it("小节为空时报错", () => {
    const text = `${CHANGELOG}## 0.8.0\n\n`;
    expect(() => extractNotes(text, "0.8.0")).toThrow("没有内容");
  });
});
