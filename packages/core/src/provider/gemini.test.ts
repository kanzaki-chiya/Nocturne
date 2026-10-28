import { describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "./adapters/gemini.js";
import type { ModelRequest, ModelStreamEvent } from "./types.js";

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "gemini-4-argon-contributor",
  system: [{ text: "system" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [
    {
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ],
  ...overrides,
});
const chunk = (parts: unknown[], finishReason?: string) => ({
  candidates: [
    { content: { role: "model", parts }, ...(finishReason !== undefined ? { finishReason } : {}) },
  ],
});
function fixture(chunks: unknown[]) {
  const capture: { url?: string; headers?: Headers; body?: Record<string, unknown> } = {};
  const fetcher: typeof fetch = async (url, init) => {
    capture.url = String(url);
    capture.headers = new Headers(init?.headers);
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { capture, fetcher };
}
async function collect(provider: ReturnType<typeof createGeminiProvider>, req = request()) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(req, new AbortController().signal))
    if (event.type !== "heartbeat") events.push(event);
  return events;
}
const config = { id: "gateway", baseURL: "https://gateway.test/google/v1beta", apiKeyEnv: "KEY" };

describe("Gemini 流式契约（ADR-0061）", () => {
  it("文本/推理/并行工具签名、缓存读和思考用量，finish 唯一且最后", async () => {
    const { capture, fetcher } = fixture([
      chunk([{ text: "think", thought: true, thoughtSignature: "reasoning-sig" }]),
      chunk([{ text: "hello", thoughtSignature: "text-sig" }]),
      chunk([
        { functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "call-a" },
        { functionCall: { name: "read", args: { path: "b" } }, thoughtSignature: "call-b" },
      ]),
      {
        ...chunk([], "STOP"),
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 3,
          cachedContentTokenCount: 8,
          totalTokenCount: 28,
        },
      },
    ]);
    const provider = createGeminiProvider(
      { ...config, sessionHeader: "x-session", headers: { "x-entry": "yes" } },
      () => "test-key",
      fetcher,
    );
    const events = await collect(
      provider,
      request({ sessionId: "session", reasoningEffort: "high" }),
    );
    expect(events).toContainEqual({
      type: "text_delta",
      text: "hello",
      providerData: { google: { thoughtSignature: "text-sig" } },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "reasoning_delta",
        text: "think",
        providerData: { google: { thoughtSignature: "reasoning-sig" } },
      }),
    );
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ providerData: { google: { thoughtSignature: "call-a" } } });
    expect(calls[1]).toMatchObject({ providerData: { google: { thoughtSignature: "call-b" } } });
    expect(events).toContainEqual({
      type: "usage",
      usage: expect.objectContaining({ inputTokens: 20, cacheReadTokens: 8, reasoningTokens: 3 }),
    });
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_calls" });
    expect(capture.url).toBe(
      `${config.baseURL}/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse`,
    );
    expect(capture.headers?.get("x-goog-api-key")).toBe("test-key");
    expect(capture.headers?.get("x-session")).toBe("session");
    expect(capture.headers?.get("x-entry")).toBe("yes");
    expect(capture.headers?.get("user-agent")).toMatch(/^nocturne\//);
    expect(capture.body).toMatchObject({
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    });
  });

  it("三处签名原样回传；并行调用后续无签名属正常；缺签名填哨兵并只记一条诊断", async () => {
    const { capture, fetcher } = fixture([chunk([{ text: "ok" }], "STOP")]);
    const record = vi.fn();
    const pd = (thoughtSignature: string) => ({ google: { thoughtSignature } });
    const provider = createGeminiProvider(
      { ...config, diagnostics: { record } },
      () => "test-key",
      fetcher,
    );
    await collect(
      provider,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "r", providerData: pd("r-sig") },
              { type: "text", text: "t", providerData: pd("t-sig") },
            ],
            toolCalls: [
              { callId: "a", name: "read", input: { path: "a" }, providerData: pd("a-sig") },
              { callId: "b", name: "read", input: { path: "b" } },
            ],
          },
          { role: "tool", callId: "a", name: "read", content: "ok", isError: false },
          { role: "tool", callId: "b", name: "read", content: "ok", isError: false },
          {
            role: "assistant",
            content: [],
            toolCalls: [
              { callId: "c", name: "read", input: { path: "c" } },
              { callId: "d", name: "read", input: { path: "d" } },
            ],
          },
          { role: "tool", callId: "c", name: "read", content: "ok", isError: false },
          { role: "tool", callId: "d", name: "read", content: "ok", isError: false },
        ],
      }),
    );
    const body = JSON.stringify(capture.body);
    for (const signature of ["r-sig", "t-sig", "a-sig"]) expect(body).toContain(signature);
    const calls = (capture.body?.contents as { parts: Record<string, unknown>[] }[])
      .flatMap((content) => content.parts)
      .filter((part) => part.functionCall !== undefined)
      .map((part) => part.thoughtSignature);
    // a 已签名，b 为并行后续不填；c、d 所在步没有任何签名，逐个填哨兵（与 SDK 判定一致）
    expect(calls).toEqual([
      "a-sig",
      undefined,
      "skip_thought_signature_validator",
      "skip_thought_signature_validator",
    ]);
    const missing = record.mock.calls.filter(
      ([name]) => name === "provider.unsupported_capability",
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.[1]).toMatchObject({ capability: "thought_signature", count: 2 });
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "content_filter"],
    ["OTHER", "other"],
  ])("结束原因 %s", async (raw, expected) => {
    const { fetcher } = fixture([chunk([{ text: "ok" }], raw)]);
    expect(
      (await collect(createGeminiProvider(config, () => "test-key", fetcher))).at(-1),
    ).toMatchObject({ type: "finish", reason: expected });
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "思考档位 %s 的翻译与诊断",
    async (effort) => {
      const { capture, fetcher } = fixture([chunk([{ text: "ok" }], "STOP")]);
      const record = vi.fn();
      await collect(
        createGeminiProvider({ ...config, diagnostics: { record } }, () => "test-key", fetcher),
        request({ reasoningEffort: effort }),
      );
      const thinking = (capture.body?.generationConfig as { thinkingConfig: unknown })
        .thinkingConfig;
      expect(thinking).toEqual(
        ["xhigh", "max"].includes(effort)
          ? { includeThoughts: true }
          : { includeThoughts: true, thinkingLevel: effort },
      );
      expect(record).toHaveBeenCalledTimes(["xhigh", "max"].includes(effort) ? 1 : 0);
    },
  );

  it("工具结果图片使用补充 user 消息而不是原生 functionResponse 图片", async () => {
    const { capture, fetcher } = fixture([chunk([{ text: "ok" }], "STOP")]);
    await collect(
      createGeminiProvider(config, () => "test-key", fetcher),
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "read image" }] },
          {
            role: "assistant",
            content: [],
            toolCalls: [{ callId: "call", name: "read", input: {} }],
          },
          {
            role: "tool",
            callId: "call",
            name: "read",
            content: "image",
            isError: false,
            images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
          },
        ],
      }),
    );
    const contents = capture.body?.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(
      contents.some(
        (content) =>
          content.role === "user" && content.parts.some((part) => part.inlineData !== undefined),
      ),
      JSON.stringify(contents),
    ).toBe(true);
    const response = contents
      .flatMap((content) => content.parts)
      .find((part) => part.functionResponse !== undefined);
    expect(response?.functionResponse).not.toHaveProperty("parts");
  });

  it("网络与上下文过长归一化", async () => {
    await expect(
      collect(
        createGeminiProvider(
          config,
          () => "test-key",
          async () => {
            throw new TypeError("fetch failed");
          },
        ),
      ),
    ).rejects.toMatchObject({ kind: "network", retryable: true });
    await expect(
      collect(
        createGeminiProvider(
          config,
          () => "test-key",
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  code: 400,
                  message: "maximum context length exceeded",
                  status: "INVALID_ARGUMENT",
                },
              }),
              { status: 400 },
            ),
        ),
      ),
    ).rejects.toMatchObject({ kind: "context_overflow", retryable: false });
  });

  it.each([
    [400, "invalid_request"],
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "server"],
  ])("HTTP %s 错误映射", async (status, kind) => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: { code: status, message: "rejected", status: "ERROR" } }),
        { status },
      );
    await expect(
      collect(createGeminiProvider(config, () => "test-key", fetcher)),
    ).rejects.toMatchObject({ kind, status });
  });

  it("中止保留 AbortError", async () => {
    const signal = AbortSignal.abort();
    const provider = createGeminiProvider(
      config,
      () => "test-key",
      async () => {
        throw new DOMException("aborted", "AbortError");
      },
    );
    await expect(
      (async () => {
        for await (const _event of provider.stream(request(), signal)) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ADR-0070：插话紧跟工具结果。Gemini 的 contents 按角色轮次组织，SDK 把工具结果与
// 随后的用户文本各映射为一条 role=user 的 content（带附图的工具结果本来就这样发），
// Gemini 接受连续 user 轮次；这里锁定线上形状，不做额外合并。
it("工具结果与随后的用户文本各自是一条 role=user 的 content", async () => {
  const { capture, fetcher } = fixture([chunk([{ text: "ok" }], "STOP")]);
  const provider = createGeminiProvider(config, () => "test-key", fetcher);
  await collect(
    provider,
    request({
      messages: [
        { role: "user", content: [{ type: "text", text: "做个页面" }] },
        {
          role: "assistant",
          content: [],
          toolCalls: [{ callId: "c1", name: "read", input: { path: "a.ts" } }],
        },
        { role: "tool", callId: "c1", name: "read", content: "file body", isError: false },
        { role: "user", content: [{ type: "text", text: "改成蓝色" }] },
      ],
    }),
  );
  const contents = (capture.body as { contents: unknown }).contents;
  expect(contents).toEqual([
    { role: "user", parts: [{ text: "做个页面" }] },
    {
      role: "model",
      parts: [
        {
          functionCall: { id: "c1", name: "read", args: { path: "a.ts" } },
          thoughtSignature: "skip_thought_signature_validator",
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "c1",
            name: "read",
            response: { name: "read", content: "file body" },
          },
        },
      ],
    },
    { role: "user", parts: [{ text: "改成蓝色" }] },
  ]);
});
