/**
 * ADR-0031 §2/§3 契约测试（离线）：三种协议的请求都以
 * `nocturne/<version>` 开头的 User-Agent 发送（SDK 追加的 ai-sdk 后缀
 * 保留）；条目 headers 里的 UA 优先。请求带 sessionId 且条目声明
 * sessionHeader 时写会话头，缺一不写，静态同名头优先；
 * fetchModels 带 UA 但不写会话头。
 */
import { describe, expect, it, vi } from "vitest";

import { NOCTURNE_VERSION } from "../protocol/version.js";
import { createAnthropicProvider, type AnthropicConfig } from "./adapters/anthropic.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from "./adapters/openai-compatible.js";
import {
  createOpenAIResponsesProvider,
  type OpenAIResponsesConfig,
} from "./adapters/openai-responses.js";
import { fetchModels } from "./presets.js";
import { ProviderError } from "./errors.js";
import type { ModelRequest, ModelStreamEvent, Provider } from "./types.js";

const envWithKey = () => "sk-test";

interface Captured {
  headers?: Headers;
}

/** 按 URL 尾部分发三种协议的 SSE 回放 */
function fakeFetch(capture: Captured): typeof fetch {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    capture.headers = new Headers(init?.headers);
    const url = String(input);
    let payload: string;
    if (url.endsWith("/messages")) {
      payload = [
        {
          type: "message_start",
          message: { id: "m1", model: "x", usage: { input_tokens: 3 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
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
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
    } else if (url.endsWith("/responses")) {
      payload =
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "r1",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            incomplete_details: null,
          },
        })}\n\n` + "data: [DONE]\n\n";
    } else {
      payload = `${[
        {
          id: "c1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
        },
        {
          id: "c1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("")}data: [DONE]\n\n`;
    }
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
}

type AnyConfig = OpenAICompatibleConfig | AnthropicConfig | OpenAIResponsesConfig;

function compatConfig(over: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    id: "oai",
    type: "openai-compatible",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_KEY",
    models: { m: {} },
    ...over,
  };
}
function anthropicConfig(over: Partial<AnthropicConfig> = {}): AnthropicConfig {
  return {
    id: "claude",
    type: "anthropic",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_KEY",
    models: { m: {} },
    ...over,
  };
}
function responsesConfig(over: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesConfig {
  return {
    id: "zen",
    type: "openai-responses",
    baseURL: "https://api.test/v1",
    apiKeyEnv: "TEST_KEY",
    models: { m: {} },
    ...over,
  };
}

function createFor(
  config: AnyConfig,
  fetchImpl: typeof fetch,
  env: (name: string) => string | undefined = envWithKey,
) {
  // config.type 可选（适配器缺省值）：本文件的工厂始终显式设置 type，
  // default 分支只可能是 openai-compatible
  if (config.type === "anthropic") {
    return createAnthropicProvider(config, env, fetchImpl);
  }
  if (config.type === "openai-responses") {
    return createOpenAIResponsesProvider(config, env, fetchImpl);
  }
  return createOpenAICompatibleProvider(config as OpenAICompatibleConfig, env, fetchImpl);
}

async function consume(
  provider: Provider,
  request: Partial<ModelRequest> = {},
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(
    {
      model: "m",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      ...request,
    },
    signal,
  ))
    events.push(event);
  return events;
}

async function drain(
  config: AnyConfig,
  request: Partial<ModelRequest> = {},
): Promise<{ events: ModelStreamEvent[]; captured: Captured }> {
  const captured: Captured = {};
  const provider = createFor(config, fakeFetch(captured));
  const events: ModelStreamEvent[] = [];
  const req: ModelRequest = {
    model: "m",
    system: [{ text: "s" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...request,
  };
  for await (const ev of provider.stream(req, new AbortController().signal)) events.push(ev);
  return { events, captured };
}

const CONFIGS = {
  "openai-compatible": compatConfig,
  anthropic: anthropicConfig,
  "openai-responses": responsesConfig,
};

describe("User-Agent（ADR-0031 §2）", () => {
  for (const [name, make] of Object.entries(CONFIGS)) {
    it(`${name} 请求 UA 以 nocturne/<version> 开头，SDK 后缀保留`, async () => {
      const { captured } = await drain(make());
      const ua = captured.headers?.get("user-agent") ?? "";
      expect(ua.startsWith(`nocturne/${NOCTURNE_VERSION}`)).toBe(true);
      expect(ua).toContain("ai-sdk");
    });

    it(`${name} 装配处注入的 userAgent 生效`, async () => {
      const { captured } = await drain(make({ userAgent: "nocturne/9.9-test" }));
      expect(captured.headers?.get("user-agent")).toContain("nocturne/9.9-test");
    });

    it(`${name} 条目 headers 的 UA（大小写不敏感）优先`, async () => {
      const { captured } = await drain(
        make({ headers: { "USER-AGENT": "my-agent/1.0", "X-Extra": "v" } }),
      );
      const ua = captured.headers?.get("user-agent") ?? "";
      expect(ua).toContain("my-agent/1.0");
      expect(ua).not.toContain("nocturne/");
    });
  }
});

describe("会话标识请求头（ADR-0031 §3）", () => {
  for (const [name, make] of Object.entries(CONFIGS)) {
    it(`${name}：sessionId + sessionHeader 同时存在才写会话头`, async () => {
      const { captured } = await drain(make({ sessionHeader: "x-opencode-session" }), {
        sessionId: "202609301230-1a2b3c4d",
      });
      expect(captured.headers?.get("x-opencode-session")).toBe("202609301230-1a2b3c4d");
    });

    it(`${name}：缺 sessionId 不写；缺 sessionHeader 不写`, async () => {
      const a = await drain(make({ sessionHeader: "x-opencode-session" }));
      expect(a.captured.headers?.get("x-opencode-session")).toBeNull();
      const b = await drain(make(), { sessionId: "s-1" });
      expect(b.captured.headers?.get("x-opencode-session")).toBeNull();
    });

    it(`${name}：静态同名头（不同大小写）优先`, async () => {
      const { captured } = await drain(
        make({
          sessionHeader: "x-opencode-session",
          headers: { "X-Opencode-Session": "static-value" },
        }),
        { sessionId: "dynamic-id" },
      );
      expect(captured.headers?.get("x-opencode-session")).toBe("static-value");
    });
  }
});

describe("鉴权请求边界（ADR-0042 §3/§6）", () => {
  for (const [name, make] of Object.entries(CONFIGS)) {
    it(`${name}：resolver 在请求时取 token，override 不读取环境变量或旧凭据`, async () => {
      const captured: Captured = {};
      const env = vi.fn(() => "ignored-env");
      const credentials = vi.fn(async () => "ignored-store");
      const token = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        return "resolved-token";
      });
      const invalidate = vi.fn(async () => undefined);
      const provider = createFor(
        make({ authResolver: { token, invalidate }, credentials }),
        fakeFetch(captured),
        env,
      );
      expect(token).not.toHaveBeenCalled();
      await consume(provider);
      expect(token).toHaveBeenCalledTimes(1);
      expect(token.mock.calls[0]).toHaveLength(1);
      expect(token.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
      expect(env).not.toHaveBeenCalled();
      expect(credentials).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      const header = name === "anthropic" ? "x-api-key" : "authorization";
      expect(captured.headers?.get(header)).toBe(
        name === "anthropic" ? "resolved-token" : "Bearer resolved-token",
      );
    });

    it(`${name}：首次 401 后失效、取新 token 并仅重发一次`, async () => {
      const tokens = ["expired-token", "renewed-token"];
      const token = vi.fn(async () => tokens.shift() ?? "unexpected-third-token");
      const invalidate = vi.fn(async () => undefined);
      const success = fakeFetch({});
      const sent: { headers: Headers; body: unknown; redirect: RequestInit["redirect"] }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        sent.push({
          headers: new Headers(init?.headers),
          body: init?.body,
          redirect: init?.redirect,
        });
        return sent.length === 1
          ? new Response("expired-token in upstream body", { status: 401 })
          : success(input, init);
      };
      const events = await consume(
        createFor(make({ authResolver: { token, invalidate }, modelHeader: "x-model" }), fetchImpl),
      );
      expect(events.some((event) => event.type === "finish")).toBe(true);
      expect(token).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(2);
      const header = name === "anthropic" ? "x-api-key" : "authorization";
      expect(sent.map((request) => request.headers.get(header))).toEqual(
        name === "anthropic"
          ? ["expired-token", "renewed-token"]
          : ["Bearer expired-token", "Bearer renewed-token"],
      );
      expect(sent[0]?.body).toBe(sent[1]?.body);
      expect(sent.map((request) => request.headers.get("x-model"))).toEqual(["m", "m"]);
      expect(sent.map((request) => request.redirect)).toEqual(["error", "error"]);
    });

    it(`${name}：二次 401 是不可重试的安全 auth 错误，不读取或附带上游 body`, async () => {
      const token = vi.fn(async () => "private-token");
      const invalidate = vi.fn(async () => undefined);
      const cancel = vi.fn();
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("private-token upstream-body"));
              },
              cancel,
            }),
            { status: 401 },
          ),
      );
      const provider = createFor(
        make({
          authResolver: {
            token,
            invalidate,
            unauthorizedMessage: "请执行 grok login",
          },
        }),
        fetchImpl,
      );
      const error: unknown = await consume(provider).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        kind: "auth",
        retryable: false,
        status: 401,
        message: "请执行 grok login",
      });
      expect(error).toHaveProperty("cause", undefined);
      expect(error).toHaveProperty("providerMessage", undefined);
      expect(String(error)).not.toContain("private-token");
      expect(JSON.stringify(error)).not.toContain("upstream-body");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(2);
    });

    it(`${name}：401 没有 resolver 提示时使用安全固定提示`, async () => {
      const provider = createFor(
        make(),
        async () => new Response("secret-upstream-body", { status: 401 }),
      );
      await expect(consume(provider)).rejects.toMatchObject({
        kind: "auth",
        retryable: false,
        message: "服务商凭据已失效，请重新配置密钥或登录",
      });
    });

    it(`${name}：旧 credentials/apiKeyEnv 路径保留环境变量优先与空值回退`, async () => {
      const stored = vi.fn(async () => "stored-key");
      const captured: Captured = {};
      const config = make({ credentials: stored });
      await consume(createFor(config, fakeFetch(captured)));
      expect(stored).not.toHaveBeenCalled();
      await consume(createFor(config, fakeFetch(captured), () => ""));
      expect(stored).toHaveBeenCalledExactlyOnceWith(config.id);
      const header = name === "anthropic" ? "x-api-key" : "authorization";
      expect(captured.headers?.get(header)).toBe(
        name === "anthropic" ? "stored-key" : "Bearer stored-key",
      );
    });

    it(`${name}：modelHeader 逐请求写模型并覆盖不同大小写的静态值`, async () => {
      const captured: Captured = {};
      const fetchImpl = fakeFetch(captured);
      const dynamic = createFor(
        make({ modelHeader: "x-model", headers: { "X-Model": "stale-model" } }),
        fetchImpl,
      );
      await consume(dynamic, { model: "first-model" });
      expect(captured.headers?.get("x-model")).toBe("first-model");
      await consume(dynamic, { model: "second-model" });
      expect(captured.headers?.get("x-model")).toBe("second-model");
    });

    it(`${name}：成功响应后的流中断不失效或重发`, async () => {
      const invalidate = vi.fn(async () => undefined);
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("connection closed"));
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      );
      const provider = createFor(
        make({ authResolver: { token: async () => "token", invalidate } }),
        fetchImpl,
      );
      await expect(consume(provider)).rejects.toBeInstanceOf(ProviderError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it(`${name}：401 后取消不会发第二次请求`, async () => {
      const controller = new AbortController();
      const invalidate = vi.fn(async () => {
        controller.abort();
      });
      const token = vi.fn(async () => "token");
      const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
      const provider = createFor(make({ authResolver: { token, invalidate } }), fetchImpl);
      await expect(consume(provider, {}, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(token).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it(`${name}：缺少凭据在发 HTTP 前结束`, async () => {
      const fetchImpl = vi.fn(fakeFetch({}));
      const provider = createFor(make(), fetchImpl, () => "");
      await expect(consume(provider)).rejects.toMatchObject({ kind: "auth", retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }
});

describe("fetchModels（ADR-0031 §2/§3）", () => {
  it("模型列表请求带 nocturne UA，不带任何会话头", async () => {
    let captured: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        captured = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    try {
      await fetchModels(
        {
          type: "openai-compatible",
          baseURL: "https://api.test/v1",
          sessionHeader: "x-opencode-session",
        },
        "k",
      );
      const ua = captured?.get("user-agent") ?? "";
      expect(ua.startsWith(`nocturne/${NOCTURNE_VERSION}`)).toBe(true);
      expect(captured?.get("x-opencode-session")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("条目 headers 里的 UA 优先于默认值", async () => {
    let captured: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        captured = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    try {
      await fetchModels(
        {
          type: "openai-compatible",
          baseURL: "https://api.test/v1",
          headers: { "user-agent": "custom-agent/2" },
        },
        "k",
      );
      expect(captured?.get("user-agent")).toBe("custom-agent/2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
