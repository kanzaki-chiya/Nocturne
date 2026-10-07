import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore, createPlatform, loadConfig } from "../src/index.js";
import { mergeLayers } from "../src/config/merge.js";
import type { ExternalAgentConfig } from "../src/config/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "nct-external-agents-"));
  roots.push(home);
  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: home,
    credentials,
    env: () => undefined,
  });
  return { home, platform, config };
}
const entry = {
  command: "node",
  args: ["agent.mjs"],
  env: { OPTION: "literal", API_TOKEN: "${AGENT_TOKEN}" },
  mode: "opaque-mode",
  configOptions: { "model/id": "opaque-value", "approval/mode": "" },
  description: "离线配置夹具",
  enabled: true,
};
const agent = { name: "local-agent", ...entry };

describe("外部 agent 程序层与管理（ADR-0049 Step 2）", () => {
  it("管理原子写程序层、overview 来源与只读标记；replace、启停、删除不改手写配置", async () => {
    const { home, config } = await setup();
    const overview = await config.saveExternalAgent({
      mode: "create",
      name: agent.name,
      config: entry,
    });
    expect(overview).toEqual({
      ...agent,
      origin: "app",
      editable: true,
      path: path.join(home, "external-agents.json"),
    });
    expect(JSON.parse(await readFile(path.join(home, "external-agents.json"), "utf8"))).toEqual({
      version: 1,
      agents: [agent],
    });
    expect((await config.describeExternalAgents()).agents).toEqual([overview]);
    await config.saveExternalAgent({
      mode: "replace",
      name: agent.name,
      config: { ...entry, command: "changed", env: { API_TOKEN: "literal-token" } },
    });
    await config.setExternalAgentEnabled({ name: agent.name, enabled: false });
    expect(config.base.externalAgents[0]).toMatchObject({
      command: "changed",
      enabled: false,
      env: { API_TOKEN: "literal-token" },
      configOptions: entry.configOptions,
    });
    const reloaded = await config.reload();
    expect(reloaded.base.externalAgents).toEqual(config.base.externalAgents);
    await reloaded.deleteExternalAgent({ name: agent.name });
    expect(reloaded.base.externalAgents).toEqual([]);
    expect(JSON.parse(await readFile(path.join(home, "external-agents.json"), "utf8"))).toEqual({
      version: 1,
      agents: [],
    });
  });

  it("手写层整条覆盖 app；各来源间名称不区分大小写唯一，手写与被覆盖 app 均不能修改", async () => {
    const { home, config } = await setup();
    await config.saveExternalAgent({ mode: "create", name: agent.name, config: entry });
    const user = {
      ...agent,
      command: "handwritten",
      env: undefined,
      mode: undefined,
      configOptions: undefined,
    };
    const text = JSON.stringify({ externalAgents: [user] });
    await writeFile(path.join(home, "config.json"), text);
    const current = await config.reload();
    expect((await current.describeExternalAgents()).agents).toEqual([
      {
        name: user.name,
        command: user.command,
        args: user.args,
        description: user.description,
        enabled: true,
        origin: "user",
        editable: false,
        path: path.join(home, "config.json"),
      },
    ]);
    for (const mode of ["create", "replace"] as const)
      await expect(
        current.saveExternalAgent({ mode, name: agent.name, config: entry }),
      ).rejects.toMatchObject({ field: "name" });
    await expect(current.deleteExternalAgent({ name: agent.name })).rejects.toMatchObject({
      field: "name",
    });
    await expect(
      current.setExternalAgentEnabled({ name: agent.name, enabled: false }),
    ).rejects.toMatchObject({ field: "name" });
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(text);
    const merged = mergeLayers([
      { kind: "app", file: { externalAgents: [agent] } },
      {
        kind: "user",
        file: {
          externalAgents: [
            { ...agent, name: "LOCAL-AGENT", command: "user" },
            { ...agent, command: "duplicate" },
          ],
        },
      },
    ]).resolved;
    expect(merged.externalAgents).toEqual([
      { ...agent, name: "LOCAL-AGENT", command: "user", origin: "user", path: undefined },
    ]);
    expect(merged.warnings).toHaveLength(1);
  });

  it("损坏或版本不符忽略整个文件；无效条目与重复条目逐条警告", async () => {
    const { home, config } = await setup();
    const file = path.join(home, "external-agents.json");
    for (const raw of [
      "broken",
      JSON.stringify({ version: 2, agents: [agent] }),
      JSON.stringify({ version: 1, agents: {} }),
    ]) {
      await writeFile(file, raw);
      const current = await config.reload();
      expect(current.base.externalAgents).toEqual([]);
      expect(
        current.base.warnings.filter((warning) =>
          warning.includes("external_agent_config_invalid"),
        ),
      ).toHaveLength(1);
    }
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: [
          agent,
          { ...agent, command: "duplicate" },
          { ...agent, name: "stored", env: { TOKEN: { stored: true } } },
          { ...agent, name: "options", configOptions: { model: 123 } },
          { ...agent, name: "valid", enabled: false },
        ],
      }),
    );
    const current = await config.reload();
    expect(current.base.externalAgents.map((item) => item.name)).toEqual([agent.name, "valid"]);
    expect(
      current.base.warnings.filter((warning) => warning.includes("external_agent_config_invalid")),
    ).toHaveLength(3);
  });

  it.each([false, true])("项目 trusted=%s 的段永不生效；程序条目仍可查询", async (trusted) => {
    const { home, config } = await setup();
    await config.saveExternalAgent({ mode: "create", name: agent.name, config: entry });
    const workspace = path.join(home, "workspace");
    await mkdir(path.join(workspace, ".nocturne"), { recursive: true });
    await writeFile(
      path.join(workspace, ".nocturne", "config.json"),
      JSON.stringify({ externalAgents: "invalid" }),
    );
    if (trusted) await config.setWorkspaceTrusted(workspace, true);
    const description = await config.describeExternalAgents({ workspaceRoot: workspace });
    expect(description.agents).toEqual((await config.describeExternalAgents()).agents);
    expect(
      description.warnings.filter((warning) => warning.includes("externalAgents 配置已忽略")),
    ).toHaveLength(1);
  });

  it("字段错误不写文件，原子替换失败保持内存与磁盘，队列可继续写", async () => {
    const { home, platform, config } = await setup();
    await config.saveExternalAgent({ mode: "create", name: agent.name, config: entry });
    const filename = path.join(home, "external-agents.json");
    const previous = await readFile(filename, "utf8");
    await expect(
      config.saveExternalAgent({ mode: "create", name: "bad/name", config: entry }),
    ).rejects.toMatchObject({ field: "name" });
    await expect(
      config.saveExternalAgent({
        mode: "create",
        name: "bad-env",
        config: { ...entry, env: { TOKEN: { stored: true } } } as unknown as Omit<
          ExternalAgentConfig,
          "name"
        >,
      }),
    ).rejects.toMatchObject({ field: "env" });
    await expect(
      config.setExternalAgentEnabled({ name: agent.name, enabled: "yes" as unknown as boolean }),
    ).rejects.toMatchObject({ field: "enabled" });
    const rename = vi
      .spyOn(platform.fs, "rename")
      .mockRejectedValueOnce(new Error("offline failure"));
    await expect(
      config.saveExternalAgent({
        mode: "replace",
        name: agent.name,
        config: { ...entry, command: "failed" },
      }),
    ).rejects.toMatchObject({ field: "config" });
    expect(await readFile(filename, "utf8")).toBe(previous);
    expect(config.base.externalAgents[0]?.command).toBe(entry.command);
    rename.mockRestore();
    await config.setExternalAgentEnabled({ name: agent.name, enabled: false });
    expect(config.base.externalAgents[0]?.enabled).toBe(false);
  });

  it("并发更新不丢条目，并与 MCP 和 settings 共用写入队列", async () => {
    const { platform, config } = await setup();
    const original = platform.fs.rename.bind(platform.fs);
    let active = 0;
    let maxActive = 0;
    vi.spyOn(platform.fs, "rename").mockImplementation(async (...args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await original(...args);
      } finally {
        active--;
      }
    });
    await Promise.all([
      config.saveExternalAgent({ mode: "create", name: "one", config: entry }),
      config.saveExternalAgent({ mode: "create", name: "two", config: entry }),
      config.saveMcpServer({ mode: "create", id: "mcp", config: { command: "node" } }),
      config.setSkillEnabled("skill", false),
    ]);
    expect(maxActive).toBe(1);
    expect(config.base.externalAgents.map((item) => item.name)).toEqual(["one", "two"]);
    const duplicate = await Promise.allSettled([
      config.saveExternalAgent({ mode: "create", name: "same", config: entry }),
      config.saveExternalAgent({ mode: "create", name: "same", config: entry }),
    ]);
    expect(duplicate.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  });
});
