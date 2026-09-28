/**
 * anthropic 适配器契约测试（离线）：stub fetch 注入 Anthropic Messages SSE，
 * 验证请求转换、流式归一化、签名回传、错误映射与中止。
 */
import { describe, expect, it } from "vitest";

import { createAnthropicProvider, type AnthropicConfig } from "./adapters/anthropic.js";
import { ProviderError } from "./errors.js";
import type { ModelRequest, ModelStreamEvent } from "./types.js";
import type { ReasoningEffortLevel } from "../protocol/index.js";

const envWithKey = (name: string) => (name === "TEST_ANTHROPIC_KEY" ? "sk-test" : undefined);

function config(overrides: Partial<AnthropicConfig> = {}): AnthropicConfig {
  return {
    id: "claude",
    type: "anthropic",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_ANTHROPIC_KEY",
    models: { "claude-x": {} },
    ...overrides,
  };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "claude-x",
    system: [{ text: "sys" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxOutputTokens: 1024,
    ...overrides,
  };
}

function sseFetch(events: object[], capture?: { body?: unknown; url?: string }) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (capture !== undefined) {
      capture.url = String(input);
      capture.body = JSON.parse(String(init?.body));
    }
    const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
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

function errorFetch(status: number, body: object) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

async function collect(p: ReturnType<typeof createAnthropicProvider>, req: ModelRequest) {
  const events: ModelStreamEvent[] = [];
  for await (const ev of p.stream(req, new AbortController().signal)) events.push(ev);
  return events;
}

const msgStart = (inputTokens = 10) => ({
  type: "message_start",
  message: { id: "msg_1", model: "claude-x", usage: { input_tokens: inputTokens } },
});
const msgEnd = (reason: string, outputTokens = 5) => [
  {
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: { output_tokens: outputTokens },
  },
  { type: "message_stop" },
];

describe("anthropic 适配器", () => {
  it("缺少凭据环境变量 → auth ProviderError（无网络）", async () => {
    const p = createAnthropicProvider(config(), () => undefined);
    await expect(collect(p, request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "auth",
    });
  });

  it("文本流：text_delta + usage + finish(stop)", async () => {
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([
        msgStart(),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        },
        { type: "content_block_stop", index: 0 },
        ...msgEnd("end_turn"),
      ]),
    );
    const events = await collect(p, request());
    expect(events).toContainEqual({ type: "text_delta", text: "hello" });
    expect(events).toContainEqual({
      type: "usage",
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it("工具调用：input_json_delta 累积为 tool_call（含解析后的 input）", async () => {
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([
        msgStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "read" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
        },
        { type: "content_block_stop", index: 0 },
        ...msgEnd("tool_use"),
      ]),
    );
    const events = await collect(
      p,
      request({
        tools: [
          {
            name: "read",
            description: "读文件",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_call_delta", toolCallId: "toolu_1", name: "read" }),
    );
    expect(events).toContainEqual({
      type: "tool_call",
      toolCallId: "toolu_1",
      name: "read",
      input: { path: "a.txt" },
      rawInput: undefined,
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool_calls" });
  });

  it("推理流：thinking_delta → reasoning_delta；signature_delta → providerData", async () => {
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([
        msgStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "想想" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig123" },
        },
        { type: "content_block_stop", index: 0 },
        ...msgEnd("end_turn"),
      ]),
    );
    const events = await collect(p, request());
    expect(events).toContainEqual({ type: "reasoning_delta", text: "想想" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "reasoning_delta",
        providerData: { anthropic: { signature: "sig123" } },
      }),
    );
  });

  it("签名回传：assistant 推理块的 providerData 还原为 thinking 块", async () => {
    const capture: { body?: { messages?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(
      p,
      request({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "当时的推理",
                providerData: { anthropic: { signature: "sig123" } },
              },
              { type: "text", text: "回答" },
            ],
            toolCalls: [],
          },
          { role: "user", content: [{ type: "text", text: "继续" }] },
        ],
      }),
    );
    const messages = capture.body?.messages as
      | { role: string; content: { type: string; signature?: string; thinking?: string }[] }[]
      | undefined;
    const assistant = messages?.[0];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toContainEqual({
      type: "thinking",
      thinking: "当时的推理",
      signature: "sig123",
    });
    expect(assistant?.content).toContainEqual({ type: "text", text: "回答" });
  });

  it("无 providerData 的推理块回传为不带 signature 的结构（适配器告警但不崩）", async () => {
    const capture: { body?: { messages?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(
      p,
      request({
        messages: [
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "无签名推理" }],
            toolCalls: [],
          },
        ],
      }),
    );
    // sendReasoning 默认开启但缺 signature → 该块被丢弃（不进 messages）
    const messages = capture.body?.messages as { content: unknown[] }[] | undefined;
    expect(messages?.[0]?.content ?? []).not.toContainEqual(
      expect.objectContaining({ type: "thinking" }),
    );
  });

  it("工具往返：tool_use 回传 + tool_result 携带同一线上 id", async () => {
    const capture: { body?: { messages?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(
      p,
      request({
        messages: [
          {
            role: "assistant",
            content: [],
            toolCalls: [{ callId: "c1", providerCallId: "toolu_1", name: "read", input: {} }],
          },
          { role: "tool", callId: "c1", name: "read", content: "文件内容", isError: false },
        ],
      }),
    );
    const messages = capture.body?.messages as
      { role: string; content: Record<string, unknown>[] }[] | undefined;
    expect(messages?.[0]?.content).toContainEqual(
      expect.objectContaining({ type: "tool_use", id: "toolu_1", name: "read" }),
    );
    expect(messages?.[1]?.content).toContainEqual(
      expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_1" }),
    );
  });

  it("历史 mcp__ 调用（服务器缺失、未声明 tools）仍生成合法 tool_use/tool_result 配对", async () => {
    const capture: { body?: { messages?: unknown[]; tools?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(
      p,
      request({
        tools: [], // MCP 服务器本次未配置/启动失败 → 工具未声明
        messages: [
          {
            role: "assistant",
            content: [],
            toolCalls: [
              {
                callId: "c1",
                providerCallId: "toolu_m1",
                name: "mcp__gone__echo",
                input: { text: "hi" },
              },
            ],
          },
          { role: "tool", callId: "c1", name: "mcp__gone__echo", content: "ok", isError: false },
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ],
      }),
    );
    const messages = capture.body?.messages as
      { role: string; content: Record<string, unknown>[] }[] | undefined;
    expect(messages?.[0]?.content).toContainEqual(
      expect.objectContaining({ type: "tool_use", id: "toolu_m1", name: "mcp__gone__echo" }),
    );
    expect(messages?.[1]?.content).toContainEqual(
      expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_m1" }),
    );
    // tools 未声明时序列化为空数组或不出现，但绝不能含悬空声明
    expect(capture.body?.tools ?? []).toEqual([]);
  });

  it("HTTP 429 → rate_limit ProviderError", async () => {
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      errorFetch(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
    );
    await expect(collect(p, request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "rate_limit",
      status: 429,
    });
  });

  it("HTTP 400 'prompt is too long' → context_overflow", async () => {
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      errorFetch(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 213000 tokens" },
      }),
    );
    await expect(collect(p, request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "context_overflow",
    });
  });

  it("HTTP 401 → auth；529 → overloaded", async () => {
    const p401 = createAnthropicProvider(
      config(),
      envWithKey,
      errorFetch(401, {
        type: "error",
        error: { type: "authentication_error", message: "bad key" },
      }),
    );
    await expect(collect(p401, request())).rejects.toMatchObject({ kind: "auth" });
    const p529 = createAnthropicProvider(
      config(),
      envWithKey,
      errorFetch(529, { type: "error", error: { type: "overloaded_error", message: "busy" } }),
    );
    await expect(collect(p529, request())).rejects.toMatchObject({ kind: "overloaded" });
  });

  it("预先中止的 signal → AbortError", async () => {
    const p = createAnthropicProvider(config(), envWithKey, async () => {
      return new Response("data: {}\n\n", { status: 200 });
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const consume = async () => {
      for await (const _ of p.stream(request(), ctrl.signal)) void _;
    };
    await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("流中 error 事件 → ProviderError（mapped）", async () => {
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([
        msgStart(),
        {
          type: "error",
          error: { type: "overloaded_error", message: "mid-stream overload", statusCode: 529 },
        },
      ]),
    );
    await expect(collect(p, request())).rejects.toBeInstanceOf(ProviderError);
  });

  it("providerOptions：配置级与请求级合并进 anthropic 命名空间，请求级覆盖", async () => {
    const capture: { body?: unknown; url?: string } = {};
    const p = createAnthropicProvider(
      // Provider ID 是自定义的 "claude"，不是 "anthropic"——
      // 选项仍必须落在 SDK 规定的 anthropic 命名空间
      config({
        providerOptions: {
          thinking: { type: "enabled", budgetTokens: 4096 },
          serviceTier: "standard_only",
        },
      }),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(
      p,
      request({ providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } } }),
    );
    const body = capture.body as Record<string, unknown>;
    // 请求级 thinking 覆盖配置级（浅合并）；配置级 serviceTier 保留
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body["service_tier"]).toBe("standard_only");
  });

  it("toolChoice 映射为具体 tool_choice（type:tool）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch(
        [
          msgStart(),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "finish" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"result":"done"}' },
          },
          { type: "content_block_stop", index: 0 },
          ...msgEnd("tool_use"),
        ],
        capture,
      ),
    );
    await collect(
      p,
      request({
        toolChoice: { name: "finish" },
        tools: [
          {
            name: "finish",
            description: "提交结果",
            inputSchema: { type: "object", properties: { result: { type: "string" } } },
          },
        ],
      }),
    );
    expect(capture.body?.["tool_choice"]).toEqual({ type: "tool", name: "finish" });
  });

  it("扩展思考 + toolChoice：本轮移除 thinking 并保留 tool_choice（兜底轮临时关思考）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const p = createAnthropicProvider(
      config({
        providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } },
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      }),
      envWithKey,
      sseFetch(
        [
          msgStart(),
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "finish" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"result":"done"}' },
          },
          { type: "content_block_stop", index: 0 },
          ...msgEnd("tool_use"),
        ],
        capture,
      ),
    );
    // thinking + 具体 tool_choice 会被服务端 400；适配器本轮关闭思考让强制生效
    await collect(
      p,
      request({
        toolChoice: { name: "finish" },
        providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } },
        tools: [
          {
            name: "finish",
            description: "提交结果",
            inputSchema: { type: "object", properties: { result: { type: "string" } } },
          },
        ],
      }),
    );
    expect(capture.body?.["thinking"]).toBeUndefined();
    expect(capture.body?.["tool_choice"]).toEqual({ type: "tool", name: "finish" });
    expect(
      records.find((r) => r.kind === "provider.unsupported_capability")?.data["resolution"],
    ).toBe("disabled_reasoning");
  });

  it("归一化 reasoningEffort + toolChoice：无法安全关闭 → 丢弃 tool_choice", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const p = createAnthropicProvider(
      config({
        providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } },
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      }),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" }, reasoningEffort: "high" }));
    expect(capture.body?.["tool_choice"]).toBeUndefined();
    // thinking 保留（丢弃的是 toolChoice 而非用户配置）
    expect(capture.body?.["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });
    // request.maxOutputTokens=1024 容不下 high 预算 → thinking_omitted；
    // 归一化档位 + toolChoice 另有 dropped_tool_choice 诊断
    expect(
      records.some(
        (r) =>
          r.kind === "provider.unsupported_capability" &&
          r.data["resolution"] === "dropped_tool_choice",
      ),
    ).toBe(true);
  });

  it("providerOptions：仅配置级时同样下发；无选项时不产生多余字段", async () => {
    const capture: { body?: unknown; url?: string } = {};
    const p = createAnthropicProvider(
      config({ providerOptions: { speed: "fast" } }),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(p, request());
    const body = capture.body as Record<string, unknown>;
    expect(body["speed"]).toBe("fast");

    const capture2: { body?: unknown; url?: string } = {};
    const p2 = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture2),
    );
    await collect(p2, request());
    const body2 = capture2.body as Record<string, unknown>;
    expect(body2["thinking"]).toBeUndefined();
    expect(body2["service_tier"]).toBeUndefined();
    expect(body2["speed"]).toBeUndefined();
  });
});

describe("anthropic 适配器：reasoningEffort → thinking.budget_tokens（ADR-0018 §3）", () => {
  const budgets: [ReasoningEffortLevel, number][] = [
    ["minimal", 1024],
    ["low", 4096],
    ["medium", 8192],
    ["high", 16384],
    ["xhigh", 32768],
    ["max", 32768],
  ];

  it.each(budgets)(
    "档位 %s → thinking.budget_tokens=%d（max 也走预算换算）",
    async (level, budget) => {
      const capture: { body?: unknown } = {};
      const p = createAnthropicProvider(
        config(),
        envWithKey,
        sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
      );
      await collect(p, request({ reasoningEffort: level, maxOutputTokens: 64_000 }));
      expect((capture.body as Record<string, unknown>)["thinking"]).toEqual({
        type: "enabled",
        budget_tokens: budget,
      });
      expect((capture.body as Record<string, unknown>)["max_tokens"]).toBe(64_000);
    },
  );

  it("thinking.budgets 覆盖表生效", async () => {
    const capture: { body?: unknown } = {};
    const p = createAnthropicProvider(
      config({ thinking: { budgets: { low: 2048 } } }),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(p, request({ reasoningEffort: "low", maxOutputTokens: 64_000 }));
    expect((capture.body as Record<string, unknown>)["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
  });

  it("max_tokens 不满足预算+余量：声明上限内先抬升（未声明时用兜底再抬）", async () => {
    const capture: { body?: unknown } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    // 未声明输出上限 → 兜底 8192 放不下 high(16384)+1024 → 抬到 17408
    await collect(p, request({ reasoningEffort: "high", maxOutputTokens: undefined }));
    const body = capture.body as Record<string, unknown>;
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(body["max_tokens"]).toBe(16384 + 1024);
  });

  it("声明上限太小：预算压到上限-余量；压不到协议下限则不发送 thinking", async () => {
    const capture: { body?: unknown } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    // 声明 8192：high(16384) 压到 7168
    await collect(p, request({ reasoningEffort: "high", maxOutputTokens: 8192 }));
    expect((capture.body as Record<string, unknown>)["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 7168,
    });
    expect((capture.body as Record<string, unknown>)["max_tokens"]).toBe(8192);

    // 声明 1024：压不到 1024 下限 → thinking 整段不发送 + 诊断
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const capture2: { body?: unknown } = {};
    const p2 = createAnthropicProvider(
      config({ diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) } }),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture2),
    );
    await collect(p2, request({ reasoningEffort: "minimal", maxOutputTokens: 1024 }));
    expect((capture2.body as Record<string, unknown>)["thinking"]).toBeUndefined();
    expect(
      records.find((r) => r.kind === "provider.unsupported_capability")?.data["resolution"],
    ).toBe("thinking_omitted");
  });

  it("不带档位：请求体不出现 thinking 字段", async () => {
    const capture: { body?: unknown } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...msgEnd("end_turn")], capture),
    );
    await collect(p, request({ maxOutputTokens: 64_000 }));
    expect((capture.body as Record<string, unknown>)["thinking"]).toBeUndefined();
  });
});

describe("anthropic 适配器：图片（ADR-0023）", () => {
  const png = { mimeType: "image/png" as const, data: "aVZCT1I=" };
  const end = [...msgEnd("end_turn")];

  it("tool 结果带图 → tool_result.content 含原生 image 块", async () => {
    const capture: { body?: { messages?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...end], capture),
    );
    await collect(
      p,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            toolCalls: [{ callId: "c1", name: "read" }],
          },
          {
            role: "tool",
            callId: "c1",
            name: "read",
            content: "r1",
            isError: false,
            images: [png],
          },
        ],
      }),
    );
    const msgs = (capture.body?.messages ?? []) as {
      role: string;
      content: { type: string; [k: string]: unknown }[];
    }[];
    const toolResultMsg = msgs.at(-1);
    expect(toolResultMsg?.role).toBe("user");
    const tr = toolResultMsg?.content.find((b) => b.type === "tool_result");
    expect(tr?.["tool_use_id"]).toBe("c1");
    expect(tr?.["content"]).toEqual([
      { type: "text", text: "r1" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aVZCT1I=" } },
    ]);
  });

  it("isError 带图：图片丢弃，文本末追加 [image omitted: error result]", async () => {
    const capture: { body?: { messages?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...end], capture),
    );
    await collect(
      p,
      request({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            toolCalls: [{ callId: "c1", name: "read" }],
          },
          {
            role: "tool",
            callId: "c1",
            name: "read",
            content: "boom",
            isError: true,
            images: [png],
          },
        ],
      }),
    );
    const msgs = (capture.body?.messages ?? []) as {
      content: { type: string; [k: string]: unknown }[];
    }[];
    const tr = msgs.at(-1)?.content.find((b) => b.type === "tool_result");
    expect(tr?.["is_error"]).toBe(true);
    expect(tr?.["content"]).toBe("boom\n[image omitted: error result]");
    expect(JSON.stringify(tr)).not.toContain('"type":"image"');
  });

  it("用户消息图片 → image 块", async () => {
    const capture: { body?: { messages?: unknown[] } } = {};
    const p = createAnthropicProvider(
      config(),
      envWithKey,
      sseFetch([msgStart(), ...end], capture),
    );
    await collect(
      p,
      request({
        messages: [{ role: "user", content: [{ type: "text", text: "look" }], images: [png] }],
      }),
    );
    const msgs = (capture.body?.messages ?? []) as {
      content: { type: string; [k: string]: unknown }[];
    }[];
    expect(msgs[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aVZCT1I=" } },
    ]);
  });
});
