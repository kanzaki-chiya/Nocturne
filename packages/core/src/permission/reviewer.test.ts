import { describe, expect, it } from "vitest";
import { FakeProvider, type FakeScript } from "../provider/index.js";
import { createModelSecurityReviewer } from "./reviewer.js";

const input = { subjects: [], cwd: "/workspace", userMessages: ["查看文件"] };
const answer = JSON.stringify({
  requested: false,
  destroys: false,
  credentials: false,
  exfiltrates: false,
  weakens: false,
  crosses: false,
  opaque: false,
  reason: "只读操作",
});
const usage = { inputTokens: 100, outputTokens: 8192, reasoningTokens: 8192 };

function setup(script: FakeScript) {
  const provider = new FakeProvider({ scripts: [script] });
  const model = provider.models()[0];
  if (model === undefined) throw new Error("缺少测试模型");
  return {
    provider,
    reviewer: createModelSecurityReviewer({ provider, model }, "review-session"),
  };
}

describe("模型安全审查", () => {
  it("为思考和回答预留 8192 token，不传思考参数且不带工具", async () => {
    const { provider, reviewer } = setup([
      { type: "reasoning_delta", text: "检查风险" },
      { type: "text_delta", text: answer },
      { type: "usage", usage: { ...usage, outputTokens: 500, reasoningTokens: 400 } },
      { type: "finish", reason: "stop" },
    ]);
    expect(await reviewer.review(input, new AbortController().signal)).toEqual({
      verdict: "allow",
      reason: "只读操作",
      cacheable: true,
      usage: { ...usage, outputTokens: 500, reasoningTokens: 400 },
    });
    expect(provider.requests[0]).toMatchObject({
      maxOutputTokens: 8192,
      tools: [],
      sessionId: "review-session",
    });
    expect(provider.requests[0]).not.toHaveProperty("reasoningEffort");
  });

  it.each(["", '{"requested":', answer])("length 一律按截断交人：%s", async (text) => {
    const { reviewer } = setup([
      { type: "text_delta", text },
      { type: "usage", usage },
      { type: "finish", reason: "length" },
    ]);
    expect(await reviewer.review(input, new AbortController().signal)).toEqual({
      verdict: "unsure",
      reason: "安全审查输出被截断",
      usage,
    });
  });

  it.each<{ events: FakeScript }>([
    { events: [{ type: "reasoning_delta", text: "还在思考" }] },
    { events: [{ type: "reasoning_block", text: "还在思考" }] },
    { events: [{ type: "usage", usage }] },
  ])("只有思考没有正文时识别截断：%j", async ({ events }) => {
    const { reviewer } = setup([
      ...events,
      { type: "text_delta", text: " \n" },
      { type: "finish", reason: "stop" },
    ]);
    expect(await reviewer.review(input, new AbortController().signal)).toMatchObject({
      verdict: "unsure",
      reason: "安全审查输出被截断",
    });
  });

  it.each(["", "not JSON", '{"requested":false}'])(
    "没有截断证据时仍报告格式错误：%s",
    async (text) => {
      const { reviewer } = setup([
        { type: "text_delta", text },
        { type: "finish", reason: "stop" },
      ]);
      expect(await reviewer.review(input, new AbortController().signal)).toMatchObject({
        verdict: "unsure",
        reason: "审查输出格式错误",
      });
    },
  );

  it("省略思考参数时无思考输出的模型仍可正常放行", async () => {
    const { provider, reviewer } = setup([{ type: "text_delta", text: answer }]);
    expect(await reviewer.review(input, new AbortController().signal)).toMatchObject({
      verdict: "allow",
      cacheable: true,
    });
    expect(provider.requests[0]).not.toHaveProperty("reasoningEffort");
  });
});
