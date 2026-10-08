import { expect, it } from "vitest";
import { diffLines, lineDiff } from "../src/protocol/index.js";

it("远距离改动输出两块，按实际行数统计", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`);
  const changed = [...lines];
  changed[2] = "first\n";
  changed[25] = "second\n";
  const result = lineDiff(lines.join(""), changed.join(""));
  expect(result).toMatchObject({ added: 2, removed: 2 });
  expect(result.diff.match(/^@@/gm)).toHaveLength(2);
  expect(result.diff).toContain("@@ -1,6 +1,6 @@");
  expect(result.diff).toContain("@@ -23,7 +23,7 @@");
});

it.each([
  ["", "a\nb\n", 2, 0],
  ["a\nb\n", "", 0, 2],
  ["a", "a\n", 1, 1],
  ["a\r\nb\rc\n", "a\nb\r\nc", 3, 3],
  ["same\r\n", "same\r\n", 0, 0],
])("新建、清空、换行与相同文本：%j → %j", (a, b, added, removed) => {
  const result = lineDiff(a, b);
  expect(result).toEqual({ diff: diffLines(a, b), added, removed });
});

it("超过编辑距离上限退回单块并标 approximate", () => {
  const a = "old\n".repeat(501);
  const b = "new\n".repeat(501);
  expect(lineDiff(a, b)).toEqual({
    diff: diffLines(a, b),
    added: 501,
    removed: 501,
    approximate: true,
  });
});

it("混用换行保留 CRLF、CR 和无末尾换行标记", () => {
  const { diff } = lineDiff("a\r\nb\rc", "A\r\nb\rc\n");
  expect(diff).toContain("\\ CRLF");
  expect(diff).toContain("\\ CR");
  expect(diff).toContain("\\ No newline at end of file");
});
