/**
 * ADR-0031 §2/§3 契约测试（离线）：三种协议的请求都以
 * `nocturne/<version>` 开头的 User-Agent 发送（SDK 追加的 ai-sdk 后缀
 * 保留）；条目 headers 里的 UA 优先。请求带 sessionId 且条目声明
 * sessionHeader 时写会话头，缺一不写，静态同名头优先；
 * fetchModels 带 UA 但不写会话头。
 */
import { describe, expect, it, vi } from "vitest";

import { NOCTURNE_VERSION } from "../version.js";
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
import type { ModelRequest, ModelStreamEvent } from "./types.js";

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

function createFor(config: AnyConfig, fetchImpl: typeof fetch) {
  switch (config.type) {
    case "anthropic":
      return createAnthropicProvider(config, envWithKey, fetchImpl);
    case "openai-responses":
      return createOpenAIResponsesProvider(config, envWithKey, fetchImpl);
    default:
      return createOpenAICompatibleProvider(config, envWithKey, fetchImpl);
  }
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

const CONFIGS: Record<string, () => AnyConfig> = {
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
