/**
 * openai-compatible 适配器契约测试（离线）：stub fetch 注入 Chat Completions SSE，
 * 覆盖 toolChoice 映射与推理冲突处置（provider-api.md 第 3 节）。
 */
import { describe, expect, it } from "vitest";

import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from "./adapters/openai-compatible.js";
import type { ModelRequest, ModelStreamEvent } from "./types.js";

const envWithKey = (name: string) => (name === "TEST_OAI_KEY" ? "sk-test" : undefined);

function config(overrides: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    id: "oai",
    type: "openai-compatible",
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
    ],
    maxOutputTokens: 1024,
    ...overrides,
  };
}

function sseFetch(events: object[], capture?: { body?: Record<string, unknown> }) {
  return async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (capture !== undefined) {
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

const doneChunk = [
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
  },
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
];

/** 返回 finish 工具调用的流（toolChoice 请求下 SDK 强制校验调用存在） */
const finishCallChunk = [
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "finish", arguments: '{"result":"done"}' },
            },
          ],
        },
      },
    ],
  },
  {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
];

async function collect(p: ReturnType<typeof createOpenAICompatibleProvider>, req: ModelRequest) {
  const events: ModelStreamEvent[] = [];
  for await (const ev of p.stream(req, new AbortController().signal)) events.push(ev);
  return events;
}

describe("openai-compatible 适配器：toolChoice", () => {
  it("toolChoice 映射为具体 tool_choice（function 指定名）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config(),
      envWithKey,
      sseFetch(finishCallChunk, capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" } }));
    expect(capture.body?.["tool_choice"]).toEqual({
      type: "function",
      function: { name: "finish" },
    });
  });

  it("providerOptions 里可识别的推理键 + toolChoice：本轮移除推理键并保留 tool_choice", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const p = createOpenAICompatibleProvider(
      config({
        providerOptions: { reasoningEffort: "high", other: "keep" },
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      }),
      envWithKey,
      sseFetch(finishCallChunk, capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" } }));
    // 推理键本轮移除（兜底轮临时关闭），其余键保留；tool_choice 正常下发
    const body = capture.body ?? {};
    expect(Object.keys(body).some((k) => k.toLowerCase().includes("reasoning"))).toBe(false);
    expect(body["tool_choice"]).toEqual({
      type: "function",
      function: { name: "finish" },
    });
    expect(records.some((r) => r.kind === "provider.unsupported_capability")).toBe(true);
    expect(
      records.find((r) => r.kind === "provider.unsupported_capability")?.data["resolution"],
    ).toBe("disabled_reasoning");
  });

  it("归一化 reasoningEffort + toolChoice：无法安全关闭 → 丢弃 tool_choice", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const p = createOpenAICompatibleProvider(
      config({
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ toolChoice: { name: "finish" }, reasoningEffort: "high" }));
    // tool_choice 被丢弃：SDK 默认的 "auto" 不算具体指定（body 里没有 function 指定名）
    const tc = capture.body?.["tool_choice"];
    expect(tc === undefined || tc === "auto").toBe(true);
    expect(
      records.find((r) => r.kind === "provider.unsupported_capability")?.data["resolution"],
    ).toBe("dropped_tool_choice");
  });

  it("无 toolChoice 时行为不变（回归）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ providerOptions: { reasoningEffort: "high" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    const events = await collect(p, request());
    // 无 toolChoice：SDK 可能发默认 "auto"，绝不能出现具体指定
    const tc = capture.body?.["tool_choice"];
    expect(tc === undefined || tc === "auto").toBe(true);
    expect(Object.keys(capture.body ?? {}).some((k) => k.toLowerCase().includes("reasoning"))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: "finish" });
  });
});

describe("openai-compatible 适配器：reasoningEffort 映射（ADR-0018 §3）", () => {
  const noReasoningKeys = (body: Record<string, unknown>) =>
    Object.keys(body).filter((k) => k === "reasoning_effort" || k === "reasoning");

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "openai 格式：档位 %s 原样写入 reasoning_effort（max 也原样发送）",
    async (level) => {
      const capture: { body?: Record<string, unknown> } = {};
      const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
      await collect(p, request({ reasoningEffort: level }));
      expect(capture.body?.["reasoning_effort"]).toBe(level);
    },
  );

  it("openrouter 格式（thinking.format）：写入 reasoning.effort，不发 reasoning_effort", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ thinking: { format: "openrouter" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "max" }));
    expect(capture.body?.["reasoning"]).toEqual({ effort: "max" });
    expect(capture.body?.["reasoning_effort"]).toBeUndefined();
  });

  it("不带档位：请求体不出现任何思考字段", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(config(), envWithKey, sseFetch(doneChunk, capture));
    await collect(p, request());
    expect(noReasoningKeys(capture.body ?? {})).toEqual([]);
  });

  it("归一化字段覆盖同名 providerOptions 键（归一化胜出）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ providerOptions: { reasoning_effort: "minimal", other: "keep" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "high" }));
    expect(capture.body?.["reasoning_effort"]).toBe("high");
    // 其余 providerOptions 键正常透传
    expect(capture.body?.["other"]).toBe("keep");
  });

  it("连字符 provider id：providerOptions 写入驼峰命名空间（SDK 首选键）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({ id: "my-p", providerOptions: { other: "keep" } }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "high" }));
    expect(capture.body?.["reasoning_effort"]).toBe("high");
    expect(capture.body?.["other"]).toBe("keep");
  });

  it("openrouter 格式与既有 reasoning 对象键合并（effort 覆盖，其余保留）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const p = createOpenAICompatibleProvider(
      config({
        thinking: { format: "openrouter" },
        providerOptions: { reasoning: { exclude: true, effort: "low" } },
      }),
      envWithKey,
      sseFetch(doneChunk, capture),
    );
    await collect(p, request({ reasoningEffort: "xhigh" }));
    expect(capture.body?.["reasoning"]).toEqual({ exclude: true, effort: "xhigh" });
  });
});
