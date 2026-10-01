import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevSecurityReviewer } from "./jev-reviewer.js";
import type { ReviewInput } from "./types.js";

const input: ReviewInput = {
  cwd: "C:/ws",
  subjects: [{ kind: "shell", target: "rm -rf build" }],
  recentUserMessages: ["清理生成的 build 目录"],
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Jev 安全审查", () => {
  it("POST systemone，编号 choice 问题、上下文、凭据及会话头；独立用量", async () => {
    const fetch = mockResponse({
      answers: { "0": { choice: "allow", confidence: 0.99 } },
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
    expect(body).toEqual({
      model: "jev-test",
      state: input,
      questions: {
        "0": {
          type: "choice",
          instructions: expect.stringContaining("不可信"),
          criteria: {
            allow: expect.any(String),
            block: expect.any(String),
            unsure: expect.any(String),
          },
        },
      },
    });
    expect(body.tools).toBeUndefined();
    expect(createJevSecurityReviewer(options).model).toEqual({
      provider: "opencode-zen",
      model: "jev-test",
    });
  });
  it.each(["allow", "block", "unsure"] as const)(
    "confidence 达到阈值时保留 %s，支持数组答案",
    async (choice) => {
      mockResponse({ answers: [{ choice, confidence: 0.7 }] });
      expect((await review()).verdict).toBe(choice);
    },
  );
  it.each(["allow", "block", "unsure"])("低置信度 %s 降为 unsure，仍保留 usage", async (choice) => {
    mockResponse({
      answers: { "0": { choice, confidence: 0.69 } },
      usage: { input_tokens: 9, output_tokens: 1 },
    });
    expect(await review()).toMatchObject({
      verdict: "unsure",
      reason: expect.stringContaining("低于阈值"),
      usage: { inputTokens: 9, outputTokens: 1 },
    });
  });
  it.each([
    null,
    {},
    { answers: [] },
    { answers: [{ choice: "ALLOW", confidence: 0.9 }] },
    { answers: [{ choice: "allow" }] },
    { answers: [{ choice: "allow", confidence: "0.9" }] },
    { answers: [{ choice: "block", confidence: 1.1 }] },
    { answers: [{ choice: "allow", confidence: -1 }] },
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
