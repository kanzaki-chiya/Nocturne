/**
 * provider-setup 上游获取与适配器凭据解析测试（provider-setup.md 第 6、7 节；
 * ADR-0016）。全部离线：fetch 用 globalThis.fetch 桩替换。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleProvider, fetchModels, listProviderPresets } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 把 globalThis.fetch 换成桩；返回捕获的请求 */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  });
  return calls;
}

const jsonRes = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

// ── 预设 ────────────────────────────────────────────────

describe("服务商预设", () => {
  it("五个预设：deepseek/openrouter/anthropic + 两个自定义", () => {
    const presets = listProviderPresets();
    expect(presets.map((p) => p.id)).toEqual([
      "deepseek",
      "openrouter",
      "anthropic",
      "custom-openai",
      "custom-anthropic",
    ]);
    expect(presets.find((p) => p.id === "anthropic")?.baseURL).toBeUndefined();
    // ADR-0026 §3：「其他 Anthropic 兼容」可拉取 /models（失败照旧转手动）
    expect(presets.find((p) => p.id === "custom-anthropic")?.fetchableModels).toBe(true);
  });
});

// ── fetchModels 上游字段映射（provider-setup.md 第 7 节） ─

describe("fetchModels 字段映射", () => {
  it("OpenRouter 形状：top_provider 限额、pricing 换算、能力位声明", async () => {
    const calls = stubFetch(() =>
      jsonRes({
        data: [
          {
            // OpenRouter 真实响应形状（节选）
            id: "deepseek/deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            context_length: 128000,
            top_provider: { context_length: 1000000, max_completion_tokens: 393216 },
            pricing: { prompt: "0.0000005", completion: "0.0000015" },
            supported_parameters: ["tools", "reasoning"],
            architecture: { input_modalities: ["text", "image"] },
          },
          {
            // 声明最少的条目：只有 id
            id: "bare/model",
          },
          { id: "" }, // 无 id 丢弃
          { notId: true },
        ],
      }),
    );
    const models = await fetchModels(
      { type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1" },
      "sk-or",
    );
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer sk-or");

    const flash = models.find((m) => m.id === "deepseek/deepseek-v4.1-flash");
    expect(flash?.displayName).toBe("DeepSeek V4.1 Flash");
    // top_provider.context_length 优先于顶层
    expect(flash?.contextWindow).toBe(1_000_000);
    expect(flash?.maxOutputTokens).toBe(393_216);
    // 按 token 计价 → 每百万 token
    expect(flash?.pricing).toEqual({ input: 0.5, output: 1.5 });
    expect(flash?.capabilities?.reasoning).toBe("visible");
    expect(flash?.capabilities?.imageInput).toBe(true);

    const bare = models.find((m) => m.id === "bare/model");
    expect(bare).toEqual({ id: "bare/model" });
    expect(models).toHaveLength(2);
  });

  it("commandcode 网关形状：context_length 映射、未声明字段保持 undefined", async () => {
    const calls = stubFetch(() =>
      jsonRes({
        data: [
          { id: "deepseek/deepseek-v4.1-flash", context_length: 1000000 },
          { id: "m-nocaps", name: "No Caps" },
        ],
      }),
    );
    const models = await fetchModels(
      { type: "openai-compatible", baseURL: "http://gw.test/v1" },
      undefined,
    );
    expect(models[0]?.contextWindow).toBe(1_000_000);
    expect(models[0]?.maxOutputTokens).toBeUndefined();
    expect(models[0]?.capabilities).toBeUndefined();
    expect(models[1]?.displayName).toBe("No Caps");
    // 无 key 时不发 Authorization
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBeNull();
  });

  it("supported_endpoints 原文映射：字符串数组、非空才记（ADR-0026 §1）", async () => {
    stubFetch(() =>
      jsonRes({
        data: [
          { id: "m-chat", supported_endpoints: ["/chat/completions", "/responses"] },
          { id: "m-msg", supported_endpoints: ["/messages"] },
          { id: "m-empty", supported_endpoints: [] },
          { id: "m-bad", supported_endpoints: ["/messages", 1, null, ""] },
          { id: "m-none" },
        ],
      }),
    );
    const models = await fetchModels(
      { type: "openai-compatible", baseURL: "http://gw.test/v1" },
      undefined,
    );
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get("m-chat")?.endpoints).toEqual(["/chat/completions", "/responses"]);
    expect(byId.get("m-msg")?.endpoints).toEqual(["/messages"]);
    // 空数组按未声明处理；数组内非字符串/空串剔除后仍非空才记
    expect(byId.get("m-empty")?.endpoints).toBeUndefined();
    expect(byId.get("m-bad")?.endpoints).toEqual(["/messages"]);
    expect(byId.get("m-none")?.endpoints).toBeUndefined();
  });

  it("anthropic 条目自定义 baseURL：列表走 <baseURL>/models（不再叠 /v1）", async () => {
    const calls = stubFetch(() => jsonRes({ data: [{ id: "claude-x" }] }));
    await fetchModels({ type: "anthropic", baseURL: "https://gw.test/anthropic/v1" }, "sk-ant");
    expect(calls[0]?.url).toBe("https://gw.test/anthropic/v1/models");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant");
  });

  it("Anthropic /v1/models：只映射官方声明字段，x-api-key 头", async () => {
    const calls = stubFetch(() =>
      jsonRes({
        data: [
          {
            id: "claude-opus-4-7",
            display_name: "Claude Opus 4.7",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
          { id: "claude-min", display_name: "Claude Min" },
        ],
      }),
    );
    const models = await fetchModels({ type: "anthropic" }, "sk-ant");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant");
    expect(headers.get("authorization")).toBeNull();

    const opus = models.find((m) => m.id === "claude-opus-4-7");
    expect(opus?.displayName).toBe("Claude Opus 4.7");
    expect(opus?.contextWindow).toBe(200_000);
    expect(opus?.maxOutputTokens).toBe(64_000);
    // 未声明的字段不猜
    const min = models.find((m) => m.id === "claude-min");
    expect(min?.contextWindow).toBeUndefined();
    expect(min?.capabilities).toBeUndefined();
  });

  it("HTTP 错误抛带状态码的错误；data 缺失返回 []", async () => {
    stubFetch(() => jsonRes({ error: "nope" }, 401));
    await expect(
      fetchModels({ type: "openai-compatible", baseURL: "http://x/v1" }, "k"),
    ).rejects.toMatchObject({ status: 401 });
    stubFetch(() => jsonRes({}));
    expect(await fetchModels({ type: "openai-compatible", baseURL: "http://x/v1" }, "k")).toEqual(
      [],
    );
  });
});

// ── 适配器：凭据解析 + max_tokens ────────────────────────

const sseOk = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: "x",
              choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
            })}\n\ndata: ${JSON.stringify({
              id: "x",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            })}\n\ndata: [DONE]\n\n`,
          ),
        );
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const REQ = {
  model: "m-1",
  system: [{ text: "sys" }],
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  tools: [],
};

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("openai-compatible 适配器：凭据与 max_tokens（ADR-0016）", () => {
  it("apiKeyEnv 缺省 + 凭据存储取密钥：Authorization 注入，请求体不含 max_tokens", async () => {
    const calls = stubFetch(() => Promise.resolve(sseOk()));
    const p = createOpenAICompatibleProvider(
      {
        id: "corp",
        baseURL: "http://gw.test/v1",
        models: { "m-1": {} },
        credentials: async (id) => (id === "corp" ? "sk-stored" : undefined),
      },
      () => undefined,
    );
    // request.maxOutputTokens 未声明 → 不发送 max_tokens
    await drain(p.stream({ ...REQ }, new AbortController().signal));
    const init = calls[0]?.init;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-stored");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBeUndefined();
  });

  it("声明 maxOutputTokens 时发送 max_tokens；环境变量优先于凭据存储", async () => {
    const calls = stubFetch(() => Promise.resolve(sseOk()));
    const p = createOpenAICompatibleProvider(
      {
        id: "corp",
        baseURL: "http://gw.test/v1",
        apiKeyEnv: "K",
        credentials: async () => "sk-store",
      },
      (n) => (n === "K" ? "sk-env" : undefined),
    );
    await drain(p.stream({ ...REQ, maxOutputTokens: 4096 }, new AbortController().signal));
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer sk-env");
  });
});
