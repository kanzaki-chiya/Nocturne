import { describe, expect, it } from "vitest";

import type { UserEntry } from "@nocturne/core/protocol";

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

function copied(lines: readonly { key: string; text: string; continued?: boolean | undefined }[]): string {
  const last = lines.at(-1);
  return selCopyText(lines, {
    anchor: { abs: 0, col: 0 },
    head: { abs: lines.length - 1, col: last?.text.length ?? 0 },
  });
}

describe("按词折行", () => {
  it("拉丁文本在空白处断开，复制拼回时保留空格", () => {
    const lines = layoutEntry(user("alpha beta gamma"), 16, true);
    const body = lines.map((line) => line.text);
    expect(body[0]).toBe("> alpha ");
    expect(body[1]).toBe("beta gamma");
    expect(lines[1]?.continued).toBe(true);
    expect(copied(lines)).toBe("> alpha beta gamma");
  });

  it("CJK 仍逐字断开，超长单词才从中间切开", () => {
    const cjk = layoutEntry(user("甲乙丙丁戊"), 12, true);
    expect(cjk.map((line) => line.text)).toEqual(["> 甲乙丙", "丁戊"]);
    expect(cjk[1]?.continued).toBe(true);
    const word = layoutEntry(user("abcdefghij"), 12, true);
    expect(word.map((line) => line.text)).toEqual(["> ", "abcdefgh", "ij"]);
    expect(word[1]?.continued).toBe(true);
    expect(word[2]?.continued).toBe(true);
    expect(copied(word)).toBe("> abcdefghij");
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
});
