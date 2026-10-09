import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { trimModelsDevProviders } from "../src/config/models-dev.js";
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
