import { expect, it } from "vitest";
import { estimateTokens, firstUserText } from "../src/protocol/index.js";

it("公开估算沿用 CJK 一字一个 token，其他四字一个", () => {
  expect(estimateTokens("中文abcd")).toBe(3);
  expect(estimateTokens("日本語한글")).toBe(5);
  expect(estimateTokens("abcde")).toBe(2);
  expect(estimateTokens("")).toBe(0);
});

it("会话首句取第一个文本块的第一个非空行，不回退到下一块", () => {
  expect(
    firstUserText({
      content: [
        { type: "text", text: "  原文首行\r\n其他" },
        { type: "text", text: "第二块" },
      ],
    }),
  ).toBe("原文首行");
  expect(
    firstUserText({
      content: [
        { type: "text", text: "\n \r\n  其他\n更多" },
        { type: "text", text: "第二块" },
      ],
    }),
  ).toBe("其他");
  expect(
    firstUserText({
      content: [
        { type: "text", text: " \n\t" },
        { type: "text", text: "第二块" },
      ],
    }),
  ).toBeUndefined();
  expect(firstUserText({ content: [] })).toBeUndefined();
});
