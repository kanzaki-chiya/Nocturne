import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevSecurityReviewer } from "./jev-reviewer.js";
import type { ReviewInput } from "./types.js";

const input: ReviewInput = {
  cwd: "C:/ws",
  subjects: [{ kind: "shell", target: "rm -rf build" }],
  userMessages: ["清理生成的 build 目录"],
};
const options = {
  baseURL: "https://example.invalid/v1/",
  endpoint: "opencode-zen",
  model: "jev-test",
  minConfidence: 0.7,
  key: async () => "test-key",
  sessionHeader: "x-opencode-session",
  sessionId: "session",
};
const review = () => createJevSecurityReviewer(options).review(input, new AbortController().signal);
const mockResponse = (value: unknown, status = 200) => {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value, { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
};
const no = (confidence = 0.9) => ({ choice: "no", confidence });
const yes = (confidence = 0.9) => ({ choice: "yes", confidence });
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

describe("Jev 安全审查", () => {
  it("POST systemone，七个编号 choice 问题、上下文、凭据及会话头；独立用量", async () => {
    const fetch = mockResponse({
      answers: allowAnswers(),
      usage: { input_tokens: 198, output_tokens: 1 },
    });
    expect(await review()).toMatchObject({
      verdict: "allow",
      usage: { inputTokens: 198, outputTokens: 1 },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("未发 Jev 请求");
    const [url, init] = call;
    expect(url).toBe("https://example.invalid/v1/systemone");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        "x-opencode-session": "session",
      },
    });
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    for (const question of Object.values(body.questions) as {
      type: string;
      instructions: string;
      criteria: unknown;
    }[]) {
      expect(question.type).toBe("choice");
      expect(question.instructions).toContain("不可信");
      expect(question.criteria).toEqual({ yes: expect.any(String), no: expect.any(String) });
    }
    expect(body.state).toEqual(input);
    expect(body.tools).toBeUndefined();
    expect(createJevSecurityReviewer(options).model).toEqual({
      provider: "opencode-zen",
      model: "jev-test",
    });
  });
  it("Q1 为是时 Q6 为是仍放行；否则交人并列出风险题", async () => {
    mockResponse({ answers: { ...allowAnswers(), "1": yes(), "6": yes() } });
    expect((await review()).verdict).toBe("allow");
    mockResponse({ answers: { ...allowAnswers(), "6": yes(0.95) } });
    const ask = await review();
    expect(ask.verdict).toBe("unsure");
    expect(ask.reason).toContain("会推送");
  });
  it("支持数组答案", async () => {
    mockResponse({ answers: [no(), no(), no(), no(), no(), no(), no()] });
    expect((await review()).verdict).toBe("allow");
    mockResponse({
      answers: [no(), yes(), no(), no(), no(), no(), no()],
      usage: { input_tokens: 9, output_tokens: 1 },
    });
    expect(await review()).toMatchObject({
      verdict: "unsure",
      usage: { inputTokens: 9, outputTokens: 1 },
    });
  });
  it("低置信度往保守方向取值：Q1 取否、Q2–Q7 取是，仍保留 usage", async () => {
    mockResponse({
      answers: { ...allowAnswers(), "1": yes(0.69), "6": yes() },
      usage: { input_tokens: 9, output_tokens: 1 },
    });
    const result = await review();
    expect(result).toMatchObject({
      verdict: "unsure",
      usage: { inputTokens: 9, outputTokens: 1 },
    });
    expect(result.reason).toContain("低于阈值");
    mockResponse({ answers: { ...allowAnswers(), "2": { choice: "no", confidence: 0.1 } } });
    const conservative = await review();
    expect(conservative.verdict).toBe("unsure");
    expect(conservative.reason).toContain("会删除");
  });
  it.each([
    null,
    {},
    { answers: [] },
    { answers: [{ choice: "no", confidence: 0.9 }] },
    { answers: { ...allowAnswers(), "7": { choice: "allow", confidence: 0.9 } } },
    { answers: { ...allowAnswers(), "1": { choice: "no" } } },
    { answers: { ...allowAnswers(), "1": { choice: "no", confidence: "0.9" } } },
    { answers: { ...allowAnswers(), "1": { choice: "no", confidence: 1.1 } } },
    { answers: { ...allowAnswers(), "1": { choice: "no", confidence: -1 } } },
  ])("响应错误按 unsure：%j", async (body) => {
    mockResponse(body);
    expect((await review()).verdict).toBe("unsure");
  });
  it.each([
    [401, "密钥无效"],
    [403, "密钥无效"],
    [400, "模型不可用"],
    [404, "模型不可用"],
    [429, "限流"],
    [500, "HTTP 错误"],
  ])("HTTP %i 显示可理解的错误，不泄露响应正文", async (status, message) => {
    mockResponse({ error: "private-data test-key" }, Number(status));
    const result = await review();
    expect(result.verdict).toBe("unsure");
    expect(result.reason).toContain(String(message));
    expect(result.reason).not.toContain("private-data");
    expect(result.reason).not.toContain("test-key");
  });
  it("20 秒超时降为 unsure；用户中止保留取消语义", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const pending = review();
    await Promise.resolve();
    controller.abort(new DOMException("timeout", "TimeoutError"));
    expect(await pending).toMatchObject({
      verdict: "unsure",
      reason: expect.stringContaining("超时"),
    });
    expect(timeout).toHaveBeenCalledWith(20_000);
    timeout.mockRestore();
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(
      createJevSecurityReviewer(options).review(input, cancelled.signal),
    ).rejects.toThrow("cancelled");
  });
  it("缺失密钥、网络错误、JSON 错误均 unsure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("private-key"));
    vi.stubGlobal("fetch", fetch);
    expect(
      await createJevSecurityReviewer({ ...options, key: async () => undefined }).review(
        input,
        new AbortController().signal,
      ),
    ).toMatchObject({ verdict: "unsure", reason: expect.stringContaining("未配置密钥") });
    expect(fetch).not.toHaveBeenCalled();
    expect(await review()).toMatchObject({
      verdict: "unsure",
      reason: expect.not.stringContaining("private-key"),
    });
    fetch.mockResolvedValue(new Response("not JSON"));
    expect((await review()).verdict).toBe("unsure");
  });
});
