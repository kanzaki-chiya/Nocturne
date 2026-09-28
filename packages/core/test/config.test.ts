/**
 * config 模块测试（config.md）：分层合并、schema 校验、信任模型、Grant 持久化。
 * 全部在临时目录中运行，不写真实用户目录。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPlatform, type Platform } from "../src/platform/index.js";
import {
  loadConfig,
  loadSettingsStore,
  workspaceKey,
  type CliConfigArgs,
} from "../src/config/index.js";
import type { Grant } from "../src/protocol/index.js";

let root: string;
let home: string;
let workspace: string;
let platform: Platform;

const noEnv = (_n: string) => undefined;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-config-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  platform = createPlatform();
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function load(cliArgs?: CliConfigArgs, env: (name: string) => string | undefined = noEnv) {
  return loadConfig(platform, { cliArgs, nocturneHome: home, env });
}

async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(data)}\n`);
}

const projectConfigPath = () => path.join(workspace, ".nocturne", "config.json");

describe("用户配置", () => {
  it("不存在时得到空配置", async () => {
    const rc = await load();
    expect(rc.base.model).toBeUndefined();
    expect(rc.base.rules).toHaveLength(0);
    expect(rc.base.providers).toHaveLength(0);
    expect(rc.sessionsDir).toBe(path.join(home, "sessions"));
  });

  it("读取 model / preset / rules / turn / providers", async () => {
    await writeJson(path.join(home, "config.json"), {
      model: "openai-compatible/m1",
      permissions: {
        preset: "auto-edit",
        rules: [
          { kind: "shell", pattern: "git status*", action: "allow", label: "安全 git" },
          { kind: "edit", pattern: "docs/**", action: "deny" },
        ],
      },
      turn: { maxSteps: 50 },
      providers: [
        {
          id: "corp",
          type: "openai-compatible",
          baseURL: "https://example.test/v1",
          apiKeyEnv: "CORP_KEY",
          models: { m1: { contextWindow: 128000 } },
        },
      ],
    });
    const rc = await load();
    expect(rc.base.model).toBe("openai-compatible/m1");
    expect(rc.base.permissionPreset).toBe("auto-edit");
    expect(rc.base.rules).toHaveLength(2);
    expect(rc.base.rules[0]?.origin).toBe("user");
    expect(rc.base.rules[0]?.rule.label).toBe("安全 git");
    expect(rc.base.turn.maxSteps).toBe(50);
    expect(rc.base.providers[0]?.id).toBe("corp");
    expect(rc.base.providers[0]?.models?.m1?.contextWindow).toBe(128000);
    await fs.unlink(path.join(home, "config.json"));
  });

  it("损坏的用户配置快速失败（config_invalid）", async () => {
    await fs.writeFile(path.join(home, "config.json"), "{ not json");
    await expect(load()).rejects.toMatchObject({ code: "config_invalid" });
    await fs.unlink(path.join(home, "config.json"));
  });

  it("provider 内联凭据字段被拒绝（config_credential_rejected）", async () => {
    await writeJson(path.join(home, "config.json"), {
      providers: [{ id: "x", baseURL: "https://e.test", apiKeyEnv: "K", apiKey: "sk-secret" }],
    });
    await expect(load()).rejects.toMatchObject({ code: "config_credential_rejected" });
    await fs.unlink(path.join(home, "config.json"));
  });
});

describe("分层合并", () => {
  it("命令行 model 覆盖环境变量与用户配置；规则按层序追加", async () => {
    await writeJson(path.join(home, "config.json"), {
      model: "a/user-model",
      permissions: { rules: [{ pattern: "u/**", action: "deny" }] },
    });
    const env = (n: string) => (n === "NOCTURNE_MODEL" ? "b/env-model" : undefined);
    const rc = await load({ model: "c/cli-model" }, env);
    expect(rc.base.model).toBe("c/cli-model");
    expect(rc.base.rules.map((r) => r.origin)).toEqual(["user"]);
    await fs.unlink(path.join(home, "config.json"));
  });

  it("providers 按 id 合并：高层字段覆盖、models 逐条合并", async () => {
    await writeJson(path.join(home, "config.json"), {
      providers: [
        {
          id: "openai-compatible",
          type: "openai-compatible",
          baseURL: "https://user.test",
          apiKeyEnv: "USER_KEY",
          models: { a: { contextWindow: 1000 }, b: { contextWindow: 2000 } },
        },
      ],
    });
    const env = (n: string) =>
      n === "NOCTURNE_BASE_URL" ? "https://env.test" : n === "NOCTURNE_MODEL" ? "c" : undefined;
    const rc = await load(undefined, env);
    const p = rc.base.providers.find((x) => x.id === "openai-compatible");
    expect(p?.baseURL).toBe("https://env.test");
    // 同 id 浅合并：env 合成条目携带的 apiKeyEnv 覆盖用户层（config.md 第 2 节）
    expect(p?.apiKeyEnv).toBe("NOCTURNE_API_KEY");
    expect(p?.models?.a?.contextWindow).toBe(1000);
    expect(p?.models?.b?.contextWindow).toBe(2000);
    expect(p?.models?.c).toBeDefined(); // env 层追加的当前模型条目
    await fs.unlink(path.join(home, "config.json"));
  });
});

describe("项目配置信任", () => {
  it("未信任：其余字段忽略，allow 规则丢弃，ask/deny 进入 untrustedRules", async () => {
    await writeJson(projectConfigPath(), {
      model: "evil/redirect",
      permissions: {
        preset: "full-access",
        rules: [
          { kind: "shell", pattern: "*", action: "allow" },
          { kind: "edit", pattern: "secrets/**", action: "deny" },
          { kind: "read", pattern: "/etc/**", action: "ask" },
        ],
      },
    });
    const rc = await load();
    const ws = await rc.forWorkspace(workspace);
    expect(ws.projectConfig.present).toBe(true);
    expect(ws.projectConfig.trusted).toBe(false);
    expect(ws.resolved.model).toBeUndefined();
    expect(ws.resolved.permissionPreset).toBeUndefined();
    expect(ws.resolved.rules).toHaveLength(0);
    expect(ws.resolved.untrustedRules.map((r) => r.rule.action)).toEqual(["deny", "ask"]);
    expect(ws.resolved.untrustedRules[0]?.origin).toBe("project-untrusted");
    await fs.rm(path.join(workspace, ".nocturne"), { recursive: true, force: true });
  });

  it("trust 后项目配置整体进入分层（规则位于用户配置之后）", async () => {
    await writeJson(path.join(home, "config.json"), {
      permissions: { rules: [{ pattern: "u/**", action: "deny" }] },
    });
    await writeJson(projectConfigPath(), {
      model: "p/model",
      permissions: { rules: [{ pattern: "p/**", action: "allow" }] },
    });
    const rc = await load();
    await rc.setWorkspaceTrusted(workspace, true);
    const ws = await rc.forWorkspace(workspace);
    expect(ws.projectConfig.trusted).toBe(true);
    expect(ws.resolved.model).toBe("p/model");
    expect(ws.resolved.rules.map((r) => r.origin)).toEqual(["user", "project"]);
    expect(ws.resolved.untrustedRules).toHaveLength(0);
    // trust.json 已持久化
    const trustRaw = JSON.parse(await fs.readFile(path.join(home, "trust.json"), "utf8")) as {
      workspaces: string[];
    };
    expect(trustRaw.workspaces).toHaveLength(1);
    // untrust 恢复
    await rc.setWorkspaceTrusted(workspace, false);
    const ws2 = await rc.forWorkspace(workspace);
    expect(ws2.projectConfig.trusted).toBe(false);
    await fs.rm(path.join(workspace, ".nocturne"), { recursive: true, force: true });
    await fs.unlink(path.join(home, "config.json"));
    await fs.unlink(path.join(home, "trust.json"));
  });

  it("未信任：项目级 mcp 与 hooks 段整段忽略并警告（ADR-0012）", async () => {
    await writeJson(projectConfigPath(), {
      mcp: { servers: { evil: { command: "node", args: ["-e", ""] } } },
      hooks: { PreToolUse: [{ command: "node", args: ["-e", "process.exit(0)"] }] },
    });
    const rc = await load();
    const ws = await rc.forWorkspace(workspace);
    expect(ws.projectConfig.trusted).toBe(false);
    expect(ws.resolved.mcpServers).toHaveLength(0);
    expect(Object.keys(ws.resolved.hooks)).toHaveLength(0);
    expect(
      ws.resolved.warnings.some(
        (w) => w.includes("未信任") && w.includes("mcp") && w.includes("hooks"),
      ),
    ).toBe(true);
    await fs.rm(path.join(workspace, ".nocturne"), { recursive: true, force: true });
  });

  it("trust 后项目级 mcp 与 hooks 进入分层", async () => {
    await writeJson(projectConfigPath(), {
      mcp: { servers: { srv: { command: "node", args: ["server.js"] } } },
      hooks: { PostToolUse: [{ command: "node", args: ["hook.js"] }] },
    });
    const rc = await load();
    await rc.setWorkspaceTrusted(workspace, true);
    const ws = await rc.forWorkspace(workspace);
    expect(ws.resolved.mcpServers.map((s) => s.name)).toEqual(["srv"]);
    expect(ws.resolved.mcpServers[0]?.entry.command).toBe("node");
    expect(ws.resolved.mcpServers[0]?.origin).toBe("project");
    expect(ws.resolved.hooks.PostToolUse).toHaveLength(1);
    await rc.setWorkspaceTrusted(workspace, false);
    await fs.rm(path.join(workspace, ".nocturne"), { recursive: true, force: true });
    await fs.unlink(path.join(home, "trust.json"));
  });

  it("损坏的项目配置整份忽略并警告", async () => {
    await writeJson(projectConfigPath(), { permissions: { rules: [{ pattern: "" }] } });
    const rc = await load();
    const ws = await rc.forWorkspace(workspace);
    expect(ws.projectConfig.present).toBe(true);
    expect(ws.resolved.rules).toHaveLength(0);
    expect(ws.resolved.untrustedRules).toHaveLength(0);
    expect(ws.resolved.warnings.some((w) => w.includes("项目配置"))).toBe(true);
    await fs.rm(path.join(workspace, ".nocturne"), { recursive: true, force: true });
  });
});

describe("Grant 持久化", () => {
  it("add 原子写文件，重新加载后可读", async () => {
    const rc = await load();
    const ws = await rc.forWorkspace(workspace);
    const grant: Grant = { kind: "edit", target: "Z:/ws/a.txt", createdAt: "2026-01-01T00:00:00Z" };
    await ws.grants.add(grant);
    expect(ws.grants.list()).toEqual([grant]);

    const rc2 = await load();
    const ws2 = await rc2.forWorkspace(workspace);
    expect(ws2.grants.list()).toEqual([grant]);
    await fs.rm(rc.grantsDir, { recursive: true, force: true });
  });

  it("损坏的 Grant 文件忽略并警告", async () => {
    const rc = await load();
    const canonical = platform.paths.canonicalize(await platform.resolveReal(workspace));
    const p = path.join(rc.grantsDir, `${workspaceKey(canonical)}.json`);
    await fs.mkdir(rc.grantsDir, { recursive: true });
    await fs.writeFile(p, "broken");
    const ws = await rc.forWorkspace(workspace);
    expect(ws.grants.list()).toEqual([]);
    expect(ws.resolved.warnings.some((w) => w.includes("授权文件"))).toBe(true);
    await fs.rm(rc.grantsDir, { recursive: true, force: true });
  });
});

describe("环境变量层", () => {
  it("NOCTURNE_API_TYPE+BASE_URL 合成 Provider；缺凭据给警告", async () => {
    const env = (n: string) =>
      n === "NOCTURNE_BASE_URL" ? "https://api.test" : n === "NOCTURNE_MODEL" ? "m1" : undefined;
    const rc = await load(undefined, env);
    expect(rc.base.model).toBe("m1");
    const p = rc.base.providers[0];
    expect(p?.id).toBe("openai-compatible");
    expect(p?.baseURL).toBe("https://api.test");
    expect(p?.apiKeyEnv).toBe("NOCTURNE_API_KEY");
    expect(p?.models?.m1).toBeDefined();
    expect(rc.base.warnings.some((w) => w.includes("NOCTURNE_API_KEY"))).toBe(true);
  });

  it("无任何相关变量时不合成 Provider", async () => {
    const rc = await load();
    expect(rc.base.providers).toHaveLength(0);
  });
});

describe("settings.json 与 shell 配置（ADR-0022 第 2、3 节）", () => {
  const settingsPath = () => path.join(home, "settings.json");

  it("config.json 的 shell/shellPath 进入合并结果；非法 shell 值报 config_invalid", async () => {
    await writeJson(path.join(home, "config.json"), {
      shell: "bash",
      shellPath: "D:\\tools\\bash.exe",
    });
    const rc = await load();
    expect(rc.base.shell).toBe("bash");
    expect(rc.base.shellPath).toBe("D:\\tools\\bash.exe");
    // 手写 config.json 未被改写
    const raw = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")) as {
      shell: string;
      shellPath: string;
    };
    expect(raw.shell).toBe("bash");
    await fs.unlink(path.join(home, "config.json"));

    await writeJson(path.join(home, "config.json"), { shell: "fish" });
    await expect(load()).rejects.toMatchObject({ code: "config_invalid" });
    await fs.unlink(path.join(home, "config.json"));
  });

  it("setShellSetting 原子写 settings.json；shellSetting live 可见；auto 清除且保留未知字段", async () => {
    const rc = await load();
    expect(rc.shellSetting()).toBeUndefined();
    await rc.setShellSetting("pwsh");
    expect(rc.shellSetting()).toEqual({ shell: "pwsh" });
    const written = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as {
      shell: string;
      theme?: string;
    };
    expect(written.shell).toBe("pwsh");
    // 再次加载可读回；不写临时文件残留
    const rc2 = await load();
    expect(rc2.shellSetting()).toEqual({ shell: "pwsh" });
    const dirEntries = await fs.readdir(home);
    expect(dirEntries.filter((n) => n.startsWith("settings.json"))).toEqual(["settings.json"]);

    // 未知字段保留；auto 清除 shell/shellPath
    await writeJson(settingsPath(), { shell: "cmd", theme: "dark" });
    const rc3 = await load();
    expect(rc3.shellSetting()).toEqual({ shell: "cmd" });
    await rc3.setShellSetting("auto");
    expect(rc3.shellSetting()).toBeUndefined();
    const after = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Record<string, unknown>;
    expect(after["shell"]).toBeUndefined();
    expect(after["theme"]).toBe("dark");
    await fs.unlink(settingsPath());
  });

  it("损坏或非法的 settings.json 降级为忽略 + 警告（不阻塞启动）", async () => {
    await fs.writeFile(settingsPath(), "{ not json");
    const rc = await load();
    expect(rc.shellSetting()).toBeUndefined();
    expect(rc.base.warnings.some((w) => w.includes("settings.json"))).toBe(true);

    await writeJson(settingsPath(), { shell: "fish" });
    const rc2 = await load();
    expect(rc2.shellSetting()?.shell).toBe("fish"); // 原文可见
    expect(rc2.base.warnings.some((w) => w.includes("无法识别"))).toBe(true);
    await fs.unlink(settingsPath());
  });

  it("shellPath 单独出现：文件名可识别则推断种类；不可识别则警告并忽略", async () => {
    // 可识别的文件名 → 有效声明（shell 推断为 bash）
    await writeJson(path.join(home, "config.json"), {
      shellPath: "D:\\portable\\bash.exe",
    });
    const rc = await load();
    expect(rc.base.shellPath).toBe("D:\\portable\\bash.exe");
    expect(rc.base.warnings.some((w) => w.includes("shellPath"))).toBe(false);
    await fs.unlink(path.join(home, "config.json"));

    // 识别不了文件名 → 警告，resolver 侧视为无声明（specFromConfigFields → undefined）
    await writeJson(path.join(home, "config.json"), {
      shellPath: "D:\\x\\weird.exe",
    });
    const rc2 = await load();
    expect(rc2.base.warnings.some((w) => w.includes("weird.exe") && w.includes("无法识别"))).toBe(
      true,
    );
    await fs.unlink(path.join(home, "config.json"));

    // settings.json 同一规则
    await writeJson(settingsPath(), { shellPath: "D:\\x\\weird.exe" });
    const rc3 = await load();
    expect(rc3.base.warnings.some((w) => w.includes("weird.exe") && w.includes("无法识别"))).toBe(
      true,
    );
    await fs.unlink(settingsPath());
  });

  it("setShellSetting 原子写失败时内存态不漂移（先写盘后提交）", async () => {
    await writeJson(settingsPath(), { shell: "cmd" });
    const failingPlatform: Platform = {
      ...platform,
      fs: {
        ...platform.fs,
        writeFile: () => Promise.reject(new Error("disk full")),
      },
    };
    const { store } = await loadSettingsStore(failingPlatform, settingsPath());
    expect(store.shellSpec()).toEqual({ kind: "cmd" });
    await expect(store.setShell("pwsh")).rejects.toThrow();
    // 写失败 → live getter 仍返回旧值
    expect(store.shellSpec()).toEqual({ kind: "cmd" });
    await fs.unlink(settingsPath());
  });
});

describe("思考档位 schema（ADR-0018）", () => {
  it("顶层 reasoningEffort 合法档位进入合并结果", async () => {
    await writeJson(path.join(home, "config.json"), { reasoningEffort: "high" });
    const rc = await load();
    expect(rc.base.reasoningEffort).toBe("high");
    await fs.unlink(path.join(home, "config.json"));
  });

  it("顶层 reasoningEffort 非法值（含 auto）报 config_invalid", async () => {
    for (const bad of ["auto", "bogus", "MAX"]) {
      await writeJson(path.join(home, "config.json"), { reasoningEffort: bad });
      await expect(load()).rejects.toMatchObject({ code: "config_invalid" });
    }
    await fs.unlink(path.join(home, "config.json"));
  });

  it("provider.thinking 接受 levels/format/budgets，非法值被拒", async () => {
    const entry = {
      id: "p1",
      baseURL: "https://e.test",
      apiKeyEnv: "K",
      thinking: {
        format: "openrouter",
        levels: ["low", "high"],
        budgets: { low: 2048, max: 40000 },
      },
    };
    await writeJson(path.join(home, "config.json"), { providers: [entry] });
    const rc = await load();
    const p = rc.base.providers[0];
    expect(p?.thinking?.levels).toBeUndefined();
    expect(p?.thinking?.format).toBe("openrouter");
    expect(p?.thinking?.budgets?.max).toBe(40000);
    await fs.unlink(path.join(home, "config.json"));

    for (const thinking of [
      { format: "anthropic" },
      { levels: ["auto"] },
      { levels: ["MAX"] },
      { budgets: { low: 0 } },
      { budgets: { low: 1.5 } },
    ]) {
      await writeJson(path.join(home, "config.json"), {
        providers: [{ ...entry, thinking }],
      });
      await expect(load()).rejects.toMatchObject({ code: "config_invalid" });
    }
    await fs.unlink(path.join(home, "config.json"));
  });
});
