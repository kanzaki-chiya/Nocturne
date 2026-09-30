/**
 * openai-responses 适配器契约测试（ADR-0031 §1）：stub fetch 回放
 * Responses SSE，覆盖文本、推理（含加密内容回传）、工具调用（含并行）、
 * 用量（缓存读、推理 token）、结束原因、错误映射、请求地址与鉴权头。
 */
import { describe, expect, it } from "vitest";

import {
  createOpenAIResponsesProvider,
  type OpenAIResponsesConfig,
} from "./adapters/openai-responses.js";
import { ProviderError } from "./errors.js";
import type { ModelRequest, ModelStreamEvent } from "./types.js";

const envWithKey = (name: string) => (name === "TEST_OAI_KEY" ? "sk-test" : undefined);
const envNoKey = () => undefined;

function config(overrides: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesConfig {
  return {
    id: "zen",
    type: "openai-responses",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_OAI_KEY",
    models: { "gpt-x": {} },
    ...overrides,
  };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "gpt-x",
    system: [{ text: "sys" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [
      {
        name: "finish",
        description: "提交结果",
        inputSchema: { type: "object", properties: { result: { type: "string" } } },
      },
      { name: "read", description: "读文件", inputSchema: { type: "object" } },
    ],
    maxOutputTokens: 1024,
    ...overrides,
  };
}

interface Captured {
  url?: string;
  headers?: Headers;
  body?: Record<string, unknown>;
}

function sseFetch(events: object[], capture?: Captured) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (capture !== undefined) {
      capture.url = String(input);
      capture.headers = new Headers(init?.headers);
      capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    }
    const payload = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(payload));
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function usage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 12,
    output_tokens: 5,
    total_tokens: 17,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
    ...over,
  };
}

function completed(responseOver: Record<string, unknown> = {}): object {
  return {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [],
      usage: usage(),
      incomplete_details: null,
      ...responseOver,
    },
  };
}

/** 一条 message 输出项（added → delta*2 → done） */
function messageChunks(text: [string, string]): object[] {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m_1", role: "assistant", content: [], phase: null },
    },
    {
      type: "response.output_text.delta",
      item_id: "m_1",
      output_index: 0,
      content_index: 0,
      delta: text[0],
    },
    {
      type: "response.output_text.delta",
      item_id: "m_1",
      output_index: 0,
      content_index: 0,
      delta: text[1],
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "m_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: text.join(""), annotations: [] }],
      },
    },
  ];
}

/** 一个 function_call 输出项（added → delta → done） */
function functionCallChunks(outputIndex: number, callId: string, args: string): object[] {
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: "finish",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: `fc_${callId}`,
      output_index: outputIndex,
      delta: args,
    },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: "finish",
        arguments: args,
        status: "completed",
      },
    },
  ];
}

/** 一个 reasoning 输出项（含 encrypted_content → providerData 回传路径） */
function reasoningChunks(encrypted: string | null): object[] {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "r_1", encrypted_content: encrypted, summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "r_1",
      output_index: 0,
      summary_index: 0,
      delta: "先想想",
    },
    {
      type: "response.reasoning_summary_part.done",
      item_id: "r_1",
      output_index: 0,
      summary_index: 0,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "r_1",
        encrypted_content: encrypted,
        summary: [{ type: "summary_text", text: "先想想" }],
      },
    },
  ];
}

async function collect(
  p: ReturnType<typeof createOpenAIResponsesProvider>,
  req: ModelRequest,
  signal?: AbortSignal,
) {
  const events: ModelStreamEvent[] = [];
  for await (const ev of p.stream(req, signal ?? new AbortController().signal)) events.push(ev);
  return events;
}

describe("openai-responses 适配器", () => {
  it("请求打到 {baseURL}/responses 且只发 Authorization: Bearer 鉴权头", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config({ credentials: async () => "sk-store" }),
      envNoKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(p, request());
    expect(capture.url).toBe("https://api.test/v1/responses");
    expect(capture.headers?.get("authorization")).toBe("Bearer sk-store");
    // 不发 anthropic 系鉴权头
    expect(capture.headers?.get("x-api-key")).toBeNull();
  });

  it("条目 headers 照带", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config({ headers: { "X-Custom": "yes" } }),
      envWithKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(p, request());
    expect(capture.headers?.get("x-custom")).toBe("yes");
  });

  it("文本流：text_delta → usage → finish(stop)，恰好一个 finish", async () => {
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...messageChunks(["hel", "lo"]), completed()]),
    );
    const events = await collect(p, request());
    expect(events[0]).toEqual({ type: "text_delta", text: "hel" });
    expect(events[1]).toEqual({ type: "text_delta", text: "lo" });
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toMatchObject({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 },
    });
  });

  it("请求体固定带 store:false 与 include reasoning.encrypted_content；max_output_tokens 随声明发送", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(p, request());
    expect(capture.body?.["store"]).toBe(false);
    expect(capture.body?.["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(capture.body?.["max_output_tokens"]).toBe(1024);
    // 未带档位时不出现 reasoning 字段
    expect(capture.body?.["reasoning"]).toBeUndefined();
  });

  it("maxOutputTokens 未声明时请求体不带 max_output_tokens", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(p, request({ maxOutputTokens: undefined }));
    expect("max_output_tokens" in (capture.body ?? {})).toBe(false);
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "reasoningEffort %s → reasoning.effort 原值 + summary auto（非名录模型经 forceReasoning 生效）",
    async (level) => {
      const capture: Captured = {};
      const p = createOpenAIResponsesProvider(
        config(),
        envWithKey,
        sseFetch([...messageChunks(["ok", ""]), completed()], capture),
      );
      await collect(p, request({ reasoningEffort: level }));
      expect(capture.body?.["reasoning"]).toEqual({ effort: level, summary: "auto" });
    },
  );

  it("推理流：reasoning_delta 文本 + providerData 携带 itemId/加密内容", async () => {
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...reasoningChunks("enc_abc"), ...messageChunks(["答", "案"]), completed()]),
    );
    const events = await collect(p, request());
    const deltas = events.filter((e) => e.type === "reasoning_delta");
    expect(deltas.map((d) => d.text).join("")).toBe("先想想");
    // 推理块边界事件上的专有数据已上送（末次携带加密内容）
    const withData = deltas.filter((d) => d.providerData !== undefined);
    expect(withData.length).toBeGreaterThan(0);
    const last = withData.at(-1)?.providerData as Record<string, Record<string, unknown>>;
    expect(last["openai"]).toMatchObject({
      itemId: "r_1",
      reasoningEncryptedContent: "enc_abc",
    });
  });

  it("推理块回传：providerData 还原为 encrypted_content 推理项（store:false）", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(
      p,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "先想想",
                provider: "zen",
                providerData: {
                  openai: { itemId: "r_1", reasoningEncryptedContent: "enc_abc" },
                },
              },
              { type: "text", text: "答" },
            ],
            toolCalls: [],
          },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ],
      }),
    );
    const input = capture.body?.["input"] as Record<string, unknown>[];
    const reasoningItem = input.find((i) => (i as { type?: string }).type === "reasoning") as
      Record<string, unknown> | undefined;
    expect(reasoningItem).toBeDefined();
    expect(reasoningItem?.["encrypted_content"]).toBe("enc_abc");
    expect(reasoningItem?.["summary"]).toEqual([{ type: "summary_text", text: "先想想" }]);
  });

  it("工具调用：tool-input delta 累积 → tool_call 完整入参；finish reason tool_calls", async () => {
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...functionCallChunks(0, "call_1", '{"result":"ok"}'), completed()]),
    );
    const events = await collect(p, request());
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({
      type: "tool_call",
      toolCallId: "call_1",
      name: "finish",
      input: { result: "ok" },
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_calls" });
  });

  it("并行工具调用：两个输出项各出一个 tool_call", async () => {
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([
        ...functionCallChunks(0, "call_a", '{"result":"a"}'),
        ...functionCallChunks(1, "call_b", '{"result":"b"}'),
        completed(),
      ]),
    );
    const events = await collect(p, request());
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.toolCallId).sort()).toEqual(["call_a", "call_b"]);
  });

  it("工具调用历史回传：providerCallId（call_id）与 function_call_output 配对", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(
      p,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            toolCalls: [
              { callId: "c1", providerCallId: "call_9", name: "finish", input: { result: "x" } },
            ],
          },
          { role: "tool", callId: "c1", name: "finish", content: "done", isError: false },
          { role: "user", content: [{ type: "text", text: "?" }] },
        ],
      }),
    );
    const input = capture.body?.["input"] as Record<string, unknown>[];
    const call = input.find((i) => i["type"] === "function_call") as
      Record<string, unknown> | undefined;
    const output = input.find((i) => i["type"] === "function_call_output") as
      Record<string, unknown> | undefined;
    expect(call?.["call_id"]).toBe("call_9");
    expect(call?.["name"]).toBe("finish");
    expect(output?.["call_id"]).toBe("call_9");
    expect(output?.["output"]).toBe("done");
  });

  it("HTTP 429 → ProviderError rate_limit；401 → auth", async () => {
    const httpError =
      (status: number): typeof fetch =>
      async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
    const p429 = createOpenAIResponsesProvider(config(), envWithKey, httpError(429));
    await expect(collect(p429, request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "rate_limit",
    });
    const p401 = createOpenAIResponsesProvider(config(), envWithKey, httpError(401));
    await expect(collect(p401, request())).rejects.toMatchObject({ kind: "auth" });
  });

  it("信号中止：流式中 abort → AbortError", async () => {
    const ac = new AbortController();
    const hanging: typeof fetch = async (_i, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const p = createOpenAIResponsesProvider(config(), envWithKey, hanging);
    const iter = p.stream(request(), ac.signal)[Symbol.asyncIterator]();
    const first = iter.next();
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("无凭据：不发请求即报 auth 错误", async () => {
    let called = 0;
    const p = createOpenAIResponsesProvider(config(), envNoKey, (async () => {
      called += 1;
      return new Response("x");
    }) as typeof fetch);
    await expect(collect(p, request())).rejects.toBeInstanceOf(ProviderError);
    await expect(collect(p, request())).rejects.toMatchObject({ kind: "auth" });
    expect(called).toBe(0);
  });
});
