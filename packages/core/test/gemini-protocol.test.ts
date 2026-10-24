import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime, FakeProvider, loadConfig } from "../src/index.js";
import { createEntryProvider } from "../src/provider/entry.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  deriveProtocolFromEndpoints,
  replaySessionView,
} from "../src/protocol/index.js";
import { builtinTools } from "../src/tools/index.js";
import { createGeminiProvider } from "../src/provider/adapters/gemini.js";
import { trimModelsDevProviders, type ModelsDevData } from "../src/config/models-dev.js";
import { modelsDevSnapshot } from "../src/config/models-dev-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nct-gemini-"));
  roots.push(root);
  return root;
}
async function json(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

describe("ADR-0061 协议、地址与兼容", () => {
  it("内置目录的 Zen 9 个与 Go 2 个 Gemini 模型均可路由", async () => {
    const home = await temp();
    const catalogue: ModelsDevData = modelsDevSnapshot;
    const providers = ["opencode", "opencode-go"].map((id) => {
      const models = Object.entries(catalogue.providers?.[id]?.models ?? {})
        .filter(([, model]) => model.npm === "@ai-sdk/google")
        .map(([modelId]) => [modelId, {}]);
      expect(models).toHaveLength(id === "opencode" ? 9 : 2);
      return {
        id,
        type: "openai-compatible",
        baseURL: `https://opencode.ai/zen/${id === "opencode" ? "" : "go/"}v1`,
        modelsDevProvider: id,
        models: Object.fromEntries(models),
      };
    });
    await json(path.join(home, "config.json"), { modelsDev: false });
    await json(path.join(home, "providers.json"), { version: 1, providers });
    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    for (const entry of config.base.providers) {
      const models = createEntryProvider({
        id: entry.id,
        type: "openai-compatible",
        baseURL: entry.baseURL,
        models: Object.fromEntries(
          Object.entries(entry.models ?? {}).map(([id, model]) => [
            id,
            {
              baseURL: model.baseURL,
              baseURLSource: model.baseURLSource,
              endpoints: model.endpoints,
            },
          ]),
        ),
      }).models();
      for (const model of models) {
        expect(model).toMatchObject({ protocol: "gemini", baseURLSource: "models.dev" });
        expect(model.baseURL).toBe(
          `https://opencode.ai/inference/${entry.id === "opencode" ? "" : "go/"}google/v1beta`,
        );
      }
    }
  });
  it("Gemini 末尾推导；原有三种协议优先级不变", () => {
    expect(
      deriveProtocolFromEndpoints(["/models/m:streamGenerateContent"], "openai-compatible"),
    ).toBe("gemini");
    expect(deriveProtocolFromEndpoints([":STREAMGENERATECONTENT/"], "anthropic")).toBe("gemini");
    expect(
      deriveProtocolFromEndpoints([":streamGenerateContent", "/responses"], "openai-compatible"),
    ).toBe("openai-responses");
  });

  it("裁剪保留服务商与模型 api，旧数据仍可缺省", () => {
    expect(
      trimModelsDevProviders({
        opencode: {
          npm: "base",
          api: "https://base.test",
          models: { a: {}, b: { provider: { npm: "model", api: "https://model.test" } } },
        },
      }),
    ).toEqual({
      opencode: {
        npm: "base",
        api: "https://base.test",
        models: { a: {}, b: { npm: "model", api: "https://model.test" } },
      },
    });
  });

  it("地址三档、显式改协议弃用目录地址、providers.json 读写 Gemini", async () => {
    const home = await temp();
    await json(path.join(home, "cache/models-dev.json"), {
      fetchedAt: "2099-01-01T00:00:00Z",
      models: {},
      providers: {
        opencode: {
          npm: "@ai-sdk/openai-compatible",
          api: "https://dev.test/openai/v1",
          models: {
            google: { npm: "@ai-sdk/google", api: "https://dev.test/google/v1beta" },
            chat: {},
            edited: { npm: "@ai-sdk/google", api: "https://dev.test/google/v1beta" },
            upstream: { npm: "@ai-sdk/google", api: "https://dev.test/google/v1beta" },
            handwritten: { npm: "@ai-sdk/google", api: "https://dev.test/google/v1beta" },
          },
        },
      },
    });
    await json(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "gateway",
          type: "openai-compatible",
          baseURL: "https://entry.test/v1",
          modelsDevProvider: "opencode",
          models: {
            google: {},
            chat: {},
            absent: {},
            edited: {},
            upstream: { endpoints: ["/messages"] },
            handwritten: { protocol: "gemini" },
          },
          userModels: { edited: { protocol: "gemini" } },
        },
      ],
    });
    let config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    const models = () => config.base.providers[0]?.models;
    expect(models()?.google).toMatchObject({
      baseURL: "https://dev.test/google/v1beta",
      baseURLSource: "models.dev",
    });
    expect(models()?.chat).toMatchObject({
      baseURL: "https://dev.test/openai/v1",
      baseURLSource: "models.dev",
    });
    expect(models()?.absent).toMatchObject({
      baseURL: "https://entry.test/v1",
      baseURLSource: "entry",
    });
    expect(models()?.edited).toMatchObject({
      protocol: "gemini",
      baseURL: "https://entry.test/v1",
      baseURLSource: "entry",
    });
    expect(models()?.upstream?.baseURL).toBe("https://entry.test/v1");
    expect(models()?.handwritten?.baseURL).toBe("https://entry.test/v1");
    expect(config.base.providers[0]?.baseURL).toBe("https://entry.test/v1");
    await config.saveModelSettings("gateway", "google", { baseURL: "https://user.test/v1beta" });
    config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    expect(models()?.google).toMatchObject({
      baseURL: "https://user.test/v1beta",
      baseURLSource: "user",
    });
    const saved = JSON.parse(await fs.readFile(path.join(home, "providers.json"), "utf8")) as {
      providers: { userModels: unknown }[];
    };
    expect(saved.providers[0]?.userModels).toMatchObject({
      google: { baseURL: "https://user.test/v1beta" },
      edited: { protocol: "gemini" },
    });
    await config.saveModelSettings("gateway", "google", { baseURL: null });
    config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    expect(models()?.google?.baseURL).toBe("https://dev.test/google/v1beta");
    const model = models()?.google;
    const provider = createEntryProvider({
      id: "gateway",
      baseURL: "https://entry.test/v1",
      models: { google: { baseURL: model?.baseURL, endpoints: model?.endpoints } },
    });
    expect(provider.models().find((m) => m.ref.model === "google")).toMatchObject({
      protocol: "gemini",
      baseURL: "https://dev.test/google/v1beta",
    });
  });

  it("anthropic 条目缺 baseURL：官方地址只兜底 Messages，其他协议仍报缺地址", async () => {
    const home = await temp();
    await json(path.join(home, "config.json"), { modelsDev: false });
    await json(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "claude",
          type: "anthropic",
          models: { messages: {}, chat: { protocol: "openai-compatible" } },
        },
      ],
    });
    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    const models = config.base.providers[0]?.models;
    expect(models?.messages).toMatchObject({
      baseURL: "https://api.anthropic.com/v1",
      baseURLSource: "entry",
    });
    expect(models?.chat?.baseURL).toBeUndefined();
    const provider = createEntryProvider(
      {
        id: "claude",
        type: "anthropic",
        apiKeyEnv: "KEY",
        models: { chat: { protocol: "openai-compatible", baseURL: models?.chat?.baseURL } },
      },
      () => "test",
    );
    await expect(async () => {
      for await (const _event of provider.stream(
        {
          model: "chat",
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
        },
        new AbortController().signal,
      )) {
        /* drain */
      }
    }).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("全部内置工具的参数声明经 Gemini SDK 转换生成 functionDeclarations", async () => {
    let body: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const tools = builtinTools();
    const provider = createGeminiProvider(
      { id: "test", baseURL: "https://test.invalid/v1beta", apiKeyEnv: "KEY" },
      () => "test",
      fetcher,
    );
    for await (const _event of provider.stream(
      {
        model: "gemini",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools,
      },
      new AbortController().signal,
    )) {
      /* drain */
    }
    const declarations = (body.tools as { functionDeclarations: unknown[] }[])[0]
      ?.functionDeclarations;
    expect(declarations).toHaveLength(tools.length);
    expect(JSON.stringify(declarations)).not.toContain('"$schema"');
  });

  it("条目路由按模型选择地址，诊断写出地址及来源", async () => {
    const urls: string[] = [];
    const records: { kind: string; data: unknown }[] = [];
    const fetcher: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const provider = createEntryProvider(
      {
        id: "gateway",
        baseURL: "https://entry.test/v1",
        apiKeyEnv: "KEY",
        diagnostics: {
          record: (kind, data) => {
            records.push({ kind, data });
          },
        },
        models: {
          first: {
            protocol: "gemini",
            baseURL: "https://first.test/v1beta",
            baseURLSource: "user",
          },
          second: {
            protocol: "gemini",
            baseURL: "https://second.test/v1beta",
            baseURLSource: "models.dev",
          },
        },
      },
      () => "test",
      fetcher,
    );
    for (const model of ["first", "second", "first"]) {
      for await (const _event of provider.stream(
        {
          model,
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
        },
        new AbortController().signal,
      )) {
        /* drain */
      }
    }
    expect(urls).toEqual(
      ["first", "second", "first"].map(
        (id) => `https://${id}.test/v1beta/models/${id}:streamGenerateContent?alt=sse`,
      ),
    );
    expect(records).toContainEqual({
      kind: "provider.endpoint",
      data: {
        provider: "gateway",
        model: "second",
        protocol: "gemini",
        baseURL: "https://second.test/v1beta",
        source: "models.dev",
      },
    });
  });

  it.each([false, true])(
    "consumeStream 三处签名落盘；仅元数据增量=%s；旧日志兼容",
    async (metadataOnly) => {
      const root = await temp();
      const pd = { google: { thoughtSignature: "signature" } };
      const fake = new FakeProvider({
        scripts: [
          [
            ...(metadataOnly
              ? [{ type: "reasoning_delta" as const, text: "", providerData: pd }]
              : []),
            {
              type: "reasoning_delta",
              text: "think",
              ...(metadataOnly ? {} : { providerData: pd }),
            },
            ...(metadataOnly ? [{ type: "text_delta" as const, text: "", providerData: pd }] : []),
            { type: "text_delta", text: "answer", ...(metadataOnly ? {} : { providerData: pd }) },
            {
              type: "tool_call",
              toolCallId: "original",
              name: "missing",
              input: {},
              providerData: pd,
            },
            { type: "finish", reason: "length" },
          ],
        ],
      });
      const config = await loadConfig(createPlatform(), {
        nocturneHome: path.join(root, "home"),
        env: () => undefined,
      });
      const runtime = await createRuntime({
        config,
        cwd: root,
        sessionsDir: path.join(root, "sessions"),
        providers: [fake],
      });
      const session = await runtime.createSession({ model: "fake/fake-1" });
      try {
        await session.submit({ text: "hi" });
        const event = session.durableEvents().find((e) => e.type === "message.assistant");
        expect(event?.payload).toMatchObject({
          content: [
            { type: "reasoning", providerData: pd },
            { type: "text", providerData: pd },
          ],
          toolCalls: [{ providerData: pd }],
        });
        if (event?.type !== "message.assistant") throw new Error("missing assistant");
        expect(decodeDurableEvent(encodeDurableEvent(event))).toEqual(event);
        const legacy = {
          ...event,
          payload: { ...event.payload, content: [{ type: "text", text: "legacy" }], toolCalls: [] },
        };
        expect(decodeDurableEvent(JSON.stringify(legacy))).toEqual(legacy);
        const restored = replaySessionView(
          session
            .durableEvents()
            .map((item) => (item === event ? decodeDurableEvent(JSON.stringify(legacy)) : item)),
        );
        expect(JSON.stringify(restored)).toContain("legacy");
      } finally {
        await session.close();
      }
    },
  );
});
