import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, modelFieldSourceText } from "../src/config/index.js";
import {
  matchModelsDev,
  modelOverrideFromDev,
  readModelsDev,
  trimModelsDev,
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
    expect(fetcher).toHaveBeenCalledOnce();
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
