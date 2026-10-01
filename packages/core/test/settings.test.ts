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
    await user.updateSettings({ "permissions.preset": "full-access" });
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
      permissions: { preset: "full-access", future: 7 },
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
