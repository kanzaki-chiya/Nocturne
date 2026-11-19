/**
 * Ensemble 执行方式（ADR-0089）完整单元与集成测试：
 * 全程离线驱动，验证入口准入、指挥工具收窄、成员与模型/档位、留言板与提及唤醒、
 * 工作区与分离头指针审查、并发排队、状态机、权限确认冒泡、安静提醒及重启/回退/分叉持久化。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { listWorktreeRecords, resetWorktreeToCommit, worktreeGit } from "../src/agent/worktree.js";
import { createRuntime, type RuntimeSession } from "../src/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  LOG_FORMAT_VERSION,
  reduceSessionView,
  replaySessionView,
  type DurableEvent,
  type RuntimeEvent,
  type SessionView,
} from "../src/protocol/index.js";
import {
  FakeProvider,
  ProviderError,
  type FakeScript,
  type ModelRequest,
  type Provider,
} from "../src/provider/index.js";
import type { RuntimeConfig } from "../src/config/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be defined");
  return value;
}

const roots: string[] = [];
const openRuntimes: { sessions: RuntimeSession[] }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of openRuntimes.splice(0)) {
    for (const s of entry.sessions.splice(0)) {
      await s.close().catch(() => undefined);
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "nocturne-ensemble-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function initGitRepo(dir: string): Promise<void> {
  await worktreeGit(dir, ["init", "-b", "main"]);
  await worktreeGit(dir, ["config", "user.name", "Test"]);
  await worktreeGit(dir, ["config", "user.email", "test@localhost"]);
  await worktreeGit(dir, ["config", "commit.gpgsign", "false"]);
  await worktreeGit(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  writeFileSync(path.join(dir, "shared.txt"), "initial\n", "utf8");
  await worktreeGit(dir, ["add", "-A"]);
  await worktreeGit(dir, ["commit", "-m", "initial commit"]);
}

const callTool = (id: string, name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: id,
  name,
  input,
});

const stopText = (text = "ok"): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

type ScriptRouter = (req: ModelRequest, modelId: string) => FakeScript | Promise<FakeScript>;

function createRoutedProvider(
  providerId: string,
  models: {
    id: string;
    pricing?: { input: number; output: number };
    effort?: ("low" | "medium" | "high")[];
  }[],
  router: ScriptRouter,
  recorded: { provider: string; model: string; req: ModelRequest }[] = [],
): Provider {
  return new FakeProvider({
    id: providerId,
    models: models.map((m) => ({
      ref: { provider: providerId, model: m.id },
      protocol: "openai-compatible" as const,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: m.effort ? ("visible" as const) : ("none" as const),
        ...(m.effort ? { reasoningEffort: m.effort } : {}),
        imageInput: false,
        promptCache: false,
        editTool: "edit" as const,
      },
    })),
    roleHandler: () => stopText("Test Title"),
    handler: async (req) => {
      recorded.push({ provider: providerId, model: req.model, req });
      return await router(req, req.model);
    },
  });
}

function trackView(session: RuntimeSession): () => SessionView {
  const view = replaySessionView(session.durableEvents());
  session.subscribe((ev: RuntimeEvent) => {
    reduceSessionView(view, ev);
  });
  return () => view;
}

function requestRole(req: ModelRequest): string {
  const sys = req.system.map((b) => b.text).join("\n");
  const match = /persistent ensemble member `@([a-z0-9-]+)`/.exec(sys);
  if (match?.[1]) return `member:${match[1]}`;
  return "maestro";
}

const VALID_CHARTER = {
  owns: "src/orders.ts",
  handsOff: "src/users.ts and shared config",
  doneWhen: "orders validation passes unit tests",
};

describe("Ensemble 执行方式（ADR-0089）", { timeout: 30_000 }, () => {
  it("入口准入检查：未开启后台子代理、子代理停用、无人值守或定时任务拒绝 /ensemble，已有活动 Ensemble 时禁止重入", async () => {
    const ws = makeTempDir();
    const sessionsDir = path.join(ws, ".sessions");
    const provider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      if (requestRole(req) === "maestro") {
        const hasInit = req.messages.some(
          (m) =>
            m.role === "tool" &&
            typeof m.content === "string" &&
            m.content.includes("Initialized ensemble"),
        );
        if (!hasInit) {
          return [
            callTool("c1", "ensemble_init", { title: "First Ensemble" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
      }
      return stopText("started");
    });

    // 1. 未开启 subagent.background（如 nctrn -p）
    const rtNoBg = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(sessionsDir, "nobg"),
      providers: [provider],
      interactive: true,
      subagent: { background: false },
    });
    const sNoBg = await rtNoBg.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [sNoBg] });
    await expect(
      sNoBg.submit({ text: "build feature", workMode: "ensemble" }),
    ).rejects.toMatchObject({
      code: "invalid_command",
    });

    // 2. 子代理停用
    const rtDisabled = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(sessionsDir, "disabled"),
      providers: [provider],
      interactive: true,
      subagent: { enabled: false, background: true },
    });
    const sDisabled = await rtDisabled.createSession({
      model: "fake/m1",
      permissionPreset: "bypass",
    });
    openRuntimes.push({ sessions: [sDisabled] });
    await expect(
      sDisabled.submit({ text: "build feature", workMode: "ensemble" }),
    ).rejects.toMatchObject({ code: "invalid_command" });

    // 3. 无人值守 / 定时任务会话不支持
    const rtOk = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(sessionsDir, "ok"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const sUnattended = await rtOk.createSession({
      model: "fake/m1",
      permissionPreset: "bypass",
      interactive: false,
    });
    const sScheduled = await rtOk.createSession({
      model: "fake/m1",
      permissionPreset: "bypass",
      schedule: { taskId: "t1", scheduledAt: new Date().toISOString(), trigger: "manual" },
    });
    const sMain = await rtOk.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [sUnattended, sScheduled, sMain] });

    await expect(
      sUnattended.submit({ text: "build feature", workMode: "ensemble" }),
    ).rejects.toMatchObject({ code: "invalid_command" });
    await expect(
      sScheduled.submit({ text: "build feature", workMode: "ensemble" }),
    ).rejects.toMatchObject({ code: "invalid_command" });

    // 4. 正常启动成功后，同一会话同时至多一个 Ensemble
    await sMain.submit({ text: "build feature", workMode: "ensemble" });
    await expect(
      sMain.submit({ text: "second ensemble", workMode: "ensemble" }),
    ).rejects.toMatchObject({
      code: "invalid_command",
    });
  });

  it("建立与添加成员：名字冲突、保留名、非法字符与任务书缺段均以 invalid_input 拒绝", async () => {
    const ws = makeTempDir();
    let step = 0;
    const provider = createRoutedProvider("fake", [{ id: "m1" }], () => {
      step++;
      if (step === 1) {
        return [
          callTool("init", "ensemble_init", { title: "Validation Test" }),
          // 保留名
          callTool("r1", "ensemble_add_member", { name: "all", charter: VALID_CHARTER }),
          callTool("r2", "ensemble_add_member", { name: "maestro", charter: VALID_CHARTER }),
          callTool("r3", "ensemble_add_member", { name: "指挥", charter: VALID_CHARTER }),
          // 非法字符
          callTool("bad1", "ensemble_add_member", { name: "Bad_Name", charter: VALID_CHARTER }),
          // 任务书缺段
          callTool("c1", "ensemble_add_member", {
            name: "incomplete-1",
            charter: { owns: "a.ts", handsOff: "b.ts" },
          }),
          callTool("c2", "ensemble_add_member", {
            name: "incomplete-2",
            charter: { owns: "a.ts", handsOff: "   ", doneWhen: "pass" },
          }),
          // 合法添加
          callTool("ok1", "ensemble_add_member", { name: "orders", charter: VALID_CHARTER }),
          // 名字冲突
          callTool("dup", "ensemble_add_member", { name: "orders", charter: VALID_CHARTER }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("checked");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    await session.submit({ text: "validate", workMode: "ensemble" });
    const events = session.durableEvents();
    const completed = events.filter(
      (e): e is Extract<DurableEvent, { type: "tool.completed" }> => e.type === "tool.completed",
    );
    expect(completed).toHaveLength(9);
    expect(completed[0]?.payload.status).toBe("ok"); // ensemble_init
    // r1, r2, r3, bad1, c1, c2 全部 invalid_input
    for (const idx of [1, 2, 3, 4, 5, 6]) {
      expect(completed[idx]?.payload.status).toBe("error");
      expect(completed[idx]?.payload.error?.code).toBe("invalid_input");
    }
    expect(completed[7]?.payload.status).toBe("ok"); // ok1: orders
    expect(completed[8]?.payload.status).toBe("error"); // dup: orders
    expect(completed[8]?.payload.error?.code).toBe("invalid_input");

    const view = replaySessionView(session.durableEvents());
    expect(view.ensemble?.members.map((m) => m.name)).toEqual(["orders"]);
    // 成员加入时公开任务书作为一条帖子发到留言板
    expect(view.ensemble?.posts).toHaveLength(1);
    expect(view.ensemble?.posts[0]?.charterOf).toBe("orders");
    expect(view.ensemble?.posts[0]?.text).toContain("Owns:");
  });

  it("模型与档位选择、互斥、未启用/不存在拒绝并列出可选项、换模型保留历史及外部 agent 被拒", async () => {
    const ws = makeTempDir();
    const recorded: { provider: string; model: string; req: ModelRequest }[] = [];

    const fakeConfig = {
      base: {
        providers: [],
        externalAgents: [
          {
            name: "codex-ext",
            command: "codex",
            args: [],
            enabled: true,
            origin: "user",
            path: "config.json",
          },
        ],
      },
      disabledProviders: () => ["disabled-prov"],
      disabledModels: () => ["fake/off-model"],
      disabledSkills: () => [],
      skillConfig: () => undefined,
      memoryConfig: () => ({ global: true, project: true }),
      shellSetting: () => undefined,
      recentModels: () => [],
      recordRecentModel: async () => undefined,
      getPreference: () => undefined,
      setPreference: async () => undefined,
      forWorkspace: async () => ({
        resolved: {
          providers: [],
          rules: [],
          untrustedRules: [],
          mcpServers: [],
          hooks: {},
          warnings: [],
          providerThinkingWarnings: [],
          providerAuthWarnings: [],
        },
        projectConfig: { present: false, trusted: true },
      }),
      resolvedSettings: () => ({
        providers: [],
        subagentProfiles: {
          fast: {
            enabled: true,
            description: "Fast read-only profile",
            model: "fake/m-fast",
            effort: "low" as const,
            tools: "explore" as const,
          },
        },
      }),
      describeSettings: () => [],
    } as unknown as RuntimeConfig;

    const mainProvider = createRoutedProvider(
      "fake",
      [
        { id: "m-coord", pricing: { input: 2, output: 10 }, effort: ["low", "medium", "high"] },
        { id: "m-worker", pricing: { input: 1, output: 5 }, effort: ["low", "medium", "high"] },
        { id: "m-fast", pricing: { input: 0.1, output: 0.5 }, effort: ["low", "medium"] },
        { id: "off-model", pricing: { input: 3, output: 15 } },
      ],
      (req) => {
        const role = requestRole(req);
        if (role === "maestro") {
          const allText = JSON.stringify(req.messages);
          const hasInited = req.messages.some(
            (m) => m.role === "tool" && m.content.includes("Initialized ensemble"),
          );
          if (!hasInited) {
            return [
              callTool("i1", "ensemble_init", { title: "Model Matrix" }),
              // 同时给出 model 和 profile → 被拒
              callTool("both", "ensemble_add_member", {
                name: "bad-both",
                charter: VALID_CHARTER,
                model: "fake/m-worker",
                profile: "fast",
              }),
              // 已停用模型 → 被拒并列出可选项
              callTool("dis1", "ensemble_add_member", {
                name: "bad-disabled",
                charter: VALID_CHARTER,
                model: "fake/off-model",
              }),
              // 不存在的模型 → 被拒并列出可选项
              callTool("no1", "ensemble_add_member", {
                name: "bad-missing",
                charter: VALID_CHARTER,
                model: "fake/non-existent",
              }),
              // 外部 ACP agent（传未定义的 agent 字段应按 schema 未知字段报错；传给 model/profile 仍由业务层拒绝）
              callTool("ext1", "ensemble_add_member", {
                name: "bad-ext-1",
                charter: VALID_CHARTER,
                agent: "codex-ext",
              }),
              callTool("ext2", "ensemble_add_member", {
                name: "bad-ext-2",
                charter: VALID_CHARTER,
                model: "codex-ext",
              }),
              callTool("ext3", "ensemble_add_member", {
                name: "bad-ext-3",
                charter: VALID_CHARTER,
                profile: "codex-ext",
              }),
              // 指定已启用模型 + 思考强度生效
              callTool("m-ok", "ensemble_add_member", {
                name: "impl",
                charter: VALID_CHARTER,
                model: "fake/m-worker",
                effort: "high",
              }),
              // 指定 profile 生效（explore 工具集上限 + low 思考档位）
              callTool("p-ok", "ensemble_add_member", {
                name: "scout",
                charter: {
                  owns: "read docs",
                  handsOff: "all edits",
                  doneWhen: "summary posted",
                },
                profile: "fast",
              }),
              // 派活给 impl 第 1 轮
              callTool("post1", "ensemble_post", {
                text: "@impl First task: remember codeword ALPHA-42.",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          const hasSwitched = req.messages.some(
            (m) => m.role === "tool" && m.content.includes("Switched @impl"),
          );
          if (allText.includes("Finished first round") && !hasSwitched) {
            return [
              callTool("chg-ext", "ensemble_change_model", {
                name: "impl",
                model: "m-coord",
                agent: "codex-ext",
              }),
              callTool("chg", "ensemble_change_model", {
                name: "impl",
                model: "m-coord",
                effort: "medium",
              }),
              callTool("post2", "ensemble_post", { text: "@impl Second task after model switch." }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          const hasEnded = req.messages.some(
            (m) => m.role === "tool" && m.content.includes("Ended ensemble"),
          );
          if (allText.includes("Finished second round") && !hasEnded) {
            return [
              callTool("end", "ensemble_end", { summary: "all verified" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coord waiting");
        }
        if (role === "member:impl") {
          const implText = JSON.stringify(req.messages);
          const postedFirst = req.messages.some(
            (m) => m.role === "tool" && m.content.includes("Posted #"),
          );
          if (!implText.includes("Second task after model switch")) {
            if (!postedFirst) {
              return [
                callTool("mp1", "ensemble_post", {
                  text: "@maestro Finished first round (ALPHA-42).",
                }),
                { type: "finish", reason: "tool_calls" },
              ];
            }
            return stopText("impl round 1 done");
          }
          // 第 2 轮：统计已完成的 ensemble_post 工具返回次数
          const postResults = req.messages.filter(
            (m) => m.role === "tool" && m.content.includes("Posted #"),
          );
          if (postResults.length < 2) {
            return [
              callTool("mp2", "ensemble_post", {
                text: "@maestro Finished second round on new model.",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("impl round 2 done");
        }
        return stopText("idle");
      },
      recorded,
    );

    const disabledProvider = createRoutedProvider("disabled-prov", [{ id: "dp-1" }], () =>
      stopText(),
    );

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [mainProvider, disabledProvider],
      config: fakeConfig,
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m-coord", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    await session.submit({ text: "test models", workMode: "ensemble" });
    await vi.waitFor(() => {
      const view = replaySessionView(session.durableEvents());
      expect(view.ensemble?.status).toBe("ended");
    });

    // 验证工具说明包含 subagentSelectionTable 档位与带价格的可选已启用模型清单，不含停用模型与外部 agent；
    // 且 ensemble_add_member 与 ensemble_change_model 的 schema 均不含 agent 字段
    const firstCoordReq = must(recorded.find((r) => requestRole(r.req) === "maestro")).req;
    const addToolSpec = must(firstCoordReq.tools.find((t) => t.name === "ensemble_add_member"));
    const changeModelToolSpec = must(
      firstCoordReq.tools.find((t) => t.name === "ensemble_change_model"),
    );
    expect(
      Object.keys((addToolSpec.inputSchema.properties ?? {}) as Record<string, unknown>),
    ).not.toContain("agent");
    expect(
      Object.keys((changeModelToolSpec.inputSchema.properties ?? {}) as Record<string, unknown>),
    ).not.toContain("agent");
    expect(addToolSpec.description).toContain("fake/m-worker");
    expect(addToolSpec.description).toContain("$1/$5");
    expect(addToolSpec.description).toContain("fast");
    expect(addToolSpec.description).not.toContain("off-model");
    expect(addToolSpec.description).not.toContain("disabled-prov");
    expect(addToolSpec.description).not.toContain("codex-ext");

    const assistantCallByProviderId = new Map(
      session
        .durableEvents()
        .filter(
          (e): e is Extract<DurableEvent, { type: "message.assistant" }> =>
            e.type === "message.assistant",
        )
        .flatMap((e) => e.payload.toolCalls)
        .filter(
          (tc): tc is typeof tc & { providerCallId: string } => tc.providerCallId !== undefined,
        )
        .map((tc) => [tc.providerCallId, tc.callId]),
    );
    const startedById = new Map(
      session
        .durableEvents()
        .filter(
          (e): e is Extract<DurableEvent, { type: "tool.started" }> => e.type === "tool.started",
        )
        .map((e) => [e.payload.callId, e.payload.input as { name?: string }]),
    );
    const completedByCallId = new Map(
      session
        .durableEvents()
        .filter(
          (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
            e.type === "tool.completed",
        )
        .map((e) => [e.payload.callId, e.payload]),
    );
    const completedByMemberName = new Map(
      [...completedByCallId.values()].map((payload) => [
        startedById.get(payload.callId)?.name ?? payload.callId,
        payload,
      ]),
    );

    expect(completedByMemberName.get("bad-both")?.error?.code).toBe("invalid_input");
    for (const rejected of ["bad-disabled", "bad-missing"]) {
      const content = completedByMemberName.get(rejected)?.modelContent ?? "";
      expect(completedByMemberName.get(rejected)?.error?.code).toBe("invalid_input");
      const availablePart = content.split("Available enabled models:")[1] ?? "";
      expect(availablePart).toContain("fake/m-coord");
      expect(availablePart).toContain("fake/m-worker");
      expect(availablePart).not.toContain("off-model");
      expect(availablePart).not.toContain("disabled-prov");
    }
    // 传 agent 字段时，在 schema 校验阶段即以未知字段拒绝（不会进入 tool.started）
    const ext1CallId = must(assistantCallByProviderId.get("ext1"));
    expect(startedById.has(ext1CallId)).toBe(false);
    expect(completedByCallId.get(ext1CallId)?.error?.code).toBe("invalid_input");
    expect(completedByCallId.get(ext1CallId)?.modelContent).toContain("输入不符合 schema");
    const chgExtCallId = must(assistantCallByProviderId.get("chg-ext"));
    expect(startedById.has(chgExtCallId)).toBe(false);
    expect(completedByCallId.get(chgExtCallId)?.error?.code).toBe("invalid_input");
    expect(completedByCallId.get(chgExtCallId)?.modelContent).toContain("输入不符合 schema");
    // 外部 agent 名作为 model 或 profile 仍被拒绝
    expect(completedByMemberName.get("bad-ext-2")?.error?.code).toBe("invalid_input");
    expect(completedByMemberName.get("bad-ext-2")?.modelContent).toContain("external ACP agent");
    expect(completedByMemberName.get("bad-ext-3")?.error?.code).toBe("invalid_input");
    expect(completedByMemberName.get("bad-ext-3")?.modelContent).toContain("external ACP agent");
    // 已启用普通 provider/model 能成功加成员
    expect(completedByMemberName.get("impl")?.status).toBe("ok");

    // 验证成员加入事件记录了实际模型、思考强度与 explore 预设
    const addedEvents = session
      .durableEvents()
      .filter(
        (e): e is Extract<DurableEvent, { type: "ensemble.member_added" }> =>
          e.type === "ensemble.member_added",
      );
    const implAdded = must(addedEvents.find((e) => e.payload.name === "impl"));
    expect(implAdded.payload.model).toEqual({ provider: "fake", model: "m-worker" });
    expect(implAdded.payload.reasoningEffort).toBe("high");
    expect(implAdded.payload.preset).toBe("general");

    const scoutAdded = must(addedEvents.find((e) => e.payload.name === "scout"));
    expect(scoutAdded.payload.model).toEqual({ provider: "fake", model: "m-fast" });
    expect(scoutAdded.payload.reasoningEffort).toBe("low");
    expect(scoutAdded.payload.profile).toBe("fast");
    expect(scoutAdded.payload.preset).toBe("explore");

    // 验证换模型前后：第 1 轮跑在 m-worker，第 2 轮跑在 m-coord 且保留了第 1 轮的 ALPHA-42 对话历史
    const implReqs = recorded.filter((r) => requestRole(r.req) === "member:impl");
    expect(implReqs[0]?.model).toBe("m-worker");
    const switchedReq = must(implReqs.find((r) => r.model === "m-coord"));
    expect(JSON.stringify(switchedReq.req.messages)).toContain("ALPHA-42");
  });

  it("工具收窄与成员边界：指挥在 Ensemble 期间无改文件工具且结束后恢复；成员无添加成员/task/finish 工具", async () => {
    const ws = makeTempDir();
    const recorded: { provider: string; model: string; req: ModelRequest }[] = [];
    let coordStep = 0;
    let memberStep = 0;

    const provider = createRoutedProvider(
      "fake",
      [{ id: "m1" }],
      (req) => {
        const role = requestRole(req);
        if (role === "maestro") {
          coordStep++;
          if (coordStep === 1) {
            return [
              callTool("i", "ensemble_init", { title: "Tool Narrowing" }),
              callTool("a", "ensemble_add_member", { name: "worker", charter: VALID_CHARTER }),
              callTool("p", "ensemble_post", { text: "@worker check your tools" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (coordStep === 2) {
            return stopText("waiting for worker");
          }
          if (coordStep === 3) {
            return [
              callTool("e", "ensemble_end", { summary: "finished" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("closed");
        }
        memberStep++;
        if (memberStep === 1) {
          // 成员尝试越权调用 ensemble_add_member，应因 unknown_tool 失败，然后发帖回报
          return [
            callTool("illegal", "ensemble_add_member", { name: "nested", charter: VALID_CHARTER }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (memberStep === 2) {
          return [
            callTool("reply", "ensemble_post", { text: "@maestro checked tools" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("member done");
      },
      recorded,
    );

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    // Ensemble 前指挥有 write / edit
    const beforeTools = session.describeContext().request.tools.map((t) => t.name);
    expect(beforeTools).toContain("write");
    expect(beforeTools).toContain("edit");

    await session.submit({ text: "start ensemble", workMode: "ensemble" });
    await vi.waitFor(() => {
      expect(replaySessionView(session.durableEvents()).ensemble?.status).toBe("ended");
    });

    // Ensemble 期间指挥请求中的工具列表：无 write / edit / apply_patch，保留 shell / apply_subagent_changes / read + Ensemble 工具
    const duringCoordTools = must(
      recorded.find((r) => requestRole(r.req) === "maestro"),
    ).req.tools.map((t) => t.name);
    expect(duringCoordTools).not.toContain("write");
    expect(duringCoordTools).not.toContain("edit");
    expect(duringCoordTools).not.toContain("apply_patch");
    expect(duringCoordTools).toContain("read");
    expect(duringCoordTools).toContain("shell");
    expect(duringCoordTools).toContain("apply_subagent_changes");
    expect(duringCoordTools).toContain("note_write");
    expect(duringCoordTools).toContain("ensemble_add_member");

    // 成员的工具列表：只有通用工具 + ensemble_post，没有 ensemble_add_member / task / finish
    const memberReq = must(recorded.find((r) => requestRole(r.req) === "member:worker")).req;
    const memberToolNames = memberReq.tools.map((t) => t.name);
    expect(memberToolNames).toContain("ensemble_post");
    expect(memberToolNames).not.toContain("ensemble_add_member");
    expect(memberToolNames).not.toContain("task");
    expect(memberToolNames).not.toContain("finish");
    // 成员越权调用返回错误
    const memberSecondReq = must(
      recorded.filter((r) => requestRole(r.req) === "member:worker")[1],
    ).req;
    expect(JSON.stringify(memberSecondReq.messages)).toContain("ensemble_add_member");

    // Ensemble 结束后，指挥的 write / edit 立即恢复，Ensemble 工具已卸载
    const afterTools = session.describeContext().request.tools.map((t) => t.name);
    expect(afterTools).toContain("write");
    expect(afterTools).toContain("edit");
    expect(afterTools).not.toContain("ensemble_add_member");
  });

  it("唤醒与提及：组提及 @fix 展开为整组、工作中安全点插话、@all 广播、用户无 @ 默认唤醒指挥、直接给成员发消息不上留言板", async () => {
    const ws = makeTempDir();
    const recorded: { provider: string; model: string; req: ModelRequest }[] = [];
    let slowRelease!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      slowRelease = resolve;
    });
    let fix1StartedResolve!: () => void;
    const fix1Started = new Promise<void>((resolve) => {
      fix1StartedResolve = resolve;
    });

    let coordSetupDone = false;
    const provider = createRoutedProvider(
      "fake",
      [{ id: "m1" }],
      async (req) => {
        const role = requestRole(req);
        if (role === "maestro") {
          if (!coordSetupDone) {
            coordSetupDone = true;
            return [
              callTool("i", "ensemble_init", { title: "Mentions & Steer" }),
              callTool("a1", "ensemble_add_member", { name: "fix-1", charter: VALID_CHARTER }),
              callTool("a2", "ensemble_add_member", { name: "fix-2", charter: VALID_CHARTER }),
              callTool("a3", "ensemble_add_member", { name: "fixture", charter: VALID_CHARTER }),
              // 用 @fix 组提及一次唤醒 fix-1 和 fix-2（不唤醒 fixture）
              callTool("p1", "ensemble_post", { text: "@fix Start fixing your assigned modules." }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coord ack");
        }
        if (role === "member:fix-1") {
          const hasSteer = JSON.stringify(req.messages).includes("STEER-UPDATE");
          if (!hasSteer) {
            // 第一步执行只读工具期间阻塞等待安全点插话
            const alreadyCalledRead = req.messages.some((m) => m.role === "tool");
            if (!alreadyCalledRead) {
              writeFileSync(path.join(ws, "note.txt"), "hello", "utf8");
              return [
                callTool("r-slow", "read", { path: "note.txt" }),
                { type: "finish", reason: "tool_calls" },
              ];
            }
            fix1StartedResolve();
            await slowGate;
          }
          return stopText("fix-1 done");
        }
        return stopText(`${role} done`);
      },
      recorded,
    );

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    await session.submit({ text: "test mentions", workMode: "ensemble" });

    // 等待 fix-1 进入工作中，fix-2 完成一轮，而 fixture 从未被唤醒
    await fix1Started;
    await vi.waitFor(
      () => {
        expect(recorded.some((r) => requestRole(r.req) === "member:fix-2")).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(recorded.some((r) => requestRole(r.req) === "member:fixture")).toBe(false);

    // 在 fix-1 正在跑第一轮期间，用户发帖 @fix-1 -> 作为安全点插话（steer）在同一轮内插入！
    await session.postToEnsemble({ text: "@fix-1 STEER-UPDATE: also check edge case." });
    slowRelease();

    await vi.waitFor(
      () => {
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    const view1 = replaySessionView(session.durableEvents());
    const fix1Member = must(must(view1.ensemble).members.find((m) => m.name === "fix-1"));
    const fix1Session = await rt.resumeSession(fix1Member.childSessionId);
    // 安全点插话写入了 steer: true，所以 fix-1 仍然只跑了 1 个 Turn！
    const fix1Turns = fix1Session.durableEvents().filter((e) => e.type === "turn.completed");
    expect(fix1Turns).toHaveLength(1);
    expect(
      fix1Session
        .durableEvents()
        .some(
          (e) =>
            e.type === "message.user" &&
            e.payload.steer === true &&
            e.payload.ensemble !== undefined,
        ),
    ).toBe(true);

    // 测试 @all：送给除发帖者外的全体在场者（此时唤醒 fix-1、fix-2、fixture、maestro）
    await session.postToEnsemble({ text: "@all Broadcast status check" });
    await vi.waitFor(
      () => {
        expect(recorded.some((r) => requestRole(r.req) === "member:fixture")).toBe(true);
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    // 测试用户发帖无任何 @ 时默认唤醒指挥
    const coordCountBefore = recorded.filter((r) => requestRole(r.req) === "maestro").length;
    const postRes = await session.postToEnsemble({ text: "How is progress going?" });
    expect(postRes.recipients).toEqual(["maestro"]);
    await vi.waitFor(
      () => {
        expect(recorded.filter((r) => requestRole(r.req) === "maestro").length).toBeGreaterThan(
          coordCountBefore,
        );
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    // 测试用户直接给成员会话发消息：只给该成员，不上指挥留言板
    const boardCountBefore = must(replaySessionView(session.durableEvents()).ensemble).posts.length;
    await fix1Session.submit({ text: "Direct private note to fix-1 only" });
    const boardCountAfter = must(replaySessionView(session.durableEvents()).ensemble).posts.length;
    expect(boardCountAfter).toBe(boardCountBefore);
    expect(
      fix1Session
        .durableEvents()
        .some(
          (e) =>
            e.type === "message.user" &&
            e.payload.ensemble === undefined &&
            JSON.stringify(e.payload.content).includes("Direct private note to fix-1 only"),
        ),
    ).toBe(true);

    await session.endEnsemble();
  }, 30_000);

  it("工作区与独立工作树：默认共用主工作区、每轮自动提交、验证成员分离头指针检出并清残留、未并回拒绝移除、结束保留未并回并清理已并回", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);

    let step = 0;
    let verifierSawImpl1Code = false;
    let verifierLeftoverCleaned = false;
    let verifierDetachedHead = false;

    const provider = createRoutedProvider("fake", [{ id: "m1" }], async (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        step++;
        if (step === 1) {
          return [
            callTool("init", "ensemble_init", { title: "Worktree Isolation" }),
            // 共用主工作区成员
            callTool("add-shared", "ensemble_add_member", {
              name: "shared-dev",
              charter: { owns: "shared-feature.txt", handsOff: "iso.txt", doneWhen: "written" },
              isolated: false,
            }),
            // 独立工作树成员 1（将并回）
            callTool("add-iso1", "ensemble_add_member", {
              name: "iso-merged",
              charter: { owns: "iso1.txt", handsOff: "iso2.txt", doneWhen: "written" },
              isolated: true,
            }),
            // 独立工作树成员 2（保留未并回以验证结束保留与移除拒绝）
            callTool("add-iso2", "ensemble_add_member", {
              name: "iso-unmerged",
              charter: { owns: "iso2.txt", handsOff: "iso1.txt", doneWhen: "written" },
              isolated: true,
            }),
            // 独立工作树验证成员
            callTool("add-ver", "ensemble_add_member", {
              name: "verifier",
              charter: { owns: "verification", handsOff: "all source edits", doneWhen: "reviewed" },
              isolated: true,
            }),
            callTool("dispatch", "ensemble_post", {
              text: "@shared-dev @iso-merged @iso-unmerged implement your files",
            }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }

      if (role === "member:shared-dev") {
        if (!req.messages.some((m) => m.role === "tool")) {
          return [
            callTool("w-sh", "write", { path: "shared-feature.txt", content: "shared-ok\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("shared done");
      }

      if (role === "member:iso-merged") {
        const wrote = req.messages.some(
          (m) =>
            m.role === "tool" && typeof m.content === "string" && !m.content.includes("Posted #"),
        );
        if (!wrote) {
          return [
            callTool("w-i1", "write", { path: "iso1.txt", content: "isolated-content-v1\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const posted = req.messages.some(
          (m) =>
            m.role === "tool" && typeof m.content === "string" && m.content.includes("Posted #"),
        );
        if (!posted) {
          return [
            callTool("p-ver", "ensemble_post", { text: "@verifier Please review iso1.txt" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("iso1 done");
      }

      if (role === "member:iso-unmerged") {
        if (!req.messages.some((m) => m.role === "tool")) {
          return [
            callTool("w-i2", "write", { path: "iso2.txt", content: "unmerged-v1\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("iso2 done");
      }

      if (role === "member:verifier") {
        // 检查验证成员工作树：应当自动分离头指针检出了 iso-merged 的提交，且预埋残留被清掉
        const envText = req.system.map((s) => s.text).join("\n");
        const wtMatch = /isolated git worktree at `([^`]+)`/.exec(envText);
        if (wtMatch?.[1]) {
          const verWt = wtMatch[1];
          verifierSawImpl1Code =
            existsSync(path.join(verWt, "iso1.txt")) &&
            readFileSync(path.join(verWt, "iso1.txt"), "utf8") === "isolated-content-v1\n";
          verifierLeftoverCleaned = !existsSync(path.join(verWt, "stale-build.tmp"));
          const symRef = await worktreeGit(verWt, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
          verifierDetachedHead = symRef.trim() === "";
        }
        return stopText("PASS");
      }

      return stopText("ok");
    });

    const wtSessionsDir = makeTempDir("nocturne-wt-sessions-");
    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: wtSessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    // 先单独验证 worktree.ts 的 resetWorktreeToCommit：在 verifier 被唤醒前，我们在它建立后也能测残留清理
    await session.submit({ text: "run worktrees", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    // 1. 共用主工作区的成员直接改在主工作区
    expect(readFileSync(path.join(ws, "shared-feature.txt"), "utf8")).toBe("shared-ok\n");
    // 2. 独立工作树成员的改动尚未并回主工作区
    expect(existsSync(path.join(ws, "iso1.txt"))).toBe(false);
    expect(existsSync(path.join(ws, "iso2.txt"))).toBe(false);

    // 3. 验证成员自动分离头指针检出了 iso-merged 的最新提交
    expect(verifierSawImpl1Code).toBe(true);
    expect(verifierDetachedHead).toBe(true);
    expect(verifierLeftoverCleaned).toBe(true);

    // 再显式在 verifier 工作树中制造未跟踪与已跟踪脏残留，调用 resetWorktreeToCommit 切到 iso-unmerged 提交，验证残留被彻底清掉
    const view = replaySessionView(session.durableEvents());
    const verMember = must(must(view.ensemble).members.find((m) => m.name === "verifier"));
    const iso2Member = must(must(view.ensemble).members.find((m) => m.name === "iso-unmerged"));
    const verWtPath = must(verMember.worktree).path;
    const iso2Wt = must(iso2Member.worktree);
    writeFileSync(path.join(verWtPath, "stale-artifact.log"), "dirty", "utf8");
    writeFileSync(path.join(verWtPath, "README.md"), "corrupted", "utf8");
    const iso2Head = (await worktreeGit(iso2Wt.path, ["rev-parse", "HEAD"])).trim();
    expect(iso2Head).not.toBe(iso2Wt.base); // 每轮结束已自动提交！
    const resetSha = await resetWorktreeToCommit(verWtPath, iso2Head);
    expect(resetSha).toBe(iso2Head);
    expect(existsSync(path.join(verWtPath, "stale-artifact.log"))).toBe(false);
    expect(readFileSync(path.join(verWtPath, "README.md"), "utf8")).toBe("# Test Repo\n");
    expect(readFileSync(path.join(verWtPath, "iso2.txt"), "utf8")).toBe("unmerged-v1\n");

    // 4. 有未并回提交的独立工作树成员拒绝移除！
    await expect(session.removeEnsembleMember({ name: "iso-merged" })).rejects.toMatchObject({
      code: "invalid_command",
    });

    // 5. 让指挥调用 apply_subagent_changes 并回 iso-merged，然后即可成功移除 iso-merged（也可留到 endEnsemble 清理）
    // 这里我们让指挥跑一轮并回 iso-merged，同时验证未并回的 iso-unmerged 在 endEnsemble 时保留工作树与分支！
    let mergeStepDone = false;
    const mergeProvider = createRoutedProvider("fake", [{ id: "m1" }], () => {
      if (!mergeStepDone) {
        mergeStepDone = true;
        return [
          callTool("app1", "apply_subagent_changes", { id: "iso-merged", mode: "clean" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("applied iso-merged");
    });
    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: wtSessionsDir,
      providers: [mergeProvider],
      interactive: true,
      subagent: { background: true },
    });
    await session.close();
    const session2 = await rt2.resumeSession(session.id);
    openRuntimes.push({ sessions: [session2] });

    await session2.submit({ text: "apply iso-merged now" });
    expect(readFileSync(path.join(ws, "iso1.txt"), "utf8")).toBe("isolated-content-v1\n");

    // 并回后，iso-merged 不再有未并回提交；结束 Ensemble 时清理 iso-merged 和 verifier，保留未并回的 iso-unmerged！
    const endResult = await session2.endEnsemble();
    expect(endResult.unmerged.map((u) => u.name)).toEqual(["iso-unmerged"]);
    expect(existsSync(iso2Wt.path)).toBe(true);
    const remainingRecords = await listWorktreeRecords(wtSessionsDir, session.id);
    expect(remainingRecords.map((r) => r.childSessionId)).toEqual([iso2Member.childSessionId]);
  }, 30_000);

  it("并发控制：等待中的成员不占 maxConcurrent 槽；槽满时唤醒排队等待，槽释放后依次执行", async () => {
    const ws = makeTempDir();
    let activeWorkers = 0;
    let peakWorkers = 0;
    const finishedWorkers: string[] = [];
    let releaseBatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    let coordInited = false;
    const provider = createRoutedProvider("fake", [{ id: "m1" }], async (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        if (!coordInited) {
          coordInited = true;
          return [
            callTool("i", "ensemble_init", { title: "Concurrency Queue" }),
            // 添加 4 名等待中的成员（maxConcurrent 设为 2：等待成员不占槽，所以 4 名都能顺利创建）
            callTool("m1", "ensemble_add_member", { name: "w-1", charter: VALID_CHARTER }),
            callTool("m2", "ensemble_add_member", { name: "w-2", charter: VALID_CHARTER }),
            callTool("m3", "ensemble_add_member", { name: "w-3", charter: VALID_CHARTER }),
            callTool("m4", "ensemble_add_member", { name: "w-4", charter: VALID_CHARTER }),
            // 一次性用 @w 同时唤醒全部 4 人！槽上限为 2，另外 2 人必须排队等待而不报错
            callTool("go", "ensemble_post", { text: "@w run in parallel up to slot limit" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord ok");
      }
      if (role.startsWith("member:w-")) {
        activeWorkers++;
        peakWorkers = Math.max(peakWorkers, activeWorkers);
        await gate;
        // eslint-disable-next-line no-restricted-syntax -- 测试替身故意延时，使并发成员保持活跃以测 maxConcurrent 峰值
        await new Promise((r) => setTimeout(r, 25));
        activeWorkers--;
        finishedWorkers.push(role);
        return stopText(`${role} finished`);
      }
      return stopText("ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true, maxConcurrent: 2 },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    await session.submit({ text: "test concurrency", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        expect(activeWorkers).toBe(2);
      },
      { timeout: 10_000 },
    );
    // 严格遵守 maxConcurrent = 2：另外 2 名在队列中等待，未超过上限
    expect(peakWorkers).toBe(2);

    releaseBatch();
    await vi.waitFor(
      () => {
        expect(finishedWorkers).toHaveLength(4);
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(peakWorkers).toBeLessThanOrEqual(2);
    expect(finishedWorkers.sort()).toEqual([
      "member:w-1",
      "member:w-2",
      "member:w-3",
      "member:w-4",
    ]);

    await session.endEnsemble();
  }, 30_000);

  it("状态机：一轮以错误结束进入 paused 且不自动重试；新帖、换模型或用户直接发消息恢复；移除后不能再唤醒", async () => {
    const ws = makeTempDir();
    let failMode = true;
    let memberAttempts = 0;
    let coordPhase = 0;

    const provider = createRoutedProvider("fake", [{ id: "m1" }, { id: "m2" }], (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        coordPhase++;
        if (coordPhase === 1) {
          return [
            callTool("i", "ensemble_init", { title: "Pause & Resume" }),
            callTool("a1", "ensemble_add_member", { name: "fragile", charter: VALID_CHARTER }),
            callTool("a2", "ensemble_add_member", { name: "temp", charter: VALID_CHARTER }),
            callTool("p1", "ensemble_post", { text: "@fragile try work" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const askedSwitch = JSON.stringify(req.messages).includes("switch fragile model");
        const alreadySwitched = req.messages.some(
          (m) => m.role === "tool" && m.content.includes("Switched @fragile"),
        );
        if (askedSwitch && !alreadySwitched) {
          // 测试通过 ensemble_change_model 恢复 paused 成员
          return [
            callTool("sw", "ensemble_change_model", { name: "fragile", model: "fake/m2" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord ack");
      }
      if (role === "member:fragile") {
        memberAttempts++;
        if (failMode) {
          return [
            {
              type: "throw",
              error: new ProviderError({
                kind: "rate_limit",
                message: "Quota exhausted",
                retryable: false,
              }),
            },
          ];
        }
        return stopText(`recovered-${memberAttempts}`);
      }
      if (role === "member:temp") {
        memberAttempts += 100;
        return stopText("should never run after removal");
      }
      return stopText("ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
      turn: { retryLimit: 0 },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });
    const getView = trackView(session);

    await session.submit({ text: "start", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        const m = getView().ensemble?.members.find((x) => x.name === "fragile");
        expect(m?.status).toBe("paused");
      },
      { timeout: 10_000 },
    );
    // 等待片刻确认不自动重试（安静提醒会唤醒指挥一次，但绝不会重试 fragile）
    await vi.waitFor(() => expect(session.isIdle()).toBe(true), { timeout: 10_000 });
    expect(memberAttempts).toBe(1);
    expect(getView().ensemble?.members.find((x) => x.name === "fragile")?.status).toBe("paused");

    // 方式 A：新帖 @fragile 恢复运行（此处让它再失败一次回到 paused，以接着测换模型恢复）
    await session.postToEnsemble({ text: "@fragile retry via new post" });
    await vi.waitFor(() => expect(memberAttempts).toBe(2), { timeout: 10_000 });
    await vi.waitFor(
      () => {
        expect(getView().ensemble?.members.find((x) => x.name === "fragile")?.status).toBe(
          "paused",
        );
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    // 方式 B：指挥调用 ensemble_change_model 换模型后自动从 paused 恢复！
    failMode = false;
    await session.submit({ text: "switch fragile model" });
    await vi.waitFor(
      () => {
        expect(memberAttempts).toBe(3);
        expect(getView().ensemble?.members.find((x) => x.name === "fragile")?.status).toBe(
          "waiting",
        );
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    // 方式 C：再让 fragile 进入 paused，验证用户直接向成员会话发消息（submit）也能恢复
    failMode = true;
    await session.postToEnsemble({ text: "@fragile fail once more" });
    await vi.waitFor(
      () => {
        expect(getView().ensemble?.members.find((x) => x.name === "fragile")?.status).toBe(
          "paused",
        );
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    failMode = false;
    const fragileId = must(
      must(getView().ensemble).members.find((x) => x.name === "fragile"),
    ).childSessionId;
    const fragileSession = await rt.resumeSession(fragileId);
    await fragileSession.submit({ text: "resume via direct user message" });
    await vi.waitFor(
      () => {
        expect(getView().ensemble?.members.find((x) => x.name === "fragile")?.status).toBe(
          "waiting",
        );
      },
      { timeout: 10_000 },
    );

    // 移除成员 temp：移除后状态为 removed，不能再被 @ 唤醒，也不能再直接 submit
    const tempId = must(
      must(getView().ensemble).members.find((x) => x.name === "temp"),
    ).childSessionId;
    await session.removeEnsembleMember("temp");
    expect(getView().ensemble?.members.find((x) => x.name === "temp")?.status).toBe("removed");

    await expect(session.postToEnsemble({ text: "@temp wake up" })).rejects.toMatchObject({
      code: "invalid_command",
    });
    const closedTempSession = await rt.resumeSession(tempId);
    openRuntimes[0]?.sessions.push(closedTempSession);
    await expect(closedTempSession.submit({ text: "hello" })).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(memberAttempts).toBeLessThan(100);

    await session.endEnsemble();
  }, 30_000);

  it("权限确认冒泡：default 预设下成员写文件等用户确认而不直接拒绝，派生视图列出等待确认的成员，批准后继续完成", async () => {
    const ws = makeTempDir();
    let coordStarted = false;
    const provider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        if (!coordStarted) {
          coordStarted = true;
          return [
            callTool("i", "ensemble_init", { title: "Permission Bubble" }),
            callTool("a", "ensemble_add_member", { name: "writer", charter: VALID_CHARTER }),
            callTool("p", "ensemble_post", { text: "@writer create approved.txt" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord done");
      }
      if (role === "member:writer") {
        if (!req.messages.some((m) => m.role === "tool")) {
          return [
            callTool("w1", "write", { path: "approved.txt", content: "confirmed-by-user\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("write succeeded");
      }
      return stopText("ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    // 使用 default 预设（写文件需要用户确认！）
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "default" });
    openRuntimes.push({ sessions: [session] });
    const getView = trackView(session);

    await session.submit({ text: "write file with approval", workMode: "ensemble" });

    // 等待成员触发权限确认：不应被非交互直接拒绝，指挥派生视图应列出 writer 正在等确认！
    await vi.waitFor(
      () => {
        expect(getView().ensemble?.awaitingPermissionMembers).toEqual(["writer"]);
      },
      { timeout: 10_000 },
    );
    const writerView = must(must(getView().ensemble).members.find((m) => m.name === "writer"));
    expect(writerView.status).toBe("working");
    expect(writerView.pendingPermissions).toHaveLength(1);
    const reqId = must(writerView.pendingPermissions[0]).requestId;

    // 新连接的订阅者也能立即拿到等待确认的快照
    const lateView = trackView(session)();
    expect(lateView.ensemble?.awaitingPermissionMembers).toEqual(["writer"]);

    // 用户在成员自己的会话上调用 respondPermission 批准
    const writerSession = await rt.resumeSession(writerView.childSessionId);
    await writerSession.respondPermission(reqId, { decision: "allow" });

    await vi.waitFor(
      () => {
        expect(getView().ensemble?.awaitingPermissionMembers).toEqual([]);
        expect(getView().ensemble?.members.find((m) => m.name === "writer")?.status).toBe(
          "waiting",
        );
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(readFileSync(path.join(ws, "approved.txt"), "utf8")).toBe("confirmed-by-user\n");

    await session.endEnsemble();
  }, 30_000);

  it("安静提醒：只送指挥模型不写 ensemble.posted、不占编号、SessionView 与 ensemble_read 均不可见，有新帖后重计", async () => {
    const ws = makeTempDir();
    let coordTurn = 0;
    const maestroRequests: ModelRequest[] = [];
    const provider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        maestroRequests.push(req);
        const hasInit = req.messages.some((m) => m.role === "tool" && m.name === "ensemble_init");
        if (!hasInit) {
          return [
            callTool("i", "ensemble_init", { title: "Quiet Monitor" }),
            callTool("a", "ensemble_add_member", { name: "silent-worker", charter: VALID_CHARTER }),
            callTool("p", "ensemble_post", { text: "@silent-worker do work" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const isQuietTurn = req.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("All ensemble members"),
        );
        const hasReadInQuietTurn = req.messages.some(
          (m) => m.role === "tool" && m.name === "ensemble_read",
        );
        if (isQuietTurn && !hasReadInQuietTurn) {
          // 收到安静提醒后调用 ensemble_read 核对留言板没有 Runtime 帖子，再直接文字结束本轮
          return [callTool("r", "ensemble_read", {}), { type: "finish", reason: "tool_calls" }];
        }
        coordTurn++;
        return stopText(`coord-turn-${coordTurn}`);
      }
      // silent-worker 完成工作但忘记发帖 @maestro
      return stopText("finished silently without posting");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    await session.submit({ text: "start quiet test", workMode: "ensemble" });

    const completedCoordTurns = () =>
      session.durableEvents().filter((e) => e.type === "turn.completed").length;

    // silent-worker 静默结束后，Runtime 触发指挥第 2 个 Turn
    await vi.waitFor(
      () => {
        expect(completedCoordTurns()).toBe(2);
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );

    const events1 = session.durableEvents();
    const quietMsgs1 = events1.filter(
      (e): e is Extract<DurableEvent, { type: "message.user" }> =>
        e.type === "message.user" && e.payload.ensembleQuietReminder === true,
    );
    expect(quietMsgs1).toHaveLength(1);
    expect(quietMsgs1[0]?.payload.ensemble).toBeUndefined();
    const reminderText1 = quietMsgs1[0]?.payload.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(reminderText1).toContain("All ensemble members are waiting or paused");
    expect(reminderText1).not.toContain("@maestro");
    expect(reminderText1).not.toContain("<ensemble-post");

    // 指挥模型请求确实收到了这条提醒
    const turn2ModelMsg = maestroRequests
      .find((r) =>
        r.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("All ensemble members"),
        ),
      )
      ?.messages.find(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("All ensemble members"),
      );
    expect(turn2ModelMsg).toBeDefined();

    // 留言板没有 ensemble.posted(fromKind: "runtime")，帖子编号保持连续（#1 任务书，#2 @silent-worker）
    const view1 = replaySessionView(events1);
    expect(must(view1.ensemble).posts.map((p) => p.number)).toEqual([1, 2]);
    expect(must(view1.ensemble).posts.some((p) => p.fromKind === "runtime")).toBe(false);
    // SessionView 的对话条目里没有安静提醒，但指挥的回复照常出现
    expect(
      view1.entries.some(
        (e) => e.kind === "user" && JSON.stringify(e.content).includes("All ensemble members"),
      ),
    ).toBe(false);
    expect(view1.entries.some((e) => e.kind === "assistant" && e.text === "coord-turn-2")).toBe(
      true,
    );
    // rewindTargets 也不列安静提醒
    expect(
      (await session.rewindTargets()).some((t) => t.text.includes("All ensemble members")),
    ).toBe(false);

    // ensemble_read 查不到安静提醒
    const readToolEv = events1.find(
      (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
        e.type === "tool.completed" && e.payload.name === "ensemble_read",
    );
    expect(readToolEv).toBeDefined();
    expect(readToolEv?.payload.modelContent).not.toContain("All ensemble members");
    expect(
      (readToolEv?.payload.output as { posts?: { fromKind: string }[] } | undefined)?.posts?.some(
        (p) => p.fromKind === "runtime",
      ),
    ).toBe(false);

    // 指挥第 2 轮没有发新帖就结束了：再等 80ms 确认绝不会重复发第 2 条安静提醒！
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：80ms 内不再补发第 2 条安静提醒
    await new Promise((r) => setTimeout(r, 80));
    expect(completedCoordTurns()).toBe(2);
    expect(
      session
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
    ).toHaveLength(1);

    // 用户发一条新帖 @silent-worker：编号连续为 #3，并重置安静期计数！
    const posted = await session.postToEnsemble({ text: "@silent-worker one more check" });
    expect(posted.number).toBe(3);
    await vi.waitFor(
      () => {
        expect(completedCoordTurns()).toBe(3);
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(
      session
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
    ).toHaveLength(2);
    expect(
      must(replaySessionView(session.durableEvents()).ensemble).posts.map((p) => p.number),
    ).toEqual([1, 2, 3]);

    await session.endEnsemble();
  }, 30_000);

  it("安静提醒持久化：重启恢复后不重复发；回退到提醒之前再继续仍触发；旧日志 Runtime 帖仍显示", async () => {
    const ws = makeTempDir();
    const sessionsDir = path.join(ws, ".sessions");
    let phase = 1;
    const provider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        const hasInit = req.messages.some((m) => m.role === "tool" && m.name === "ensemble_init");
        if (phase === 1 && !hasInit) {
          return [
            callTool("i", "ensemble_init", { title: "Quiet Persist" }),
            callTool("a", "ensemble_add_member", { name: "worker", charter: VALID_CHARTER }),
            callTool("p", "ensemble_post", { text: "@worker first task" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText(`coord-phase-${phase}`);
      }
      return stopText("worker silent done");
    });

    const rt1 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session1 = await rt1.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session1] });

    await session1.submit({ text: "start", workMode: "ensemble" });
    // 等 worker 跑完、锚点消息提交前先等 Turn 1 + 安静提醒 Turn 2? 先插一条锚点消息在提醒前！
    await vi.waitFor(
      () =>
        expect(
          session1.durableEvents().filter((e) => e.type === "turn.completed").length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 10_000 },
    );

    const quietCount1 = () =>
      session1
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true)
        .length;
    expect(quietCount1()).toBe(1);

    // 1. 重启恢复：打开后不自动发，之后指挥再跑普通轮（未发新帖）也不重复发安静提醒
    const sid = session1.id;
    await session1.close();

    phase = 2;
    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session2 = await rt2.resumeSession(sid);
    openRuntimes[0]?.sessions.push(session2);
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：恢复会话后 60ms 内不自动补发安静提醒
    await new Promise((r) => setTimeout(r, 60));
    expect(
      session2
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
    ).toHaveLength(1);

    // 指挥跑一轮普通对话（没有发新帖）并归于空闲，仍然不重复发安静提醒
    await session2.submit({ text: "just check in" });
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：普通轮结束后 80ms 内不重复补发安静提醒
    await new Promise((r) => setTimeout(r, 80));
    expect(
      session2
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
    ).toHaveLength(1);

    // 2. 回退到安静提醒之前再继续：新帖发出后触发第 2 次提醒，记录 anchor 再回退到 anchor（在第 2 次提醒之前）
    await session2.postToEnsemble({ text: "@worker second task" });
    await vi.waitFor(
      () => {
        expect(
          session2
            .durableEvents()
            .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
        ).toHaveLength(2);
        expect(session2.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    // 先发一条锚点用户消息（在已有 #4 新帖后的安静期内？改为先发新帖、同时提交一条普通消息再回退）：
    await session2.postToEnsemble({ text: "@worker third task" });
    await vi.waitFor(
      () => {
        expect(
          session2
            .durableEvents()
            .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
        ).toHaveLength(3);
        expect(session2.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    await session2.close();

    // 构造一个带「提醒前用户消息 anchor → 安静提醒」的会话来测回退到提醒前再继续
    let releaseWorkerGate: (() => void) | undefined;
    const gateProvider = createRoutedProvider("fake", [{ id: "m1" }], async (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        const hasInit = req.messages.some((m) => m.role === "tool" && m.name === "ensemble_init");
        if (!hasInit) {
          return [
            callTool("i", "ensemble_init", { title: "Quiet Rewind" }),
            callTool("a", "ensemble_add_member", { name: "worker", charter: VALID_CHARTER }),
            callTool("p", "ensemble_post", { text: "@worker first task" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord ok");
      }
      if (JSON.stringify(req.messages).includes("task before anchor")) {
        await new Promise<void>((resolve) => {
          releaseWorkerGate = resolve;
        });
      }
      return stopText("worker silent done");
    });
    const rtRewind = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: makeTempDir(),
      providers: [gateProvider],
      interactive: true,
      subagent: { background: true },
    });
    const rwSession = await rtRewind.createSession({
      model: "fake/m1",
      permissionPreset: "bypass",
    });
    openRuntimes[0]?.sessions.push(rwSession);
    await rwSession.submit({ text: "init only", workMode: "ensemble" });
    await vi.waitFor(
      () =>
        expect(
          rwSession
            .durableEvents()
            .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
        ).toHaveLength(1),
      { timeout: 10_000 },
    );
    // 发新帖触发新周期，worker 在 gate 上等待，确保 anchor 在第 2 次提醒之前落盘
    await rwSession.postToEnsemble({ text: "@worker task before anchor" });
    await vi.waitFor(() => expect(releaseWorkerGate).toBeDefined(), { timeout: 10_000 });
    await rwSession.submit({ text: "anchor before second reminder" });
    releaseWorkerGate?.();
    await vi.waitFor(
      () => {
        expect(
          rwSession
            .durableEvents()
            .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
        ).toHaveLength(2);
        expect(rwSession.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    const anchorEv = must(
      rwSession
        .durableEvents()
        .find(
          (e) =>
            e.type === "message.user" &&
            JSON.stringify(e.payload.content).includes("anchor before second reminder"),
        ),
    );
    await rwSession.rewind(anchorEv.seq, "conversation");
    expect(replaySessionView(rwSession.durableEvents()).ensemble?.status).toBe("active");
    // 回退后上下文里不再包含被撤回的那条提醒
    const ctxTextAfterRewind = JSON.stringify(rwSession.describeContext().request.messages);
    expect(ctxTextAfterRewind).not.toContain("anchor before second reminder");

    // 继续一轮普通对话：有效历史回到了提醒之前，安静提醒应再次触发
    await rwSession.submit({ text: "continue after rewind" });
    await vi.waitFor(
      () => {
        expect(rwSession.isIdle()).toBe(true);
        const lastReminderInCtx = rwSession
          .describeContext()
          .request.messages.filter(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("All ensemble members"),
          );
        expect(lastReminderInCtx.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000 },
    );
    await rwSession.endEnsemble();

    // 3. 旧日志兼容：日志里已有的 fromKind: "runtime" 提醒帖仍出现在留言板，且恢复后不重复发
    const legacyDir = makeTempDir();
    const legacyId = "20261117-legacy-quiet";
    const legacyLog = [
      {
        type: "session.created",
        sessionId: legacyId,
        seq: 1,
        time: "2026-11-17T00:00:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "m1" },
          permissionPreset: "bypass",
        },
      },
      {
        type: "turn.started",
        sessionId: legacyId,
        seq: 2,
        time: "2026-11-17T00:00:01.000Z",
        turnId: "t1",
        payload: { turnIndex: 1 },
      },
      {
        type: "message.user",
        sessionId: legacyId,
        seq: 3,
        time: "2026-11-17T00:00:01.000Z",
        turnId: "t1",
        payload: { messageId: "u1", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "ensemble.created",
        sessionId: legacyId,
        seq: 4,
        time: "2026-11-17T00:00:02.000Z",
        turnId: "t1",
        payload: { title: "Legacy Quiet" },
      },
      {
        type: "ensemble.posted",
        sessionId: legacyId,
        seq: 5,
        time: "2026-11-17T00:00:03.000Z",
        turnId: "t1",
        payload: {
          number: 1,
          from: "maestro",
          fromKind: "maestro",
          text: "initial",
          mentions: [],
          recipients: [],
        },
      },
      {
        type: "turn.completed",
        sessionId: legacyId,
        seq: 6,
        time: "2026-11-17T00:00:04.000Z",
        turnId: "t1",
        payload: { reason: "done", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      },
      {
        type: "ensemble.posted",
        sessionId: legacyId,
        seq: 7,
        time: "2026-11-17T00:00:05.000Z",
        payload: {
          number: 2,
          from: "Runtime",
          fromKind: "runtime",
          text: "@maestro Legacy quiet reminder",
          mentions: ["maestro"],
          recipients: ["maestro"],
        },
      },
      {
        type: "turn.started",
        sessionId: legacyId,
        seq: 8,
        time: "2026-11-17T00:00:06.000Z",
        turnId: "t2",
        payload: { turnIndex: 2 },
      },
      {
        type: "message.user",
        sessionId: legacyId,
        seq: 9,
        time: "2026-11-17T00:00:06.000Z",
        turnId: "t2",
        payload: {
          messageId: "u2",
          ensemble: { postNumber: 2, from: "Runtime", fromKind: "runtime" },
          content: [
            {
              type: "text",
              text: '<ensemble-post n="2" from="Runtime">\n@maestro Legacy quiet reminder\n</ensemble-post>',
            },
          ],
        },
      },
      {
        type: "turn.completed",
        sessionId: legacyId,
        seq: 10,
        time: "2026-11-17T00:00:07.000Z",
        turnId: "t2",
        payload: { reason: "done", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      },
    ];
    writeFileSync(
      path.join(legacyDir, `${legacyId}.jsonl`),
      legacyLog.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const rtLegacy = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: legacyDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const legacySession = await rtLegacy.resumeSession(legacyId);
    openRuntimes[0]?.sessions.push(legacySession);
    const legacyView = replaySessionView(legacySession.durableEvents());
    expect(legacyView.ensemble?.posts.some((p) => p.fromKind === "runtime" && p.number === 2)).toBe(
      true,
    );
    expect(
      legacyView.entries.some((e) => e.kind === "user" && e.ensemble?.fromKind === "runtime"),
    ).toBe(true);
    // 恢复后跑普通轮（未发新帖），不重复发安静提醒
    await legacySession.submit({ text: "after legacy resume" });
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：旧日志恢复后普通轮结束 80ms 内不补发安静提醒
    await new Promise((r) => setTimeout(r, 80));
    expect(
      legacySession
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.ensembleQuietReminder === true),
    ).toHaveLength(0);
  }, 30_000);

  it("持久化：重启补送未送达提及且不自动唤醒；回退到建立之前结束 Ensemble；分叉新会话不继承 Ensemble；日志格式兼容", async () => {
    const ws = makeTempDir();
    const sessionsDir = path.join(ws, ".sessions");

    const provider1 = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const role = requestRole(req);
      if (role === "maestro") {
        if (!req.messages.some((m) => m.role === "tool")) {
          return [
            callTool("i", "ensemble_init", { title: "Persistence Test" }),
            callTool("a", "ensemble_add_member", { name: "worker", charter: VALID_CHARTER }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("setup ready");
      }
      return stopText("worker ran");
    });

    const rt1 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider1],
      interactive: true,
      subagent: { background: true },
    });
    const s1 = await rt1.createSession({ model: "fake/m1", permissionPreset: "bypass" });

    // 先发一条建立 Ensemble 之前的普通用户消息（供回退目标测试）
    const preEnsembleTurnProvider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const isEnsembleTurn = JSON.stringify(req.messages).includes("launch ensemble");
      if (!isEnsembleTurn) return stopText("hello before ensemble");
      if (requestRole(req) === "maestro" && !req.messages.some((m) => m.role === "tool")) {
        return [
          callTool("i", "ensemble_init", { title: "Persistence Test" }),
          callTool("a", "ensemble_add_member", { name: "worker", charter: VALID_CHARTER }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("setup ready");
    });
    await s1.close();

    const rtSetup = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [preEnsembleTurnProvider],
      interactive: true,
      subagent: { background: true },
    });
    const coord = await rtSetup.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    await coord.submit({ text: "hello before ensemble" });
    await coord.submit({ text: "launch ensemble", workMode: "ensemble" });

    const ensembleMsg = must(
      coord
        .durableEvents()
        .find((e) => e.type === "message.user" && e.payload.workMode?.name === "ensemble"),
    );
    const workerInfo = must(must(replaySessionView(coord.durableEvents()).ensemble).members[0]);

    // 1. 分叉测试：从当前活动 Ensemble 会话分叉，新会话不继承 Ensemble！
    const forkedId = await rtSetup.forkSession(coord.id);
    const forked = await rtSetup.resumeSession(forkedId);
    expect(replaySessionView(forked.durableEvents()).ensemble).toBeUndefined();
    expect(forked.describeContext().request.tools.map((t) => t.name)).toContain("write");
    expect(forked.describeContext().request.tools.map((t) => t.name)).not.toContain(
      "ensemble_post",
    );
    await forked.close();

    // 模拟崩溃前指挥日志已写入一条提及 @worker 的帖子，但 worker 日志里尚未写入对应 message.user
    await coord.close();
    const coordLogPath = path.join(sessionsDir, `${coord.id}.jsonl`);
    const lines = readFileSync(coordLogPath, "utf8").trim().split("\n");
    const lastEv = decodeDurableEvent(must(lines.at(-1)));
    // 验证 LOG_FORMAT_VERSION 未提升（保持 1）
    const firstEv = decodeDurableEvent(must(lines[0]));
    if (firstEv.type === "session.created") {
      expect(firstEv.payload.formatVersion).toBe(LOG_FORMAT_VERSION);
      expect(LOG_FORMAT_VERSION).toBe(1);
    }
    const missedPostEvent: DurableEvent = {
      seq: lastEv.seq + 1,
      time: new Date().toISOString(),
      sessionId: coord.id,
      type: "ensemble.posted",
      payload: {
        number: 2,
        from: "maestro",
        fromKind: "maestro",
        text: "@worker Unsent crash recovery task",
        mentions: ["worker"],
        recipients: ["worker"],
      },
    };
    writeFileSync(
      coordLogPath,
      `${lines.join("\n")}\n${encodeDurableEvent(missedPostEvent)}\n`,
      "utf8",
    );

    // 2. 重启恢复：Ensemble 保留，成员全部为 waiting，缺失提及补为暂停待发输入，且绝不自动唤醒！
    let wakeCalls = 0;
    const rtRestart = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [
        createRoutedProvider("fake", [{ id: "m1" }], () => {
          wakeCalls++;
          return stopText("woken");
        }),
      ],
      interactive: true,
      subagent: { background: true },
    });
    const coordResumed = await rtRestart.resumeSession(coord.id);
    openRuntimes.push({ sessions: [coordResumed] });

    const resumedView = replaySessionView(coordResumed.durableEvents());
    expect(resumedView.ensemble?.status).toBe("active");
    expect(resumedView.ensemble?.members[0]?.status).toBe("waiting");
    // 不自动唤醒任何模型调用
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：重启恢复后 50ms 内不自动唤醒成员模型调用
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeCalls).toBe(0);

    // 打开 worker 子会话查看 pendingInputs：缺失的帖子已补为 paused 待发输入！
    const workerResumed = await rtRestart.resumeSession(workerInfo.childSessionId);
    const pending = workerResumed.pendingInputs();
    expect(pending.paused).toBe(true);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.mode).toBe("ensemble");
    expect(pending.items[0]?.text).toContain("Unsent crash recovery task");
    expect(wakeCalls).toBe(0);

    // 3. 回退到建立之前（rewind 到发 /ensemble 的那条用户消息）：结束 Ensemble、停止全部成员、恢复编辑工具！
    await coordResumed.rewind(ensembleMsg.seq, "conversation");
    const afterRewindView = replaySessionView(coordResumed.durableEvents());
    expect(afterRewindView.ensemble?.status).toBe("ended");
    expect(afterRewindView.ensemble?.endedReason).toBe("rewound");
    expect(coordResumed.describeContext().request.tools.map((t) => t.name)).toContain("write");
  });

  it("ensemble_checkout 保护与重置忽略规则：有未并回提交的实现成员调用 ensemble_checkout 被拒且工作树与分支不变，验证成员重置保留被忽略文件", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    writeFileSync(path.join(ws, ".gitignore"), ".env.local\nnode_modules/\n", "utf8");
    await worktreeGit(ws, ["add", ".gitignore"]);
    await worktreeGit(ws, ["commit", "-m", "chore: gitignore"]);

    const wtSessionsDir = makeTempDir("nocturne-checkout-guard-");
    let coordDone = false;
    const provider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const role = requestRole(req);
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const countTool = (name: string) =>
        toolMsgs.filter((m) => "name" in m && m.name === name).length;

      if (role === "maestro") {
        if (!coordDone) {
          coordDone = true;
          return [
            callTool("i", "ensemble_init", { title: "Checkout Guard" }),
            callTool("a1", "ensemble_add_member", {
              name: "author-a",
              charter: VALID_CHARTER,
              isolated: true,
            }),
            callTool("a2", "ensemble_add_member", {
              name: "author-b",
              charter: VALID_CHARTER,
              isolated: true,
            }),
            callTool("a3", "ensemble_add_member", {
              name: "verifier",
              charter: VALID_CHARTER,
              isolated: true,
            }),
            callTool("p1", "ensemble_post", { text: "@author-a @author-b implement your files" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }

      if (role === "member:author-b") {
        if (countTool("write") === 0) {
          return [
            callTool("wb", "write", { path: "b.txt", content: "author-b-code\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("b done");
      }

      if (role === "member:author-a") {
        if (countTool("write") === 0) {
          return [
            callTool("wa", "write", { path: "a.txt", content: "author-a-unmerged\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (countTool("ensemble_checkout") === 0) {
          // author-a 自身分支已有未并回改动，试图调用 ensemble_checkout 切去 author-b 必须被拒！
          return [
            callTool("chk-bad", "ensemble_checkout", { member: "author-b" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("a saw rejection");
      }

      if (role === "member:verifier") {
        const msgText = JSON.stringify(req.messages);
        const expectedCheckouts = msgText.includes("second review") ? 2 : 1;
        if (countTool("ensemble_checkout") < expectedCheckouts) {
          return [
            callTool("chk-ok", "ensemble_checkout", { member: "author-b" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("verifier checked out b");
      }

      return stopText("ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: wtSessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    await session.submit({ text: "test checkout protection", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 15_000 },
    );

    const view = replaySessionView(session.durableEvents());
    const memberA = must(must(view.ensemble).members.find((m) => m.name === "author-a"));
    const memberVer = must(must(view.ensemble).members.find((m) => m.name === "verifier"));
    const wtA = must(memberA.worktree);
    const wtVer = must(memberVer.worktree);

    // 1. 检查 author-a 子会话日志：ensemble_checkout 以 invalid_input 被拒绝
    const sessionA = await rt.resumeSession(memberA.childSessionId);
    const checkoutCompletedA = must(
      sessionA
        .durableEvents()
        .find(
          (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
            e.type === "tool.completed" && e.payload.name === "ensemble_checkout",
        ),
    );
    expect(checkoutCompletedA.payload.status).toBe("error");
    expect(checkoutCompletedA.payload.error?.code).toBe("invalid_input");
    expect(checkoutCompletedA.payload.modelContent).toContain("unapplied changes");

    // 2. author-a 的工作树文件与分支均保持不变（仍在自己的分支上，a.txt 完好且已提交，没有切到 author-b）
    const symRefA = (await worktreeGit(wtA.path, ["symbolic-ref", "-q", "HEAD"])).trim();
    expect(symRefA).toBe(`refs/heads/${wtA.branch}`);
    expect(readFileSync(path.join(wtA.path, "a.txt"), "utf8")).toBe("author-a-unmerged\n");
    expect(existsSync(path.join(wtA.path, "b.txt"))).toBe(false);
    const headA = (await worktreeGit(wtA.path, ["rev-parse", "HEAD"])).trim();
    expect(headA).not.toBe(wtA.base);
    // 移除未并回的 author-a 依然被未并回检查拦截！
    await expect(session.removeEnsembleMember("author-a")).rejects.toMatchObject({
      code: "invalid_command",
    });

    // 3. 先让干净的 verifier 执行第 1 次 ensemble_checkout 进入分离头指针审查态，然后写入被忽略文件 .env.local 与未跟踪非忽略文件 untracked-residue.txt，第 2 次审查重置后验证被忽略文件仍在、非忽略文件被清掉
    const sessionVer = await rt.resumeSession(memberVer.childSessionId);
    await session.postToEnsemble({ text: "@verifier first review author-b" });
    await vi.waitFor(
      () => {
        expect(
          sessionVer
            .durableEvents()
            .filter(
              (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
                e.type === "tool.completed" && e.payload.name === "ensemble_checkout",
            ),
        ).toHaveLength(1);
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 15_000 },
    );

    writeFileSync(path.join(wtVer.path, ".env.local"), "SECRET=keep-me\n", "utf8");
    writeFileSync(path.join(wtVer.path, "untracked-residue.txt"), "remove-me\n", "utf8");
    await session.postToEnsemble({ text: "@verifier second review author-b" });
    await vi.waitFor(
      () => {
        expect(
          sessionVer
            .durableEvents()
            .filter(
              (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
                e.type === "tool.completed" &&
                e.payload.name === "ensemble_checkout" &&
                e.payload.status === "ok",
            ),
        ).toHaveLength(2);
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 15_000 },
    );
    expect(readFileSync(path.join(wtVer.path, ".env.local"), "utf8")).toBe("SECRET=keep-me\n");
    expect(existsSync(path.join(wtVer.path, "untracked-residue.txt"))).toBe(false);
    expect(readFileSync(path.join(wtVer.path, "b.txt"), "utf8")).toBe("author-b-code\n");

    await session.endEnsemble();
  }, 30_000);

  it("工作树清理容错：移除成员或并回清理时删工作树/分支失败发 runtime.warning(worktree_cleanup_failed)，ensemble.member_removed 照样写进日志", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const wtSessionsDir = makeTempDir("nocturne-cleanup-warn-");

    let coordSetup = false;
    const provider = createRoutedProvider("fake", [{ id: "m1" }], (req) => {
      const role = requestRole(req);
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const countTool = (name: string) =>
        toolMsgs.filter((m) => "name" in m && m.name === name).length;

      if (role === "maestro") {
        if (!coordSetup) {
          coordSetup = true;
          return [
            callTool("i", "ensemble_init", { title: "Cleanup Warning" }),
            callTool("a1", "ensemble_add_member", {
              name: "iso-remove",
              charter: VALID_CHARTER,
              isolated: true,
            }),
            callTool("a2", "ensemble_add_member", {
              name: "iso-apply",
              charter: VALID_CHARTER,
              isolated: true,
            }),
            callTool("p1", "ensemble_post", { text: "@iso-apply write file" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (
          JSON.stringify(req.messages).includes("apply post-end") &&
          countTool("apply_subagent_changes") === 0
        ) {
          return [
            callTool("ap", "apply_subagent_changes", { id: "iso-apply", mode: "clean" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord ok");
      }

      if (role === "member:iso-apply") {
        if (countTool("write") === 0) {
          return [
            callTool("w", "write", { path: "applied-after.txt", content: "ok\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("done");
      }

      return stopText("ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: wtSessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openRuntimes.push({ sessions: [session] });

    const warnings: { code: string; message: string }[] = [];
    session.subscribe((ev) => {
      if (ev.type === "runtime.warning") warnings.push(ev.payload);
    });

    await session.submit({ text: "setup members", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        expect(session.isIdle()).toBe(true);
      },
      { timeout: 15_000 },
    );

    const view = replaySessionView(session.durableEvents());
    const isoRemove = must(must(view.ensemble).members.find((m) => m.name === "iso-remove"));
    const isoApply = must(must(view.ensemble).members.find((m) => m.name === "iso-apply"));
    const wtRemove = must(isoRemove.worktree);
    const wtApply = must(isoApply.worktree);

    // 制造 removeWorktree 中 branch -D 失败：让原工作树切到分离头指针（目录仍在），再用辅助工作树占用其分支
    const holderRemove = path.join(wtSessionsDir, "holder-remove");
    await worktreeGit(wtRemove.path, ["checkout", "--detach"]);
    await worktreeGit(ws, ["worktree", "add", holderRemove, wtRemove.branch]);

    try {
      // 1. 移除成员：删分支失败不应抛错，ensemble.member_removed 必须写进持久日志，且发出 worktree_cleanup_failed 警告
      await expect(session.removeEnsembleMember("iso-remove")).resolves.toBeUndefined();
      expect(
        session
          .durableEvents()
          .some((e) => e.type === "ensemble.member_removed" && e.payload.name === "iso-remove"),
      ).toBe(true);
      expect(warnings.some((w) => w.code === "worktree_cleanup_failed")).toBe(true);

      // 2. 结束 Ensemble 后对保留下来的 iso-apply 并回，同样占用分支使并回后的清理失败：apply_subagent_changes 仍成功并发出警告
      await session.endEnsemble();
      const holderApply = path.join(wtSessionsDir, "holder-apply");
      await worktreeGit(wtApply.path, ["checkout", "--detach"]);
      await worktreeGit(ws, ["worktree", "add", holderApply, wtApply.branch]);
      const warnCountBeforeApply = warnings.filter(
        (w) => w.code === "worktree_cleanup_failed",
      ).length;
      try {
        await session.submit({ text: "apply post-end" });
        expect(readFileSync(path.join(ws, "applied-after.txt"), "utf8")).toBe("ok\n");
        expect(warnings.filter((w) => w.code === "worktree_cleanup_failed").length).toBeGreaterThan(
          warnCountBeforeApply,
        );
      } finally {
        await worktreeGit(ws, ["worktree", "remove", "--force", holderApply]).catch(
          () => undefined,
        );
      }

      // 3. 重启恢复验证：iso-remove 在持久日志中确为 removed，不会复活为 waiting
      const sessionId = session.id;
      await session.close();
      const resumed = await rt.resumeSession(sessionId);
      openRuntimes[0]?.sessions.push(resumed);
      expect(
        replaySessionView(resumed.durableEvents()).ensemble?.members.find(
          (m) => m.name === "iso-remove",
        )?.status,
      ).toBe("removed");
    } finally {
      await worktreeGit(ws, ["worktree", "remove", "--force", holderRemove]).catch(() => undefined);
    }
  }, 30_000);
});
