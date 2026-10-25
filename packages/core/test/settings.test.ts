import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  loadSettingsStore,
  type SettingsPatch,
  type CredentialStore,
} from "../src/index.js";
import { createRulePolicy, PERMISSION_PRESET_NAMES } from "../src/permission/index.js";

let root: string;
let home: string;
let workspace: string;
const platform = createPlatform();
const noEnv = () => undefined;
const json = (name: string, value: unknown) =>
  writeFile(path.join(home, name), JSON.stringify(value));
const readSettings = async () =>
  JSON.parse(await readFile(path.join(home, "settings.json"), "utf8")) as Record<string, unknown>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nct-settings-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await Promise.all([mkdir(home), mkdir(workspace)]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const load = () => loadConfig(platform, { nocturneHome: home, env: noEnv });

describe("ADR-0034 设置层", () => {
  it("压缩阈值：默认、设置、用户与可信项目逐层覆盖，清除保留未知字段", async () => {
    const defaults = await load();
    expect(
      defaults.describeSettings().find((item) => item.key === "compaction.threshold"),
    ).toMatchObject({ effective: "90%", source: "default" });
    await json("settings.json", { compaction: { threshold: "200k", future: true } });
    const settings = await load();
    expect(settings.resolvedSettings().compactionThreshold).toBe("200k");
    await json("config.json", { compaction: { threshold: "75%" } });
    await mkdir(path.join(workspace, ".nocturne"));
    await writeFile(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({ compaction: { threshold: 300000 } }),
    );
    const config = await load();
    await config.forWorkspace(workspace);
    expect(config.resolvedSettings(workspace).compactionThreshold).toBe("75%");
    await config.setWorkspaceTrusted(workspace, true);
    await config.forWorkspace(workspace);
    expect(
      config.describeSettings(workspace).find((item) => item.key === "compaction.threshold"),
    ).toMatchObject({ effective: "300000", saved: "200k", source: "project", overridden: true });
    await expect(config.updateSettings({ "compaction.threshold": "101%" })).rejects.toThrow();
    expect((await readSettings()).compaction).toEqual({ threshold: "200k", future: true });
    await config.updateSettings({ "compaction.threshold": "1.5m" });
    expect((await readSettings()).compaction).toEqual({ threshold: "1.5m", future: true });
    await config.updateSettings({ "compaction.threshold": null });
    expect((await readSettings()).compaction).toEqual({ future: true });
    expect(config.resolvedSettings(workspace).compactionThreshold).toBe(300000);
  });
  it("设置层无效压缩阈值被忽略，合法字段仍生效", async () => {
    await json("settings.json", { compaction: { threshold: "0%" }, shell: "cmd" });
    const config = await load();
    expect(config.resolvedSettings().compactionThreshold).toBeUndefined();
    expect(config.base.shell).toBe("cmd");
    expect(config.base.warnings.join("\n")).toContain("compaction");
  });
  it("ADR-0066 修剪上限：默认 200000、逐层覆盖、0 不设上限、非法值拒绝与独立降级", async () => {
    const defaults = await load();
    expect(
      defaults.describeSettings().find((item) => item.key === "compaction.pruneLimit"),
    ).toMatchObject({ effective: "200000", source: "default", overridden: false });
    await json("settings.json", {
      compaction: { threshold: "85%", pruneLimit: 150000, future: true },
    });
    const settings = await load();
    expect(settings.resolvedSettings().compactionPruneLimit).toBe(150000);
    await json("config.json", { compaction: { pruneLimit: 0 } });
    await mkdir(path.join(workspace, ".nocturne"));
    await writeFile(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({ compaction: { pruneLimit: 300000 } }),
    );
    const config = await load();
    await config.forWorkspace(workspace);
    expect(config.resolvedSettings(workspace).compactionPruneLimit).toBe(0);
    await config.setWorkspaceTrusted(workspace, true);
    await config.forWorkspace(workspace);
    expect(
      config.describeSettings(workspace).find((item) => item.key === "compaction.pruneLimit"),
    ).toMatchObject({ effective: "300000", saved: "150000", source: "project", overridden: true });
    await expect(config.updateSettings({ "compaction.pruneLimit": -1 })).rejects.toThrow();
    await expect(config.updateSettings({ "compaction.pruneLimit": 1.5 })).rejects.toThrow();
    await config.updateSettings({ "compaction.pruneLimit": 0 });
    expect((await readSettings()).compaction).toEqual({
      threshold: "85%",
      pruneLimit: 0,
      future: true,
    });
    await config.updateSettings({ "compaction.pruneLimit": null });
    expect((await readSettings()).compaction).toEqual({ threshold: "85%", future: true });

    // 设置层 compaction.pruneLimit 损坏不影响 compaction.threshold
    await json("config.json", {});
    await json("settings.json", { compaction: { threshold: "80%", pruneLimit: -5 } });
    const partial = await load();
    expect(partial.resolvedSettings().compactionThreshold).toBe("80%");
    expect(partial.resolvedSettings().compactionPruneLimit).toBeUndefined();
    expect(partial.base.warnings.join("\n")).toContain("compaction.pruneLimit");
  });
  it("审查器保存、清除、关闭与高层覆盖；未知字段保留，坏配置拒绝写入", async () => {
    await json("settings.json", { permission: { extra: 1 }, other: true });
    const config = await load();
    const reviewer = { backend: "model" as const, model: { provider: "fake", model: "review" } };
    await config.updateSettings({ "permission.reviewer": reviewer });
    expect(config.resolvedSettings().permissionReviewer).toEqual(reviewer);
    expect(
      config.describeSettings().find((item) => item.key === "permission.reviewer"),
    ).toMatchObject({ effective: "fake/review", saved: "fake/review", source: "settings" });
    expect(await readSettings()).toMatchObject({ permission: { reviewer, extra: 1 }, other: true });
    await expect(
      config.updateSettings({
        "permission.reviewer": { backend: "model", model: { provider: "", model: "x" } },
      }),
    ).rejects.toThrow();
    await config.updateSettings({ "permission.reviewer": { backend: "off" } });
    expect(config.resolvedSettings().permissionReviewer).toEqual({ backend: "off" });
    await config.updateSettings({ "permission.reviewer": null });
    expect(config.resolvedSettings().permissionReviewer).toBeUndefined();
    await json("config.json", { permission: { reviewer } });
    const overridden = await load();
    await overridden.updateSettings({ "permission.reviewer": { backend: "off" } });
    expect(
      overridden.describeSettings().find((item) => item.key === "permission.reviewer"),
    ).toMatchObject({ effective: "fake/review", source: "user", overridden: true });
  });
  it("Jev 独立密钥走凭据库，设置只写引用；写入失败恢复原密钥", async () => {
    const keys = new Map<string, string>([["reviewer", "old-key"]]);
    const credentials: CredentialStore = {
      get: async (id) => keys.get(id),
      set: vi.fn(async (id, key) => {
        keys.set(id, key);
      }),
      delete: vi.fn(async (id) => {
        keys.delete(id);
      }),
      has: (id) => keys.has(id),
      backend: () => "memory",
    };
    const config = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials });
    const runtime = await createRuntime({ cwd: workspace, workspaceRoot: workspace, config });
    const reviewer = {
      backend: "jev" as const,
      endpoint: "opencode-zen" as const,
      model: "jev-1.13-free",
      credential: { stored: true as const },
      minConfidence: 0.7,
    };
    await runtime.updateSettings({ "permission.reviewer": reviewer }, { reviewerKey: "new-key" });
    expect(keys.get("reviewer")).toBe("new-key");
    const saved = await readSettings();
    expect(saved).toMatchObject({ permission: { reviewer } });
    expect(JSON.stringify(saved)).not.toContain("new-key");
    expect(
      runtime.describeSettings().find((item) => item.key === "permission.reviewer"),
    ).toMatchObject({
      reviewer: { saved: reviewer, effective: reviewer },
      saved: "Jev · opencode-zen · jev-1.13-free",
    });
    const write = vi.spyOn(config, "updateSettings").mockRejectedValue(new Error("disk failure"));
    await expect(
      runtime.updateSettings({ "permission.reviewer": reviewer }, { reviewerKey: "replacement" }),
    ).rejects.toThrow("disk failure");
    expect(keys.get("reviewer")).toBe("new-key");
    write.mockRestore();
    vi.mocked(credentials.set).mockRejectedValueOnce(new Error("store unavailable"));
    await expect(
      runtime.updateSettings({ "permission.reviewer": reviewer }, { reviewerKey: "replacement" }),
    ).rejects.toThrow("store unavailable");
    expect(keys.get("reviewer")).toBe("new-key");
    expect(await readSettings()).toEqual(saved);
    await expect(
      runtime.updateSettings(
        { "permission.reviewer": { backend: "off" } },
        { reviewerKey: "invalid" },
      ),
    ).rejects.toThrow("单独密钥");
    const concurrent = vi.spyOn(config, "updateSettings").mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("disk failure");
    });
    const results = await Promise.allSettled([
      runtime.updateSettings({ "permission.reviewer": reviewer }, { reviewerKey: "failed-key" }),
      runtime.updateSettings({ "permission.reviewer": reviewer }, { reviewerKey: "last-key" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(keys.get("reviewer")).toBe("last-key");
    expect(await readSettings()).toMatchObject({ permission: { reviewer } });
    concurrent.mockRestore();
  });
  it("可信项目默认模型的档位同时用于 setDefaultModel 校验与界面模型清单", async () => {
    await mkdir(path.join(workspace, ".nocturne"));
    await writeFile(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({
        model: "corp/project",
        providers: [
          {
            id: "corp",
            type: "openai-compatible",
            baseURL: "https://example.invalid",
            models: { project: { capabilities: { reasoningEffort: ["low", "high"] } } },
          },
        ],
      }),
    );
    const config = await load();
    await config.setWorkspaceTrusted(workspace, true);
    await config.forWorkspace(workspace);
    const runtime = await createRuntime({ cwd: workspace, workspaceRoot: workspace, config });
    expect(
      runtime.listModels().find((model) => model.ref.model === "project")?.capabilities
        .reasoningEffort,
    ).toEqual(["low", "high"]);
    await runtime.setDefaultModel("corp/project", "high");
    await expect(runtime.setDefaultModel("corp/project", "medium")).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(runtime.describeSettings().find((item) => item.key === "defaultModel")).toMatchObject({
      effective: "corp/project",
      source: "project",
    });
  });
  it("shell 通用合并保持声明边界，环境选择不继承低层路径，非法路径被忽略", async () => {
    await json("settings.json", { shell: "bash", shellPath: "C:/custom/bash.exe" });
    await json("config.json", { shell: "cmd" });
    const config = await load();
    expect(config.base.shell).toBe("cmd");
    expect(config.base.shellPath).toBeUndefined();
    expect(config.describeSettings().find((item) => item.key === "shell")).toMatchObject({
      effective: "cmd",
      saved: "C:/custom/bash.exe",
      source: "user",
      overridden: true,
    });
    await json("config.json", { shell: "pwsh", shellPath: "C:/custom/pwsh.exe" });
    const env = await loadConfig(platform, {
      nocturneHome: home,
      env: (key) => (key === "NOCTURNE_SHELL" ? "bash" : undefined),
    });
    expect(env.base.shell).toBe("bash");
    expect(env.base.shellPath).toBeUndefined();
    expect(env.describeSettings().find((item) => item.key === "shell")?.source).toBe("env");
    await json("settings.json", { shellPath: "C:/custom/unknown.exe" });
    const { store, warning } = await loadSettingsStore(platform, path.join(home, "settings.json"));
    expect(store.fields().shellPath).toBeUndefined();
    expect(warning).toContain("无法识别");
  });
  it("并发设置、shell 与界面偏好写入不会互相丢失，未知字段保留", async () => {
    await json("settings.json", { unknown: { value: 1 }, theme: "dark" });
    const config = await load();
    await Promise.all([
      config.updateSettings({ "permissions.preset": "auto-edit" }),
      config.setPreference("theme", "light"),
      config.setDefaultModel("fake/m", "high"),
      config.setShellSetting("cmd"),
    ]);
    expect(await readSettings()).toMatchObject({
      unknown: { value: 1 },
      theme: "light",
      permissions: { preset: "auto-edit" },
      model: "fake/m",
      reasoningEffort: "high",
      shell: "cmd",
    });
  });
  it("默认档位只读：updateSettings 拒绝单独修改档位（ADR-0034 修订）", async () => {
    await json("settings.json", { model: "fake/saved" });
    await json("config.json", { model: "fake/user" });
    const config = await load();
    const models = [
      { id: "saved", levels: ["high" as const] },
      { id: "user", levels: ["low" as const] },
    ];
    const runtime = await createRuntime({
      cwd: workspace,
      config,
      sessionsDir: path.join(root, "sessions"),
      providers: [
        new FakeProvider({
          models: models.map(({ id, levels }) => ({
            ref: { provider: "fake", model: id },
            capabilities: {
              toolCalls: true,
              parallelToolCalls: true,
              reasoning: "visible",
              imageInput: false,
              promptCache: false,
              editTool: "edit",
              reasoningEffort: levels,
            },
          })),
        }),
      ],
    });
    const before = await readSettings();
    await expect(
      runtime.updateSettings({ reasoningEffort: "low" } as unknown as SettingsPatch),
    ).rejects.toThrow("setDefaultModel");
    expect(await readSettings()).toEqual(before);
    expect(runtime.describeSettings().find((item) => item.key === "reasoningEffort")).toMatchObject(
      { readonly: true },
    );
  });

  it("设置高于旧向导，用户配置优先且不被程序改写，未知字段与界面偏好保留", async () => {
    await json("providers.json", { version: 1, model: "fake/old", providers: [] });
    await json("settings.json", {
      model: "fake/new",
      reasoningEffort: "low",
      permissions: {
        preset: "auto-edit",
        rules: [{ kind: "edit", pattern: "**", action: "allow" }],
        future: 7,
      },
      theme: "light",
      providers: [{ id: "evil" }],
      extra: { nested: true },
    });
    const config = await load();
    expect(config.base.model).toBe("fake/new");
    expect(config.base.rules).toEqual([]);
    expect(config.base.providers).toEqual([]);
    expect(config.describeSettings().find((item) => item.key === "defaultModel")).toMatchObject({
      effective: "fake/new",
      saved: "fake/new",
      source: "settings",
      overridden: false,
      readonly: true,
    });
    await json("config.json", {
      model: "fake/user",
      permissions: { preset: "read-only" },
      reasoningEffort: "high",
    });
    const before = await readFile(path.join(home, "config.json"), "utf8");
    const user = await load();
    await user.updateSettings({ "permissions.preset": "guarded" });
    await user.setDefaultModel("fake/new", "medium");
    expect(user.describeSettings().find((item) => item.key === "reasoningEffort")).toMatchObject({
      effective: "high",
      saved: "medium",
      source: "user",
      overridden: true,
    });
    expect(await readSettings()).toMatchObject({
      theme: "light",
      extra: { nested: true },
      permissions: { preset: "guarded", future: 7 },
      providers: [{ id: "evil" }],
    });
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(before);
    await user.setPreference("theme", "dark");
    expect(user.getPreference("theme")).toBe("dark");
  });
  it("项目只在信任后覆盖设置；环境与 CLI 优先并正确标记来源", async () => {
    await json("settings.json", { model: "fake/settings", permissions: { preset: "auto-edit" } });
    await mkdir(path.join(workspace, ".nocturne"));
    await writeFile(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({ model: "fake/project", permissions: { preset: "read-only" } }),
    );
    const config = await load();
    await config.forWorkspace(workspace);
    expect(
      config.describeSettings(workspace).find((item) => item.key === "defaultModel")?.source,
    ).toBe("settings");
    await config.setWorkspaceTrusted(workspace, true);
    await config.forWorkspace(workspace);
    expect(
      config.describeSettings(workspace).find((item) => item.key === "defaultModel"),
    ).toMatchObject({ effective: "fake/project", source: "project", overridden: true });
    const env = await loadConfig(platform, {
      nocturneHome: home,
      env: (key) => (key === "NOCTURNE_MODEL" ? "fake/env" : undefined),
    });
    expect(env.describeSettings().find((item) => item.key === "defaultModel")?.source).toBe("env");
    const cli = await loadConfig(platform, {
      nocturneHome: home,
      env: (key) => (key === "NOCTURNE_MODEL" ? "fake/env" : undefined),
      cliArgs: { model: "fake/cli" },
    });
    expect(cli.describeSettings().find((item) => item.key === "defaultModel")).toMatchObject({
      effective: "fake/cli",
      source: "cli",
      overridden: true,
    });
  });
  it.each(["{bad", "[]", "null"])("损坏文件 %s 降级而不阻止加载", async (raw) => {
    await writeFile(path.join(home, "settings.json"), raw);
    const config = await load();
    expect(config.base.model).toBeUndefined();
    expect(config.base.warnings.join("\n")).toContain("settings.json");
  });
  it("无效字段逐个忽略并警告，其余合法字段仍然生效", async () => {
    await json("settings.json", {
      model: 123,
      reasoningEffort: "bogus",
      permissions: { preset: "bogus" },
      shell: "cmd",
      theme: "light",
    });
    const config = await load();
    expect(config.base.model).toBeUndefined();
    expect(config.base.reasoningEffort).toBeUndefined();
    expect(config.base.permissionPreset).toBeUndefined();
    expect(config.base.shell).toBe("cmd");
    expect(config.base.warnings.join("\n")).toContain("reasoningEffort");
    expect(config.getPreference("theme")).toBe("light");
  });
  it("schema 与只读字段拒绝，null 清除后来源回到默认", async () => {
    const config = await load();
    await config.updateSettings({ "permissions.preset": "auto-edit" });
    const before = await readSettings();
    await expect(
      config.updateSettings({ reasoningEffort: "bogus" } as unknown as SettingsPatch),
    ).rejects.toThrow();
    await expect(config.updateSettings({ model: "fake/new" } as SettingsPatch)).rejects.toThrow();
    expect(await readSettings()).toEqual(before);
    await config.updateSettings({ "permissions.preset": null });
    expect(
      config.describeSettings().find((item) => item.key === "permissions.preset"),
    ).toMatchObject({ effective: "default", source: "default", saved: undefined });
  });
  it("原子 rename 失败时磁盘和内存都保留旧值，后续写入可重试", async () => {
    const { store } = await loadSettingsStore(platform, path.join(home, "settings.json"));
    await store.setDefaultModel("fake/old", "low");
    const rename = vi.spyOn(platform.fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(store.setDefaultModel("fake/new", "high")).rejects.toThrow("disk failure");
    expect(store.fields()).toMatchObject({ model: "fake/old", reasoningEffort: "low" });
    expect(await readSettings()).toMatchObject({ model: "fake/old", reasoningEffort: "low" });
    rename.mockRestore();
    await store.setDefaultModel("fake/new", null);
    expect(store.fields()).toMatchObject({ model: "fake/new" });
    expect(store.fields().reasoningEffort).toBeUndefined();
  });
  it("模型和档位仅一次原子写入，旧 providers 模型兼容且文件不再被写", async () => {
    await json("providers.json", { version: 1, model: "fake/old", providers: [] });
    const config = await load();
    expect(config.base.model).toBe("fake/old");
    const before = await readFile(path.join(home, "providers.json"), "utf8");
    const rename = vi.spyOn(platform.fs, "rename");
    await config.setDefaultModel("fake/new", "low");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(config.base).toMatchObject({ model: "fake/new", reasoningEffort: "low" });
    expect(await readFile(path.join(home, "providers.json"), "utf8")).toBe(before);
  });
  it("Runtime 新会话默认生效，已有会话不变，不支持的档位拒绝", async () => {
    const config = await load();
    const provider = new FakeProvider({
      models: [
        {
          ref: { provider: "fake", model: "m" },
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "visible",
            imageInput: false,
            promptCache: false,
            editTool: "edit",
            reasoningEffort: ["low", "high"],
          },
        },
      ],
    });
    const runtime = await createRuntime({
      cwd: workspace,
      sessionsDir: path.join(root, "sessions"),
      config,
      providers: [provider],
    });
    const old = await runtime.createSession({ model: "fake/m" });
    await runtime.setDefaultModel("fake/m", "low");
    await runtime.updateSettings({ "permissions.preset": "read-only" });
    await expect(runtime.setDefaultModel("fake/m", "medium")).rejects.toMatchObject({
      code: "invalid_command",
      message: expect.stringContaining("off | low | high"),
    });
    expect(old.state().config.permissionPreset).toBe("default");
    expect(old.reasoningEffortInfo().current).toBe("off");
    const defaultModel = runtime.defaultModel();
    expect(defaultModel).toEqual({ provider: "fake", model: "m" });
    if (defaultModel === undefined) throw new Error("missing default model");
    const fresh = await runtime.createSession({ model: defaultModel });
    expect(fresh.state().config.model).toEqual({ provider: "fake", model: "m" });
    expect(fresh.state().config.permissionPreset).toBe("read-only");
    expect(fresh.reasoningEffortInfo().current).toBe("low");
    await runtime.setDefaultModel("fake/m", null);
    expect((await readSettings()).reasoningEffort).toBeUndefined();
    await Promise.all([old.close(), fresh.close()]);
  });
  it("未注入配置读取为空、写入 Promise 拒绝", async () => {
    const runtime = await createRuntime({
      cwd: workspace,
      sessionsDir: path.join(root, "sessions"),
    });
    expect(runtime.describeSettings()).toEqual([]);
    await expect(runtime.updateSettings({ "permissions.preset": null })).rejects.toThrow("未注入");
    await expect(runtime.setDefaultModel("fake/m", null)).rejects.toThrow("未注入");
  });
  it("通知偏好：缺省全开、逐字段合并、无效逐个忽略、补丁读写与 null 清除", async () => {
    const defaults = await load();
    expect(
      defaults.describeSettings().filter((item) => item.key.startsWith("notifications.")),
    ).toMatchObject([
      { key: "notifications.enabled", effective: "true", source: "default", saved: undefined },
      { key: "notifications.events.attention", effective: "true", source: "default" },
      { key: "notifications.events.error", effective: "true", source: "default" },
      { key: "notifications.events.done", effective: "true", source: "default" },
      { key: "notifications.doneAfterSeconds", effective: "60", source: "default" },
      { key: "notifications.sound", effective: "true", source: "default" },
    ]);
    expect(defaults.base.notifications).toEqual({
      enabled: true,
      events: { attention: true, error: true, done: true },
      doneAfterSeconds: 60,
      sound: true,
    });
    await json("settings.json", {
      notifications: {
        enabled: "yes",
        events: { attention: false },
        doneAfterSeconds: -5,
        sound: "loud",
      },
      theme: "dark",
    });
    const loaded = await load();
    expect(loaded.base.notifications).toEqual({
      enabled: true,
      events: { attention: false, error: true, done: true },
      doneAfterSeconds: 60,
      sound: true,
    });
    for (const key of ["enabled", "doneAfterSeconds", "sound"]) {
      expect(loaded.base.warnings.join("\n")).toContain(`notifications.${key}`);
    }
    expect(loaded.getPreference("theme")).toBe("dark");
    await json("settings.json", {
      notifications: { enabled: false, events: { done: false }, doneAfterSeconds: 30 },
    });
    await json("config.json", { notifications: { events: { error: false }, sound: false } });
    await mkdir(path.join(workspace, ".nocturne")).catch(() => undefined);
    await writeFile(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({ notifications: { doneAfterSeconds: 300 } }),
    );
    const layered = await load();
    await layered.forWorkspace(workspace);
    expect(layered.resolvedSettings(workspace).notifications).toEqual({
      enabled: false,
      events: { attention: true, error: false, done: false },
      doneAfterSeconds: 30,
      sound: false,
    });
    expect(
      layered.describeSettings(workspace).find((item) => item.key === "notifications.sound"),
    ).toMatchObject({ effective: "false", saved: undefined, source: "user", overridden: false });
    await layered.setWorkspaceTrusted(workspace, true);
    await layered.forWorkspace(workspace);
    expect(layered.resolvedSettings(workspace).notifications?.doneAfterSeconds).toBe(300);
    expect(
      layered.describeSettings(workspace).find((item) => item.key === "notifications.enabled"),
    ).toMatchObject({ effective: "false", saved: "false", source: "settings", overridden: false });
    const before = await readSettings();
    await expect(
      layered.updateSettings({ "notifications.doneAfterSeconds": 1.5 }),
    ).rejects.toThrow();
    await expect(
      layered.updateSettings({ "notifications.enabled": "yes" } as never),
    ).rejects.toThrow();
    expect(await readSettings()).toEqual(before);
    await layered.updateSettings({
      "notifications.events.attention": true,
      "notifications.doneAfterSeconds": 180,
      "notifications.sound": false,
    });
    expect(await readSettings()).toMatchObject({
      notifications: {
        enabled: false,
        events: { done: false, attention: true },
        doneAfterSeconds: 180,
        sound: false,
      },
    });
    await layered.updateSettings({ "notifications.events.done": null });
    expect((await readSettings()).notifications).toMatchObject({
      events: { attention: true },
    });
    await layered.updateSettings({
      "notifications.enabled": null,
      "notifications.events.attention": null,
      "notifications.doneAfterSeconds": null,
      "notifications.sound": null,
    });
    expect((await readSettings()).notifications ?? {}).toEqual({});
  });
  it("审查追加规则：逐字段合并、无效只丢自己不连累审查器、补丁读写与清除", async () => {
    const reviewer = { backend: "model", model: { provider: "fake", model: "m" } };
    await json("settings.json", {
      permission: { reviewer, reviewerRules: { ask: "任何 docker 命令", allow: "x".repeat(1001) } },
    });
    const invalid = await load();
    expect(invalid.base.permissionReviewer).toEqual(reviewer);
    expect(invalid.base.permissionReviewerRules).toBeUndefined();
    expect(invalid.base.warnings.join("\n")).toContain("permission.reviewerRules");

    await json("settings.json", { permission: { reviewerRules: { allow: "允许 pnpm install" } } });
    await json("config.json", { permission: { reviewerRules: { ask: "任何 ssh 命令" } } });
    const merged = await load();
    expect(merged.base.permissionReviewerRules).toEqual({
      ask: "任何 ssh 命令",
      allow: "允许 pnpm install",
    });
    expect(
      merged.describeSettings().find((item) => item.key === "permission.reviewerRules"),
    ).toMatchObject({
      effective: "额外交人 9 字 · 额外放行 15 字",
      saved: "额外放行 15 字",
      reviewerRules: {
        effective: { ask: "任何 ssh 命令", allow: "允许 pnpm install" },
        saved: { allow: "允许 pnpm install" },
      },
    });

    const before = await readSettings();
    await expect(
      merged.updateSettings({ "permission.reviewerRules": { ask: "x".repeat(1001) } }),
    ).rejects.toThrow();
    await expect(
      merged.updateSettings({ "permission.reviewerRules": { ask: 1 } } as never),
    ).rejects.toThrow();
    expect(await readSettings()).toEqual(before);

    await merged.updateSettings({
      "permission.reviewerRules": { ask: "不要动 prod 目录", allow: "  " },
    });
    expect((await readSettings()).permission).toEqual({
      reviewerRules: { ask: "不要动 prod 目录" },
    });
    await merged.updateSettings({ "permission.reviewer": { backend: "off" } });
    expect((await readSettings()).permission).toEqual({
      reviewer: { backend: "off" },
      reviewerRules: { ask: "不要动 prod 目录" },
    });
    await merged.updateSettings({ "permission.reviewerRules": null });
    expect((await readSettings()).permission).toEqual({ reviewer: { backend: "off" } });
  });
  it("通知事件无效字段单独忽略、容器无效不影响其他字段、未知字段写回保留", async () => {
    await json("settings.json", {
      notifications: {
        enabled: false,
        events: { attention: "yes", error: false, done: 1, future: true },
        sound: false,
        future: "keep",
      },
    });
    const config = await load();
    expect(config.base.notifications).toMatchObject({
      enabled: false,
      events: { attention: true, error: false, done: true },
      sound: false,
    });
    expect(config.base.warnings.join("\n")).toContain("notifications.events.attention");
    expect(config.base.warnings.join("\n")).toContain("notifications.events.done");
    await config.updateSettings({ "notifications.enabled": null });
    expect((await readSettings()).notifications).toMatchObject({
      events: { future: true },
      future: "keep",
    });
    await json("settings.json", { notifications: { events: [], enabled: false } });
    const malformed = await load();
    expect(malformed.base.notifications?.enabled).toBe(false);
    expect(malformed.base.warnings.join("\n")).toContain("notifications.events");
  });
  it.each(PERMISSION_PRESET_NAMES)("%s 对 settings edit 至少 ask（read-only deny）", (preset) => {
    const policy = createRulePolicy({
      workspaceRoot: root,
      caseSensitive: false,
      preset,
      presetContext: { nocturneHome: home },
    });
    const target = path.join(home, "settings.json");
    const decision = policy.evaluate([{ kind: "edit", target, resolved: target }]).decision;
    expect(decision.action).toBe(preset === "read-only" ? "deny" : "ask");
    if (preset !== "read-only")
      expect(decision.matchedRule?.rule?.label).toBe("修改 Nocturne 授权配置");
  });
});
