import { describe, expect, it } from "vitest";

import { buildLatestManifest } from "../release-build.mjs";
import { extractChangelog, extractNotes } from "../release-notes.mjs";

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

  it("extractChangelog 解析多个版本、版本间空行与三级标题，跳过非版本号与空小节", () => {
    const multi = [
      "# 更新日志",
      "",
      "## 未发布",
      "",
      "- 未发布说明",
      "",
      "## 0.8.0",
      "",
      "",
      "### 所有客户端",
      "",
      "- 修复 A",
      "",
      "### 桌面端",
      "",
      "- 新增 B",
      "",
      "",
      "## 0.7.0",
      "",
      "### 桌面端",
      "",
      "- 改进 C",
      "",
      "## 0.6.0",
      "",
      "- 旧条目 D",
      "",
    ].join("\n");
    expect(extractChangelog(multi)).toEqual([
      {
        version: "0.8.0",
        notes: "### 所有客户端\n\n- 修复 A\n\n### 桌面端\n\n- 新增 B",
      },
      {
        version: "0.7.0",
        notes: "### 桌面端\n\n- 改进 C",
      },
      {
        version: "0.6.0",
        notes: "- 旧条目 D",
      },
    ]);
  });

  it("buildLatestManifest 生成含 changelog 的 latest.json，--notes 覆盖不影响 changelog", () => {
    const manifest = buildLatestManifest({
      version: "0.6.0",
      signature: "SIG",
      setupName: "Nocturne_0.6.0_x64-setup.exe",
      changelogText: CHANGELOG,
      notesOverride: "临时说明",
      pubDate: "2026-11-17T00:00:00.000Z",
    });
    expect(manifest.notes).toBe("临时说明");
    expect(manifest.changelog).toEqual([
      { version: "0.6.0", notes: "### 功能\n\n- 新功能 A\n- 新功能 B" },
      { version: "0.5.0", notes: "- 旧版本条目" },
    ]);
  });
});
