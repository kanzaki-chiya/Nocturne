import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  loadSettingsStore,
  type CredentialStore,
  type FakeScript,
  type ModelInfo,
  type RuntimeConfig,
} from "../src/index.js";

/**
 * ADR-0054：服务商与模型启停。settings.json 专用字段读写、注册表停用盖章、
 * 各解析点尊重 unavailable、恢复两条路径、刷新与删除语义。
 */
let root: string;
let home: string;
let workspace: string;
const platform = createPlatform();
const noEnv = () => undefined;

const model = (provider: string, id: string): ModelInfo => ({
  ref: { provider, model: id },
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: {
    toolCalls: true,
    parallelToolCalls: true,
    reasoning: "none",
    imageInput: false,
    promptCache: false,
    editTool: "edit",
  },
});

const writeJson = (name: string, value: unknown) =>
  writeFile(path.join(home, name), JSON.stringify(value));
const readSettings = async () =>
  JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")) as Record<string, unknown>;

async function credentials(): Promise<CredentialStore> {
  return (await createCredentialStore(platform, home, { backend: "memory" })).store;
}

async function load(): Promise<RuntimeConfig> {
  return loadConfig(platform, { nocturneHome: home, env: noEnv, credentials: await credentials() });
}

const setupProviderFile = (models: Record<string, unknown>) => ({
  version: 1,
  providers: [
    {
      id: "up",
      type: "openai-compatible",
      baseURL: "https://example.invalid/v1",
      models,
    },
  ],
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nct-toggle-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await Promise.all([mkdir(home), mkdir(workspace)]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ADR-0054 settings.json 停用集合", () => {
  it("专用字段读写保留未知字段；写盘失败不更新内存", async () => {
    const settingsPath = path.join(home, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ theme: "dark", disabledProviders: ["keep"] }));
    const { store } = await loadSettingsStore(platform, settingsPath);
    expect(store.disabledProviders()).toEqual(["keep"]);
    expect(store.disabledModels()).toEqual([]);
    await store.setProviderEnabled("grok", false);
    await store.setModelsEnabled("ocx", ["m1", "m2"], false);
    await store.setModelsEnabled("ocx", ["m1"], true);
    expect(store.disabledProviders()).toEqual(["keep", "grok"]);
    expect(store.disabledModels()).toEqual(["ocx/m2"]);
    expect(await readSettings()).toMatchObject({
      theme: "dark",
      disabledProviders: ["keep", "grok"],
      disabledModels: ["ocx/m2"],
    });

    // 写盘失败：内存保持旧值（不更新）
    const failing = {
      ...platform,
      fs: {
        ...platform.fs,
        writeFile: async () => {
          throw new Error("disk full");
        },
      },
    };
    const { store: broken } = await loadSettingsStore(failing, settingsPath);
    await expect(broken.setProviderEnabled("x", false)).rejects.toThrow();
    expect(broken.disabledProviders()).toEqual(["keep", "grok"]);
    expect(broken.disabledModels()).toEqual(["ocx/m2"]);
    await expect(broken.setModelsEnabled("ocx", ["m3"], false)).rejects.toThrow();
    expect(broken.disabledModels()).toEqual(["ocx/m2"]);
  });
});

describe("ADR-0054 Runtime 停用与解析", () => {
  it("停用服务商：listModels/defaultModel 与提交前拦截（无 HTTP）", async () => {
    const config = await load();
    const fake = new FakeProvider({
      models: [model("fake", "a"), model("fake", "b")],
      scripts: [
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await config.setDefaultModel("fake/a", null);
    expect(runtime.defaultModel()).toEqual({ provider: "fake", model: "a" });
    const session = await runtime.createSession({ model: "fake/a" });

    await runtime.setProviderEnabled({ provider: "fake", enabled: false });
    expect(runtime.listModels()).toEqual([]);
    expect(
      runtime.listModels({ includeDisabled: true }).map((m) => [m.ref.model, m.disabled]),
    ).toEqual([
      ["a", "provider"],
      ["b", "provider"],
    ]);
    expect(runtime.defaultModel()).toBeUndefined();
    expect(runtime.describeSettings().find((item) => item.key === "defaultModel")).toMatchObject({
      effective: "fake/a",
      disabled: "provider",
    });
    expect(config.disabledProviders()).toEqual(["fake"]);

    await expect(session.submit({ text: "hi" })).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "provider", model: { provider: "fake", model: "a" } },
    });
    expect(fake.requests).toHaveLength(0);
    await expect(runtime.createSession({ model: "fake/a" })).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "provider", model: { provider: "fake", model: "a" } },
    });
    await expect(session.setModel("fake/b")).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "provider" },
    });

    // 重新启用：立即恢复（设置值本身未改写）
    await runtime.setProviderEnabled({ provider: "fake", enabled: true });
    expect(runtime.listModels().map((m) => m.ref.model)).toEqual(["a", "b"]);
    expect(runtime.defaultModel()).toEqual({ provider: "fake", model: "a" });
    expect(await session.submit({ text: "hi" })).toBe("done");
    expect(
      runtime.describeSettings().find((item) => item.key === "defaultModel")?.disabled,
    ).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    await session.close();
  });

  it("逐个模型停用：默认滤除；服务商关开保留个别设置", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a"), model("fake", "b")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: false });
    expect(runtime.listModels().map((m) => m.ref.model)).toEqual(["a"]);
    expect(
      runtime.listModels({ includeDisabled: true }).find((m) => m.ref.model === "b")?.disabled,
    ).toBe("model");

    // 服务商停用再启用：b 的逐个停用保留
    await runtime.setProviderEnabled({ provider: "fake", enabled: false });
    await runtime.setProviderEnabled({ provider: "fake", enabled: true });
    expect(runtime.listModels().map((m) => m.ref.model)).toEqual(["a"]);
    expect(config.disabledModels()).toEqual(["fake/b"]);

    // 全部启用
    await runtime.setModelsEnabled({ provider: "fake", models: ["a", "b"], enabled: true });
    expect(runtime.listModels().map((m) => m.ref.model)).toEqual(["a", "b"]);
    expect(config.disabledModels()).toEqual([]);
  });

  it("describeToggleImpact：打开会话/默认模型/角色，未配置角色时为空", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a"), model("fake", "b")] });
    const other = new FakeProvider({ id: "other", models: [model("other", "x")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake, other],
    });
    const session = await runtime.createSession({ model: "fake/a" });
    await config.setDefaultModel("fake/b", null);
    await config.setModelRole("task", "fake/b");
    expect(runtime.describeToggleImpact({ provider: "fake" })).toEqual({
      affectedSessions: 1,
      defaultModel: true,
      roles: ["task"],
    });
    // 只停用 b：会话用的是 a，不受影响；默认模型与角色仍指向 b
    expect(runtime.describeToggleImpact({ provider: "fake", models: ["b"] })).toEqual({
      affectedSessions: 0,
      defaultModel: true,
      roles: ["task"],
    });
    // 角色指向停用模型时按不可用处理（available false、model undefined）
    await runtime.setProviderEnabled({ provider: "fake", enabled: false });
    expect(runtime.describeModelRoles().find((role) => role.role === "task")).toMatchObject({
      configured: "fake/b",
      model: undefined,
      available: false,
    });
    await runtime.setProviderEnabled({ provider: "fake", enabled: true });
    expect(runtime.describeModelRoles().find((role) => role.role === "task")).toMatchObject({
      model: "fake/b",
      available: true,
    });
    // 未配置角色时为空
    await config.setModelRole("task", null);
    expect(runtime.describeToggleImpact({ provider: "fake" }).roles).toEqual([]);
    await session.close();
  });

  it("恢复：停用模型无替代拒绝、带替代先写 config_changed；未知模型无 disabled 细节", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a")] });
    const other = new FakeProvider({ id: "other", models: [model("other", "x")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake, other],
    });
    const session = await runtime.createSession({ model: "fake/a" });
    const id = session.id;
    await session.close();
    await runtime.setProviderEnabled({ provider: "fake", enabled: false });

    // 路径一：无替代模型 → invalid_model（携带结构化停用信息）
    await expect(runtime.resumeSession(id)).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "provider", model: { provider: "fake", model: "a" } },
    });

    // 路径二：带替代模型 → 先写 session.config_changed 再打开
    const resumed = await runtime.resumeSession(id, { model: "other/x" });
    expect(resumed.state().config.model).toEqual({ provider: "other", model: "x" });
    const events = resumed.durableEvents();
    const changedIndex = events.findIndex((e) => e.type === "session.config_changed");
    expect(changedIndex).toBeGreaterThan(0);
    expect(events[changedIndex]?.payload).toMatchObject({
      model: { provider: "other", model: "x" },
    });
    // 未知模型（服务商不存在）无 disabled 细节，与停用区分
    const ghost = await resumed.setModel("ghost/x").then(
      () => undefined,
      (error: { code?: string; detail?: unknown }) => error,
    );
    expect(ghost?.code).toBe("invalid_model");
    expect(ghost?.detail).toBeUndefined();
    await resumed.close();
  });
});

describe("ADR-0054 刷新与删除", () => {
  it("刷新：上游新模型默认启用，已停用 ID 刷新后仍停用", async () => {
    await writeJson("providers.json", setupProviderFile({ a: {}, b: {} }));
    const config = await load();
    const runtime = await createRuntime({ cwd: workspace, workspaceRoot: workspace, config });
    await runtime.setModelsEnabled({ provider: "up", models: ["a"], enabled: false });
    expect(runtime.listModels().map((m) => m.ref.model)).toEqual(["b"]);
    expect((await config.describeProviders()).find((p) => p.id === "up")).toMatchObject({
      enabled: true,
      enabledModelCount: 1,
      modelCount: 2,
    });

    // 上游刷新新增 c：重写 providers.json 后重载
    await writeJson("providers.json", setupProviderFile({ a: {}, b: {}, c: {} }));
    const reloaded = await config.reload();
    await runtime.updateProviders(reloaded);
    expect(runtime.listModels().map((m) => m.ref.model)).toEqual(["b", "c"]);
    expect(
      runtime.listModels({ includeDisabled: true }).find((m) => m.ref.model === "a")?.disabled,
    ).toBe("model");
    expect((await reloaded.describeProviders()).find((p) => p.id === "up")).toMatchObject({
      enabled: true,
      enabledModelCount: 2,
      modelCount: 3,
    });

    // 停用整个服务商：enabled=false、已启用模型数为 0
    await runtime.setProviderEnabled({ provider: "up", enabled: false });
    expect((await reloaded.describeProviders()).find((p) => p.id === "up")).toMatchObject({
      enabled: false,
      enabledModelCount: 0,
      modelCount: 3,
    });
  });

  it("删除向导服务商清除停用条目；之后同名重新添加从全部启用开始", async () => {
    await writeJson("providers.json", setupProviderFile({ a: {}, b: {} }));
    const config = await load();
    await config.setProviderEnabled("up", false);
    await config.setModelsEnabled("up", ["a"], false);
    expect(config.disabledProviders()).toEqual(["up"]);
    expect(config.disabledModels()).toEqual(["up/a"]);

    await config.removeSetupProvider("up");
    expect(config.disabledProviders()).toEqual([]);
    expect(config.disabledModels()).toEqual([]);
    expect((await config.describeProviders()).find((p) => p.id === "up")).toBeUndefined();

    await writeJson("providers.json", setupProviderFile({ a: {}, b: {} }));
    const readded = await config.reload();
    expect((await readded.describeProviders()).find((p) => p.id === "up")).toMatchObject({
      enabled: true,
      enabledModelCount: 2,
    });
  });

  it("删除时停用条目清理写盘失败：服务商已删、残留旧条目并显式报错", async () => {
    await writeJson("providers.json", setupProviderFile({ a: {}, b: {} }));
    await writeJson("settings.json", {
      disabledProviders: ["up"],
      disabledModels: ["up/a"],
    });
    // 只让 settings.json 写盘失败（临时文件同名匹配）：providers.json 删除成功
    const failing = {
      ...platform,
      fs: {
        ...platform.fs,
        writeFile: (p: string, data: string | Uint8Array, options?: { mode?: number }) => {
          if (p.includes("settings.json")) return Promise.reject(new Error("disk full"));
          return platform.fs.writeFile(p, data, options);
        },
      },
    };
    const failingConfig = await loadConfig(failing, {
      nocturneHome: home,
      env: noEnv,
      credentials: await credentials(),
    });
    const failure = await failingConfig.removeSetupProvider("up").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ code: "config_unavailable" });
    expect(String((failure as Error)?.message)).toContain('服务商 "up" 已删除');
    expect(String((failure as Error)?.message)).toContain("停用条目");
    // 服务商已删除，旧停用条目残留（写盘失败不更新内存）
    expect(failingConfig.disabledProviders()).toEqual(["up"]);
    expect(failingConfig.disabledModels()).toEqual(["up/a"]);
    expect(await failingConfig.describeProviders()).toHaveLength(0);
  });

  it('停用的服务商下逐个设置仍可辨认：disabled 报 "model"，其余报 "provider"', async () => {
    await writeJson("providers.json", setupProviderFile({ a: {}, b: {} }));
    const config = await load();
    const runtime = await createRuntime({ cwd: workspace, workspaceRoot: workspace, config });
    await runtime.setModelsEnabled({ provider: "up", models: ["a"], enabled: false });
    await runtime.setProviderEnabled({ provider: "up", enabled: false });
    expect(
      runtime.listModels({ includeDisabled: true }).map((m) => [m.ref.model, m.disabled]),
    ).toEqual([
      ["a", "model"],
      ["b", "provider"],
    ]);
    // 服务商停用按未设置处理；引用它的默认模型同样不可用
    await config.setDefaultModel("up/a", null);
    expect(runtime.defaultModel()).toBeUndefined();
  });

  it('双重停用记 "model" 并带 providerDisabled；同时恢复后可用', async () => {
    const config = await load();
    const fake = new FakeProvider({
      models: [model("fake", "a"), model("fake", "b")],
      scripts: [
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    const session = await runtime.createSession({ model: "fake/a" });
    await runtime.setModelsEnabled({ provider: "fake", models: ["a"], enabled: false });
    await runtime.setProviderEnabled({ provider: "fake", enabled: false });

    // 双重命中记 "model"（保留逐个设置）并带 providerDisabled；单重只有 provider
    expect(
      runtime
        .listModels({ includeDisabled: true })
        .map((m) => [m.ref.model, m.disabled, m.providerDisabled ?? false]),
    ).toEqual([
      ["a", "model", true],
      ["b", "provider", false],
    ]);

    // 提交被拒携带双重信息，不发 HTTP
    await expect(session.submit({ text: "hi" })).rejects.toMatchObject({
      code: "invalid_model",
      detail: {
        disabled: "model",
        model: { provider: "fake", model: "a" },
        providerDisabled: true,
      },
    });
    expect(fake.requests).toHaveLength(0);

    // 只恢复模型仍不可用（服务商还停着，disabled 转回 "provider"）
    await runtime.setModelsEnabled({ provider: "fake", models: ["a"], enabled: true });
    await expect(session.submit({ text: "hi" })).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "provider", model: { provider: "fake", model: "a" } },
    });

    // 一键重新启用（同时恢复两者）后可用
    await runtime.setModelsEnabled({ provider: "fake", models: ["a"], enabled: false });
    await runtime.setProviderEnabled({ provider: "fake", enabled: false });
    await runtime.setModelsEnabled({ provider: "fake", models: ["a"], enabled: true });
    await runtime.setProviderEnabled({ provider: "fake", enabled: true });
    expect(await session.submit({ text: "hi" })).toBe("done");
    expect(fake.requests).toHaveLength(1);
    await session.close();
  });
});

/**
 * ADR-0054 §3：「所有经注册表解析模型的地方」都要尊重 unavailable。
 * 逐个核对会话模型、标题（smol）、子代理（task）、权限审查、压缩摘要，
 * 并覆盖「先正常解析、再热停用」的路径（不能沿用旧解析）。
 */
describe("ADR-0054 各解析点热停用", () => {
  const textScript = (text: string): FakeScript => [
    { type: "text_delta", text },
    { type: "finish", reason: "stop" },
  ];

  it("defaultModel：逐个停用按未设置；未声明服务商保持原行为", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a"), model("fake", "b")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await config.setDefaultModel("fake/b", null);
    expect(runtime.defaultModel()).toEqual({ provider: "fake", model: "b" });

    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: false });
    expect(runtime.defaultModel()).toBeUndefined();
    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: true });
    expect(runtime.defaultModel()).toEqual({ provider: "fake", model: "b" });

    // 服务商未声明（手写配置指向不存在的条目）：经注册表解析会抛错，
    // 保持原行为照常返回引用，不由 defaultModel 变成未设置
    await config.setDefaultModel("ghost/x", null);
    expect(runtime.defaultModel()).toEqual({ provider: "ghost", model: "x" });
    // 指向不存在服务商的停用条目无害（ADR-0054 §2：读取时忽略）：
    // 默认模型按未停用处理，而不是被另一套集合判成未设置
    await config.setModelsEnabled("ghost", ["x"], false);
    expect(runtime.defaultModel()).toEqual({ provider: "ghost", model: "x" });
  });

  it("单模型停用：新建会话/setModel/setDefaultModel 一律拒绝", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a"), model("fake", "b")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: false });

    // 新建会话：停用模型直接拒绝（不建会话）
    await expect(runtime.createSession({ model: "fake/b" })).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "model", model: { provider: "fake", model: "b" } },
    });
    // setModel：逐个停用的模型同样拒绝（此前只覆盖了服务商停用整组）
    const session = await runtime.createSession({ model: "fake/a" });
    await expect(session.setModel("fake/b")).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "model", model: { provider: "fake", model: "b" } },
    });
    // setDefaultModel：不再接受已停用模型（既有指向被停用后按未设置处理，见上一用例）
    await expect(runtime.setDefaultModel("fake/b", null)).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "model", model: { provider: "fake", model: "b" } },
    });
    await session.close();
  });

  it("标题模型（smol 角色）热停用 → 回退会话模型", async () => {
    const config = await load();
    const fake = new FakeProvider({
      models: [model("fake", "a"), model("fake", "b")],
      handler: () => textScript("完成"),
      roleHandler: () => textScript("标题"),
    });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await config.setModelRole("smol", "fake/b");
    const session = await runtime.createSession({ model: "fake/a" });
    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: false });
    await session.submit({ text: "你好" });
    await vi.waitFor(() =>
      expect(session.durableEvents().some((e) => e.type === "session.titled")).toBe(true),
    );
    expect(fake.roleRequests[0]).toMatchObject({ purpose: "title", model: "a" });
    await session.close();
  });

  it("子代理模型（task 角色）热停用 → 回退会话模型", async () => {
    const config = await load();
    const fake = new FakeProvider({
      models: [model("fake", "a"), model("fake", "b")],
      handler: (req) => {
        if (req.tools.some((t) => t.name === "finish"))
          return [
            {
              type: "tool_call",
              toolCallId: "cf1",
              name: "finish",
              input: { result: "子代理结论" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        return req.messages.some((m) => m.role === "tool")
          ? textScript("收到")
          : [
              {
                type: "tool_call",
                toolCallId: "t1",
                name: "task",
                input: { task: "调查", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await config.setModelRole("task", "fake/b");
    const session = await runtime.createSession({ model: "fake/a" });
    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: false });
    await session.submit({ text: "派个子代理" });
    const child = fake.requests.find((r) => r.tools.some((t) => t.name === "finish"));
    expect(child?.model).toBe("a");
    await session.close();
  });

  it("权限审查模型热停用 → 缓存失效、审查按未配置处理并告警", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a"), model("fake", "b")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    await config.updateSettings({
      "permission.reviewer": { backend: "model", model: { provider: "fake", model: "b" } },
    });
    const session = await runtime.createSession({ model: "fake/a", permissionPreset: "smart" });
    const warnings: string[] = [];
    session.subscribe((e) => {
      if (e.type === "runtime.warning") warnings.push(e.payload.code);
    });
    // 停用后 setPermissionPreset 会重建会话级注册表并重新解析审查器
    await runtime.setModelsEnabled({ provider: "fake", models: ["b"], enabled: false });
    await session.setPermissionPreset("smart");
    expect(warnings.filter((code) => code === "permission_reviewer_missing")).toHaveLength(1);
    await session.close();
  });

  it("压缩摘要：会话模型热停用 → compact 以 invalid_model 拒绝", async () => {
    const config = await load();
    const fake = new FakeProvider({ models: [model("fake", "a")] });
    const runtime = await createRuntime({
      cwd: workspace,
      workspaceRoot: workspace,
      config,
      providers: [fake],
    });
    const session = await runtime.createSession({ model: "fake/a" });
    await runtime.setModelsEnabled({ provider: "fake", models: ["a"], enabled: false });
    await expect(session.compact()).rejects.toMatchObject({
      code: "invalid_model",
      detail: { disabled: "model", model: { provider: "fake", model: "a" } },
    });
    await session.close();
  });
});
