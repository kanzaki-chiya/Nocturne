import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPlatform,
  createRuntime,
  loadConfig,
  type McpConnector,
  type ModelInfo,
  type ModelPricing,
  type ToolDefinition,
} from "../src/index.js";
import {
  checkLocalPluginDirectory,
  discoverInstalledPlugins,
  installLocalPlugin,
  parsePluginSubagentMarkdown,
  resolvePlugins,
  setPluginEnabled,
} from "../src/plugins/index.js";
import { resolveSubagentProfile } from "../src/config/subagent-profiles.js";
import { parseConfigFile } from "../src/config/schema.js";
import { mergeLayers } from "../src/config/merge.js";
import { FakeProvider } from "../src/provider/index.js";
import { isValidPluginSubagentId } from "../src/protocol/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const builtPluginsDir = path.join(repoRoot, "plugins");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix = "plugin-subagents-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeNativePlugin(
  parentDir: string,
  opts: {
    dirName: string;
    manifest: Record<string, unknown>;
    files?: Record<string, string>;
  },
): string {
  const dir = path.join(parentDir, opts.dirName);
  mkdirSync(path.join(dir, ".nocturne-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".nocturne-plugin", "plugin.json"),
    JSON.stringify(opts.manifest, null, 2),
  );
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function makeModelInfo(
  provider: string,
  model: string,
  opts?: { pricing?: ModelPricing; reasoningEffort?: ("low" | "medium" | "high" | "max")[] },
): ModelInfo {
  return {
    ref: { provider, model },
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    ...(opts?.pricing !== undefined ? { pricing: opts.pricing } : {}),
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: opts?.reasoningEffort ? "hidden" : "none",
      ...(opts?.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      imageInput: true,
      promptCache: false,
      editTool: "edit",
    },
  };
}

function fakeMcpConnectorWithTools(tools: ToolDefinition[]): McpConnector {
  return {
    open() {
      return Promise.resolve({
        startup: () => Promise.resolve(),
        tools: () => tools,
        status: () => [{ name: "slides", state: "ready", toolCount: tools.length, restarts: 0 }],
        applyPendingTools: () => ({ add: [], remove: [] }),
        prepareTurn: () => Promise.resolve(),
        reconcile: () => Promise.resolve(),
        close: () => Promise.resolve(),
      });
    },
    probe() {
      return Promise.resolve({ ok: true, tools: [], durationMs: 1 });
    },
  };
}

describe("插件子代理 frontmatter 解析", () => {
  it("解析合法 frontmatter（name/description/tools/effort）与正文", () => {
    const res = parsePluginSubagentMarkdown(
      `---
name: visual-judge
description: 检查演示文稿视觉效果
tools:
  - read
  - mcp__slides__render
effort: high
---
你是视觉验收审查员。
`,
      "visual-judge.md",
      "pptx@builtin",
    );
    expect(res.warnings).toEqual([]);
    expect(res.agent).toEqual({
      name: "visual-judge",
      description: "检查演示文稿视觉效果",
      tools: ["read", "mcp__slides__render"],
      effort: "high",
      prompt: "你是视觉验收审查员。",
    });
  });

  it("缺字段、不合法 name、description 超长、正文为空或超长时整条跳过并告警", () => {
    // 缺 frontmatter
    const noFm = parsePluginSubagentMarkdown("只有正文", "a.md", "p@local");
    expect(noFm.agent).toBeUndefined();
    expect(noFm.warnings[0]).toContain("缺少 YAML frontmatter");

    // 缺 description
    const missingDesc = parsePluginSubagentMarkdown(
      "---\nname: judge\n---\n正文",
      "b.md",
      "p@local",
    );
    expect(missingDesc.agent).toBeUndefined();
    expect(missingDesc.warnings[0]).toContain("description");

    // 不合法 name（大写 / default / 含冒号 / 超 32 字符）
    for (const badName of ["Judge", "default", "a:b", "a".repeat(33)]) {
      const bad = parsePluginSubagentMarkdown(
        `---\nname: ${badName}\ndescription: ok\n---\n正文`,
        "c.md",
        "p@local",
      );
      expect(bad.agent, badName).toBeUndefined();
      expect(bad.warnings[0]).toContain("name");
    }

    // description 超 300 字（不截断，整条跳过）
    const longDesc = parsePluginSubagentMarkdown(
      `---\nname: judge\ndescription: ${"字".repeat(301)}\n---\n正文`,
      "d.md",
      "p@local",
    );
    expect(longDesc.agent).toBeUndefined();
    expect(longDesc.warnings[0]).toContain("300");

    // 正文为空
    const emptyBody = parsePluginSubagentMarkdown(
      "---\nname: judge\ndescription: ok\n---\n   \n",
      "e.md",
      "p@local",
    );
    expect(emptyBody.agent).toBeUndefined();
    expect(emptyBody.warnings[0]).toContain("不能为空");

    // 正文超 10,000 字
    const longBody = parsePluginSubagentMarkdown(
      `---\nname: judge\ndescription: ok\n---\n${"文".repeat(10_001)}`,
      "f.md",
      "p@local",
    );
    expect(longBody.agent).toBeUndefined();
    expect(longBody.warnings[0]).toContain("10000");
  });

  it("带 model 字段和未知字段时忽略并各记一条警告，不跳过该子代理", () => {
    const res = parsePluginSubagentMarkdown(
      `---
name: judge
description: 审查员
model: openai/gpt-5
color: red
thoughtLevel: max
---
只读审查。
`,
      "judge.md",
      "demo@local",
    );
    expect(res.agent).toEqual({
      name: "judge",
      description: "审查员",
      prompt: "只读审查。",
    });
    expect(res.warnings).toHaveLength(3);
    expect(res.warnings.some((w) => w.includes("model") && w.includes("不能替用户指定模型"))).toBe(
      true,
    );
    expect(res.warnings.some((w) => w.includes("color"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("thoughtLevel"))).toBe(true);
  });

  it("单文件解析出错只跳过该文件，不影响同插件的技能与有效子代理", async () => {
    const root = makeTempRoot();
    const builtinDir = path.join(root, "builtin");
    writeNativePlugin(builtinDir, {
      dirName: "mix",
      manifest: { name: "mix", version: "1.0.0", skills: "./skills", agents: "./agents" },
      files: {
        "skills/hello/SKILL.md": "---\nname: hello\ndescription: hi\n---\nbody",
        "agents/a-broken.md": "---\nname: BAD\ndescription: bad\n---\nbody",
        "agents/b-good.md": "---\nname: checker\ndescription: 好用\n---\n你是检查员。",
      },
    });
    const plat = createPlatform();
    const discovered = await discoverInstalledPlugins(plat, {
      nocturneHome: path.join(root, "home"),
      builtinPluginsDir: builtinDir,
      codexHome: path.join(root, "codex"),
      claudeHome: path.join(root, "claude"),
    });
    expect(discovered.plugins).toHaveLength(1);
    expect(discovered.plugins[0]?.overview.skills).toEqual(["hello"]);
    expect(discovered.plugins[0]?.agents.map((a) => a.id)).toEqual(["mix:checker"]);
    expect(discovered.plugins[0]?.overview.warnings.some((w) => w.includes("a-broken.md"))).toBe(
      true,
    );
  });
});

describe("名称生成、重名去重与本地安装校验", () => {
  it("生成 <插件>:<名称>，两个已启用同名插件按发现顺序只保留第一个并告警", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const builtinDir = path.join(root, "builtin");
    const localSrc = path.join(root, "local-src");
    mkdirSync(home, { recursive: true });

    writeNativePlugin(builtinDir, {
      dirName: "demo",
      manifest: {
        name: "demo",
        version: "1.0.0",
        agents: "./agents",
        interface: { displayName: "内置演示" },
      },
      files: {
        "agents/judge.md": "---\nname: judge\ndescription: 内置版本\n---\n内置正文",
      },
    });
    const localPluginDir = writeNativePlugin(localSrc, {
      dirName: "demo",
      manifest: {
        name: "demo",
        version: "2.0.0",
        agents: "./agents",
        interface: { displayName: "本地演示" },
      },
      files: {
        "agents/judge.md": "---\nname: judge\ndescription: 本地版本\n---\n本地正文",
      },
    });

    const plat = createPlatform();
    const discOpts = {
      nocturneHome: home,
      builtinPluginsDir: builtinDir,
      codexHome: path.join(root, "codex"),
      claudeHome: path.join(root, "claude"),
    };
    await installLocalPlugin(plat, { ...discOpts, path: localPluginDir });
    await setPluginEnabled(plat, { ...discOpts, id: "nocturne:demo@local", enabled: true });

    const resolved = await resolvePlugins(plat, discOpts);
    expect(resolved.agents).toHaveLength(1);
    expect(resolved.agents[0]?.id).toBe("demo:judge");
    expect(resolved.agents[0]?.pluginId).toBe("nocturne:demo@builtin");
    expect(resolved.agents[0]?.description).toBe("内置版本");
    expect(resolved.warnings.some((w) => w.includes("同名已启用插件") && w.includes("demo"))).toBe(
      true,
    );
  });

  it("仅带子代理的自有插件满足可用能力门槛且可通过本地检查与安装；agents 路径越界被拒", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const srcRoot = path.join(root, "src");
    mkdirSync(home, { recursive: true });

    const onlyAgents = writeNativePlugin(srcRoot, {
      dirName: "agents-only",
      manifest: { name: "agents-only", version: "1.0.0", agents: "./agents" },
      files: {
        "agents/reviewer.md": "---\nname: reviewer\ndescription: 只读审查\n---\n审查正文",
      },
    });
    const badPath = writeNativePlugin(srcRoot, {
      dirName: "bad-agents-path",
      manifest: { name: "bad-agents-path", version: "1.0.0", agents: "../escape" },
    });

    const plat = createPlatform();
    const okCheck = await checkLocalPluginDirectory(plat, { path: onlyAgents, nocturneHome: home });
    expect(okCheck.installable).toBe(true);
    expect(okCheck.agents).toEqual([
      { id: "agents-only:reviewer", name: "reviewer", description: "只读审查" },
    ]);

    const installed = await installLocalPlugin(plat, {
      nocturneHome: home,
      codexHome: path.join(root, "codex"),
      claudeHome: path.join(root, "claude"),
      path: onlyAgents,
    });
    expect(installed.agents).toEqual([
      { id: "agents-only:reviewer", name: "reviewer", description: "只读审查" },
    ]);

    const badCheck = await checkLocalPluginDirectory(plat, { path: badPath, nocturneHome: home });
    expect(badCheck.installable).toBe(false);
    expect(badCheck.errors.some((e) => e.includes('必须以 "./" 开头'))).toBe(true);
  });
});

describe("插件子代理模型设置与分层覆盖", () => {
  it("合法 id 校验、读写设置、分层覆盖以及不可信项目层被忽略", async () => {
    expect(isValidPluginSubagentId("pptx:visual-judge")).toBe(true);
    expect(isValidPluginSubagentId("pptx:default")).toBe(false);
    expect(isValidPluginSubagentId("bad")).toBe(false);
    expect(isValidPluginSubagentId("a:b:c")).toBe(false);

    const parsed = parseConfigFile(
      {
        subagents: {
          pluginModels: {
            "pptx:visual-judge": "p/vision",
            "bad-id": "p/vision",
            "docx:visual-judge": "invalid-ref",
          },
        },
      },
      "test.json",
    );
    expect(parsed.subagents?.pluginModels).toEqual({ "pptx:visual-judge": "p/vision" });
    expect(parsed.subagentProfileWarnings).toHaveLength(2);

    const merged = mergeLayers([
      {
        kind: "settings",
        file: {
          subagents: { pluginModels: { "pptx:visual-judge": "p/a", "pdf:visual-judge": "p/b" } },
        },
      },
      {
        kind: "user",
        file: { subagents: { pluginModels: { "pptx:visual-judge": "p/c" } } },
      },
    ]);
    expect(merged.resolved.pluginSubagentModels).toEqual({
      "pptx:visual-judge": "p/c",
      "pdf:visual-judge": "p/b",
    });

    const root = makeTempRoot();
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(ws, ".nocturne"), { recursive: true });
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ modelsDev: false }));
    writeFileSync(
      path.join(ws, ".nocturne", "config.json"),
      JSON.stringify({ subagents: { pluginModels: { "pptx:visual-judge": "p/project" } } }),
    );

    const plat = { ...createPlatform(), env: () => undefined, homeDir: () => home };
    const config = await loadConfig(plat, { nocturneHome: home, env: () => undefined });
    await config.updateSettings({ "subagents.pluginModels.pptx:visual-judge": "p/user" });
    expect(
      config.describeSettings().find((i) => i.key === "subagents.pluginModels.pptx:visual-judge")
        ?.effective,
    ).toBe("p/user");

    // 不可信项目层被忽略
    expect((await config.forWorkspace(ws)).resolved.pluginSubagentModels).toEqual({
      "pptx:visual-judge": "p/user",
    });

    // 信任项目后覆盖生效
    await config.setWorkspaceTrusted(ws, true);
    expect((await config.forWorkspace(ws)).resolved.pluginSubagentModels).toEqual({
      "pptx:visual-judge": "p/project",
    });

    // null 清除用户设置层
    await config.updateSettings({ "subagents.pluginModels.pptx:visual-judge": null });
    expect(config.resolvedSettings(home).pluginSubagentModels).toBeUndefined();
  });

  it("resolveSubagentProfile 未选模型跟随 default，所选模型不可用不回退", () => {
    const pluginDef = {
      "pptx:visual-judge": {
        id: "pptx:visual-judge",
        pluginId: "nocturne:pptx@builtin",
        pluginName: "pptx",
        pluginDisplayName: "演示文档",
        description: "视觉验收",
        prompt: "角色说明正文",
        effort: "high" as const,
        tools: ["read", "mcp__slides__render"],
      },
    };
    const models: Record<string, string> = { "p/custom": "CUSTOM" };
    const resolveModel = (ref: string) => models[ref];

    const followDefault = resolveSubagentProfile(
      "pptx:visual-judge",
      {},
      resolveModel,
      "CURRENT",
      "DEFAULT_TASK",
      pluginDef,
      {},
    );
    expect(followDefault).toEqual({
      model: "DEFAULT_TASK",
      profile: { description: "视觉验收", effort: "high", enabled: true },
      rolePrompt: "角色说明正文",
      sourcePlugin: { id: "nocturne:pptx@builtin", name: "pptx", displayName: "演示文档" },
      allowedTools: ["read", "mcp__slides__render"],
    });

    const chosen = resolveSubagentProfile(
      "pptx:visual-judge",
      {},
      resolveModel,
      "CURRENT",
      "DEFAULT_TASK",
      pluginDef,
      { "pptx:visual-judge": "p/custom" },
    );
    expect(chosen?.model).toBe("CUSTOM");

    const unavailable = resolveSubagentProfile(
      "pptx:visual-judge",
      {},
      resolveModel,
      "CURRENT",
      "DEFAULT_TASK",
      pluginDef,
      { "pptx:visual-judge": "p/missing" },
    );
    expect(unavailable).toBeUndefined();
  });
});

describe("选择表、动态重建与 launcher 行为", () => {
  it("选择表排序、价格跟随 default/自选模型、模型不可用排除告警、插件停用后空闲边界移除", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeNativePlugin(builtinDir, {
      dirName: "pptx",
      manifest: {
        name: "pptx",
        version: "1.0.0",
        agents: "./agents",
        interface: { displayName: "演示文档" },
      },
      files: {
        "agents/visual-judge.md": `---
name: visual-judge
description: 检查幻灯片排版
tools:
  - read
---
逐页检查。
`,
      },
    });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        modelsDev: false,
        modelRoles: { task: "p/task-default" },
        subagents: {
          profiles: {
            quick: { description: "快速检索", tools: "explore", enabled: true },
          },
        },
        externalAgents: [
          { name: "ext-agent", command: "node", args: [], description: "外部", enabled: true },
        ],
      }),
    );

    const provider = new FakeProvider({
      id: "p",
      models: [
        makeModelInfo("p", "main", { pricing: { input: 3, output: 15 } }),
        makeModelInfo("p", "task-default", { pricing: { input: 1, output: 5 } }),
        makeModelInfo("p", "vision", { pricing: { input: 2, output: 8 } }),
      ],
      scripts: [
        [
          { type: "text_delta", text: "turn1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "turn2" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "turn3" },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "disabled-call",
            name: "task",
            input: { profile: "pptx:visual-judge", task: "检查" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "turn4-done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const plat = { ...createPlatform(), env: () => undefined, homeDir: () => home };
    const config = await loadConfig(plat, { nocturneHome: home, env: () => undefined });
    const rt = await createRuntime({
      config,
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(home, "sessions"),
      builtinPluginsDir: builtinDir,
      providers: [provider],
      permissions: { autoApproveAsk: true },
      externalAgents: {
        run: () => Promise.resolve({ status: "ok", modelContent: "ext" }),
        probe: () => Promise.resolve({ ok: true, configOptions: [], durationMs: 1 }),
      },
    });

    const warnings: { code: string; message: string }[] = [];
    const taskErrors: { code?: string; modelContent: string }[] = [];
    const session = await rt.createSession({
      cwd: ws,
      workspaceRoot: ws,
      model: { provider: "p", model: "main" },
    });
    session.subscribe((e) => {
      if (e.type === "runtime.warning") warnings.push(e.payload);
      if (e.type === "tool.completed" && e.payload.name === "task") {
        taskErrors.push({
          ...(e.payload.error?.code !== undefined ? { code: e.payload.error.code } : {}),
          modelContent: e.payload.modelContent,
        });
      }
    });

    // Turn 1：未选模型 → 排在 quick 后、ext-agent 前，模型和价格同 default (p/task-default, $1/$5)
    await session.submit({ text: "t1" });
    const task1 = provider.requests[0]?.tools.find((t) => t.name === "task");
    const desc1 = task1?.description ?? "";
    expect(desc1).toContain("pptx:visual-judge：检查幻灯片排版（p/task-default，跟随会话，$1/$5）");
    expect(desc1.indexOf("  - quick：")).toBeLessThan(desc1.indexOf("  - pptx:visual-judge："));
    expect(desc1.indexOf("  - pptx:visual-judge：")).toBeLessThan(
      desc1.indexOf("  - ext-agent（外部 agent）："),
    );

    // Turn 2：选定 p/vision → 显示 p/vision 和 $2/$8
    await rt.updateSettings({ "subagents.pluginModels.pptx:visual-judge": "p/vision" });
    await session.submit({ text: "t2" });
    const desc2 = provider.requests[1]?.tools.find((t) => t.name === "task")?.description ?? "";
    expect(desc2).toContain("pptx:visual-judge：检查幻灯片排版（p/vision，跟随会话，$2/$8）");

    // Turn 3：选定不可用模型 → 排除出选择表并发 subagent_profile_unavailable 告警，不回退
    await rt.updateSettings({ "subagents.pluginModels.pptx:visual-judge": "p/nonexistent" });
    await session.submit({ text: "t3" });
    const desc3 = provider.requests[2]?.tools.find((t) => t.name === "task")?.description ?? "";
    expect(desc3).not.toContain("pptx:visual-judge");
    expect(
      warnings.some(
        (w) =>
          w.code === "subagent_profile_unavailable" &&
          w.message.includes("pptx:visual-judge") &&
          w.message.includes("p/nonexistent"),
      ),
    ).toBe(true);

    // Turn 4：恢复默认模型，停用插件 → 下一个空闲边界从选择表消失，且直接调用报 invalid_input 并列出可选值
    await rt.updateSettings({ "subagents.pluginModels.pptx:visual-judge": null });
    await rt.setPluginEnabled({ id: "nocturne:pptx@builtin", enabled: false });
    await session.submit({ text: "t4" });
    const task4 = provider.requests[3]?.tools.find((t) => t.name === "task");
    expect(task4?.description ?? "").not.toContain("pptx:visual-judge");
    const profileProp = (task4?.inputSchema.properties as Record<string, { enum?: string[] }>)
      ?.profile;
    expect(profileProp?.enum ?? []).not.toContain("pptx:visual-judge");
    expect(taskErrors[0]?.code).toBe("invalid_input");
    expect(taskErrors[0]?.modelContent).toContain("quick");

    await session.close();
    await rt.close();
  });

  it("launcher 交集为空时报 invalid_input，effort 按子模型可用档位就近降档", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeNativePlugin(builtinDir, {
      dirName: "check",
      manifest: {
        name: "check",
        version: "1.0.0",
        agents: "./agents",
        interface: { displayName: "检查器" },
      },
      files: {
        "agents/empty-tools.md": `---
name: empty-tools
description: 工具池交集为空
tools:
  - mcp__missing__tool
---
正文。
`,
        "agents/clamped.md": `---
name: clamped
description: 降档测试
effort: max
tools:
  - read
  - mcp__missing__ignored
---
只用 read 检查。
`,
      },
    });

    const provider = new FakeProvider({
      id: "p",
      models: [makeModelInfo("p", "limited", { reasoningEffort: ["low", "medium"] })],
      scripts: [
        // 1. 父会话调 empty-tools（工具交集为空 → invalid_input）
        [
          {
            type: "tool_call",
            toolCallId: "c1",
            name: "task",
            input: { profile: "check:empty-tools", task: "检查" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 2. 父会话收到错误后再调 clamped（effort: max → 降档到 medium；只剩 read + finish）
        [
          {
            type: "tool_call",
            toolCallId: "c2",
            name: "task",
            input: { profile: "check:clamped", task: "检查" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 3. 子会话直接 finish
        [
          {
            type: "tool_call",
            toolCallId: "c3",
            name: "finish",
            input: { result: "通过" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 4. 父会话总结
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const plat = { ...createPlatform(), env: () => undefined, homeDir: () => home };
    const config = await loadConfig(plat, { nocturneHome: home, env: () => undefined });
    const rt = await createRuntime({
      config,
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(home, "sessions"),
      builtinPluginsDir: builtinDir,
      providers: [provider],
      permissions: { autoApproveAsk: true },
    });
    const session = await rt.createSession({
      cwd: ws,
      workspaceRoot: ws,
      model: { provider: "p", model: "limited" },
    });

    const toolResults: {
      name: string;
      status: string;
      modelContent: string;
      error?: { code: string };
      output?: unknown;
    }[] = [];
    session.subscribe((e) => {
      if (e.type === "tool.completed" && e.payload.name === "task") {
        toolResults.push({
          name: e.payload.name,
          status: e.payload.status,
          modelContent: e.payload.modelContent,
          ...(e.payload.error !== undefined ? { error: e.payload.error } : {}),
          output: e.payload.output,
        });
      }
    });

    await session.submit({ text: "测试" });

    const emptyRes = toolResults[0];
    expect(emptyRes?.status).toBe("error");
    expect(emptyRes?.error?.code).toBe("invalid_input");
    expect(emptyRes?.modelContent).toContain("在当前会话没有可用工具");

    const clampedRes = toolResults[1];
    expect(clampedRes?.status).toBe("ok");
    expect((clampedRes?.output as { reasoningEffort?: string })?.reasoningEffort).toBe("medium");
    // 忽略池外工具 mcp__missing__ignored，仅保留 read + finish
    expect(provider.requests[2]?.tools.map((t) => t.name).sort()).toEqual(["finish", "read"]);

    await session.close();
    await rt.close();
  });

  it("端到端：隔离 NOCTURNE_HOME 调用 pptx:visual-judge，验证 default 模型、系统提示词与精确工具集", async () => {
    const root = makeTempRoot("e2e-visual-judge-");
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        modelsDev: false,
        modelRoles: { task: "p/default-task" },
      }),
    );

    const fakeRenderTool: ToolDefinition = {
      name: "mcp__slides__render",
      description: "Render slides",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      traits: { mutates: false, concurrencySafe: true },
      permissionSubjects: () => [{ kind: "mcp", target: "slides/render" }],
      execute: () => Promise.resolve({ status: "ok", modelContent: "rendered" }),
    };
    const fakeEditTool: ToolDefinition = {
      name: "mcp__slides__edit",
      description: "Edit slides",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      traits: { mutates: true, concurrencySafe: false },
      permissionSubjects: () => [{ kind: "mcp", target: "slides/edit" }],
      execute: () => Promise.resolve({ status: "ok", modelContent: "edited" }),
    };

    const provider = new FakeProvider({
      id: "p",
      models: [
        makeModelInfo("p", "main", { pricing: { input: 3, output: 15 } }),
        makeModelInfo("p", "default-task", { pricing: { input: 0.5, output: 2 } }),
      ],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "call-vj",
            name: "task",
            input: {
              profile: "pptx:visual-judge",
              task: "检查 /tmp/deck.pptx 第 1-2 页的排版和字号。",
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "call-finish",
            name: "finish",
            input: { result: "第 1 页：通过（无明显视觉问题）\n第 2 页：通过（无明显视觉问题）" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "视觉验收完成，两页均通过。" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const plat = { ...createPlatform(), env: () => undefined, homeDir: () => home };
    const config = await loadConfig(plat, { nocturneHome: home, env: () => undefined });
    const rt = await createRuntime({
      config,
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(home, "sessions"),
      builtinPluginsDir: builtPluginsDir,
      mcp: fakeMcpConnectorWithTools([fakeRenderTool, fakeEditTool]),
      providers: [provider],
      permissions: { autoApproveAsk: true },
    });

    const session = await rt.createSession({
      cwd: ws,
      workspaceRoot: ws,
      model: { provider: "p", model: "main" },
    });

    let childLogPath = "";
    session.subscribe((e) => {
      if (e.type === "tool.completed" && e.payload.name === "task") {
        childLogPath = String(
          (e.payload.output as { childLogPath?: string } | undefined)?.childLogPath ?? "",
        );
      }
    });

    await session.submit({ text: "请用视觉验收检查这份演示文稿。" });

    // 1. 子会话 session.created 记录 default 模型（p/default-task）
    expect(childLogPath).not.toBe("");
    const firstLine = readFileSync(childLogPath, "utf8").split("\n")[0] ?? "";
    const createdEvent = JSON.parse(firstLine) as {
      type: string;
      payload: { model: { provider: string; model: string } };
    };
    expect(createdEvent.type).toBe("session.created");
    expect(createdEvent.payload.model).toEqual({ provider: "p", model: "default-task" });

    // 2. 子会话请求里的系统提示词包含逐字不变的固定提示词 + 角色说明段
    const childReq = provider.requests[1];
    expect(childReq?.model).toBe("default-task");
    const systemText = (childReq?.system ?? []).map((b) => b.text).join("\n\n");
    const fixedStart = "你是一个子代理，由父代理派生来完成一项独立任务。";
    const fixedEnd =
      "完成后必须调用 finish 工具提交结果（outputSchema 存在时 result 必须符合该 schema）；只输出文本而不调用 finish 不算完成。";
    const roleHeader = "以下角色说明来自插件 演示文档（nocturne:pptx@builtin）：";
    expect(systemText).toContain(fixedStart);
    expect(systemText).toContain(fixedEnd);
    expect(systemText).toContain(roleHeader);
    expect(systemText).toContain("你是演示文稿视觉验收审查员");
    expect(systemText.indexOf(fixedEnd)).toBeLessThan(systemText.indexOf(roleHeader));

    // 3. 子会话工具定义严格只有 read、mcp__slides__render 和 finish
    expect(childReq?.tools.map((t) => t.name).sort()).toEqual([
      "finish",
      "mcp__slides__render",
      "read",
    ]);

    await session.close();
    await rt.close();
  });
});
