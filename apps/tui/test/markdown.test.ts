import { describe, expect, it } from "vitest";

import { renderMarkdown, splitMarkdownBlocks } from "../src/markdown.js";

describe("assistant Markdown", () => {
  it("only commits complete blocks and keeps an open inline marker literal", () => {
    expect(splitMarkdownBlocks("# 标题\n\n正文 **未完", false)).toEqual({
      blocks: ["# 标题\n\n"],
      tail: "正文 **未完",
    });
    expect(renderMarkdown("正文 **未完", 40, "a").map((line) => line.text)).toEqual([
      "正文 **未完",
    ]);
  });

  it("renders headings, nested lists, links and table fallback at display width", () => {
    const source =
      "# 标题\n\n- 一\n  - 二\n\n[文档](https://example.com)\n\n| 列名 | 数值 |\n|---|---|\n| 中文内容 | 123 |";
    const lines = renderMarkdown(source, 20, "a");
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("标题");
    expect(lines[0]?.segments?.[0]?.bold).toBe(true);
    expect(text).toContain("• 一\n  • 二");
    expect(text).toContain("文档 (https://");
    expect(text).toContain("列名：中文内容");
    expect(text).toContain("数值：123");
    expect(lines.every((line) => line.text.length > 0)).toBe(true);
  });
});
