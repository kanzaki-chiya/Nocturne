import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultJevReviewer,
  fetchJevModels,
  resolveJevConnection,
} from "../src/config/reviewer.js";
import { parseConfigFile } from "../src/config/schema.js";
import type { CredentialStore, JevReviewerConfig, ProviderOverview } from "../src/config/types.js";

const selected: JevReviewerConfig = {
  backend: "jev",
  endpoint: "opencode-zen",
  model: "jev-1.13-free",
  credential: { provider: "opencode-go" },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("审查器接入配置", () => {
  it("保留第一轮 model/off 写法；Jev 三种凭据与 custom 往返", () => {
    const variants = [
      { backend: "off" },
      { backend: "model", model: { provider: "p", model: "m" } },
      selected,
      { ...selected, credential: { env: "JEV_KEY" } },
      { ...selected, credential: { stored: true } },
      {
        ...selected,
        endpoint: "custom",
        baseURL: "https://example.invalid/v1",
        minConfidence: 0.8,
      },
    ];
    for (const reviewer of variants)
      expect(
        parseConfigFile(JSON.parse(JSON.stringify({ permission: { reviewer } })), "test").permission
          ?.reviewer,
      ).toEqual(reviewer);
  });
  it.each([
    { apiKey: "inline-forbidden" },
    { credential: { provider: "p", env: "KEY" } },
    { credential: { stored: false } },
    { credential: { key: "secret" } },
    { credential: { env: "bad name" } },
    { minConfidence: 1.1 },
    { endpoint: "typesafe", baseURL: "https://example.invalid" },
    { endpoint: "custom" },
    { endpoint: "custom", baseURL: "https://key:secret@example.invalid" },
    { endpoint: "custom", baseURL: "file:///tmp" },
  ])("拒绝无效配置 %j", (patch) => {
    expect(() =>
      parseConfigFile({ permission: { reviewer: { ...selected, ...patch } } }, "test"),
    ).toThrow();
  });
  it("主机匹配自动借用 opencode-go；默认模型、阈值与 env", () => {
    const provider = {
      id: "opencode-go",
      host: "opencode.ai",
      keySource: "credential",
    } as ProviderOverview;
    expect(defaultJevReviewer("opencode-zen", [provider])).toEqual({
      ...selected,
      minConfidence: 0.7,
    });
    expect(defaultJevReviewer("typesafe")).toMatchObject({
      model: "jev-latest",
      credential: { env: "TYPESAFE_API_KEY" },
      minConfidence: 0.7,
    });
    expect(defaultJevReviewer("custom", [provider], "https://opencode.ai/custom")).toMatchObject({
      baseURL: "https://opencode.ai/custom",
      credential: { provider: "opencode-go" },
    });
  });
  it("凭据只从选定来源取；provider 与 stored 使用不同 id，会话头沿用条目", async () => {
    const get = vi.fn(async (id: string) => `key-${id}`);
    const store = { get } as unknown as CredentialStore;
    const env = vi.fn((name: string) => (name === "JEV_KEY" ? "env-key" : undefined));
    const providers = [{ id: "opencode-go", sessionHeader: "x-opencode-session" }];
    const connection = resolveJevConnection(selected, providers, store, env);
    expect(await connection.key()).toBe("key-opencode-go");
    expect(env).not.toHaveBeenCalled();
    expect(
      resolveJevConnection(
        selected,
        [{ id: "opencode-go", sessionHeader: "custom-session-header" }],
        store,
        env,
      ).sessionHeader,
    ).toBe("custom-session-header");
    expect(connection).toMatchObject({
      baseURL: "https://opencode.ai/zen/v1",
      sessionHeader: "x-opencode-session",
      minConfidence: 0.7,
    });
    expect(
      await resolveJevConnection(
        { ...selected, credential: { stored: true } },
        providers,
        store,
        env,
      ).key(),
    ).toBe("key-reviewer");
    get.mockClear();
    expect(
      await resolveJevConnection(
        { ...selected, credential: { env: "JEV_KEY" } },
        providers,
        store,
        env,
      ).key(),
    ).toBe("env-key");
    expect(get).not.toHaveBeenCalled();
  });
  it("实时 GET 模型列表，只留下含 jev 的 id 并去重", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          { id: "gpt" },
          { id: "jev-latest" },
          { id: "Jev-custom" },
          { id: "jev-latest" },
          { id: 42 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await fetchJevModels(
      { baseURL: "https://example.invalid/v1", key: async () => "test-key" },
      "jev-default",
    );
    expect(result).toEqual({ models: ["jev-latest", "Jev-custom"] });
    expect(fetch).toHaveBeenCalledWith(
      "https://example.invalid/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } }),
    );
  });
  it.each([null, { data: [] }, { data: [{ id: "gpt" }] }])(
    "列表格式错误或没有 Jev 退回默认 %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      expect(
        await fetchJevModels(
          { baseURL: "https://example.invalid", key: async () => undefined },
          "jev-default",
        ),
      ).toMatchObject({ models: ["jev-default"], warning: expect.stringContaining("退回默认") });
    },
  );
  it("列表网络或 HTTP 失败退回默认", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const call = () =>
      fetchJevModels(
        { baseURL: "https://example.invalid", key: async () => undefined },
        "jev-default",
      );
    expect((await call()).models).toEqual(["jev-default"]);
    fetch.mockResolvedValue(new Response("", { status: 401 }));
    expect((await call()).models).toEqual(["jev-default"]);
  });
});
