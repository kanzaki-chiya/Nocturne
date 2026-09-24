import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelStreamEvent } from "./index.js";
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  FakeProvider,
  isProviderError,
  ProviderError,
  resolveModelInfo,
  UnknownModelError,
} from "./index.js";

const REQ: ModelRequest = {
  model: "fake-1",
  system: [{ text: "sys" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxOutputTokens: 1024,
};

async function collect(iter: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe("FakeProvider", () => {
  it("按脚本逐次返回流式事件，以 finish 结束", async () => {
    const p = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "hello" },
          {
            type: "tool_call",
            toolCallId: "p1",
            name: "read",
            input: { path: "a.ts" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const s1 = await collect(p.stream(REQ, new AbortController().signal));
    expect(s1.map((e) => e.type)).toEqual(["text_delta", "tool_call", "finish"]);
    const s2 = await collect(p.stream(REQ, new AbortController().signal));
    expect(s2.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(p.requests).toHaveLength(2);
  });

  it("脚本缺少 finish 时自动补 finish", async () => {
    const p = new FakeProvider({ scripts: [[{ type: "text_delta", text: "x" }]] });
    const events = await collect(p.stream(REQ, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("finish 之后的事件被丢弃", async () => {
    const p = new FakeProvider({
      scripts: [
        [
          { type: "finish", reason: "stop" },
          { type: "text_delta", text: "late" },
        ],
      ],
    });
    const events = await collect(p.stream(REQ, new AbortController().signal));
    expect(events).toHaveLength(1);
  });

  it("throw 条目抛出错误（模拟 ProviderError）", async () => {
    const err = new ProviderError({ kind: "rate_limit", message: "limited" });
    const p = new FakeProvider({ scripts: [[{ type: "throw", error: err }]] });
    await expect(collect(p.stream(REQ, new AbortController().signal))).rejects.toBe(err);
  });

  it("signal 中止时抛出 AbortError", async () => {
    const p = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "a" },
          { type: "text_delta", text: "b" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const c = new AbortController();
    const iter = p.stream(REQ, c.signal)[Symbol.asyncIterator]();
    await iter.next(); // 消费第一个事件
    c.abort();
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ProviderRegistry / 模型目录", () => {
  it("resolve 返回 provider 与合并后的 ModelInfo", () => {
    const fake = new FakeProvider({ id: "fake" });
    const registry = createProviderRegistry([fake], {
      fake: { "fake-1": { contextWindow: 64_000 } },
    });
    const { provider, model } = registry.resolve({
      provider: "fake",
      model: "fake-1",
    });
    expect(provider).toBe(fake);
    expect(model.contextWindow).toBe(64_000);
    expect(model.capabilities.toolCalls).toBe(true);
  });

  it("未配置 Provider → UnknownModelError", () => {
    const registry = createProviderRegistry([]);
    expect(() => registry.resolve({ provider: "nope", model: "m" })).toThrowError(
      UnknownModelError,
    );
  });

  it("resolveModelInfo：内置目录 ← 覆盖 ← 保守默认", () => {
    const ds = resolveModelInfo({ provider: "deepseek", model: "deepseek-chat" }, undefined);
    expect(ds.contextWindow).toBe(128_000);
    const overridden = resolveModelInfo(ds.ref, { contextWindow: 96_000 });
    expect(overridden.contextWindow).toBe(96_000);
    const unknown = resolveModelInfo({ provider: "x", model: "y" }, undefined);
    expect(unknown.capabilities.toolCalls).toBe(false);
  });
});

describe("ProviderError", () => {
  it("默认可重试 kind", () => {
    expect(new ProviderError({ kind: "rate_limit", message: "x" }).retryable).toBe(true);
    expect(new ProviderError({ kind: "auth", message: "x" }).retryable).toBe(false);
    expect(isProviderError(new ProviderError({ kind: "auth", message: "x" }))).toBe(true);
  });
});

describe("openai-compatible 适配器", () => {
  it("缺少凭据环境变量 → auth ProviderError（无网络）", async () => {
    const p = createOpenAICompatibleProvider(
      {
        id: "test",
        baseURL: "http://127.0.0.1:1/v1",
        apiKeyEnv: "NOCTURNE_TEST_DEFINITELY_MISSING_KEY",
        models: { "m-1": { contextWindow: 1000 } },
      },
      () => undefined,
    );
    expect(p.type).toBe("openai-compatible");
    expect(p.models()[0]?.contextWindow).toBe(1000);
    await expect(
      collect(p.stream({ ...REQ, model: "m-1" }, new AbortController().signal)),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("历史 mcp__ 调用（服务器缺失、未声明 tools）仍生成合法 tool_calls/tool 配对", async () => {
    // 验收 D（mcp.md）：恢复会话时 MCP 服务器不在，发给 openai-compatible
    // 的请求中历史调用必须保持 assistant.tool_calls ↔ tool 消息 id 配对
    const capture: { body?: Record<string, unknown> } = {};
    const sseFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const chunks = [
        { id: "x", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
        {
          id: "x",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ];
      const payload =
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(payload));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const p = createOpenAICompatibleProvider(
      {
        id: "test",
        baseURL: "http://127.0.0.1:9/v1",
        apiKeyEnv: "TEST_OAI_KEY",
        models: { "m-1": {} },
      },
      (n) => (n === "TEST_OAI_KEY" ? "sk-test" : undefined),
    );
    // @ai-sdk/openai-compatible 用全局 fetch；测试内替换
    const originalFetch = globalThis.fetch;
    globalThis.fetch = sseFetch as typeof fetch;
    try {
      await collect(
        p.stream(
          {
            ...REQ,
            model: "m-1",
            messages: [
              {
                role: "assistant",
                content: [],
                toolCalls: [{ callId: "c1", name: "mcp__gone__echo", input: { text: "hi" } }],
              },
              {
                role: "tool",
                callId: "c1",
                name: "mcp__gone__echo",
                content: "ok",
                isError: false,
              },
              { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
          },
          new AbortController().signal,
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const messages = capture.body?.["messages"] as Record<string, unknown>[] | undefined;
    const assistant = messages?.find((m) => m["role"] === "assistant");
    const calls = assistant?.["tool_calls"] as
      { id: string; function: { name: string } }[] | undefined;
    expect(calls?.[0]?.function.name).toBe("mcp__gone__echo");
    const toolMsg = messages?.find((m) => m["role"] === "tool");
    expect(toolMsg?.["tool_call_id"]).toBe(calls?.[0]?.id);
  });
});
