import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, modelFieldSourceText } from "../src/config/index.js";
import {
  devProviderEndpoints,
  matchModelsDev,
  modelOverrideFromDev,
  npmToEndpoints,
  readModelsDev,
  trimModelsDev,
  trimModelsDevProviders,
  type ModelsDevData,
} from "../src/config/models-dev.js";
import { modelsDevSnapshot } from "../src/config/models-dev-snapshot.js";
import { createPlatform } from "../src/platform/index.js";

const platform = createPlatform();
const id = "example/adr-0025-model";
const raw = {
  [id]: {
    reasoning: true,
    attachment: false,
    modalities: { input: ["text", "image"] },
    limit: { context: 99_000, output: 7_000 },
    name: "Ignored name",
  },
};
let root: string;
let home: string;

const writeJson = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
};
const fetchOk = () => vi.fn(async () => ({ ok: true, json: async () => raw }) as Response);
const load = (fetcher?: typeof fetch) =>
  loadConfig(platform, { nocturneHome: home, env: () => undefined, modelsDevFetch: fetcher });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-models-dev-"));
  home = path.join(root, "home");
  await fs.mkdir(home);
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("models.dev", () => {
  it("裁剪字段且以 modalities.input 判定看图，不使用 attachment", () => {
    const model = trimModelsDev(raw, "2026-09-28T00:00:00.000Z").models[id];
    expect(model).toBeDefined();
    expect(model).toEqual({
      reasoning: true,
      input: ["text", "image"],
      context: 99_000,
      output: 7_000,
    });
    expect(modelOverrideFromDev(model ?? {})).toEqual({
      contextWindow: 99_000,
      maxOutputTokens: 7_000,
      capabilities: { reasoning: "visible", imageInput: true },
    });
    expect(
      modelOverrideFromDev(
        trimModelsDev({ x: { attachment: true, modalities: { input: ["text"] } } }).models.x ?? {},
      ),
    ).toEqual({ capabilities: { imageInput: false } });
  });

  it("按精确、大小写、去冒号后缀的末段顺序匹配；歧义不猜", () => {
    const models = {
      "A/Model": { reasoning: true },
      "b/model": { reasoning: false },
      "c/unique": { context: 42 },
    };
    expect(matchModelsDev(models, "A/Model")?.reasoning).toBe(true);
    expect(matchModelsDev(models, "a/MODEL")?.reasoning).toBe(true);
    expect(matchModelsDev(models, "different/UNIQUE:free")?.context).toBe(42);
    expect(matchModelsDev(models, "model:free")).toBeUndefined();
    expect(matchModelsDev(models, "unknown")).toBeUndefined();
  });

  it("大小写多义不猜且不再试后缀；后缀多义不猜；冒号变体只看去后缀末段", () => {
    const models = {
      "A/Model": { reasoning: true },
      "a/MODEL": { reasoning: false },
      "c/unique": { context: 42 },
      "d/unique": { context: 43 },
    };
    // 大小写两义 → undefined（即使后缀唯一也不回退到后缀）；精确命中的 key 本身不受影响
    expect(matchModelsDev(models, "A/model")).toBeUndefined();
    expect(matchModelsDev(models, "A/Model")?.reasoning).toBe(true);
    expect(matchModelsDev(models, "a/MODEL")?.reasoning).toBe(false);
    // 后缀两义 → undefined
    expect(matchModelsDev(models, "x/unique")).toBeUndefined();
    expect(matchModelsDev(models, "unique")).toBeUndefined();
    // 冒号后缀先去掉再取末段：c/unique:free 的 tail 是 unique，单一条目时唯一命中
    expect(matchModelsDev({ "c/unique:free": { context: 7 } }, "other/unique")?.context).toBe(7);
    expect(matchModelsDev({ "c/unique:free": { context: 7 } }, "other/unique:paid")?.context).toBe(
      7,
    );
    // 同 tail 两义（冒号变体与无后缀）→ undefined
    expect(
      matchModelsDev({ "c/unique:free": { context: 7 }, "d/unique": { context: 8 } }, "unique"),
    ).toBeUndefined();
  });

  it("同一数据对象多次匹配结果一致；换新对象后用新索引", () => {
    const first = { "a/m": { reasoning: true } };
    expect(matchModelsDev(first, "A/M")?.reasoning).toBe(true);
    expect(matchModelsDev(first, "A/M")?.reasoning).toBe(true);
    expect(matchModelsDev(first, "other/m:free")?.reasoning).toBe(true);
    // 内容相同但对象不同：各自建索引，结果一致
    const same = { "a/m": { reasoning: true } };
    expect(matchModelsDev(same, "A/M")?.reasoning).toBe(true);
    // 换成新的数据对象（模拟 modelsDev 刷新整体替换）后用新的索引：
    // 无精确命中的大小写变体落到多义 → undefined；精确命中的 key 照常返回
    const second = { "a/m": { reasoning: true }, "A/M": { reasoning: false } };
    expect(matchModelsDev(second, "A/m")).toBeUndefined();
    expect(matchModelsDev(second, "A/M")?.reasoning).toBe(false);
    // 旧对象仍走旧索引，不受影响
    expect(matchModelsDev(first, "A/M")?.reasoning).toBe(true);
  });
  it("刷新写缓存；失败保留较新缓存，来源标注和层序正确", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "corp",
          type: "openai-compatible",
          baseURL: "https://example.test/v1",
          models: { [id]: { displayName: "Upstream", contextWindow: 40_000 } },
        },
      ],
    });
    const fetcher = fetchOk();
    const config = await load(fetcher);
    expect(await config.refreshModelsDev()).toBeUndefined();
    // ADR-0031 §4：models.json（模型表）+ api.json（服务商接口块）两次请求
    expect(fetcher).toHaveBeenCalledTimes(2);
    const cache = JSON.parse(
      await fs.readFile(path.join(home, "cache", "models-dev.json"), "utf8"),
    ) as { fetchedAt: string; models: Record<string, unknown> };
    expect(Date.parse(cache.fetchedAt)).toBeGreaterThan(Date.parse(modelsDevSnapshot.fetchedAt));
    expect(cache.models[id]).toEqual({
      reasoning: true,
      input: ["text", "image"],
      context: 99_000,
      output: 7_000,
    });

    const offline = await load(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(offline.base.providers[0]?.models?.[id]).toMatchObject({
      displayName: "Upstream",
      contextWindow: 40_000,
      maxOutputTokens: 7_000,
      capabilities: { reasoning: "visible", imageInput: true },
    });
    const view = (await offline.listModelSettings("corp"))[0];
    expect(view).toBeDefined();
    expect(modelFieldSourceText(view?.fields.reasoning.source ?? { kind: "default" })).toBe(
      "models.dev",
    );
    expect(modelFieldSourceText(view?.fields.imageInput.source ?? { kind: "default" })).toBe(
      "models.dev",
    );
    expect(modelFieldSourceText(view?.fields.contextWindow.source ?? { kind: "default" })).toBe(
      "上游",
    );
    expect(await offline.refreshModelsDev()).toMatch(/models.dev 获取失败/);
    expect((await readModelsDev(platform, home)).models[id]).toEqual(cache.models[id]);

    await offline.saveModelSettings("corp", id, { maxOutputTokens: 6_000 });
    expect((await (await load()).listModelSettings("corp"))[0]?.fields.maxOutputTokens.value).toBe(
      6_000,
    );
    await writeJson(path.join(home, "config.json"), {
      providers: [
        {
          id: "corp",
          baseURL: "https://example.test/v1",
          models: { [id]: { capabilities: { imageInput: false } } },
        },
      ],
    });
    expect((await (await load()).listModelSettings("corp"))[0]?.fields.imageInput).toMatchObject({
      value: false,
      source: { kind: "config" },
    });
  });

  it("modelsDev:false 不联网且只使用内置快照；没有数据时回退原行为", async () => {
    await writeJson(path.join(home, "cache", "models-dev.json"), {
      fetchedAt: new Date(Date.now() + 60_000).toISOString(),
      models: raw,
    });
    await writeJson(path.join(home, "config.json"), { modelsDev: false });
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [{ id: "corp", baseURL: "https://example.test/v1", models: { [id]: {} } }],
    });
    const fetcher = fetchOk();
    const config = await load(fetcher);
    expect(await config.refreshModelsDev()).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(config.base.providers[0]?.models?.[id]?.capabilities?.reasoning).toBeUndefined();
    expect((await config.listModelSettings("corp"))[0]?.fields.reasoning.value).toBe("none");
    expect(Object.keys(modelsDevSnapshot.models).length).toBeGreaterThan(0);
  });
});

describe("models.dev 服务商层（ADR-0031 §4）", () => {
  /** api.json 形状：服务商级 npm + 逐模型 provider.npm */
  const apiRaw = {
    opencode: {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "gpt-5.4": { provider: { npm: "@ai-sdk/openai" } },
        "claude-opus-5-5": { provider: { npm: "@ai-sdk/anthropic" } },
        "gemini-3-pro": { provider: { npm: "@ai-sdk/google" } },
        "kimi-k2.5-free": {}, // 缺省 → 继承服务商级
      },
    },
    "opencode-go": {
      npm: "@ai-sdk/openai-compatible",
      models: { "grok-4.7": { provider: { npm: "@ai-sdk/openai" } } },
    },
    // 白名单外的服务商不收录
    other: { npm: "@ai-sdk/google", models: { x: {} } },
  };
  const devData: ModelsDevData = {
    fetchedAt: "2026-09-30T00:00:00.000Z",
    models: {},
    providers: trimModelsDevProviders(apiRaw),
  };

  it("裁剪只收录白名单键；保存服务商级与逐模型 npm 原文", () => {
    const p = devData.providers;
    expect(Object.keys(p ?? {})).toEqual(["opencode", "opencode-go"]);
    expect(p?.opencode?.npm).toBe("@ai-sdk/openai-compatible");
    expect(p?.opencode?.models?.["gpt-5.4"]).toEqual({ npm: "@ai-sdk/openai" });
    // 未声明 npm 的模型仍记录存在性（继承判定用）
    expect(p?.opencode?.models?.["kimi-k2.5-free"]).toEqual({});
    expect(trimModelsDevProviders([])).toBeUndefined();
    expect(trimModelsDevProviders({})).toBeUndefined();
  });

  it("npm → endpoints 映射表逐行", () => {
    expect(npmToEndpoints("@ai-sdk/openai-compatible")).toEqual(["/chat/completions"]);
    expect(npmToEndpoints("@ai-sdk/anthropic")).toEqual(["/messages"]);
    expect(npmToEndpoints("@ai-sdk/openai")).toEqual(["/responses"]);
    expect(npmToEndpoints("@ai-sdk/google")).toEqual(["npm:@ai-sdk/google"]);
  });

  it("devProviderEndpoints：逐模型 npm 优先，缺省继承服务商级；查不到不贡献", () => {
    expect(devProviderEndpoints(devData, "opencode", "gpt-5.4")).toEqual(["/responses"]);
    expect(devProviderEndpoints(devData, "opencode", "claude-opus-5-5")).toEqual(["/messages"]);
    expect(devProviderEndpoints(devData, "opencode", "kimi-k2.5-free")).toEqual([
      "/chat/completions",
    ]);
    expect(devProviderEndpoints(devData, "opencode", "gemini-3-pro")).toEqual([
      "npm:@ai-sdk/google",
    ]);
    // 不在服务商表内的模型 / 未知服务商键 / 无 providers 块 → 不贡献
    expect(devProviderEndpoints(devData, "opencode", "not-listed")).toBeUndefined();
    expect(devProviderEndpoints(devData, "unknown", "gpt-5.4")).toBeUndefined();
    expect(
      devProviderEndpoints({ fetchedAt: devData.fetchedAt, models: {} }, "opencode", "gpt-5.4"),
    ).toBeUndefined();
  });

  it("合并：modelsDevProvider 条目的模型拿到 models.dev 层 endpoints；上游层优先", async () => {
    // 写入含 providers 块的缓存（fetchedAt 比内置快照新 → 生效）
    await writeJson(path.join(home, "cache", "models-dev.json"), {
      fetchedAt: new Date(Date.now() + 60_000).toISOString(),
      models: {},
      providers: devData.providers,
    });
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "oc",
          type: "openai-compatible",
          baseURL: "https://opencode.ai/zen/v1",
          modelsDevProvider: "opencode",
          models: {
            "gpt-5.4": {}, // models.dev → /responses
            "kimi-k2.5-free": {}, // 服务商级继承 → /chat/completions
            // 上游声明的 endpoints（向导层）优先于 models.dev 层
            "claude-opus-5-5": { endpoints: ["/chat/completions"] },
            "not-listed": {},
          },
        },
        {
          // 未声明 modelsDevProvider 的条目不受影响
          id: "plain",
          baseURL: "https://example.test/v1",
          models: { "gpt-5.4": {} },
        },
      ],
    });
    const config = await load();
    const oc = config.base.providers.find((p) => p.id === "oc");
    expect(oc?.models?.["gpt-5.4"]?.endpoints).toEqual(["/responses"]);
    expect(oc?.models?.["kimi-k2.5-free"]?.endpoints).toEqual(["/chat/completions"]);
    expect(oc?.models?.["claude-opus-5-5"]?.endpoints).toEqual(["/chat/completions"]);
    expect(oc?.models?.["not-listed"]?.endpoints).toBeUndefined();
    expect(
      config.base.providers.find((p) => p.id === "plain")?.models?.["gpt-5.4"]?.endpoints,
    ).toBeUndefined();
  });

  it("旧缓存（无 providers 块）仍然有效", async () => {
    // 缓存里是裁剪后的形状（context 为顶层字段）
    await writeJson(path.join(home, "cache", "models-dev.json"), {
      fetchedAt: new Date(Date.now() + 60_000).toISOString(),
      models: trimModelsDev(raw, "2026-09-30T00:00:00.000Z").models,
    });
    const data = await readModelsDev(platform, home);
    expect(data.models[id]?.context).toBe(99_000);
    expect(data.providers).toBeUndefined();
  });
});
