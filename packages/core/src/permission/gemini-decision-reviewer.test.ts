import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiDecisionReviewer } from "./gemini-decision-reviewer.js";
import type { ReviewInput } from "./types.js";

const input: ReviewInput = {
  cwd: "C:/ws",
  subjects: [{ kind: "shell", target: "rm -rf build" }],
  userMessages: ["清理生成的 build 目录"],
};
const options = {
  baseURL: "https://generativelanguage.googleapis.com/v1beta/",
  endpoint: "ai-studio",
  model: "gemini-decision-1",
  minConfidence: 0.7,
  key: async () => "fake-gemini-key",
};
const review = () =>
  createGeminiDecisionReviewer(options).review(input, new AbortController().signal);
const mockResponse = (value: unknown, status = 200) => {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value, { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
};
const no = (confidence = 0.92) => ({
  type: "choice",
  choice: "no",
  confidence,
  probabilities: { yes: 1 - confidence, no: confidence },
});
const yes = (confidence = 0.92) => ({
  type: "choice",
  choice: "yes",
  confidence,
  probabilities: { yes: confidence, no: 1 - confidence },
});
const allowAnswers = () => ({
  "1": no(),
  "2": no(),
  "3": no(),
  "4": no(),
  "5": no(),
  "6": no(),
  "7": no(),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gemini Decisions 安全审查", () => {
  it("POST /decisions，带 x-goog-api-key、JSON 文本 input 与七道 choice 题；独立用量记账", async () => {
    const fetch = mockResponse({
      answers: allowAnswers(),
      usage: { total_input_tokens: 215, total_output_tokens: 0, total_tokens: 215 },
    });
    expect(await review()).toMatchObject({
      verdict: "allow",
      cacheable: true,
      usage: { inputTokens: 215, outputTokens: 0 },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("未发 Gemini 请求");
    const [url, init] = call;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": "fake-gemini-key",
      },
    });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gemini-decision-1");
    expect(typeof body.input).toBe("string");
    expect(JSON.parse(body.input)).toEqual(input);
    expect(Object.keys(body.questions).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    for (const question of Object.values(body.questions) as {
      type: string;
      instructions: string;
      criteria: unknown;
    }[]) {
      expect(question.type).toBe("choice");
      expect(question.criteria).toEqual({ yes: expect.any(String), no: expect.any(String) });
    }
    expect(createGeminiDecisionReviewer(options).model).toEqual({
      provider: "ai-studio",
      model: "gemini-decision-1",
    });
  });

  it("Q1 为是时风险题放行且不缓存；否则交人", async () => {
    mockResponse({ answers: { ...allowAnswers(), "1": yes(), "6": yes() } });
    expect(await review()).toMatchObject({ verdict: "allow", cacheable: false });

    mockResponse({ answers: { ...allowAnswers(), "6": yes(0.95) } });
    const ask = await review();
    expect(ask.verdict).toBe("unsure");
    expect(ask.reason).toContain("会推送");
  });

  it("低置信度按保守方向降级并保留 usage", async () => {
    mockResponse({
      answers: { ...allowAnswers(), "1": yes(0.65), "6": yes(0.95) },
      usage: { total_input_tokens: 120 },
    });
    const result = await review();
    expect(result).toMatchObject({
      verdict: "unsure",
      usage: { inputTokens: 120, outputTokens: 0 },
    });
    expect(result.reason).toContain("Q1");
    expect(result.reason).toContain("0.7");
  });

  it.each(["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"])(
    "HTTP 400 安全拒绝（%s）返回 unsure 且提示输入被拒绝",
    async (code) => {
      mockResponse({ error: { code, message: "blocked" } }, 400);
      expect(await review()).toEqual({
        verdict: "unsure",
        reason: "决策模型拒绝了这次输入",
      });
    },
  );

  it("HTTP 200 prompt_feedback.block_reason 返回 unsure 且保留 usage", async () => {
    mockResponse({
      answers: {},
      prompt_feedback: { block_reason: "safety" },
      usage: { total_input_tokens: 80 },
    });
    expect(await review()).toEqual({
      verdict: "unsure",
      reason: "决策模型拒绝了这次输入",
      usage: { inputTokens: 80, outputTokens: 0 },
    });
  });

  it.each([
    [401, "密钥无效或无权限"],
    [403, "密钥无效或无权限"],
    [404, "模型不可用或请求不受支持"],
    [429, "审查服务限流"],
    [500, "审查服务 HTTP 错误"],
  ])("HTTP %d 映射为 unsure 与对应理由", async (status, expected) => {
    mockResponse({ error: { message: "err" } }, status);
    const result = await review();
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain(expected);
    expect(result.reason).toContain(String(status));
  });

  it("缺密钥、格式错误与超时均为 unsure", async () => {
    expect(
      await createGeminiDecisionReviewer({ ...options, key: async () => undefined }).review(
        input,
        new AbortController().signal,
      ),
    ).toEqual({ verdict: "unsure", reason: "安全审查失败：未配置密钥" });

    mockResponse({ answers: { "1": { choice: "maybe", confidence: 0.9 } } });
    expect(await review()).toMatchObject({ verdict: "unsure", reason: "安全审查响应格式错误" });

    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const pending = review();
    await Promise.resolve();
    controller.abort(new DOMException("timeout", "TimeoutError"));
    expect(await pending).toMatchObject({ verdict: "unsure", reason: "安全审查超时（20 秒）" });
    expect(timeout).toHaveBeenCalledWith(20_000);
    timeout.mockRestore();
  });
});
