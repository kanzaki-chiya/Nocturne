import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadConfig,
  createPlatform,
  createRuntime,
  type ModelInfo,
  type ModelPricing,
  type ModelRequest,
} from "../src/index.js";
import { parseConfigFile } from "../src/config/schema.js";
import { mergeLayers } from "../src/config/merge.js";
import { resolveSubagentProfile } from "../src/config/subagent-profiles.js";
import { createTaskTool } from "../src/tools/index.js";
import { subagentSelectionTable, isValidSubagentProfileName } from "../src/protocol/index.js";
import { FakeProvider } from "../src/provider/index.js";

const profile = { description: "查找和读取", tools: "explore" as const, enabled: true };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("子代理档位配置", () => {
  it.each(["default", "Quick", "a_b", "x".repeat(33), "quick\n"])("拒绝名称 %s", (name) => {
    expect(isValidSubagentProfileName(name)).toBe(false);
  });
  it("无效字段逐个忽略并告警，其他字段保留", () => {
    const parsed = parseConfigFile(
      {
        subagents: {
          profiles: { quick: { ...profile, model: "bad", effort: "bad", timeoutMs: -1 } },
        },
      },
      "test.json",
    );
    expect(parsed.subagents?.profiles?.quick).toEqual(profile);
    expect(parsed.subagentProfileWarnings).toHaveLength(3);
  });
  it("分层按名称合并，高层整条覆盖", () => {
    const result = mergeLayers([
      { kind: "settings", file: { subagents: { profiles: { quick: profile, deep: profile } } } },
      {
        kind: "project",
        file: { subagents: { profiles: { quick: { description: "新说明", enabled: false } } } },
      },
    ]);
    expect(result.resolved.subagentProfiles).toEqual({
      quick: { description: "新说明", enabled: false },
      deep: profile,
    });
  });
  it("补丁逐条保存、删除，双向外部名称冲突拒绝", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "profiles-"));
    roots.push(home);
    const platform = { ...createPlatform(), env: () => undefined, homeDir: () => home };
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        modelsDev: false,
        externalAgents: [{ name: "offline", command: "offline", args: [], enabled: false }],
      }),
    );
    const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
    await config.updateSettings({ "subagents.profiles.quick": profile });
    expect(
      JSON.parse(
        config.describeSettings().find((item) => item.key === "subagents.profiles.quick")
          ?.effective ?? "null",
      ),
    ).toEqual(profile);
    expect(() => config.updateSettings({ "subagents.profiles.offline": profile })).toThrow(
      "外部 agent",
    );
    await expect(
      config.saveExternalAgent({
        mode: "create",
        name: "quick",
        config: { command: "offline", args: [], enabled: false },
      }),
    ).rejects.toThrow("档位");
    await config.updateSettings({ "subagents.profiles.quick": null });
    expect(config.resolvedSettings(home).subagentProfiles).toBeUndefined();
  });
  it("可信项目覆盖用户同名条目，不可信时整段忽略", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "profile-trust-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "ws");
    mkdirSync(home);
    mkdirSync(path.join(workspace, ".nocturne"), { recursive: true });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, subagents: { profiles: { quick: profile } } }),
    );
    writeFileSync(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({
        subagents: { profiles: { quick: { description: "项目档位", enabled: false } } },
      }),
    );
    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    expect((await config.forWorkspace(workspace)).resolved.subagentProfiles?.quick).toEqual(
      profile,
    );
    await config.setWorkspaceTrusted(workspace, true);
    expect((await config.forWorkspace(workspace)).resolved.subagentProfiles?.quick).toEqual({
      description: "项目档位",
      enabled: false,
    });
  });
  it("模型留空跟随当前，default 使用角色，模型不可用不回退", () => {
    const profiles = {
      quick: profile,
      deep: { ...profile, model: "p/deep" },
      off: { ...profile, enabled: false },
    };
    expect(
      resolveSubagentProfile("quick", profiles, () => undefined, "parent", "role")?.model,
    ).toBe("parent");
    expect(
      resolveSubagentProfile("default", profiles, () => undefined, "parent", "role")?.model,
    ).toBe("role");
    expect(
      resolveSubagentProfile("deep", profiles, () => undefined, "parent", "role"),
    ).toBeUndefined();
    expect(
      resolveSubagentProfile("off", profiles, () => undefined, "parent", "role"),
    ).toBeUndefined();
  });
});

describe("task 档位表", () => {
  const launcher = {
    launch: async () => ({
      status: "error" as const,
      error: { code: "offline", message: "offline" },
    }),
  };
  it("只有 default 不公开 profile，描述保持原状", () => {
    const tool = createTaskTool(launcher);
    expect(tool.inputSchema.properties).not.toHaveProperty("profile");
    expect(tool.description).not.toContain("按任务难度和性质挑");
  });
  it("公开 profile 枚举与共享表，兼容 agent 别名并拒绝同时指定", () => {
    const agents = [{ name: "offline", description: "外部" }];
    const profiles = [{ ...profile, name: "quick" }];
    const tool = createTaskTool(
      launcher,
      { agents, run: async () => ({ status: "ok", modelContent: "ok" }) },
      600000,
      profiles,
    );
    expect(tool.inputSchema.properties).toMatchObject({
      profile: { enum: ["default", "quick", "offline"] },
    });
    expect(tool.description).toContain(subagentSelectionTable(profiles, agents));
    expect(tool.validateInput?.({ task: "test", agent: "offline" })).toBeUndefined();
    expect(tool.validateInput?.({ task: "test", agent: "offline", profile: "offline" })).toContain(
      "不能同时",
    );
    expect(tool.validateInput?.({ task: "test", profile: "missing" })).toContain(
      "default, quick, offline",
    );
    expect(
      tool.permissionSubjects(
        { task: "test", profile: "quick" },
        { cwd: ".", workspaceRoot: ".", paths: createPlatform().paths },
      ),
    ).toEqual([{ kind: "subagent", target: "explore" }]);
  });

  it("选择表写上价格：覆盖有价格、查不到价格、default 跟随当前模型、分档模型、价格为 0、外部 agent 与两条生成路径一致", () => {
    const priceMap: Record<string, ModelPricing | undefined> = {
      "magpie/auto/deepseek-v4.1-flash": { input: 0.045, output: 0.5 },
      "magpie/workbuddy/deepseek-v4.1-flash": { input: 0.045, output: 0.5 },
      "magpie/antigravity/gemini-4-argon": {
        input: 1.25,
        output: 10,
        tiers: [{ aboveInputTokens: 200_000, input: 2.5, output: 15 }],
      },
      "p/free": { input: 0, output: 0 },
      "p/partial": { input: 1 },
    };
    const currentPricing: ModelPricing = { input: 2, output: 10 };
    const lookup = (model: string | undefined): ModelPricing | undefined =>
      model === undefined ? currentPricing : priceMap[model];

    const profiles = [
      {
        name: "quick",
        description: "只读查找",
        model: "magpie/workbuddy/deepseek-v4.1-flash",
        tools: "explore" as const,
        enabled: true,
      },
      {
        name: "deepseek",
        description: "实现与排查",
        model: "magpie/auto/deepseek-v4.1-flash",
        effort: "max" as const,
        enabled: true,
      },
      {
        name: "deep",
        description: "跨模块修改",
        model: "magpie/antigravity/gemini-4-argon",
        effort: "medium" as const,
        enabled: true,
      },
      {
        name: "free",
        description: "零价模型",
        model: "p/free",
        enabled: true,
      },
      {
        name: "unpriced",
        description: "未声明价格",
        model: "p/unknown",
        enabled: true,
      },
      {
        name: "partial",
        description: "单边价格缺失",
        model: "p/partial",
        enabled: true,
      },
    ];
    const agents = [{ name: "codex", description: "Codex CLI" }];

    const table = subagentSelectionTable(profiles, agents, undefined, lookup);
    const lines = table.split("\n");
    expect(lines[0]).toContain("每百万 token 的输入/输出美元");
    expect(table.match(/每百万 token/g)).toHaveLength(1);
    expect(table).toContain("  - default：通用。（跟随当前模型，跟随会话，$2/$10）");
    expect(table).toContain(
      "  - quick：只读查找（magpie/workbuddy/deepseek-v4.1-flash，跟随会话，只读，$0.045/$0.5）",
    );
    expect(table).toContain(
      "  - deepseek：实现与排查（magpie/auto/deepseek-v4.1-flash，max，$0.045/$0.5）",
    );
    expect(table).toContain(
      "  - deep：跨模块修改（magpie/antigravity/gemini-4-argon，medium，$1.25/$10）",
    );
    expect(table).toContain("  - free：零价模型（p/free，跟随会话，$0/$0）");
    expect(table).toContain("  - unpriced：未声明价格（p/unknown，跟随会话）");
    expect(table).toContain("  - partial：单边价格缺失（p/partial，跟随会话）");
    expect(table).toContain(
      "  - codex（外部 agent）：Codex CLI；费用与额度计在该 agent 自己的账号上。",
    );

    const tool = createTaskTool(
      launcher,
      { agents, run: async () => ({ status: "ok", modelContent: "ok" }) },
      600000,
      profiles,
      undefined,
      undefined,
      lookup,
    );
    expect(tool.description).toContain(table);
  });

  it("Runtime 会话注册 task 工具与 subagentSelectionTable 输出一致，复用用量页同源价格（含 vendor 兜底），且会话中途刷新价格不改变已创建工具的选择表", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nctrn-task-price-"));
    roots.push(root);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, "cache"), { recursive: true });
    writeFileSync(
      path.join(home, "cache", "models-dev.json"),
      JSON.stringify({
        fetchedAt: "2099-01-01T00:00:00Z",
        models: {
          "deepseek/deepseek-v4.1-flash": { reasoning: true, input: ["text"] },
        },
        providers: {
          deepseek: {
            models: {
              "deepseek-v4.1-flash": { cost: { input: 0.045, output: 0.5 } },
            },
          },
        },
      }),
    );
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        version: 1,
        subagents: {
          profiles: {
            deepseek: {
              description: "范围明确的实现与排查",
              model: "magpie/auto/deepseek-v4.1-flash",
              effort: "max",
              enabled: true,
            },
            tiered: {
              description: "分档计价模型",
              model: "magpie/gemini-4-argon",
              effort: "medium",
              enabled: true,
            },
            free: {
              description: "零价模型",
              model: "magpie/free-model",
              enabled: true,
            },
            unknown: {
              description: "无价格模型",
              model: "magpie/unpriced-model",
              enabled: true,
            },
          },
        },
      }),
    );

    const baseModel = new FakeProvider({}).models()[0];
    if (baseModel === undefined) throw new Error("missing base fake model");
    const models: ModelInfo[] = [
      {
        ...baseModel,
        ref: { provider: "magpie", model: "main-model" },
        pricing: { input: 2, output: 10 },
      },
      {
        ...baseModel,
        ref: { provider: "magpie", model: "auto/deepseek-v4.1-flash" },
        capabilities: {
          ...baseModel.capabilities,
          reasoningEffort: ["low", "medium", "high", "max"],
        },
        // 不声明 model.pricing，验证通过 config.vendorPricing("auto/deepseek-v4.1-flash") 兜底解析
      },
      {
        ...baseModel,
        ref: { provider: "magpie", model: "gemini-4-argon" },
        capabilities: {
          ...baseModel.capabilities,
          reasoningEffort: ["low", "medium", "high"],
        },
        pricing: {
          input: 1.25,
          output: 10,
          tiers: [{ aboveInputTokens: 200_000, input: 2.5, output: 15 }],
        },
      },
      {
        ...baseModel,
        ref: { provider: "magpie", model: "free-model" },
        pricing: { input: 0, output: 0 },
      },
      {
        ...baseModel,
        ref: { provider: "magpie", model: "unpriced-model" },
      },
    ];

    const requests: ModelRequest[] = [];
    const provider = new FakeProvider({
      id: "magpie",
      models,
      handler: (req) => {
        requests.push(req);
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    let refreshedPrice = 0.045;
    const config = await loadConfig(createPlatform(), {
      nocturneHome: home,
      env: () => undefined,
      modelsDevFetch: async (url) =>
        new Response(
          String(url).endsWith("/models.json")
            ? JSON.stringify({
                "deepseek/deepseek-v4.1-flash": {
                  reasoning: true,
                  modalities: { input: ["text"] },
                },
              })
            : JSON.stringify({
                deepseek: {
                  id: "deepseek",
                  models: {
                    "deepseek-v4.1-flash": {
                      id: "deepseek-v4.1-flash",
                      cost: { input: refreshedPrice, output: 9.9 },
                    },
                  },
                },
              }),
          { status: 200 },
        ),
    });

    const runtime = await createRuntime({
      config,
      providers: [provider],
      sessionsDir: path.join(root, "sessions"),
      cwd: root,
      workspaceRoot: root,
    });
    const session = await runtime.createSession({ model: "magpie/main-model" });
    await session.submit({ text: "first" });

    const firstTaskDesc = requests[0]?.tools.find((t) => t.name === "task")?.description ?? "";
    expect(firstTaskDesc).toContain("  - default：通用。（跟随当前模型，跟随会话，$2/$10）");
    expect(firstTaskDesc).toContain(
      "  - deepseek：范围明确的实现与排查（magpie/auto/deepseek-v4.1-flash，max，$0.045/$0.5）",
    );
    expect(firstTaskDesc).toContain(
      "  - tiered：分档计价模型（magpie/gemini-4-argon，medium，$1.25/$10）",
    );
    expect(firstTaskDesc).toContain("  - free：零价模型（magpie/free-model，跟随会话，$0/$0）");
    expect(firstTaskDesc).toContain("  - unknown：无价格模型（magpie/unpriced-model，跟随会话）");
    const expectedTable = subagentSelectionTable(
      [
        {
          name: "deepseek",
          description: "范围明确的实现与排查",
          model: "magpie/auto/deepseek-v4.1-flash",
          effort: "max",
          enabled: true,
          pricing: { input: 0.045, output: 0.5 },
        },
        {
          name: "tiered",
          description: "分档计价模型",
          model: "magpie/gemini-4-argon",
          effort: "medium",
          enabled: true,
          pricing: {
            input: 1.25,
            output: 10,
            tiers: [{ aboveInputTokens: 200_000, input: 2.5, output: 15 }],
          },
        },
        {
          name: "free",
          description: "零价模型",
          model: "magpie/free-model",
          enabled: true,
          pricing: { input: 0, output: 0 },
        },
        {
          name: "unknown",
          description: "无价格模型",
          model: "magpie/unpriced-model",
          enabled: true,
        },
      ],
      [],
      undefined,
      { input: 2, output: 10 },
    );
    expect(firstTaskDesc).toContain(expectedTable);

    // 会话中途刷新价格：选择表已在工具创建时定下，不应因刷新价格而变化
    refreshedPrice = 0.88;
    await config.refreshModelsDev?.();
    expect(config.vendorPricing?.("auto/deepseek-v4.1-flash")).toEqual({
      input: 0.88,
      output: 9.9,
    });
    await session.submit({ text: "second" });
    const secondTaskDesc = requests[1]?.tools.find((t) => t.name === "task")?.description ?? "";
    expect(secondTaskDesc).toBe(firstTaskDesc);
    expect(secondTaskDesc).toContain("（magpie/auto/deepseek-v4.1-flash，max，$0.045/$0.5）");

    // 切换模型：default 跟随当前模型，价格要换成新模型的
    await session.setModel("magpie/gemini-4-argon");
    await session.submit({ text: "third" });
    const thirdTaskDesc = requests[2]?.tools.find((t) => t.name === "task")?.description ?? "";
    expect(thirdTaskDesc).toContain("  - default：通用。（跟随当前模型，跟随会话，$1.25/$10）");

    await session.close();
  });
});
