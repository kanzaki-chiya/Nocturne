/**
 * openai-responses 适配器契约测试（ADR-0031 §1）：stub fetch 回放
 * Responses SSE，覆盖文本、推理（含加密内容回传）、工具调用（含并行）、
 * 用量（缓存读、推理 token）、结束原因、错误映射、请求地址与鉴权头。
 */
import { describe, expect, it, vi } from "vitest";

import {
  createOpenAIResponsesProvider,
  type OpenAIResponsesConfig,
} from "./adapters/openai-responses.js";
import { ProviderError } from "./errors.js";
import type {
  AuthResolver,
  ModelRequest,
  ModelStreamEvent,
  ResponsesRequestConstraints,
} from "./types.js";

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

  it("上游先回响应头、内容迟到时，心跳在内容之前到达（ADR-0014 修订）", async () => {
    const base = sseFetch([...messageChunks(["ok", ""]), completed()]);
    const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const response = await base(input, init);
      const reader = response.body?.getReader();
      const delayed = new ReadableStream<Uint8Array>({
        async start(c) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          for (;;) {
            const chunk = await reader?.read();
            if (chunk === undefined || chunk.done) break;
            c.enqueue(chunk.value);
          }
          c.close();
        },
      });
      return new Response(delayed, { status: 200, headers: response.headers });
    };
    const p = createOpenAIResponsesProvider(config(), envWithKey, fetchImpl);
    const start = Date.now();
    const timeline: [string, number][] = [];
    for await (const ev of p.stream(request(), new AbortController().signal))
      timeline.push([ev.type, Date.now() - start]);
    const heartbeat = timeline.find(([type]) => type === "heartbeat");
    const text = timeline.find(([type]) => type === "text_delta");
    expect(heartbeat?.[1]).toBeLessThan(200);
    expect(text?.[1]).toBeGreaterThanOrEqual(250);
  });

  it("文本流：text_delta → usage → finish(stop)，恰好一个 finish", async () => {
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([...messageChunks(["hel", "lo"]), completed()]),
    );
    const events = await collect(p, request());
    // 上游开始响应时先发心跳（ADR-0014 修订），随后才是内容
    expect(events[0]).toEqual({ type: "heartbeat" });
    expect(events[1]).toEqual({ type: "text_delta", text: "hel" });
    expect(events[2]).toEqual({ type: "text_delta", text: "lo" });
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

  it("带 sessionId 时作为 prompt_cache_key 发送；配置已给时不覆盖；不带时不发", async () => {
    const send = async (extra: Parameters<typeof request>[0]) => {
      const capture: Captured = {};
      const p = createOpenAIResponsesProvider(
        config(),
        envWithKey,
        sseFetch([...messageChunks(["ok", ""]), completed()], capture),
      );
      await collect(p, request(extra));
      return capture.body?.["prompt_cache_key"];
    };
    expect(await send({ sessionId: "sess-1" })).toBe("sess-1");
    expect(await send({ sessionId: "sess-1", providerOptions: { promptCacheKey: "custom" } })).toBe(
      "custom",
    );
    expect(await send({})).toBeUndefined();
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

  it("推理摘要分段：段间补空行，不首尾相连", async () => {
    const [added = {}, delta0 = {}, done0 = {}, itemDone = {}] = reasoningChunks("enc_abc");
    const part = { item_id: "r_1", output_index: 0, summary_index: 1 };
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch([
        added,
        { ...delta0, delta: "**A**" },
        done0,
        { type: "response.reasoning_summary_part.added", ...part },
        { type: "response.reasoning_summary_text.delta", ...part, delta: "**B**" },
        { type: "response.reasoning_summary_part.done", ...part },
        itemDone,
        ...messageChunks(["ok", ""]),
        completed(),
      ]),
    );
    const events = await collect(p, request());
    const text = events
      .filter((e) => e.type === "reasoning_delta")
      .map((d) => d.text)
      .join("");
    expect(text).toBe("**A**\n\n**B**");
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

  it("混合历史只回传有 OpenAI 标识的推理，丢弃诊断不含正文且没有 SDK 警告", async () => {
    const capture: Captured = {};
    const records: { kind: string; data: unknown }[] = [];
    const p = createOpenAIResponsesProvider(
      config({ diagnostics: { record: (kind, data) => records.push({ kind, data }) } }),
      envWithKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    const mixed = request({
      messages: [
        {
          role: "assistant",
          toolCalls: [],
          content: [
            { type: "reasoning", text: "foreign secret" },
            {
              type: "reasoning",
              text: "missing id secret",
              providerData: { openai: { reasoningEncryptedContent: "x" } },
            },
            {
              type: "reasoning",
              text: "valid",
              providerData: { openai: { itemId: "r_1", reasoningEncryptedContent: "enc_abc" } },
            },
            { type: "text", text: "answer" },
          ],
        },
        {
          role: "assistant",
          toolCalls: [],
          content: [{ type: "reasoning", text: "only foreign" }],
        },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
    });
    const original = JSON.stringify(mixed);
    await collect(p, mixed);
    const input = capture.body?.["input"] as Record<string, unknown>[];
    expect(input.filter((item) => item["type"] === "reasoning")).toEqual([
      {
        type: "reasoning",
        id: "r_1",
        encrypted_content: "enc_abc",
        summary: [{ type: "summary_text", text: "valid" }],
      },
    ]);
    expect(records).toEqual([
      { kind: "provider.reasoning_dropped", data: { count: 3, reason: "missing_openai_item_id" } },
    ]);
    expect(JSON.stringify(mixed)).toBe(original);
  });

  it("同服务商连续两轮：流中保存的推理标识与加密内容原样回放", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch(
        [...reasoningChunks("enc_round1"), ...messageChunks(["答", "案"]), completed()],
        capture,
      ),
    );
    const first = await collect(p, request());
    const reasoning = first.filter((event) => event.type === "reasoning_delta");
    const providerData = reasoning
      .filter((event) => event.providerData !== undefined)
      .at(-1)?.providerData;
    await collect(
      p,
      request({
        messages: [
          ...request().messages,
          {
            role: "assistant",
            toolCalls: [],
            content: [
              {
                type: "reasoning",
                text: reasoning.map((event) => event.text).join(""),
                provider: "zen",
                providerData,
              },
              { type: "text", text: "答案" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "继续" }] },
        ],
      }),
    );
    const input = capture.body?.["input"] as Record<string, unknown>[];
    expect(input.find((item) => item["type"] === "reasoning")).toEqual({
      type: "reasoning",
      id: "r_1",
      encrypted_content: "enc_round1",
      summary: [{ type: "summary_text", text: "先想想" }],
    });
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

const constraints: ResponsesRequestConstraints = {
  omitFields: [
    "max_output_tokens",
    "temperature",
    "top_p",
    "metadata",
    "truncation",
    "user",
    "prompt_cache_retention",
    "safety_identifier",
    "previous_response_id",
  ],
  systemAsInstructions: true,
  namespaceTools: true,
  requireCompleted: true,
};

function constrainedConfig(overrides: Partial<AuthResolver> = {}): OpenAIResponsesConfig {
  return config({
    authResolver: {
      token: async () => "test-access",
      invalidate: () => Promise.resolve(),
      requestConstraints: constraints,
      ...overrides,
    },
  });
}

describe("声明式 Responses 约束（ADR-0042 §5）", () => {
  it("粘性路由头：响应返回的令牌在同一会话后续请求带回，其他会话不带", async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    const base = sseFetch([...messageChunks(["ok", ""]), completed()]);
    const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers).get("x-route"));
      const response = await base(input, init);
      n += 1;
      response.headers.set("x-route", `tok-${n}`);
      return response;
    };
    const p = createOpenAIResponsesProvider(
      constrainedConfig({
        requestConstraints: { ...constraints, stickyRoutingHeader: "x-route" },
      }),
      envNoKey,
      fetchImpl,
    );
    await collect(p, request({ sessionId: "a" }));
    await collect(p, request({ sessionId: "a" }));
    await collect(p, request({ sessionId: "b" }));
    expect(seen).toEqual([null, "tok-1", null]);
  });

  it("通道声明的会话头：条目未声明时按通道头名发送会话 ID", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      constrainedConfig({ requestConstraints: { ...constraints, sessionHeader: "session_id" } }),
      envNoKey,
      sseFetch([...messageChunks(["ok", ""]), completed()], capture),
    );
    await collect(p, request({ sessionId: "sess-9" }));
    expect(capture.headers?.get("session_id")).toBe("sess-9");
    expect(capture.body?.["prompt_cache_key"]).toBe("sess-9");
  });

  it("请求快照：system 转 instructions、函数 namespace、禁用参数、保留加密推理", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      constrainedConfig(),
      envNoKey,
      sseFetch(
        [
          ...functionCallChunks(0, "call_echo", "{}").map(
            (event) =>
              JSON.parse(
                JSON.stringify(event).replaceAll('"finish"', '"functions.echo"'),
              ) as object,
          ),
          completed(),
        ],
        capture,
      ),
    );
    await collect(
      p,
      request({
        tools: [
          {
            name: "echo",
            description: "回显",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
        providerOptions: {
          metadata: { secret: "should-not-send" },
          truncation: "auto",
          previousResponseId: "must-not-send",
          user: "user",
          safetyIdentifier: "private",
          promptCacheRetention: "24h",
        },
        toolChoice: { name: "echo" },
      }),
    );
    expect(capture.body).toMatchObject({
      model: "gpt-x",
      store: false,
      stream: true,
      instructions: "sys",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "Tools provided by the local coding agent",
          tools: [
            {
              type: "function",
              name: "echo",
              description: "回显",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        },
      ],
      tool_choice: { type: "function", name: "echo", namespace: "functions" },
      include: ["reasoning.encrypted_content"],
    });
    for (const field of constraints.omitFields) expect(capture.body).not.toHaveProperty(field);
  });

  it("工具两轮往返：入站流和 completed 名称还原，历史带 namespace 且 call_id 配对", async () => {
    const capture: Captured = {};
    const chunks = functionCallChunks(0, "call_1", '{"result":"ok"}').map(
      (event) =>
        JSON.parse(JSON.stringify(event).replaceAll('"finish"', '"functions.finish"')) as object,
    );
    const p = createOpenAIResponsesProvider(
      constrainedConfig(),
      envNoKey,
      sseFetch(
        [
          ...chunks,
          completed({
            output: [
              {
                type: "function_call",
                id: "fc_call_1",
                call_id: "call_1",
                name: "functions.finish",
                arguments: '{"result":"ok"}',
                status: "completed",
              },
            ],
          }),
        ],
        capture,
      ),
    );
    const first = await collect(p, request());
    expect(first.filter((event) => event.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        toolCallId: "call_1",
        name: "finish",
        input: { result: "ok" },
        rawInput: undefined,
      },
    ]);
    expect(
      first
        .filter((event) => event.type === "tool_call_delta")
        .every((event) => event.name === "finish"),
    ).toBe(true);
    await collect(
      p,
      request({
        messages: [
          ...request().messages,
          {
            role: "assistant",
            content: [],
            toolCalls: [
              {
                callId: "local",
                providerCallId: "call_1",
                name: "finish",
                input: { result: "ok" },
              },
            ],
          },
          { role: "tool", callId: "local", name: "finish", content: "done", isError: false },
        ],
      }),
    );
    // 历史调用名不带点号（通道要求 ^[a-zA-Z0-9_-]+$），命名空间单列
    expect(capture.body?.input).toContainEqual({
      type: "function_call",
      call_id: "call_1",
      name: "finish",
      namespace: "functions",
      arguments: '{"result":"ok"}',
    });
    for (const item of capture.body?.input as { name?: string }[])
      if (item.name !== undefined) expect(item.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(capture.body?.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "done",
    });
  });

  it.each(["EOF", "response.incomplete"])(
    "%s 缺 completed 时可重试，不能发成功 finish",
    async (ending) => {
      const streamEvents: object[] = messageChunks(["part", "ial"]);
      if (ending === "response.incomplete")
        streamEvents.push({ ...completed(), type: "response.incomplete" });
      const p = createOpenAIResponsesProvider(
        constrainedConfig(),
        envNoKey,
        sseFetch(streamEvents),
      );
      const events: ModelStreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of p.stream(request(), new AbortController().signal))
            events.push(event);
        })(),
      ).rejects.toMatchObject({ kind: "network", retryable: true });
      expect(events.some((event) => event.type === "finish")).toBe(false);
    },
  );

  it("API key 通道仍接受 EOF 的 SDK finish、发送原函数名与 max_output_tokens", async () => {
    const capture: Captured = {};
    const p = createOpenAIResponsesProvider(
      config(),
      envWithKey,
      sseFetch(messageChunks(["o", "k"]), capture),
    );
    expect((await collect(p, request())).at(-1)).toMatchObject({ type: "finish" });
    expect(capture.body).toHaveProperty("max_output_tokens", 1024);
    expect(capture.body?.tools).toContainEqual(
      expect.objectContaining({ type: "function", name: "finish" }),
    );
    expect(capture.body).not.toHaveProperty("instructions");
  });

  const mappings = [
    [
      429,
      "subscription_sharing_usage_limit_exceeded",
      "rate_limit",
      false,
      "ChatGPT 套餐额度已用完，稍后再试或换模型",
    ],
    [
      403,
      "subscription_sharing_user_not_eligible",
      "auth",
      false,
      "该 ChatGPT 账号的套餐不支持第三方应用调用",
    ],
    [
      400,
      "subscription_sharing_unsupported_capability",
      "invalid_request",
      false,
      "该功能不支持经 ChatGPT 账号调用，请调整模型或请求参数",
    ],
    [503, "subscription_sharing_usage_unavailable", "server", true, "ChatGPT 额度服务暂不可用"],
  ] as const;
  for (const shape of ["detail", "error.code"] as const) {
    it.each(mappings)(`${shape}：HTTP %i / %s`, async (status, code, kind, retryable, message) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            JSON.stringify(
              shape === "detail"
                ? { detail: code, extra: "secret-access" }
                : { error: { code, message: "secret-access" } },
            ),
            { status, headers: { "content-type": "application/json" } },
          ),
      );
      const p = createOpenAIResponsesProvider(constrainedConfig(), envNoKey, fetch);
      await expect(collect(p, request())).rejects.toMatchObject({
        kind,
        retryable,
        message,
        status,
        providerMessage: undefined,
        cause: undefined,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it("第二个 401 用 resolver 提示，invalidate 一次，不返回正文/令牌", async () => {
    const invalidate = vi.fn(() => Promise.resolve());
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("secret-access", { status: 401 }),
    );
    const p = createOpenAIResponsesProvider(
      constrainedConfig({
        invalidate,
        unauthorizedMessage: "ChatGPT 登录已失效，请执行 /provider login",
      }),
      envNoKey,
      fetch,
    );
    await expect(collect(p, request())).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
      message: "ChatGPT 登录已失效，请执行 /provider login",
      providerMessage: undefined,
      cause: undefined,
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("流中失败按安全错误映射，未知坏 JSON 不泄漏正文", async () => {
    const p = createOpenAIResponsesProvider(
      constrainedConfig(),
      envNoKey,
      sseFetch([
        {
          type: "error",
          code: "subscription_sharing_usage_limit_exceeded",
          message: "secret-access",
        },
      ]),
    );
    await expect(collect(p, request())).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: false,
      providerMessage: undefined,
      cause: undefined,
    });
    const broken = createOpenAIResponsesProvider(
      constrainedConfig(),
      envNoKey,
      async () =>
        new Response("data: secret-access\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await expect(collect(broken, request())).rejects.toMatchObject({
      kind: "network",
      retryable: true,
      message: "服务商响应流中断，请重试",
      providerMessage: undefined,
      cause: undefined,
    });
  });
});
