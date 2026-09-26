import { describe, expect, it } from "vitest";

import { renderMarkdown, splitMarkdownBlocks, takeMarkdownBlocks } from "../src/markdown.js";

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

  it("松散列表/引用后跟空行不算结束：等下一个非空白 token", () => {
    // 列表 item 在空行后可能续写（松散列表），不能按"后随空行"收尾
    expect(splitMarkdownBlocks("说明：\n\n1. **第一步**\n\n", false)).toEqual({
      blocks: ["说明：\n\n"],
      tail: "1. **第一步**\n\n",
    });
    expect(splitMarkdownBlocks("> 引用一\n\n", false)).toEqual({
      blocks: [],
      tail: "> 引用一\n\n",
    });
    // 出现下一个非空白 token 后前块才收尾（块内含其后空行）
    expect(splitMarkdownBlocks("> 引用一\n\n> 引用二\n\n", false)).toEqual({
      blocks: ["> 引用一\n\n"],
      tail: "> 引用二\n\n",
    });
    // 其他块（如段落）沿用原规则：后随空行即稳定
    expect(splitMarkdownBlocks("段落一\n\n段落二", false)).toEqual({
      blocks: ["段落一\n\n"],
      tail: "段落二",
    });
  });
});

describe("流式 Markdown 按字符位置写入", () => {
  /**
   * 逐字符增长的流式模拟：每次只把"未写入的剩余文本"切块进回滚区，
   * 完成后只提交剩余。块偏移必须紧贴上一块末尾（重叠即重复、空洞即丢字），
   * 最终回滚区与活动区拼起来恰为全文。
   */
  function simulate(text: string): string {
    let written = 0;
    let emitted = 0;
    const out: string[] = [];
    const push = (step: ReturnType<typeof takeMarkdownBlocks>): void => {
      for (const part of step.parts) {
        expect(part.offset).toBe(emitted);
        out.push(part.text);
        emitted += part.text.length;
      }
      written = step.written;
    };
    for (let n = 1; n <= text.length; n++) {
      push(takeMarkdownBlocks(text.slice(0, n), written, false));
    }
    const done = takeMarkdownBlocks(text, written, true);
    push(done);
    expect(done.tail).toBe("");
    return out.join("");
  }

  it("松散列表逐字增长：后半段不丢不重", () => {
    const text = "说明：\n\n1. **第一步**\n\n   细节一\n\n2. **第二步**\n\n   细节二\n\n结束。";
    expect(simulate(text)).toBe(text);
  });

  it("代码块内含空行：未闭合栅栏期间的空行不提前收尾", () => {
    const text = "前文：\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后文。";
    expect(simulate(text)).toBe(text);
  });

  it("表格逐字增长", () => {
    const text = "开头：\n\n| 列名 | 数值 |\n|---|---|\n| 甲 | 1 |\n| 乙 | 2 |\n\n结尾。";
    expect(simulate(text)).toBe(text);
  });

  it("多段引用逐字增长", () => {
    const text = "说明：\n\n> 引用一\n\n> 引用二\n\n收尾。";
    expect(simulate(text)).toBe(text);
  });

  it("已写入位置随消息保持：晋升后只写剩余文本", () => {
    const text = "甲\n\n乙\n\n丙";
    const streaming = takeMarkdownBlocks("甲\n\n乙", 0, false);
    expect(streaming.written).toBe("甲\n\n".length);
    // 条目持久化后按同一位置续写，不重发前缀
    const promoted = takeMarkdownBlocks(text, streaming.written, true);
    expect(promoted.parts.map((p) => p.offset)).toEqual([3, 6]); // "乙\n\n"、"丙"
    expect([streaming.parts[0]?.text, ...promoted.parts.map((p) => p.text)].join("")).toBe(text);
  });
});
