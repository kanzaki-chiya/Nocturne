/**
 * 路由 Provider 契约测试（ADR-0026 §3-§5 + ADR-0031 §1，离线）：stub fetch
 * 捕获请求 URL 与鉴权头——同一 openai-compatible 条目下的模型按各自
 * 生效协议走 /chat/completions、/messages 或 /responses，并携带协议对应
 * 的鉴权头；不可用模型照常列出但发请求前以说明拒绝（不发 HTTP）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEntryProvider, type EntryProviderConfig } from "./entry.js";
import { ProviderError } from "./errors.js";
import type { ModelRequest, ModelStreamEvent } from "./types.js";

// anthropic 条目缺省 baseURL 时，@ai-sdk/anthropic 直接读 process.env
// .ANTHROPIC_BASE_URL（不经过注入的 env reader）——用例断言的是官方默认
// 地址，因此本文件统一隔离该变量，不受宿主 shell 环境影响。
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const envWithKey = (name: string) => (name === "TEST_KEY" ? "sk-test" : undefined);

interface Capture {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** 按 URL 返回对应协议的 SSE 流；把请求地址与头记入 capture */
function routingFetch(capture: Capture) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    capture.url = String(input);
    const h = new Headers(init?.headers);
    capture.headers = Object.fromEntries(h.entries());
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const events = capture.url.endsWith("/messages")
      ? [
          {
            type: "message_start",
            message: { id: "msg_1", model: "m", usage: { input_tokens: 1 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]
      : capture.url.endsWith("/responses")
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "m_1", role: "assistant", content: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: "m_1",
              output_index: 0,
              content_index: 0,
              delta: "ok",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "m_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]
        : [
            {
              id: "c1",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
            },
            {
              id: "c1",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ];
    const payload = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}${
      capture.url.endsWith("/messages") ? "" : "data: [DONE]\n\n"
    }`; // Responses 流同样以 [DONE] 收尾
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

function request(model: string, over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxOutputTokens: 1024,
    ...over,
  };
}

async function collect(
  p: ReturnType<typeof createEntryProvider>,
  req: ModelRequest,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const ev of p.stream(req, new AbortController().signal)) events.push(ev);
  return events;
}

describe("路由 Provider：openai-compatible 条目（ADR-0026 §3/§4）", () => {
  const entry = (over: Partial<EntryProviderConfig> = {}): EntryProviderConfig => ({
    id: "gw",
    type: "openai-compatible",
    baseURL: "https://gw.test/v1",
    apiKeyEnv: "TEST_KEY",
    models: {
      chat: { endpoints: ["/chat/completions", "/responses"] },
      msg: { endpoints: ["/messages"] },
    },
    ...over,
  });

  it("鉴权限定 Responses 优先于请求/模型协议及不支持的 endpoints", async () => {
    const capture: Capture = {};
    const token = vi.fn(async () => "test-access");
    const env = vi.fn(() => "must-not-read");
    const p = createEntryProvider(
      entry({
        auth: { kind: "openai-siwc" },
        authResolver: { protocol: "openai-responses", token, invalidate: () => Promise.resolve() },
        models: { m: { protocol: "anthropic", endpoints: ["/unknown"] } },
      }),
      env,
      routingFetch(capture),
    );
    expect(p.models()[0]).toMatchObject({ protocol: "openai-responses", unavailable: undefined });
    await collect(p, request("m", { protocol: "openai-compatible" }));
    expect(capture.url).toBe("https://gw.test/v1/responses");
    expect(capture.headers?.authorization).toBe("Bearer test-access");
    expect(token).toHaveBeenCalledTimes(1);
    expect(env).not.toHaveBeenCalled();
  });

  it("默认协议模型 → /chat/completions，只发 Authorization: Bearer", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(entry(), envWithKey, routingFetch(capture));
    await collect(p, request("chat"));
    expect(capture.url).toBe("https://gw.test/v1/chat/completions");
    expect(capture.headers?.["authorization"]).toBe("Bearer sk-test");
    expect(capture.headers?.["x-api-key"]).toBeUndefined();
    expect(capture.headers?.["anthropic-version"]).toBeUndefined();
  });

  it("messages 模型 → /messages，x-api-key 与 Bearer 双发 + anthropic-version", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(entry(), envWithKey, routingFetch(capture));
    await collect(p, request("msg"));
    expect(capture.url).toBe("https://gw.test/v1/messages");
    expect(capture.headers?.["x-api-key"]).toBe("sk-test");
    expect(capture.headers?.["authorization"]).toBe("Bearer sk-test");
    expect(capture.headers?.["anthropic-version"]).toBeDefined();
  });

  it("跨协议 Messages 使用凭据存储密钥，不依赖 ANTHROPIC_API_KEY", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      entry({ apiKeyEnv: undefined, credentials: async () => "sk-stored" }),
      () => undefined,
      routingFetch(capture),
    );
    await collect(p, request("msg"));
    expect(capture.url).toBe("https://gw.test/v1/messages");
    expect(capture.headers?.["x-api-key"]).toBe("sk-stored");
    expect(capture.headers?.["authorization"]).toBe("Bearer sk-stored");
  });

  it("手写 protocol 压过 endpoints：/responses 声明 + protocol=anthropic 仍走 /messages", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      entry({ models: { m: { endpoints: ["/responses"], protocol: "anthropic" } } }),
      envWithKey,
      routingFetch(capture),
    );
    await collect(p, request("m"));
    expect(capture.url).toBe("https://gw.test/v1/messages");
  });

  it("条目级 providerOptions 只给同协议（openai）请求，不进 /messages 体", async () => {
    const captures: Capture[] = [{}];
    const p = createEntryProvider(
      entry({ providerOptions: { region: "x" } }),
      envWithKey,
      routingFetch(captures[0] ?? {}),
    );
    await collect(p, request("chat"));
    const chatCapture = { ...captures[0] };
    const msgCapture: Capture = {};
    const p2 = createEntryProvider(
      entry({ providerOptions: { region: "x" } }),
      envWithKey,
      routingFetch(msgCapture),
    );
    await collect(p2, request("msg"));
    // openai 兼容体的 providerOptions 是命名空间键（SDK 首选驼峰命名空间），
    // messages 体则应是协议自有字段——不含命名空间注入的自定义键
    expect(JSON.stringify(chatCapture.body)).toContain("region");
    expect(JSON.stringify(msgCapture.body)).not.toContain("region");
  });
});

describe("路由 Provider：anthropic 条目", () => {
  it("本家 Messages 使用凭据存储密钥，不额外发送 Authorization", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      {
        id: "claude",
        type: "anthropic",
        baseURL: "https://api.test/v1",
        credentials: async () => "sk-stored",
        models: { m: { endpoints: ["/messages"] } },
      },
      () => undefined,
      routingFetch(capture),
    );
    await collect(p, request("m"));
    expect(capture.url).toBe("https://api.test/v1/messages");
    expect(capture.headers?.["x-api-key"]).toBe("sk-stored");
    expect(capture.headers?.["authorization"]).toBeUndefined();
  });

  it("messages 模型 → <baseURL>/messages，x-api-key + anthropic-version，不带 Authorization", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      {
        id: "claude",
        type: "anthropic",
        baseURL: "https://api.test/v1",
        apiKeyEnv: "TEST_KEY",
        models: { m: { endpoints: ["/messages"] } },
      },
      envWithKey,
      routingFetch(capture),
    );
    await collect(p, request("m"));
    expect(capture.url).toBe("https://api.test/v1/messages");
    expect(capture.headers?.["x-api-key"]).toBe("sk-test");
    expect(capture.headers?.["anthropic-version"]).toBeDefined();
    expect(capture.headers?.["authorization"]).toBeUndefined();
  });

  it("缺省 baseURL → 官方 https://api.anthropic.com/v1/messages", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      {
        id: "claude",
        type: "anthropic",
        apiKeyEnv: "TEST_KEY",
        models: { m: {} },
      },
      envWithKey,
      routingFetch(capture),
    );
    await collect(p, request("m"));
    expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("chat-only 模型（endpoints 只含 /chat/completions）→ 同条目走 chat 端点、只发 Bearer", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      {
        id: "claude",
        type: "anthropic",
        baseURL: "https://api.test/v1",
        apiKeyEnv: "TEST_KEY",
        models: { m: { endpoints: ["/chat/completions"] } },
      },
      envWithKey,
      routingFetch(capture),
    );
    await collect(p, request("m"));
    expect(capture.url).toBe("https://api.test/v1/chat/completions");
    expect(capture.headers?.["authorization"]).toBe("Bearer sk-test");
    expect(capture.headers?.["x-api-key"]).toBeUndefined();
  });
});

describe("路由 Provider：Responses 协议（ADR-0031 §1）", () => {
  it("/responses-only 模型：清单可用（protocol=openai-responses），请求走 /responses 且只发 Bearer", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      {
        id: "gw",
        type: "openai-compatible",
        baseURL: "https://gw.test/v1",
        apiKeyEnv: "TEST_KEY",
        models: { resp: { endpoints: ["/responses"] } },
      },
      envWithKey,
      routingFetch(capture),
    );
    const info = p.models().find((m) => m.ref.model === "resp");
    expect(info?.unavailable).toBeUndefined();
    expect(info?.protocol).toBe("openai-responses");
    const events = await collect(p, request("resp"));
    expect(capture.url).toBe("https://gw.test/v1/responses");
    expect(capture.headers?.["authorization"]).toBe("Bearer sk-test");
    expect(capture.headers?.["x-api-key"]).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "finish" });
  });

  it("显式 protocol=openai-responses（无 endpoints）也路由到 /responses", async () => {
    const capture: Capture = {};
    const p = createEntryProvider(
      {
        id: "gw",
        type: "anthropic",
        baseURL: "https://gw.test/v1",
        apiKeyEnv: "TEST_KEY",
        models: { resp: { protocol: "openai-responses" } },
      },
      envWithKey,
      routingFetch(capture),
    );
    await collect(p, request("resp"));
    expect(capture.url).toBe("https://gw.test/v1/responses");
  });

  it("anthropic 条目缺 baseURL 时 Responses 请求按 openai-compatible 同款报错", async () => {
    const p = createEntryProvider(
      {
        id: "claude",
        type: "anthropic",
        apiKeyEnv: "TEST_KEY",
        models: { resp: { protocol: "openai-responses" } },
      },
      envWithKey,
      async () => new Response("x", { status: 500 }),
    );
    await expect(collect(p, request("resp"))).rejects.toMatchObject({
      name: "ProviderError",
      kind: "invalid_request",
      retryable: false,
    });
    await expect(collect(p, request("resp"))).rejects.toThrow(
      /baseURL.*openai-responses.*\/responses/,
    );
  });
});

describe("路由 Provider：不可用模型（ADR-0026 §5）", () => {
  it("接口全部无法识别的模型照常列出但标记 unavailable；发请求即拒绝（不发 HTTP）", async () => {
    let called = 0;
    const p = createEntryProvider(
      {
        id: "gw",
        type: "openai-compatible",
        baseURL: "https://gw.test/v1",
        apiKeyEnv: "TEST_KEY",
        models: {
          bad: { endpoints: ["/embeddings"] },
          good: {},
        },
      },
      envWithKey,
      async () => {
        called += 1;
        return new Response("x", { status: 500 });
      },
    );
    const list = p.models();
    const bad = list.find((m) => m.ref.model === "bad");
    const good = list.find((m) => m.ref.model === "good");
    expect(bad?.unavailable?.reason).toContain("没有可用的服务协议");
    expect(bad?.protocol).toBeUndefined();
    expect(good?.unavailable).toBeUndefined();
    expect(good?.protocol).toBe("openai-compatible");
    await expect(collect(p, request("bad"))).rejects.toMatchObject({
      name: "ProviderError",
      kind: "invalid_request",
      retryable: false,
    });
    await expect(collect(p, request("bad"))).rejects.toBeInstanceOf(ProviderError);
    expect(called).toBe(0);
  });

  it("清单模型 endpoints 缺失/空 → 生效协议回落条目 type", async () => {
    const p = createEntryProvider(
      {
        id: "gw",
        type: "anthropic",
        apiKeyEnv: "TEST_KEY",
        models: { m: {} },
      },
      envWithKey,
      async () => new Response("x", { status: 500 }),
    );
    expect(p.models()[0]?.protocol).toBe("anthropic");
  });
});

describe("路由 Provider：共享 AuthResolver（ADR-0042 §3）", () => {
  it("三个协议共用失效后的 token，非 API key override 不读取 env/credentials", async () => {
    let key = "old-token";
    const token = vi.fn(async () => key);
    const invalidate = vi.fn(async () => {
      key = "new-token";
    });
    const env = vi.fn(() => "unused-env-token");
    const credentials = vi.fn(async () => "unused-stored-token");
    const capture: Capture = {};
    const success = routingFetch(capture);
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (new Headers(init?.headers).get("authorization") === "Bearer old-token") {
        return new Response("old-token in body", { status: 401 });
      }
      return success(input, init);
    });
    const provider = createEntryProvider(
      {
        id: "mixed",
        baseURL: "https://api.test/v1",
        apiKeyEnv: "IGNORED",
        auth: {
          kind: "external-file",
          path: "unused-auth-file",
          keyPath: ["key"],
          renewHint: "renew",
        },
        authResolver: { token, invalidate },
        credentials,
        modelHeader: "x-model",
        models: {
          chat: { protocol: "openai-compatible" },
          messages: { protocol: "anthropic" },
          responses: { protocol: "openai-responses" },
        },
      },
      env,
      fetchImpl,
    );
    for (const model of ["chat", "messages", "responses"]) {
      const events = await collect(provider, request(model));
      expect(events.some((event) => event.type === "finish")).toBe(true);
      expect(capture.headers?.authorization).toBe("Bearer new-token");
      expect(capture.headers?.["x-model"]).toBe(model);
      if (model === "messages") expect(capture.headers?.["x-api-key"]).toBe("new-token");
    }
    expect(env).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("API key resolver 构造一次，延迟构造三个适配器不会重复读 env", async () => {
    const env = vi.fn(() => "entry-key");
    const capture: Capture = {};
    const provider = createEntryProvider(
      {
        id: "mixed",
        baseURL: "https://api.test/v1",
        apiKeyEnv: "ENTRY_KEY",
        models: {
          chat: { protocol: "openai-compatible" },
          messages: { protocol: "anthropic" },
          responses: { protocol: "openai-responses" },
        },
      },
      env,
      routingFetch(capture),
    );
    for (const model of ["chat", "messages", "responses"]) await collect(provider, request(model));
    expect(env).toHaveBeenCalledExactlyOnceWith("ENTRY_KEY");
  });
});
