import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPlatform,
  createRuntime,
  loadConfig,
  type ModelInfo,
  type ModelPricing,
} from "../src/index.js";
import { subagentBasePrompt } from "../src/agent/subagent.js";
import {
  discoverProjectSubagents,
  parseClaudeSubagentMarkdown,
  parseNocturneSubagentMarkdown,
  resolveSubagentProfile,
} from "../src/config/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { truncateSubagentTableDescription } from "../src/protocol/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix = "project-subagents-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
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
    writeFile(path.join(dir, rel), content);
  }
  return dir;
}

function makeModelInfo(
  provider: string,
  model: string,
  opts?: {
    pricing?: ModelPricing;
    reasoningEffort?: ("low" | "medium" | "high" | "max")[];
    editTool?: "edit" | "apply_patch";
  },
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
      editTool: opts?.editTool ?? "edit",
    },
  };
}

describe("项目子代理发现与优先级", () => {
  it("同时发现 .nocturne/agents 与 .claude/agents，并受 skills.sources.claude 开关控制", async () => {
    const ws = makeTempRoot();
    writeFile(
      path.join(ws, ".nocturne/agents/arch.md"),
      `---
name: arch-reviewer
description: 审查架构边界
tools:
  - read
  - grep
effort: high
---
检查模块依赖方向。
`,
    );
    writeFile(
      path.join(ws, ".claude/agents/sec.md"),
      `---
name: sec-auditor
description: Security auditor
tools: Read, Grep
---
Audit security boundaries.
`,
    );
    const plat = createPlatform();

    const both = await discoverProjectSubagents(plat, { workspaceRoot: ws, cwd: ws });
    expect(both.warnings).toEqual([]);
    expect(both.active.map((a) => ({ id: a.id, source: a.source }))).toEqual([
      { id: "project:arch-reviewer", source: ".nocturne" },
      { id: "project:sec-auditor", source: ".claude" },
    ]);

    const nocturneOnly = await discoverProjectSubagents(plat, {
      workspaceRoot: ws,
      cwd: ws,
      includeClaude: false,
    });
    expect(nocturneOnly.warnings).toEqual([]);
    expect(nocturneOnly.active.map((a) => a.id)).toEqual(["project:arch-reviewer"]);
  });

  it("根路径是普通文件或不存在时静默跳过且无警告", async () => {
    const ws = makeTempRoot();
    writeFile(path.join(ws, ".nocturne/agents"), "not a directory");
    writeFile(path.join(ws, ".claude/agents"), "also not a directory");

    const res = await discoverProjectSubagents(createPlatform(), { workspaceRoot: ws, cwd: ws });
    expect(res.agents).toEqual([]);
    expect(res.active).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("同名优先级：离 cwd 近的优先，同级 .nocturne 优先于 .claude，被覆盖项记警告与 shadowedBy", async () => {
    const ws = makeTempRoot();
    const sub = path.join(ws, "packages/app");
    const subNocturne = writeFile(
      path.join(sub, ".nocturne/agents/r.md"),
      "---\nname: reviewer\ndescription: 子目录 nocturne\n---\n子目录 nocturne 正文",
    );
    const subClaude = writeFile(
      path.join(sub, ".claude/agents/r.md"),
      "---\nname: reviewer\ndescription: 子目录 claude\n---\n子目录 claude 正文",
    );
    const rootNocturne = writeFile(
      path.join(ws, ".nocturne/agents/r.md"),
      "---\nname: reviewer\ndescription: 根目录 nocturne\n---\n根目录 nocturne 正文",
    );
    // 根目录独有与子目录 .claude 独有
    const subOnlyClaude = writeFile(
      path.join(sub, ".claude/agents/shared.md"),
      "---\nname: shared\ndescription: 子目录 claude 胜出\n---\n近层胜出",
    );
    const rootOnlyNocturne = writeFile(
      path.join(ws, ".nocturne/agents/shared.md"),
      "---\nname: shared\ndescription: 根目录 nocturne 被覆盖\n---\n远层被覆盖",
    );

    const res = await discoverProjectSubagents(createPlatform(), { workspaceRoot: ws, cwd: sub });

    expect(res.active.map((a) => ({ name: a.name, path: a.path }))).toEqual([
      { name: "reviewer", path: subNocturne },
      { name: "shared", path: subOnlyClaude },
    ]);

    const shadowedReviewerClaude = res.agents.find((a) => a.path === subClaude);
    const shadowedReviewerRoot = res.agents.find((a) => a.path === rootNocturne);
    const shadowedSharedRoot = res.agents.find((a) => a.path === rootOnlyNocturne);
    expect(shadowedReviewerClaude?.shadowedBy).toBe(subNocturne);
    expect(shadowedReviewerRoot?.shadowedBy).toBe(subNocturne);
    expect(shadowedSharedRoot?.shadowedBy).toBe(subOnlyClaude);

    expect(res.warnings.filter((w) => w.includes("覆盖"))).toHaveLength(3);
    expect(res.warnings.some((w) => w.includes(subClaude) && w.includes(subNocturne))).toBe(true);
    expect(
      res.warnings.some((w) => w.includes(rootOnlyNocturne) && w.includes(subOnlyClaude)),
    ).toBe(true);
  });
});

describe(".claude/agents 格式解析与工具映射", () => {
  it("支持逗号字符串与 YAML 列表、disallowedTools 相减、编辑三项、Bash 连带两项、MCP 原样保留及未知工具警告", () => {
    const commaParsed = parseClaudeSubagentMarkdown(
      `---
name: builder
description: Builds and verifies changes
tools: Read, Write, Bash, Glob, LS, Grep, WebFetch, TodoWrite, Task, Agent, Skill, mcp__slides__render, UnknownTool
disallowedTools: KillBash, UnknownDeny
effort: high
---
Build carefully.
`,
      { prefix: "test.md：" },
    );
    expect(commaParsed.agent?.tools).toEqual([
      "read",
      "edit",
      "write",
      "apply_patch",
      "shell",
      "shell_output",
      "glob",
      "grep",
      "web_fetch",
      "todo_write",
      "task",
      "skill",
      "mcp__slides__render",
    ]);
    expect(commaParsed.agent?.effort).toBe("high");
    expect(commaParsed.warnings).toHaveLength(2);
    expect(commaParsed.warnings[0]).toContain("UnknownTool");
    expect(commaParsed.warnings[1]).toContain("UnknownDeny");

    const listParsed = parseClaudeSubagentMarkdown(
      `---
name: editor
description: Uses YAML list tools
tools:
  - Read
  - Edit
  - MultiEdit
  - BashOutput
  - KillShell
disallowedTools:
  - Write
  - Bash(git push *)
---
Edit files carefully.
`,
      { prefix: "list.md：" },
    );
    // Write 覆盖 edit/write/apply_patch，Bash(...) 覆盖 shell/shell_output/shell_kill，最终仅剩 read
    expect(listParsed.agent?.tools).toEqual(["read"]);
    expect(listParsed.warnings).toEqual([]);
  });

  it("model 等不支持字段合并为一条警告，无效 effort 忽略并警告但不跳过", () => {
    const parsed = parseClaudeSubagentMarkdown(
      `---
name: reviewer
description: Reviews code carefully
model: sonnet
permissionMode: plan
mcpServers:
  - slack
hooks: {}
maxTurns: 10
skills:
  - api-conventions
initialPrompt: Check PR
memory: project
background: true
isolation: worktree
color: cyan
omitClaudeMd: true
autoCompactWindow: 200000
experimental:
  cacheTtl: 1h
effort: turbo
---
Review code thoroughly.
`,
      { prefix: "reviewer.md：" },
    );
    expect(parsed.agent).toEqual({
      name: "reviewer",
      description: "Reviews code carefully",
      prompt: "Review code thoroughly.",
    });
    const ignoredWarnings = parsed.warnings.filter((w) => w.includes("忽略不支持的字段"));
    expect(ignoredWarnings).toHaveLength(1);
    for (const field of [
      "model",
      "permissionMode",
      "mcpServers",
      "hooks",
      "maxTurns",
      "skills",
      "initialPrompt",
      "memory",
      "background",
      "isolation",
      "color",
      "omitClaudeMd",
      "autoCompactWindow",
      "experimental",
    ]) {
      expect(ignoredWarnings[0]).toContain(field);
    }
    expect(parsed.warnings.some((w) => w.includes("effort"))).toBe(true);
  });

  it("两种格式的长 description 不跳过，选择表截到 300 字符加省略号，公开查询保留全文", () => {
    const longDesc = "甲".repeat(350);
    const noc = parseNocturneSubagentMarkdown(
      `---\nname: long-noc\ndescription: ${longDesc}\n---\n正文`,
      {
        prefix: "noc.md：",
        rejectLongDescription: false,
        modelIgnoreReason: "项目子代理不能指定模型",
      },
    );
    const claude = parseClaudeSubagentMarkdown(
      `---\nname: long-claude\ndescription: ${longDesc}\n---\n正文`,
      { prefix: "claude.md：" },
    );
    expect(noc.agent?.description).toBe(longDesc);
    expect(claude.agent?.description).toBe(longDesc);

    const truncated = truncateSubagentTableDescription(longDesc);
    expect(Array.from(truncated)).toHaveLength(301);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.slice(0, -1)).toBe("甲".repeat(300));
  });
});

describe("项目子代理档位接入与 Runtime 执行", () => {
  it("未信任项目照常加载，选择表顺序、长描述截断、默认模型不可用排除、与插件冲突优先项目", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    const builtinDir = path.join(root, "builtin");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });

    // 未信任项目放一个 .nocturne/config.json（确保未在 trust.json 中）
    writeFile(path.join(ws, ".nocturne/config.json"), JSON.stringify({ model: "p/evil" }));

    const longDesc = "很长的描述".repeat(80); // 400 字符
    writeFile(
      path.join(ws, ".nocturne/agents/conflict.md"),
      `---
name: conflict
description: 项目版本胜出
tools:
  - read
---
项目角色说明。
`,
    );
    writeFile(
      path.join(ws, ".claude/agents/long-desc.md"),
      `---
name: long-desc
description: ${longDesc}
model: sonnet
tools: Read, Grep
---
Claude 兼容角色说明。
`,
    );

    // 造一个名为 "project" 的内置插件，包含同名 conflict 与非冲突 other
    writeNativePlugin(builtinDir, {
      dirName: "project",
      manifest: {
        name: "project",
        version: "1.0.0",
        agents: "./agents",
        interface: { displayName: "冲突插件" },
      },
      files: {
        "agents/conflict.md": `---
name: conflict
description: 插件版本应被跳过
tools:
  - read
---
插件冲突正文。
`,
        "agents/other.md": `---
name: other
description: 插件其他子代理
tools:
  - read
---
插件其他正文。
`,
      },
    });

    writeFile(
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
      ],
      scripts: [
        [
          { type: "text_delta", text: "ok1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "ok2" },
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

    // 公开查询保留完整 description
    const described = await rt.describeProjectSubagents({ workspaceRoot: ws });
    expect(described.agents.find((a) => a.id === "project:long-desc")?.description).toBe(longDesc);
    expect(described.agents.find((a) => a.id === "project:long-desc")?.tools).toEqual([
      "read",
      "grep",
    ]);

    const session = await rt.createSession({ model: { provider: "p", model: "main" } });
    // 与插件冲突记了警告
    expect(session.warnings.some((w) => w.includes("project:conflict") && w.includes("跳过"))).toBe(
      true,
    );

    await session.submit({ text: "hi" });
    const taskSpec = provider.requests[0]?.tools?.find((t) => t.name === "task");
    expect(taskSpec).toBeDefined();
    const desc = taskSpec?.description ?? "";

    // 顺序：default -> quick -> project:conflict / project:long-desc -> project:other（插件） -> ext-agent
    const idxDefault = desc.indexOf("  - default：");
    const idxQuick = desc.indexOf("  - quick：");
    const idxProjConflict = desc.indexOf("  - project:conflict：项目版本胜出");
    const idxProjLong = desc.indexOf("  - project:long-desc：");
    const idxPluginOther = desc.indexOf("  - project:other：插件其他子代理");
    const idxExt = desc.indexOf("  - ext-agent（外部 agent）");
    expect(idxDefault).toBeGreaterThan(-1);
    expect(idxQuick).toBeGreaterThan(idxDefault);
    expect(idxProjConflict).toBeGreaterThan(idxQuick);
    expect(idxProjLong).toBeGreaterThan(idxQuick);
    expect(idxPluginOther).toBeGreaterThan(idxProjConflict);
    expect(idxPluginOther).toBeGreaterThan(idxProjLong);
    expect(idxExt).toBeGreaterThan(idxPluginOther);
    // 插件的 conflict 被跳过
    expect(desc).not.toContain("插件版本应被跳过");
    // 长 description 在选择表截断到 300 字符 + …
    expect(desc).toContain(truncateSubagentTableDescription(longDesc));
    expect(desc).not.toContain(longDesc);

    // 默认任务模型停用变为不可用时，项目子代理被排除并发 subagent_profile_unavailable
    const ephemeralWarnings: { code: string; message: string }[] = [];
    session.subscribe((e) => {
      if (e.type === "runtime.warning") ephemeralWarnings.push(e.payload);
    });
    await rt.setModelsEnabled({ provider: "p", models: ["task-default"], enabled: false });
    await session.submit({ text: "hi2" });
    const taskSpec2 = provider.requests[1]?.tools?.find((t) => t.name === "task");
    expect(taskSpec2?.description ?? "").not.toContain("project:conflict");
    expect(taskSpec2?.description ?? "").not.toContain("project:long-desc");
    expect(
      ephemeralWarnings.some(
        (w) => w.code === "subagent_profile_unavailable" && w.message.includes("project:conflict"),
      ),
    ).toBe(true);

    await session.close();
    await rt.close();
  });

  it("执行项目子代理：跟随 default 模型、effort 降档、工具交集与空交集 invalid_input、固定提示词逐字不变并追加相对路径来源段落", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });

    writeFile(
      path.join(ws, ".claude/agents/code-reviewer.md"),
      `---
name: code-reviewer
description: Review code
tools: Read, Grep, Write
disallowedTools: Write
effort: max
---
你是严格的代码审查员。
`,
    );
    writeFile(
      path.join(ws, ".nocturne/agents/empty-tools.md"),
      `---
name: empty-tools
description: Only unavailable tools
tools:
  - mcp__missing__tool
---
没有可用工具。
`,
    );
    writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        modelsDev: false,
        modelRoles: { task: "p/task-default" },
      }),
    );

    const provider = new FakeProvider({
      id: "p",
      models: [
        makeModelInfo("p", "main", { reasoningEffort: ["low", "medium", "high", "max"] }),
        // task-default 最高支持 medium，用于验证 effort: max 降档到 medium
        makeModelInfo("p", "task-default", { reasoningEffort: ["low", "medium"] }),
      ],
      scripts: [
        // 1. 父会话先调用 empty-tools（工具交集只剩 finish -> invalid_input）
        [
          {
            type: "tool_call",
            toolCallId: "call-empty",
            name: "task",
            input: { profile: "project:empty-tools", task: "尝试运行" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 2. 父会话调用 project:code-reviewer
        [
          {
            type: "tool_call",
            toolCallId: "call-review",
            name: "task",
            input: { profile: "project:code-reviewer", task: "请审查 index.ts" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 3. 子会话（project:code-reviewer）调用 finish 提交结果
        [
          {
            type: "tool_call",
            toolCallId: "child-finish",
            name: "finish",
            input: { result: "审查通过" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 4. 父会话最终答复
        [
          { type: "text_delta", text: "全部完成" },
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
      providers: [provider],
      permissions: { autoApproveAsk: true },
    });

    const session = await rt.createSession({ model: { provider: "p", model: "main" } });
    const completedTasks: {
      callId: string;
      status: string;
      error?: { code: string } | undefined;
      modelContent: string;
    }[] = [];
    session.subscribe((e) => {
      if (e.type === "tool.completed" && e.payload.name === "task") {
        completedTasks.push({
          callId: e.payload.callId,
          status: e.payload.status,
          error: e.payload.error,
          modelContent: e.payload.modelContent,
        });
      }
    });
    await session.submit({ text: "开始审查" });

    // 第 3 次请求（索引 2）来自子会话（project:code-reviewer）
    const childReq = provider.requests[2];
    expect(childReq).toBeDefined();
    // 跟随 default 模型 p/task-default
    expect(childReq?.model).toBe("task-default");
    // effort: max 按 task-default 能力降档到 medium
    expect(childReq?.reasoningEffort).toBe("medium");
    // 工具交集：Read + Grep + Write - Write => read, grep + finish
    expect(childReq?.tools?.map((t) => t.name).sort()).toEqual(["finish", "grep", "read"]);
    // 固定 subagentBasePrompt 逐字不变，且角色说明独立成段追加在其后并注明相对 workspaceRoot 路径
    const fixedPrompt = subagentBasePrompt(false);
    const systemText = (childReq?.system ?? []).map((b) => b.text).join("\n\n");
    expect(systemText.startsWith(fixedPrompt)).toBe(true);
    expect(systemText).toContain(
      `${fixedPrompt}\n\n以下角色说明来自项目文件 .claude/agents/code-reviewer.md：\n\n你是严格的代码审查员。`,
    );

    // 第 1 次 task（empty-tools）工具交集只剩 finish，返回 invalid_input；第 2 次（code-reviewer）成功
    expect(completedTasks).toHaveLength(2);
    const emptyResult = completedTasks[0];
    expect(emptyResult?.status).toBe("error");
    expect(emptyResult?.error?.code).toBe("invalid_input");
    expect(emptyResult?.modelContent).toContain("在当前会话没有可用工具");
    expect(completedTasks[1]?.status).toBe("ok");

    await session.close();
    await rt.close();
  });

  it("resolveSubagentProfile 中项目子代理优先于插件子代理，且默认模型不可用返回 undefined", () => {
    const projectDef = {
      "project:judge": {
        id: "project:judge",
        name: "judge",
        source: ".nocturne" as const,
        path: "/ws/.nocturne/agents/judge.md",
        relativePath: ".nocturne/agents/judge.md",
        description: "项目评审",
        prompt: "项目正文",
        effort: "high" as const,
        tools: ["read"],
      },
    };
    const pluginDef = {
      "project:judge": {
        id: "project:judge",
        pluginId: "nocturne:project@local",
        pluginName: "project",
        pluginDisplayName: "Project",
        description: "插件评审",
        prompt: "插件正文",
      },
    };
    const models: Record<string, string> = { "p/default": "DEFAULT_MODEL" };
    const resolveModel = (ref: string) => models[ref];

    const resolved = resolveSubagentProfile(
      "project:judge",
      {},
      resolveModel,
      "CURRENT",
      "DEFAULT_MODEL",
      pluginDef,
      {},
      projectDef,
      "p/default",
    );
    expect(resolved?.sourceProject?.relativePath).toBe(".nocturne/agents/judge.md");
    expect(resolved?.sourcePlugin).toBeUndefined();
    expect(resolved?.model).toBe("DEFAULT_MODEL");

    const unavailable = resolveSubagentProfile(
      "project:judge",
      {},
      resolveModel,
      "CURRENT",
      "DEFAULT_MODEL",
      pluginDef,
      {},
      projectDef,
      "p/missing",
    );
    expect(unavailable).toBeUndefined();
  });

  it("仅声明 disallowedTools 时从子会话工具池中剔除被禁用工具，且配置重载后文件增改生效", async () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });

    writeFile(
      path.join(ws, ".claude/agents/no-write.md"),
      `---
name: no-write
description: Read-only via disallowedTools
disallowedTools: Write, Bash
---
只读分析，不允许改文件或跑命令。
`,
    );
    writeFile(path.join(home, "config.json"), JSON.stringify({ modelsDev: false }));

    const provider = new FakeProvider({
      id: "p",
      models: [makeModelInfo("p", "main")],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "c-nowrite",
            name: "task",
            input: { profile: "project:no-write", task: "只读检查" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "c-finish",
            name: "finish",
            input: { result: "完成" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "done2" },
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
      providers: [provider],
      permissions: { autoApproveAsk: true },
    });

    const session = await rt.createSession({ model: { provider: "p", model: "main" } });
    await session.submit({ text: "turn1" });

    const childTools = provider.requests[1]?.tools?.map((t) => t.name) ?? [];
    expect(childTools).toContain("read");
    expect(childTools).toContain("grep");
    expect(childTools).not.toContain("write");
    expect(childTools).not.toContain("edit");
    expect(childTools).not.toContain("apply_patch");
    expect(childTools).not.toContain("shell");

    // 磁盘新增一个项目子代理，配置重载后进入下一轮选择表
    writeFile(
      path.join(ws, ".nocturne/agents/added.md"),
      "---\nname: added\ndescription: 重载后出现\n---\n新增角色说明。",
    );
    await rt.updateProviders(await config.reload());
    await session.submit({ text: "turn2" });
    const taskAfterReload = provider.requests[3]?.tools?.find((t) => t.name === "task");
    expect(taskAfterReload?.description ?? "").toContain("project:added：重载后出现");

    await session.close();
    await rt.close();
  });
});
