import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { trimModelsDevProviders, vendorPricing } from "../src/config/models-dev.js";
import { providerEntrySchema } from "../src/config/schema.js";
import { createPlatform } from "../src/platform/index.js";
import { createEntryProvider } from "../src/provider/entry.js";
import { fetchModels } from "../src/provider/presets.js";
import { createProviderRegistry } from "../src/provider/registry.js";

describe("ADR-0053 pricing", () => {
  it("schema accepts cache prices, tiers and the price-only provider key", () => {
    const pricing = {
      input: 2,
      cacheRead: 0,
      cacheWrite: 3,
      tiers: [{ aboveInputTokens: 100, output: 8 }],
    };
    expect(
      providerEntrySchema.parse({
        id: "p",
        baseURL: "https://example.test",
        modelsDevPricing: "xai",
        models: { m: { pricing } },
      }).models?.m?.pricing,
    ).toEqual(pricing);
  });

  it("snapshot cost trim keeps only prices and mapped thresholds", () => {
    expect(
      trimModelsDevProviders({
        deepseek: {
          models: {
            m: {
              cost: {
                input: 1,
                output: 2,
                cache_read: 0.1,
                cache_write: 3,
                junk: 4,
                tiers: [{ input: 5, tier: { size: 100, type: "context" }, junk: 6 }],
              },
            },
          },
        },
      })?.deepseek?.models?.m,
    ).toEqual({
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 3,
        tiers: [{ aboveInputTokens: 100, input: 5 }],
      },
    });
  });

  it("snapshot trim adds derived vendor providers with flat-table models and cost only", () => {
    const providers = trimModelsDevProviders(
      {
        openai: { npm: "@ai-sdk/openai", models: { m: { provider: { npm: "x" } } } },
        alibaba: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "qwen3.8-flash": { provider: { npm: "y" }, cost: { input: 0.05, junk: 1 } },
            "not-in-flat": { cost: { input: 9 } },
            "no-cost": {},
          },
        },
        nobody: { models: { x: { cost: { input: 1 } } } },
      },
      {
        "openai/m": {},
        "alibaba/qwen3.8-flash": {},
        "alibaba/no-cost": {},
        "ghost/x": {},
        plain: {},
      },
    );
    expect(Object.keys(providers ?? {}).sort()).toEqual(["alibaba", "openai"]);
    expect(providers?.openai).toEqual({ npm: "@ai-sdk/openai", models: { m: { npm: "x" } } });
    expect(providers?.alibaba).toEqual({ models: { "qwen3.8-flash": { cost: { input: 0.05 } } } });
  });

  it("vendor price matches with or without vendor prefix, any case, then falls back to OpenRouter", () => {
    const data = {
      fetchedAt: "2099-01-01T00:00:00Z",
      models: {
        "xai/grok-4.7": {},
        "deepseek/deepseek-v4.1-flash": {},
        "alibaba/qwen3.8-flash": {},
        "devin/swe-2-max": {},
      },
      providers: {
        xai: { models: { "grok-4.7": { cost: { input: 3 } } } },
        deepseek: { models: { "deepseek-v4-flash": { cost: { input: 0.2 } } } },
        alibaba: { models: { "qwen3.8-flash": { cost: { input: 0.05 } } } },
        openrouter: {
          models: {
            "deepseek/deepseek-v4.1-flash": { cost: { input: 0.1 } },
            "xai/grok-4.7": { cost: { input: 99 } },
          },
        },
      },
    };
    expect(vendorPricing(data, "xai/grok-4.7")).toEqual({ input: 3 });
    expect(vendorPricing(data, "grok-4.7")).toEqual({ input: 3 });
    expect(vendorPricing(data, "Qwen/Qwen3.8-Flash")).toEqual({ input: 0.05 });
    expect(vendorPricing(data, "deepseek/deepseek-v4.1-flash")).toEqual({ input: 0.1 });
    expect(vendorPricing(data, "devin/swe-2-max")).toBeUndefined();
    expect(vendorPricing(data, "unknown-model")).toBeUndefined();
  });

  it("vendor price is the last source: config > upstream > models.dev key > vendor", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-pricing-vendor-"));
    try {
      await fs.mkdir(path.join(home, "cache"));
      await fs.writeFile(
        path.join(home, "cache", "models-dev.json"),
        JSON.stringify({
          fetchedAt: "2099-01-01T00:00:00Z",
          models: { "xai/grok-4.7": {}, "openai/gpt-6-luna": {} },
          providers: {
            xai: { models: { "grok-4.7": { cost: { input: 3 } } } },
            openai: { models: { "gpt-6-luna": { cost: { input: 1 } } } },
            opencode: { models: { "gpt-6-luna": { cost: { input: 7 } } } },
          },
        }),
      );
      await fs.writeFile(
        path.join(home, "providers.json"),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: "ocx",
              baseURL: "https://example.test",
              models: { "xai/grok-4.7": {}, "gpt-6-luna": {}, other: {} },
            },
            {
              id: "keyed",
              baseURL: "https://example.test",
              modelsDevPricing: "opencode",
              models: { "gpt-6-luna": {}, "grok-4.7": {} },
            },
            {
              id: "up",
              baseURL: "https://example.test",
              source: "upstream",
              models: { "grok-4.7": { pricing: { input: 5 } } },
            },
          ],
        }),
      );
      await fs.writeFile(
        path.join(home, "config.json"),
        JSON.stringify({
          providers: [
            {
              id: "ocx",
              baseURL: "https://example.test",
              models: { "gpt-6-luna": { pricing: { input: 2 } } },
            },
          ],
        }),
      );
      const config = await loadConfig(createPlatform(), {
        nocturneHome: home,
        env: () => undefined,
      });
      const models = (id: string) => config.base.providers.find((p) => p.id === id)?.models;
      expect(models("ocx")?.["xai/grok-4.7"]).toMatchObject({
        pricing: { input: 3 },
        pricingSource: "vendor",
      });
      expect(models("ocx")?.["gpt-6-luna"]).toMatchObject({
        pricing: { input: 2 },
        pricingSource: "config",
      });
      expect(models("ocx")?.other?.pricing).toBeUndefined();
      expect(models("keyed")?.["gpt-6-luna"]).toMatchObject({
        pricing: { input: 7 },
        pricingSource: "models.dev",
      });
      expect(models("keyed")?.["grok-4.7"]).toMatchObject({
        pricing: { input: 3 },
        pricingSource: "vendor",
      });
      expect(models("up")?.["grok-4.7"]).toMatchObject({
        pricing: { input: 5 },
        pricingSource: "upstream",
      });
      expect(config.vendorPricing?.("grok-4.7")).toEqual({ input: 3 });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("config > upstream > models.dev; modelsDevPricing does not infer protocol", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-pricing-"));
    try {
      await fs.mkdir(path.join(home, "cache"));
      await fs.writeFile(
        path.join(home, "cache", "models-dev.json"),
        JSON.stringify({
          fetchedAt: "2099-01-01T00:00:00Z",
          models: {},
          providers: { openai: { npm: "@ai-sdk/openai", models: { m: { cost: { input: 1 } } } } },
        }),
      );
      const entry = {
        id: "p",
        baseURL: "https://example.test",
        modelsDevPricing: "openai",
        source: "upstream",
        models: { m: {} },
      };
      const resolve = async () => {
        const config = await loadConfig(createPlatform(), {
          nocturneHome: home,
          env: () => undefined,
        });
        const configured = config.base.providers[0];
        if (configured === undefined) throw new Error("missing provider fixture");
        const model = configured.models?.m;
        const p = createEntryProvider({
          id: configured.id,
          baseURL: configured.baseURL,
          models: {
            m: {
              pricing: model?.pricing,
              pricingSource: model?.pricingSource,
              endpoints: model?.endpoints,
            },
          },
        });
        return createProviderRegistry([p]).resolve({ provider: "p", model: "m" }).model;
      };
      await fs.writeFile(
        path.join(home, "providers.json"),
        JSON.stringify({ version: 1, providers: [entry] }),
      );
      expect(await resolve()).toMatchObject({
        pricing: { input: 1 },
        pricingSource: "models.dev",
        protocol: "openai-compatible",
      });
      await fs.writeFile(
        path.join(home, "providers.json"),
        JSON.stringify({
          version: 1,
          providers: [{ ...entry, models: { m: { pricing: { input: 2 } } } }],
        }),
      );
      expect(await resolve()).toMatchObject({ pricing: { input: 2 }, pricingSource: "upstream" });
      await fs.writeFile(
        path.join(home, "config.json"),
        JSON.stringify({
          providers: [
            { id: "p", baseURL: entry.baseURL, models: { m: { pricing: { output: 3 } } } },
          ],
        }),
      );
      expect(await resolve()).toMatchObject({ pricing: { output: 3 }, pricingSource: "config" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to modelsDevProvider pricing and prefers the layered modelsDevPricing key", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-pricing-fallback-"));
    try {
      await fs.mkdir(path.join(home, "cache"));
      await fs.writeFile(
        path.join(home, "cache", "models-dev.json"),
        JSON.stringify({
          fetchedAt: "2099-01-01T00:00:00Z",
          models: {},
          providers: {
            openai: { npm: "@ai-sdk/openai", models: { m: { cost: { input: 1 } } } },
            anthropic: { npm: "@ai-sdk/anthropic", models: { m: { cost: { input: 2 } } } },
          },
        }),
      );
      const entry = {
        id: "p",
        baseURL: "https://example.test",
        modelsDevProvider: "openai",
        models: { m: {} },
      };
      const save = async (provider: typeof entry & { modelsDevPricing?: string }) =>
        fs.writeFile(
          path.join(home, "providers.json"),
          JSON.stringify({ version: 1, providers: [provider] }),
        );
      const resolve = async () => {
        const config = await loadConfig(createPlatform(), {
          nocturneHome: home,
          env: () => undefined,
        });
        const configured = config.base.providers[0];
        if (!configured) throw new Error("missing provider fixture");
        const model = configured.models?.m;
        const provider = createEntryProvider({
          id: configured.id,
          baseURL: configured.baseURL,
          models: {
            m: {
              pricing: model?.pricing,
              pricingSource: model?.pricingSource,
              endpoints: model?.endpoints,
            },
          },
        });
        return createProviderRegistry([provider]).resolve({ provider: configured.id, model: "m" })
          .model;
      };
      await save(entry);
      expect(await resolve()).toMatchObject({ pricing: { input: 1 }, pricingSource: "models.dev" });
      await save({ ...entry, modelsDevPricing: "anthropic" });
      expect(await resolve()).toMatchObject({ pricing: { input: 2 }, pricingSource: "models.dev" });
      await fs.writeFile(
        path.join(home, "config.json"),
        JSON.stringify({
          providers: [
            {
              id: "p",
              baseURL: entry.baseURL,
              modelsDevProvider: "anthropic",
              modelsDevPricing: "openai",
            },
          ],
        }),
      );
      expect(await resolve()).toMatchObject({ pricing: { input: 1 }, pricingSource: "models.dev" });
      await fs.writeFile(
        path.join(home, "config.json"),
        JSON.stringify({
          providers: [{ id: "p", baseURL: entry.baseURL, modelsDevProvider: "openai" }],
        }),
      );
      expect(await resolve()).toMatchObject({ pricing: { input: 2 }, pricingSource: "models.dev" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("OpenRouter maps cache prices per token including free cache writes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "m",
                  pricing: {
                    prompt: "0.000002",
                    completion: "0.000008",
                    input_cache_read: "0.00000025",
                    input_cache_write: "0",
                  },
                },
              ],
            }),
          ),
      ),
    );
    try {
      expect(
        (
          await fetchModels(
            { type: "openai-compatible", baseURL: "https://example.test" },
            undefined,
          )
        )[0]?.pricing,
      ).toEqual({ input: 2, output: 8, cacheRead: 0.25, cacheWrite: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
