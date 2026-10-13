import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, createPlatform } from "../src/index.js";
import { parseConfigFile } from "../src/config/schema.js";
import { mergeLayers } from "../src/config/merge.js";
import { resolveSubagentProfile } from "../src/config/subagent-profiles.js";
import { createTaskTool } from "../src/tools/index.js";
import { subagentSelectionTable, isValidSubagentProfileName } from "../src/protocol/index.js";

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
    expect(tool.description).not.toContain("档位");
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
});
