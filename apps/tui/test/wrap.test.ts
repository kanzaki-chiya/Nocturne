import { describe, expect, it } from "vitest";

import type { ToolEntry, UserEntry } from "@nocturne/core/protocol";

import { layoutEntry } from "../src/lines.js";
import { renderMarkdown } from "../src/markdown.js";
import { selCopyText } from "../src/selection.js";

const user = (text: string): UserEntry => ({
  kind: "user",
  key: "u",
  turnId: "t",
  seq: 1,
  content: [{ type: "text", text }],
});

function copied(
  lines: readonly { key: string; text: string; continued?: boolean | undefined }[],
): string {
  const last = lines.at(-1);
  return selCopyText(lines, {
    anchor: { abs: 0, col: 0 },
    head: { abs: lines.length - 1, col: last?.text.length ?? 0 },
  });
}

const url = `https://example.com/${"a".repeat(16)}`;
const mixed = "这个函数调用了一个名字很长的方法someVeryLongFunctionName然后继续";
const earlySpace = "我们 在这里写了一大段很长很长的中文abc";

describe("按词折行", () => {
  it("任务复选框与短正文同一行，保留勾选状态和嵌套缩进", () => {
    const lines = renderMarkdown("- [ ] 短任务\n- [x] 已完成\n  - [ ] 子任务", 40, "tasks");
    expect(lines.map((line) => line.text)).toEqual([
      "• [ ] 短任务",
      "• [x] 已完成",
      "  • [ ] 子任务",
    ]);
    expect(renderMarkdown("1. [ ] 短任务", 40, "ordered").map((line) => line.text)).toEqual([
      "1. [ ] 短任务",
    ]);
  });

  it("任务长正文沿用按词折行，复制保留复选框与正文", () => {
    const lines = renderMarkdown("- [ ] alpha beta gamma", 20, "task-wrap");
    expect(lines.map((line) => line.text)).toEqual(["• [ ] alpha ", "beta gamma"]);
    expect(lines[1]?.continued).toBe(true);
    expect(copied(lines)).toBe("• [ ] alpha beta gamma");
  });

  it("拉丁文本在空白处断开，复制拼回时保留空格", () => {
    const lines = layoutEntry(user("alpha beta gamma"), 16, true);
    const body = lines.map((line) => line.text);
    expect(body[0]).toBe("> alpha ");
    expect(body[1]).toBe("beta gamma");
    expect(lines[1]?.continued).toBe(true);
    expect(copied(lines)).toBe("> alpha beta gamma");
  });

  it("CJK 仍逐字断开，超长单词硬切时不把提示符单独留成一行", () => {
    const cjk = layoutEntry(user("甲乙丙丁戊"), 12, true);
    expect(cjk.map((line) => line.text)).toEqual(["> 甲乙丙", "丁戊"]);
    expect(cjk[1]?.continued).toBe(true);
    expect(copied(cjk)).toBe("> 甲乙丙丁戊");
    const word = layoutEntry(user("abcdefghij"), 12, true);
    expect(word.map((line) => line.text)).toEqual(["> abcdef", "ghij"]);
    expect(word[1]?.continued).toBe(true);
    expect(copied(word)).toBe("> abcdefghij");
  });

  it("前缀和缩进不是断点，中英交界优先于更早的空格", () => {
    const bullet = renderMarkdown(`- ${url}`, 40, "b");
    // 裸 URL 会被标成链接，正文后面还有「 (地址)」。前缀不能单独成行。
    expect(bullet.map((line) => line.text)).toEqual([
      `• https://example.com/${"a".repeat(14)}`,
      "aa ",
      `(https://example.com/${"a".repeat(15)}`,
      "a)",
    ]);
    expect(bullet[1]?.continued).toBe(true);
    expect(copied(bullet)).toBe(`• ${url} (${url})`);

    const nested = renderMarkdown(`- 甲\n  - ${"b".repeat(36)}`, 40, "n");
    expect(nested.map((line) => line.text)).toEqual([
      "• 甲",
      `  • ${"b".repeat(32)}`,
      "b".repeat(4),
    ]);
    expect(nested[2]?.continued).toBe(true);
    expect(copied(nested)).toBe(`• 甲\n  • ${"b".repeat(36)}`);

    const quote = renderMarkdown(`> ${"c".repeat(36)}`, 40, "q");
    expect(quote.map((line) => line.text)).toEqual([`│ ${"c".repeat(34)}`, "cc"]);
    expect(quote[1]?.continued).toBe(true);
    expect(copied(quote)).toBe(`│ ${"c".repeat(36)}`);

    const prompted = layoutEntry(user(url), 40, true);
    expect(prompted.map((line) => line.text)).toEqual([
      `> https://example.com/${"a".repeat(14)}`,
      "aa",
    ]);
    expect(prompted[1]?.continued).toBe(true);
    expect(copied(prompted)).toBe(`> ${url}`);

    const cjkLatin = renderMarkdown(mixed, 40, "m");
    expect(cjkLatin.map((line) => line.text)).toEqual([
      "这个函数调用了一个名字很长的方法",
      "someVeryLongFunctionName然后继续",
    ]);
    expect(cjkLatin[1]?.continued).toBe(true);
    expect(copied(cjkLatin)).toBe(mixed);

    const later = renderMarkdown(earlySpace, 40, "e");
    expect(later.map((line) => line.text)).toEqual(["我们 在这里写了一大段很长很长的中文", "abc"]);
    expect(later[1]?.continued).toBe(true);
    expect(copied(later)).toBe(earlySpace);
  });

  it("正文按词折行，围栏代码块仍按字符折行", () => {
    const prose = renderMarkdown("alpha beta", 12, "p");
    expect(prose.map((line) => line.text)).toEqual(["alpha ", "beta"]);
    expect(prose[1]?.continued).toBe(true);
    expect(copied(prose)).toBe("alpha beta");

    const code = renderMarkdown("```\nabcd wxyz\n```", 12, "c");
    const codeText = code.map((line) => line.text);
    expect(codeText.some((line) => line.includes("abcd w"))).toBe(true);
    expect(codeText.some((line) => line.endsWith("wxyz"))).toBe(false);
    expect(copied(code).replaceAll("│", "").replaceAll(" ", "")).toContain("abcdwxyz");
  });

  it("展开的工具结果按字符折行，不在空格处把命令输出拆开", () => {
    const tool: ToolEntry = {
      kind: "tool",
      key: "t:c",
      turnId: "t",
      callId: "c",
      seq: 2,
      name: "shell",
      status: "ok",
      input: { command: "echo" },
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: {
        status: "ok",
        modelContent: "abc defghijklm",
        output: "abc defghijklm",
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: undefined,
      },
    };
    const lines = layoutEntry(tool, 16, true, new Map(), 0, false, true);
    const body = lines.filter((line) => line.key.includes(":out"));
    expect(body.map((line) => line.text)).toEqual(["  abc defghi", "  jklm"]);
    expect(copied(body)).toBe("abc defghijklm");
  });
});
