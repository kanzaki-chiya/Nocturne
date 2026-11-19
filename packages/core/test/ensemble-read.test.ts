/**
 * ADR-0095 §2 `ensemble_read` 完整单元与集成测试：
 * 覆盖输入过滤全组合、@all 提及语义、before 翻页与 hasMore、limit 默认 20/最大 50、
 * 升序输出、开头成员名单（name/status/isolated/charter 三段）、`<ensemble-post>` 原文不截断、
 * 指挥与成员（含 explore 只读成员）调用、重启恢复、合奏结束卸载与不可用、不声明 pinResult 与无副作用。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { worktreeGit } from "../src/agent/worktree.js";
import {
  createEnsembleController,
  type EnsembleControllerDeps,
  type EnsembleMemberOpenSpec,
  type EnsembleReadOutput,
  type EnsembleWorktreeHandle,
  type ManagedMemberSession,
} from "../src/ensemble/index.js";
import { createRuntime, type RuntimeSession } from "../src/index.js";
import {
  formatEnsemblePostForModel,
  replaySessionView,
  type DurableEvent,
  type DurablePayloadMap,
  type DurableType,
  type ModelRef,
} from "../src/protocol/index.js";
import {
  FakeProvider,
  type FakeScript,
  type ModelInfo,
  type ModelRequest,
  type Provider,
} from "../src/provider/index.js";
import {
  createExecutionScope,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  type PermissionGate,
  type ToolDefinition,
  type ToolEventSink,
} from "../src/tools/index.js";
import { createPlatform } from "../src/platform/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be defined");
  return value;
}

const tempRoots: string[] = [];
const openSessions: RuntimeSession[] = [];

afterEach(async () => {
  for (const s of openSessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "nocturne-ensemble-read-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function initGitRepo(dir: string): Promise<void> {
  await worktreeGit(dir, ["init", "-b", "main"]);
  await worktreeGit(dir, ["config", "user.name", "Test"]);
  await worktreeGit(dir, ["config", "user.email", "test@localhost"]);
  await worktreeGit(dir, ["config", "commit.gpgsign", "false"]);
  await worktreeGit(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "README.md"), "# Ensemble Read Test\n", "utf8");
  await worktreeGit(dir, ["add", "-A"]);
  await worktreeGit(dir, ["commit", "-m", "init"]);
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

function createTestModelInfo(ref: ModelRef): ModelInfo {
  return {
    ref,
    protocol: "openai-compatible",
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
  };
}

function createFakeProvider(
  router: (req: ModelRequest, role: string) => FakeScript | Promise<FakeScript>,
  recorded: { role: string; req: ModelRequest }[] = [],
): Provider {
  const ref: ModelRef = { provider: "fake", model: "m1" };
  return new FakeProvider({
    id: "fake",
    models: [createTestModelInfo(ref)],
    roleHandler: () => stopText("Title"),
    handler: async (req) => {
      const sys = req.system.map((b) => b.text).join("\n");
      const match = /persistent ensemble member `@([a-z0-9-]+)`/.exec(sys);
      const role = match?.[1] ? `member:${match[1]}` : "maestro";
      recorded.push({ role, req });
      return await router(req, role);
    },
  });
}

function makeControllerHarness() {
  const durable: DurableEvent[] = [];
  let seq = 1;
  const modelRef: ModelRef = { provider: "fake", model: "m1" };
  const fakeProvider = new FakeProvider({ id: "fake", models: [createTestModelInfo(modelRef)] });
  const resolvedModel = { provider: fakeProvider, model: createTestModelInfo(modelRef) };
  const memberSpecs = new Map<string, EnsembleMemberOpenSpec>();
  const memberSessions = new Map<string, ManagedMemberSession>();
  const worktrees = new Map<string, EnsembleWorktreeHandle>();

  const createdEv: DurableEvent = {
    seq: seq++,
    time: new Date().toISOString(),
    sessionId: "coord-1",
    type: "session.created",
    payload: {
      formatVersion: 1,
      cwd: "/ws",
      workspaceRoot: "/ws",
      model: modelRef,
      permissionPreset: "bypass",
      nocturneVersion: "0.50.0",
    },
  };
  durable.push(createdEv);

  let childCounter = 0;
  const deps: EnsembleControllerDeps = {
    maestroSessionId: "coord-1",
    newChildSessionId: () => `child-${++childCounter}`,
    isClosing: () => false,
    currentDirectory: () => ({ cwd: "/ws", workspaceRoot: "/ws" }),
    maestroModel: () => resolvedModel,
    maestroEffort: () => undefined,
    enabledModels: () => [{ provider: "fake", model: "m1" }],
    availableProfiles: () => [],
    externalAgentNames: () => new Set(),
    resolveEnabledModel: () => resolvedModel,
    pricing: () => undefined,
    durableEvents: () => durable,
    readChildDurableEvents: () => Promise.resolve([]),
    emitDurable: <T extends DurableType>(type: T, payload: DurablePayloadMap[T]) => {
      const ev = {
        seq: seq++,
        time: new Date().toISOString(),
        sessionId: "coord-1",
        type,
        payload,
      } as unknown as DurableEvent;
      durable.push(ev);
      return Promise.resolve(ev);
    },
    emitEphemeral: () => undefined,
    deliverToMaestro: () => Promise.resolve(),
    clearMaestroEnsembleInputs: () => undefined,
    isMaestroBusy: () => false,
    hasMaestroPendingActive: () => false,
    syncMaestroTools: () => undefined,
    notifyMaestroIdle: () => undefined,
    openMemberSession: (spec) => {
      memberSpecs.set(spec.name, spec);
      const handle: ManagedMemberSession = {
        id: spec.childSessionId,
        isBusy: () => false,
        hasActivePendingInputs: () => false,
        deliverEnsemblePost: () => Promise.resolve(),
        resumeFromModelChange: () => Promise.resolve(),
        setModelAndEffort: () => Promise.resolve(),
        interruptAndWait: () => Promise.resolve(),
        clearPendingEnsembleInputs: () => undefined,
        subscribe: () => () => undefined,
        closeUnderlying: () => Promise.resolve(),
      };
      memberSessions.set(spec.name, handle);
      return Promise.resolve(handle);
    },
    worktrees: {
      inspectRepository: () => Promise.resolve("/ws"),
      create: (input) => {
        const rec: EnsembleWorktreeHandle = {
          childSessionId: input.childSessionId,
          parentSessionId: "coord-1",
          repository: input.repository,
          worktree: `/wt/${input.childSessionId}`,
          branch: `nocturne/${input.childSessionId}`,
          base: "main",
          snapshot: false,
          cwd: `/wt/${input.childSessionId}`,
          workspaceRoot: `/wt/${input.childSessionId}`,
          task: input.task,
          includeSkipped: false,
        };
        worktrees.set(input.childSessionId, rec);
        return Promise.resolve(rec);
      },
      loadRecord: (id) => Promise.resolve(worktrees.get(id)),
      listParentRecords: () => Promise.resolve([...worktrees.values()]),
      checkpoint: () => Promise.resolve(undefined),
      currentHead: () => Promise.resolve("deadbeef"),
      isOnMemberBranch: () => Promise.resolve(true),
      resetToCommit: () => Promise.resolve("deadbeef"),
      markApplied: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      cleanupMerged: () => Promise.resolve(),
    },
    commandError: (code, message) => Object.assign(new Error(message), { code }),
  };

  const controller = createEnsembleController(deps);
  return { controller, durable, memberSpecs };
}

async function execReadTool(tool: ToolDefinition, input: unknown) {
  const platform = createPlatform();
  const registry = createToolRegistry();
  registry.register(tool);
  const completed: unknown[] = [];
  const events: ToolEventSink = {
    emit: (_t, payload) => {
      completed.push(payload);
      return Promise.resolve();
    },
    emitEphemeral: () => undefined,
  };
  const gate: PermissionGate = {
    checkLexical: () => "allow",
    check: (subjects) =>
      Promise.resolve({
        subjects,
        decision: { action: "allow", source: "rule", reason: "test" },
      }),
  };
  const executor = createToolExecutor(registry);
  const scope = createExecutionScope(
    {
      platform,
      gate,
      readState: createReadStateStore(platform.paths),
    },
    {
      sessionId: "s-test",
      turnId: "turn-1",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      events,
      signal: new AbortController().signal,
    },
  );
  return {
    execution: await executor.execute({ callId: "call-1", name: tool.name, input }, scope),
    completed,
  };
}

describe("ADR-0095 §2 ensemble_read Core 单元与集成测试", { timeout: 30_000 }, () => {
  it("工具声明与特性：mutates=false、concurrencySafe=true、无 pinResult、permissionSubjects=[]、无新增持久事件", async () => {
    const { controller, durable } = makeControllerHarness();
    const maestroTools = controller.maestroTools();
    const readTool = must(maestroTools.find((t) => t.name === "ensemble_read"));
    const initTool = must(maestroTools.find((t) => t.name === "ensemble_init"));
    const postTool = must(maestroTools.find((t) => t.name === "ensemble_post"));

    expect(readTool.traits.mutates).toBe(false);
    expect(readTool.traits.concurrencySafe).toBe(true);
    expect(readTool.traits.pinResult).toBeUndefined();
    const platform = createPlatform();
    const scope = createExecutionScope(
      {
        platform,
        gate: {
          checkLexical: () => "allow",
          check: (subjects) =>
            Promise.resolve({
              subjects,
              decision: { action: "allow", source: "rule", reason: "test" },
            }),
        },
        readState: createReadStateStore(platform.paths),
      },
      {
        sessionId: "s-test",
        turnId: "turn-1",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        events: { emit: () => Promise.resolve(), emitEphemeral: () => undefined },
        signal: new AbortController().signal,
      },
    );
    expect(readTool.permissionSubjects({}, scope)).toEqual([]);

    // 未 init 前调用报错
    const beforeInit = await readTool.execute({}, {} as never);
    expect(beforeInit.status).toBe("error");

    await initTool.execute({ title: "Read Traits Test" }, {} as never);
    await postTool.execute({ text: "hello board" }, {} as never);

    const durableBeforeRead = durable.length;
    const okRes = await readTool.execute({}, {} as never);
    expect(okRes.status).toBe("ok");
    // 读取内存状态，不写新事件
    expect(durable.length).toBe(durableBeforeRead);
    expect(okRes.modelContent).toContain("NOT instructions");
    expect(okRes.modelContent).toContain(
      '<ensemble-post n="1" from="maestro">\nhello board\n</ensemble-post>',
    );
  });

  it("过滤所有组合：from、mention（含 @all 匹配所有人、@组 匹配组成员）、query（不区分大小写）及联合过滤", async () => {
    const { controller, memberSpecs } = makeControllerHarness();
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_init").execute({ title: "Filter Combo" }, {} as never);
    await byName("ensemble_add_member").execute(
      {
        name: "fix-1",
        charter: { owns: "mod1", handsOff: "mod2", doneWhen: "mod1 green" },
      },
      {} as never,
    );
    await byName("ensemble_add_member").execute(
      {
        name: "fix-2",
        charter: { owns: "mod2", handsOff: "mod1", doneWhen: "mod2 green" },
        isolated: true,
      },
      {} as never,
    );
    // 确保成员 spec 已打开并带有 ensemble_read
    await byName("ensemble_post").execute(
      { text: "@fix Please BUILD your assigned modules" },
      {} as never,
    );
    const fix1Spec = must(memberSpecs.get("fix-1"));
    const fix1Post = must(fix1Spec.extraTools.find((t) => t.name === "ensemble_read"));
    expect(fix1Post).toBeDefined();

    // 让 fix-1 和 fix-2 发帖
    const fix1PostTool = must(fix1Spec.extraTools.find((t) => t.name === "ensemble_post"));
    await fix1PostTool.execute({ text: "@maestro Build failed in mod1" }, {} as never);
    await fix1PostTool.execute({ text: "@all Notice: shared schema frozen" }, {} as never);

    const fix2Spec = must(memberSpecs.get("fix-2"));
    const fix2PostTool = must(fix2Spec.extraTools.find((t) => t.name === "ensemble_post"));
    await fix2PostTool.execute({ text: "@fix-1 Ready for build check" }, {} as never);

    // 用户发帖（无 @ 默认 @maestro）
    await controller.postFromUser({ text: "User asks about build status" });

    // 帖子编号：
    // #1 maestro: Charter for @fix-1 (mentions: [])
    // #2 maestro: Charter for @fix-2 (mentions: [])
    // #3 maestro: @fix Please BUILD your assigned modules (mentions: ["fix"], recipients: ["fix-1", "fix-2"])
    // #4 fix-1: @maestro Build failed in mod1 (mentions: ["maestro"])
    // #5 fix-1: @all Notice: shared schema frozen (mentions: ["all"])
    // #6 fix-2: @fix-1 Ready for build check (mentions: ["fix-1"])
    // #7 user: User asks about build status (mentions: ["maestro"])

    const read = async (input: Record<string, unknown>) => {
      const res = await byName("ensemble_read").execute(input, {} as never);
      expect(res.status).toBe("ok");
      return res.output as EnsembleReadOutput;
    };

    // 1. 单条件 from（支持带/不带 @、@指挥 -> maestro）
    expect((await read({ from: "fix-1" })).posts.map((p) => p.number)).toEqual([4, 5]);
    expect((await read({ from: "@fix-1" })).posts.map((p) => p.number)).toEqual([4, 5]);
    expect((await read({ from: "@指挥" })).posts.map((p) => p.number)).toEqual([1, 2, 3]);
    expect((await read({ from: "user" })).posts.map((p) => p.number)).toEqual([7]);

    // 2. 单条件 mention（@all 视为提及每个人；@fix 展开匹配 fix-1/fix-2）
    expect((await read({ mention: "fix-1" })).posts.map((p) => p.number)).toEqual([3, 5, 6]);
    expect((await read({ mention: "@fix-2" })).posts.map((p) => p.number)).toEqual([3, 5]);
    expect((await read({ mention: "maestro" })).posts.map((p) => p.number)).toEqual([4, 5, 7]);
    expect((await read({ mention: "@all" })).posts.map((p) => p.number)).toEqual([5]);

    // 3. 单条件 query（不区分大小写子串）
    expect((await read({ query: "build" })).posts.map((p) => p.number)).toEqual([3, 4, 6, 7]);
    expect((await read({ query: "BUILD" })).posts.map((p) => p.number)).toEqual([3, 4, 6, 7]);

    // 4. 两两组合
    expect((await read({ from: "fix-1", mention: "maestro" })).posts.map((p) => p.number)).toEqual([
      4, 5,
    ]);
    expect((await read({ from: "fix-1", query: "build" })).posts.map((p) => p.number)).toEqual([4]);
    expect((await read({ mention: "fix-1", query: "build" })).posts.map((p) => p.number)).toEqual([
      3, 6,
    ]);

    // 5. 三条件联合：from + mention + query
    expect(
      (await read({ from: "maestro", mention: "fix-1", query: "build" })).posts.map(
        (p) => p.number,
      ),
    ).toEqual([3]);

    // 6. 四/五条件联合：加上 before 与 limit
    expect(
      (await read({ mention: "fix-1", query: "build", before: 6, limit: 1 })).posts.map(
        (p) => p.number,
      ),
    ).toEqual([3]);
    expect(
      (
        await read({ from: "fix-1", mention: "maestro", query: "BUILD", before: 6, limit: 1 })
      ).posts.map((p) => p.number),
    ).toEqual([4]);

    // 7. 无命中结果
    const none = await read({ from: "user", query: "nonexistent" });
    expect(none.posts).toEqual([]);
    expect(none.hasMore).toBe(false);
    expect(none.members.map((m) => m.name)).toEqual(["fix-1", "fix-2"]);
  });

  it("分页与排序：limit 默认 20、最大 50、before 向前翻页、严格升序与 hasMore 判定", async () => {
    const { controller } = makeControllerHarness();
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_init").execute({ title: "Pagination Test" }, {} as never);
    await byName("ensemble_add_member").execute(
      { name: "worker", charter: { owns: "a", handsOff: "b", doneWhen: "c" } },
      {} as never,
    );
    // charter 为 #1；再发 55 条帖子，共 56 条（#1..#56）
    for (let i = 2; i <= 56; i++) {
      await byName("ensemble_post").execute(
        { text: `@worker task #${i} ${i % 2 === 0 ? "even" : "odd"}` },
        {} as never,
      );
    }

    const read = async (input: Record<string, unknown>) => {
      const res = await byName("ensemble_read").execute(input, {} as never);
      expect(res.status).toBe("ok");
      return res.output as EnsembleReadOutput;
    };

    // 默认 limit = 20：返回最新 20 条（#37..#56），升序，hasMore=true
    const page1 = await read({});
    expect(page1.posts).toHaveLength(20);
    expect(page1.posts[0]?.number).toBe(37);
    expect(page1.posts.at(-1)?.number).toBe(56);
    expect(page1.hasMore).toBe(true);
    for (let i = 1; i < page1.posts.length; i++) {
      expect(must(page1.posts[i]).number).toBeGreaterThan(must(page1.posts[i - 1]).number);
    }

    // 往前翻页 before=37：返回 #17..#36，hasMore=true
    const page2 = await read({ before: 37 });
    expect(page2.posts).toHaveLength(20);
    expect(page2.posts[0]?.number).toBe(17);
    expect(page2.posts.at(-1)?.number).toBe(36);
    expect(page2.hasMore).toBe(true);

    // 再往前翻页 before=17：返回 #1..#16（16条），hasMore=false
    const page3 = await read({ before: 17 });
    expect(page3.posts).toHaveLength(16);
    expect(page3.posts[0]?.number).toBe(1);
    expect(page3.posts.at(-1)?.number).toBe(16);
    expect(page3.hasMore).toBe(false);

    // limit=50 与 limit>50（封顶 50）
    const cap50 = await read({ limit: 50 });
    expect(cap50.posts).toHaveLength(50);
    expect(cap50.posts[0]?.number).toBe(7);
    expect(cap50.posts.at(-1)?.number).toBe(56);
    expect(cap50.hasMore).toBe(true);

    const capOver = await read({ limit: 99 });
    expect(capOver.posts).toHaveLength(50);
    expect(capOver.posts[0]?.number).toBe(7);
    expect(capOver.hasMore).toBe(true);

    // 过滤条件下 hasMore 针对命中集判定
    const filteredPage1 = await read({ query: "even", limit: 10 });
    expect(filteredPage1.posts).toHaveLength(10);
    expect(filteredPage1.posts[0]?.number).toBe(38);
    expect(filteredPage1.posts.at(-1)?.number).toBe(56);
    expect(filteredPage1.hasMore).toBe(true);

    const filteredAllEarlier = await read({ query: "even", before: 10, limit: 10 });
    expect(filteredAllEarlier.posts.map((p) => p.number)).toEqual([2, 4, 6, 8]);
    expect(filteredAllEarlier.hasMore).toBe(false);

    // 非法 before / limit 被 ToolExecutor 拒绝
    const readToolDef = must(tools.find((t) => t.name === "ensemble_read"));
    const badBefore = await execReadTool(readToolDef, { before: 0 });
    expect(badBefore.execution.status).toBe("error");
    expect(badBefore.execution.result.status).toBe("error");
    if (badBefore.execution.result.status === "error") {
      expect(badBefore.execution.result.error.code).toBe("invalid_input");
    }

    const badLimit = await execReadTool(readToolDef, { limit: 0 });
    expect(badLimit.execution.status).toBe("error");
    expect(badLimit.execution.result.status).toBe("error");
    if (badLimit.execution.result.status === "error") {
      expect(badLimit.execution.result.error.code).toBe("invalid_input");
    }
  });

  it("成员名单展示：含 name/status/isolated/charter 三段，动态反映 working/waiting/paused 并排除已移除成员", async () => {
    const { controller, memberSpecs } = makeControllerHarness();
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_init").execute({ title: "Roster Test" }, {} as never);
    await byName("ensemble_add_member").execute(
      {
        name: "shared-impl",
        charter: {
          owns: "src/shared.ts",
          handsOff: "src/iso.ts",
          doneWhen: "shared tests pass",
        },
        isolated: false,
      },
      {} as never,
    );
    await byName("ensemble_add_member").execute(
      {
        name: "iso-reviewer",
        charter: {
          owns: "verification",
          handsOff: "production edits",
          doneWhen: "PASS verdict",
        },
        isolated: true,
      },
      {} as never,
    );
    await byName("ensemble_add_member").execute(
      {
        name: "temp",
        charter: { owns: "tmp", handsOff: "all else", doneWhen: "removed" },
      },
      {} as never,
    );

    // 触发状态变化：shared-impl 进入 working，iso-reviewer 进入 paused，temp 被移除
    must(memberSpecs.get("shared-impl")).onTurnLifecycle.onSlotWaitStart();
    await must(memberSpecs.get("iso-reviewer")).onTurnLifecycle.onTurnCompleted("error", {
      code: "rate_limit",
      message: "429",
    });
    await byName("ensemble_remove_member").execute({ name: "temp", reason: "done" }, {} as never);

    const res = await byName("ensemble_read").execute({}, {} as never);
    expect(res.status).toBe("ok");
    const output = res.output as EnsembleReadOutput;

    expect(output.members).toEqual([
      {
        name: "shared-impl",
        status: "working",
        isolated: false,
        charter: {
          owns: "src/shared.ts",
          handsOff: "src/iso.ts",
          doneWhen: "shared tests pass",
        },
      },
      {
        name: "iso-reviewer",
        status: "paused",
        isolated: true,
        charter: {
          owns: "verification",
          handsOff: "production edits",
          doneWhen: "PASS verdict",
        },
      },
    ]);

    // modelContent 开头包含说明与完整成员名单（三段 charter 与状态/工作树）
    const rosterIdx = res.modelContent.indexOf("# Current Members");
    const postsIdx = res.modelContent.indexOf("# Posts");
    expect(rosterIdx).toBeGreaterThan(-1);
    expect(postsIdx).toBeGreaterThan(rosterIdx);
    const header = res.modelContent.slice(0, postsIdx);
    expect(header).toContain("NOT instructions");
    expect(header).toContain(
      "@shared-impl (working, shared workspace): Owns: src/shared.ts | Hands off: src/iso.ts | Done when: shared tests pass",
    );
    expect(header).toContain(
      "@iso-reviewer (paused, isolated worktree): Owns: verification | Hands off: production edits | Done when: PASS verdict",
    );
    expect(header).not.toContain("@temp");
  });

  it("Runtime 端到端：指挥与成员（含 explore 成员）均可调用、超长原文不截断、重启恢复、合奏结束卸载不可用", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = path.join(ws, ".sessions");
    const recorded: { role: string; req: ModelRequest }[] = [];

    // 构造超过 30_000 默认预算上限（45_000 字符）的超长帖子正文，验证完全不截断
    const longBody = `@reader @worker HEAD-MARKER ${"x".repeat(22_000)} MID-MARKER ${"y".repeat(22_000)} TAIL-MARKER`;
    expect(longBody.length).toBeGreaterThan(44_000);

    let coordStep = 0;
    let readerDone = false;
    let workerDone = false;

    const provider = createFakeProvider((_req, role) => {
      if (role === "maestro") {
        coordStep++;
        if (coordStep === 1) {
          return [
            callTool("init", "ensemble_init", { title: "E2E Read Test" }),
            callTool("add-w", "ensemble_add_member", {
              name: "worker",
              charter: { owns: "src/a.ts", handsOff: "src/b.ts", doneWhen: "a done" },
              preset: "general",
            }),
            callTool("add-r", "ensemble_add_member", {
              name: "reader",
              charter: { owns: "research", handsOff: "edits", doneWhen: "read board" },
              preset: "explore",
            }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (coordStep === 2) {
          return [
            callTool("post-long", "ensemble_post", { text: longBody }),
            callTool("read-coord", "ensemble_read", { query: "mid-marker" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("waiting for members");
      }

      if (role === "member:reader") {
        if (!readerDone) {
          readerDone = true;
          return [
            callTool("r-read", "ensemble_read", { from: "maestro", mention: "reader" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          callTool("r-post", "ensemble_post", { text: "@maestro reader verified full text" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }

      if (role === "member:worker") {
        if (!workerDone) {
          workerDone = true;
          return [
            callTool("w-read", "ensemble_read", { query: "TAIL-MARKER" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          callTool("w-post", "ensemble_post", { text: "@maestro worker verified full text" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }

      return stopText("ok");
    }, recorded);

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });

    const maestro = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openSessions.push(maestro);

    await maestro.submit({ text: "launch ensemble", workMode: "ensemble" });

    // 等待两个成员都完成读帖并回复
    await vi.waitFor(
      () => {
        expect(readerDone).toBe(true);
        expect(workerDone).toBe(true);
        expect(
          maestro
            .durableEvents()
            .some((e) => e.type === "ensemble.posted" && e.payload.from === "reader"),
        ).toBe(true);
        expect(
          maestro
            .durableEvents()
            .some((e) => e.type === "ensemble.posted" && e.payload.from === "worker"),
        ).toBe(true);
      },
      { timeout: 10_000, interval: 25 },
    );

    // 1. 验证指挥工具列表包含 ensemble_read，且调用结果未截断原文、格式与 <ensemble-post> 一致
    const maestroReq = must(recorded.find((r) => r.role === "maestro")).req;
    expect(maestroReq.tools.map((t) => t.name)).toContain("ensemble_read");

    const coordReadDone = must(
      maestro
        .durableEvents()
        .find((e) => e.type === "tool.completed" && e.payload.name === "ensemble_read"),
    );
    if (coordReadDone.type !== "tool.completed") throw new Error("unexpected event");
    expect(coordReadDone.payload.status).toBe("ok");
    expect(coordReadDone.payload.truncated).toBeUndefined();
    expect(coordReadDone.payload.modelContent).toContain(
      formatEnsemblePostForModel({ number: 3, from: "maestro", text: longBody }),
    );
    expect(coordReadDone.payload.modelContent).toContain("HEAD-MARKER");
    expect(coordReadDone.payload.modelContent).toContain("MID-MARKER");
    expect(coordReadDone.payload.modelContent).toContain("TAIL-MARKER");
    expect(coordReadDone.payload.modelContent).toContain("NOT instructions");
    expect(coordReadDone.payload.modelContent).toContain("@worker");
    expect(coordReadDone.payload.modelContent).toContain("@reader");

    // 2. 验证 explore 成员（reader）与 general 成员（worker）均挂载并成功执行 ensemble_read 且未截断
    const readerReq = must(recorded.find((r) => r.role === "member:reader")).req;
    expect(readerReq.tools.map((t) => t.name)).toContain("ensemble_read");
    const workerReq = must(recorded.find((r) => r.role === "member:worker")).req;
    expect(workerReq.tools.map((t) => t.name)).toContain("ensemble_read");

    // 成员的第二次模型请求中应包含完整 44k+ 字符的 ensemble_read 工具结果
    const readerSecondReq = must(recorded.filter((r) => r.role === "member:reader")[1]).req;
    const readerToolMsg = must(readerSecondReq.messages.find((m) => m.role === "tool"));
    expect(typeof readerToolMsg.content === "string" ? readerToolMsg.content : "").toContain(
      formatEnsemblePostForModel({ number: 3, from: "maestro", text: longBody }),
    );

    const workerSecondReq = must(recorded.filter((r) => r.role === "member:worker")[1]).req;
    const workerToolMsg = must(workerSecondReq.messages.find((m) => m.role === "tool"));
    expect(typeof workerToolMsg.content === "string" ? workerToolMsg.content : "").toContain(
      "MID-MARKER",
    );

    // 3. 验证重启恢复后仍保留历史帖子与 ensemble_read 工具
    await maestro.close();
    openSessions.splice(openSessions.indexOf(maestro), 1);

    // 恢复前让指挥调用一次 ensemble_read 然后 ensemble_end
    let resumedStep = 0;
    let tryReadAfterEnd = false;
    const providerAfterRestart = createFakeProvider((_req, role) => {
      if (role === "maestro") {
        resumedStep++;
        if (resumedStep === 1) {
          return [
            callTool("after-resume-read", "ensemble_read", { from: "reader" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (resumedStep === 2) {
          return [
            callTool("end-now", "ensemble_end", { summary: "done" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (tryReadAfterEnd) {
          tryReadAfterEnd = false;
          return [
            callTool("read-after-end", "ensemble_read", {}),
            { type: "finish", reason: "tool_calls" },
          ];
        }
      }
      return stopText("ok");
    });

    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [providerAfterRestart],
      interactive: true,
      subagent: { background: true },
    });
    const resumed = await rt2.resumeSession(maestro.id);
    openSessions.push(resumed);

    expect(resumed.describeContext().request.tools.map((t) => t.name)).toContain("ensemble_read");

    // 取得 worker 的 childSessionId 用于验证结束后不可用
    const workerChildId = must(
      resumed
        .durableEvents()
        .find((e) => e.type === "ensemble.member_added" && e.payload.name === "worker"),
    );
    if (workerChildId.type !== "ensemble.member_added") throw new Error("unexpected");
    const childSessionId = workerChildId.payload.childSessionId;

    await resumed.submit({ text: "read after restart and end" });

    // 验证重启后读取到了重启前的帖子
    const resumeReadEv = must(
      resumed
        .durableEvents()
        .filter((e) => e.type === "tool.completed" && e.payload.name === "ensemble_read")
        .at(-1),
    );
    if (resumeReadEv.type !== "tool.completed") throw new Error("unexpected");
    expect(resumeReadEv.payload.status).toBe("ok");
    expect(resumeReadEv.payload.modelContent).toContain("reader verified full text");

    // 4. 合奏结束后：ensemble_read 从指挥卸载（调用报 unknown_tool），且重新打开原成员会话也不再拥有 ensemble_read
    expect(resumed.describeContext().request.tools.map((t) => t.name)).not.toContain(
      "ensemble_read",
    );

    tryReadAfterEnd = true;
    await resumed.submit({ text: "try ensemble_read after end" });
    const afterEndReadEv = must(
      resumed
        .durableEvents()
        .filter((e) => e.type === "tool.completed" && e.payload.name === "ensemble_read")
        .at(-1),
    );
    if (afterEndReadEv.type !== "tool.completed") throw new Error("unexpected");
    expect(afterEndReadEv.payload.status).toBe("error");
    expect(afterEndReadEv.payload.error?.code).toBe("unknown_tool");

    const reopenedMember = await rt2.resumeSession(childSessionId);
    openSessions.push(reopenedMember);
    expect(reopenedMember.describeContext().request.tools.map((t) => t.name)).not.toContain(
      "ensemble_read",
    );
  });

  it("已移除成员与合奏结束后的直接工具调用均被拒绝（不可用）", async () => {
    const { controller, memberSpecs } = makeControllerHarness();
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_init").execute({ title: "Removal & End Test" }, {} as never);
    await byName("ensemble_add_member").execute(
      { name: "m1", charter: { owns: "a", handsOff: "b", doneWhen: "c" } },
      {} as never,
    );
    await byName("ensemble_add_member").execute(
      { name: "m2", charter: { owns: "x", handsOff: "y", doneWhen: "z" } },
      {} as never,
    );
    // 确保 m1 和 m2 的 extraTools 都已构建
    await byName("ensemble_post").execute({ text: "@m1 @m2 hi" }, {} as never);

    const m1ReadTool = must(
      must(memberSpecs.get("m1")).extraTools.find((t) => t.name === "ensemble_read"),
    );
    const m2ReadTool = must(
      must(memberSpecs.get("m2")).extraTools.find((t) => t.name === "ensemble_read"),
    );

    expect((await m1ReadTool.execute({}, {} as never)).status).toBe("ok");

    // 移除 m1 后，m1 调用被拒，未移除的 m2 仍可用
    await byName("ensemble_remove_member").execute({ name: "m1" }, {} as never);
    const m1AfterRemove = await m1ReadTool.execute({}, {} as never);
    expect(m1AfterRemove.status).toBe("error");
    expect((await m2ReadTool.execute({}, {} as never)).status).toBe("ok");

    // 结束合奏后，指挥与 m2 均不可用
    await byName("ensemble_end").execute({}, {} as never);
    expect((await byName("ensemble_read").execute({}, {} as never)).status).toBe("error");
    expect((await m2ReadTool.execute({}, {} as never)).status).toBe("error");
  });

  it("query 原样子串匹配回归：保留首尾空格（' Alpha ' vs 'Alpha'）、空串匹配所有，且成员系统提示包含 ensemble_read 说明", async () => {
    const { controller, memberSpecs } = makeControllerHarness();
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_init").execute({ title: "Query Whitespace Test" }, {} as never);
    await byName("ensemble_add_member").execute(
      { name: "m1", charter: { owns: "a", handsOff: "b", doneWhen: "c" } },
      {} as never,
    );
    // charter 帖子为 #1
    expect(must(memberSpecs.get("m1")).basePrompt()).toContain("ensemble_read");

    // #2: 含前后空格 " Alpha "
    await byName("ensemble_post").execute({ text: "check the Alpha build" }, {} as never);
    // #3: 仅含紧凑 "Alpha"，前后无空格
    await byName("ensemble_post").execute({ text: "Alpha" }, {} as never);
    // #4: 紧邻标点，无前后空格
    await byName("ensemble_post").execute({ text: "target:Alpha!" }, {} as never);

    const read = async (input: Record<string, unknown>) => {
      const res = await byName("ensemble_read").execute(input, {} as never);
      expect(res.status).toBe("ok");
      return res.output as EnsembleReadOutput;
    };

    // 不带空格的 "Alpha" 匹配 #2, #3, #4（不区分大小写）
    expect((await read({ query: "Alpha" })).posts.map((p) => p.number)).toEqual([2, 3, 4]);
    // 带前后空格的 " Alpha " 不得被 trim，只匹配真正含前后空格的 #2（大小写仍不敏感）
    expect((await read({ query: " Alpha " })).posts.map((p) => p.number)).toEqual([2]);
    expect((await read({ query: " alpha " })).posts.map((p) => p.number)).toEqual([2]);
    // 空串匹配所有帖子
    expect((await read({ query: "" })).posts.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    // 纯空格只匹配含空格的帖子（#1, #2；排除 #3, #4）
    expect((await read({ query: " " })).posts.map((p) => p.number)).toEqual([1, 2]);
  });

  it("mention 过滤沿用发帖解析语义：精确 fix 与 fix-1 共存、历史组提及后新增成员、组成员发自己组、@all 及重放一致", async () => {
    const sharedDurable: DurableEvent[] = [];
    let nextSeq = 1;
    const buildHarnessFromLog = () => {
      const modelRef: ModelRef = { provider: "fake", model: "m1" };
      const fakeProvider = new FakeProvider({
        id: "fake",
        models: [createTestModelInfo(modelRef)],
      });
      const resolvedModel = { provider: fakeProvider, model: createTestModelInfo(modelRef) };
      const memberSpecs = new Map<string, EnsembleMemberOpenSpec>();
      const deps: EnsembleControllerDeps = {
        maestroSessionId: "coord-mention",
        newChildSessionId: () => `child-${Math.random().toString(36).slice(2, 8)}`,
        isClosing: () => false,
        currentDirectory: () => ({ cwd: "/ws", workspaceRoot: "/ws" }),
        maestroModel: () => resolvedModel,
        maestroEffort: () => undefined,
        enabledModels: () => [{ provider: "fake", model: "m1" }],
        availableProfiles: () => [],
        externalAgentNames: () => new Set(),
        resolveEnabledModel: () => resolvedModel,
        pricing: () => undefined,
        durableEvents: () => sharedDurable,
        readChildDurableEvents: () => Promise.resolve([]),
        emitDurable: (type, payload) => {
          const ev = {
            seq: nextSeq++,
            time: new Date().toISOString(),
            sessionId: "coord-mention",
            type,
            payload,
          } as DurableEvent;
          sharedDurable.push(ev);
          return Promise.resolve(ev);
        },
        emitEphemeral: () => undefined,
        deliverToMaestro: () => Promise.resolve(),
        clearMaestroEnsembleInputs: () => undefined,
        isMaestroBusy: () => false,
        hasMaestroPendingActive: () => false,
        syncMaestroTools: () => undefined,
        notifyMaestroIdle: () => undefined,
        openMemberSession: (spec) => {
          memberSpecs.set(spec.name, spec);
          const handle: ManagedMemberSession = {
            id: spec.childSessionId,
            isBusy: () => false,
            hasActivePendingInputs: () => false,
            deliverEnsemblePost: () => Promise.resolve(),
            resumeFromModelChange: () => Promise.resolve(),
            setModelAndEffort: () => Promise.resolve(),
            interruptAndWait: () => Promise.resolve(),
            clearPendingEnsembleInputs: () => undefined,
            subscribe: () => () => undefined,
            closeUnderlying: () => Promise.resolve(),
          };
          return Promise.resolve(handle);
        },
        worktrees: {
          inspectRepository: () => Promise.resolve("/ws"),
          create: (input) =>
            Promise.resolve({
              childSessionId: input.childSessionId,
              parentSessionId: "coord-mention",
              repository: input.repository,
              worktree: `/wt/${input.childSessionId}`,
              branch: `nocturne/${input.childSessionId}`,
              base: "main",
              snapshot: false,
              cwd: `/wt/${input.childSessionId}`,
              workspaceRoot: `/wt/${input.childSessionId}`,
              task: input.task,
              includeSkipped: false,
            }),
          loadRecord: () => Promise.resolve(undefined),
          listParentRecords: () => Promise.resolve([]),
          checkpoint: () => Promise.resolve(undefined),
          currentHead: () => Promise.resolve("deadbeef"),
          isOnMemberBranch: () => Promise.resolve(true),
          resetToCommit: () => Promise.resolve("deadbeef"),
          markApplied: () => Promise.resolve(),
          remove: () => Promise.resolve(),
          cleanupMerged: () => Promise.resolve(),
        },
        commandError: (code, message) => Object.assign(new Error(message), { code }),
      };
      return { controller: createEnsembleController(deps), memberSpecs };
    };

    const { controller, memberSpecs } = buildHarnessFromLog();
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_init").execute({ title: "Mention Semantics Test" }, {} as never);
    // 1) 精确成员 fix 与 fix-1 共存；组 grp-1/grp-2（无精确 grp）；单人组 solo-1
    for (const name of ["fix", "fix-1", "grp-1", "grp-2", "solo-1"]) {
      await byName("ensemble_add_member").execute(
        { name, charter: { owns: name, handsOff: "other", doneWhen: "done" } },
        {} as never,
      );
    }
    // charter 占用 #1..#5

    // #6: maestro @fix -> 精确解析为 fix（mentions=["fix"], recipients=["fix"]），不得推成 fix-1
    await byName("ensemble_post").execute({ text: "@fix exact target only" }, {} as never);
    // #7: fix-1 @fix -> 同样精确解析为 fix，作者 fix-1 也不得命中自己名字
    const fix1Post = must(
      must(memberSpecs.get("fix-1")).extraTools.find((t) => t.name === "ensemble_post"),
    );
    await fix1Post.execute({ text: "@fix fix-1 asks exact fix" }, {} as never);
    // #8: maestro @fix-1 -> 只命中 fix-1
    await byName("ensemble_post").execute({ text: "@fix-1 suffix exact only" }, {} as never);

    // #9: maestro @grp -> 组解析为当时在场成员 grp-1, grp-2
    await byName("ensemble_post").execute({ text: "@grp initial group broadcast" }, {} as never);
    // #10: 组成员 grp-1 向自己所属组 @grp 发帖（recipients 排除自身只有 grp-2，但 grp-1 仍是发帖时组内成员）
    const grp1Post = must(
      must(memberSpecs.get("grp-1")).extraTools.find((t) => t.name === "ensemble_post"),
    );
    await grp1Post.execute({ text: "@grp member post to own group" }, {} as never);
    // #11: 单成员组 solo-1 向自己组 @solo 发帖（recipients=[]）
    const solo1Post = must(
      must(memberSpecs.get("solo-1")).extraTools.find((t) => t.name === "ensemble_post"),
    );
    await solo1Post.execute({ text: "@solo solo group post" }, {} as never);

    // #12: @all 视为提及每个人
    await grp1Post.execute({ text: "@all announcement for everyone" }, {} as never);

    // 之后新增 grp-3 与 solo-2
    await byName("ensemble_add_member").execute(
      { name: "grp-3", charter: { owns: "grp-3", handsOff: "other", doneWhen: "done" } },
      {} as never,
    );
    await byName("ensemble_add_member").execute(
      { name: "solo-2", charter: { owns: "solo-2", handsOff: "other", doneWhen: "done" } },
      {} as never,
    );
    // charter 占用 #13, #14

    // #15: 新增 grp-3 之后再发一条 @grp，此帖才命中 grp-3
    await byName("ensemble_post").execute({ text: "@grp after grp-3 joined" }, {} as never);

    const assertMentions = async (c: ReturnType<typeof createEnsembleController>) => {
      const readTool = must(c.maestroTools().find((t) => t.name === "ensemble_read"));
      const readMention = async (mention: string) => {
        const res = await readTool.execute({ mention, limit: 50 }, {} as never);
        expect(res.status).toBe("ok");
        return (res.output as EnsembleReadOutput).posts.map((p) => p.number);
      };

      // 精确 fix 与 fix-1 共存：@fix（#6, #7）只命中 fix，绝不命中 fix-1；@fix-1（#8）只命中 fix-1；@all（#12）命中每人
      expect(await readMention("fix")).toEqual([6, 7, 12]);
      expect(await readMention("fix-1")).toEqual([8, 12]);

      // 历史组提及：#9, #10 命中 grp-1, grp-2；#15 命中 grp-1, grp-2, grp-3；@all（#12）命中每人
      expect(await readMention("grp-1")).toEqual([9, 10, 12, 15]);
      expect(await readMention("grp-2")).toEqual([9, 10, 12, 15]);
      // 后来加入的 grp-3 绝不匹配历史 #9, #10，只匹配加入后的 #15 和 @all(#12)
      expect(await readMention("grp-3")).toEqual([12, 15]);
      expect(await readMention("grp")).toEqual([9, 10, 12, 15]);

      // 单成员组：solo-1 命中 #11 与 @all(#12)，后加入的 solo-2 只命中 @all(#12)
      expect(await readMention("solo-1")).toEqual([11, 12]);
      expect(await readMention("solo-2")).toEqual([12]);
      expect(await readMention("solo")).toEqual([11, 12]);

      // @all 自身与 maestro
      expect(await readMention("all")).toEqual([12]);
      expect(await readMention("maestro")).toEqual([12]);
    };

    // 实时状态验证
    await assertMentions(controller);

    // 从持久日志重启重建控制器，验证完全一致（无新增事件）
    const reloaded = buildHarnessFromLog().controller;
    await reloaded.initializeFromLog();
    await assertMentions(reloaded);
  });

  it("Runtime 端到端生命周期：ensemble_read 与 replaySessionView ensemble.posts 对照一致，且回退到建立之后/之前并恢复均保持一致", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = path.join(ws, ".sessions");

    let maestroPhase: "t1" | "t1-read" | "t2" | "t2-read" | "t3" | "t4" | "after-end" = "t1";
    let t1Step = 0;
    let t2Step = 0;
    let workerReplied = false;
    let extraReplied = false;

    const provider = createFakeProvider((_req, role) => {
      if (role === "member:worker") {
        if (!workerReplied) {
          workerReplied = true;
          return [
            callTool("w-post-1", "ensemble_post", { text: "@maestro worker turn1 done" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("worker ok");
      }
      if (role === "member:extra") {
        if (!extraReplied) {
          extraReplied = true;
          return [
            callTool("e-post-1", "ensemble_post", { text: "@maestro extra turn2 done" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("extra ok");
      }

      if (maestroPhase === "t1") {
        t1Step++;
        if (t1Step === 1) {
          return [
            callTool("init", "ensemble_init", { title: "Rewind Consistency" }),
            callTool("add-w", "ensemble_add_member", {
              name: "worker",
              charter: { owns: "w", handsOff: "e", doneWhen: "w done" },
            }),
            callTool("post-1", "ensemble_post", { text: "@worker turn1 task" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("t1 ok");
      }
      if (maestroPhase === "t2") {
        t2Step++;
        if (t2Step === 1) {
          return [
            callTool("add-e", "ensemble_add_member", {
              name: "extra",
              charter: { owns: "e", handsOff: "w", doneWhen: "e done" },
            }),
            callTool("post-2", "ensemble_post", { text: "@extra turn2 task" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("t2 ok");
      }
      if (
        maestroPhase === "t1-read" ||
        maestroPhase === "t2-read" ||
        maestroPhase === "t3" ||
        maestroPhase === "t4" ||
        maestroPhase === "after-end"
      ) {
        // 只在尚未调用 ensemble_read 的这一步调用一次
        const toolMsgs = _req.messages.filter((m) => m.role === "tool");
        const lastUserIdx = _req.messages.findLastIndex(
          (m) => m.role === "user" && !JSON.stringify(m.content).includes("<ensemble-post"),
        );
        const toolsInThisTurn = toolMsgs.filter(
          (m) => _req.messages.indexOf(m) > lastUserIdx,
        ).length;
        if (toolsInThisTurn === 0) {
          return [
            callTool(`read-${maestroPhase}`, "ensemble_read", { limit: 50 }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText(`${maestroPhase} ok`);
      }
      return stopText("ok");
    });

    const rt1 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const maestro = await rt1.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openSessions.push(maestro);

    const assertLastReadMatchesReplay = (session: RuntimeSession) => {
      const completed = must(
        session
          .durableEvents()
          .findLast(
            (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
              e.type === "tool.completed" && e.payload.name === "ensemble_read",
          ),
      );
      expect(completed.payload.status).toBe("ok");
      const out = completed.payload.output as EnsembleReadOutput;
      const viewPosts = must(replaySessionView(session.durableEvents()).ensemble).posts;
      expect(out.posts).toEqual(
        viewPosts.map((p) => ({
          number: p.number,
          from: p.from,
          fromKind: p.fromKind,
          text: p.text,
          mentions: p.mentions,
        })),
      );
      return out;
    };

    // Turn 1：建立合奏并等待 worker 回复完成，随后调用 ensemble_read 与 replaySessionView 对照
    await maestro.submit({ text: "launch ensemble turn 1", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        expect(workerReplied).toBe(true);
        expect(maestro.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    maestroPhase = "t1-read";
    await maestro.submit({ text: "read board after turn 1" });
    const out1 = assertLastReadMatchesReplay(maestro);
    expect(out1.posts.some((p) => p.text.includes("worker turn1 done"))).toBe(true);

    // Turn 2：合奏建立之后继续添成员和发帖，再等待 extra 回复完成并对照 replaySessionView
    maestroPhase = "t2";
    await maestro.submit({ text: "follow up turn 2" });
    await vi.waitFor(
      () => {
        expect(extraReplied).toBe(true);
        expect(maestro.isIdle()).toBe(true);
      },
      { timeout: 10_000 },
    );
    maestroPhase = "t2-read";
    await maestro.submit({ text: "read board after turn 2" });
    const out2 = assertLastReadMatchesReplay(maestro);
    expect(out2.members.map((m) => m.name)).toEqual(["worker", "extra"]);

    const targets = await maestro.rewindTargets();
    const turn1Target = must(targets.find((t) => t.text.includes("launch ensemble turn 1")));
    const turn2Target = must(targets.find((t) => t.text === "follow up turn 2"));

    // 1) 回退到合奏建立之后（turn2Target）：Turn 2 新增成员与帖子回退，合奏保持 active
    await maestro.rewind(turn2Target.seq, "conversation");
    const afterMidRewindView = replaySessionView(maestro.durableEvents()).ensemble;
    expect(afterMidRewindView?.status).toBe("active");
    expect(afterMidRewindView?.members.map((m) => m.name)).toEqual(["worker"]);

    maestroPhase = "t3";
    await maestro.submit({ text: "verify board after mid rewind" });
    const out3 = assertLastReadMatchesReplay(maestro);
    expect(out3.members.map((m) => m.name)).toEqual(["worker"]);
    expect(out3.posts.some((p) => p.text.includes("turn2"))).toBe(false);

    // 关闭并恢复：ensemble_read 与 replaySessionView 依然完全一致
    const maestroId = maestro.id;
    await maestro.close();
    openSessions.splice(openSessions.indexOf(maestro), 1);

    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const resumed = await rt2.resumeSession(maestroId);
    openSessions.push(resumed);

    maestroPhase = "t4";
    await resumed.submit({ text: "verify board after resume" });
    const out4 = assertLastReadMatchesReplay(resumed);
    expect(out4.members.map((m) => m.name)).toEqual(["worker"]);

    // 2) 回退到合奏建立之前（turn1Target）：合奏结束，ensemble_read 卸载且不可用，编辑工具恢复
    await resumed.rewind(turn1Target.seq, "conversation");
    const afterFullRewindView = replaySessionView(resumed.durableEvents()).ensemble;
    expect(afterFullRewindView?.status).toBe("ended");
    expect(afterFullRewindView?.endedReason).toBe("rewound");
    expect(resumed.describeContext().request.tools.map((t) => t.name)).not.toContain(
      "ensemble_read",
    );
    expect(resumed.describeContext().request.tools.map((t) => t.name)).toContain("write");

    maestroPhase = "after-end";
    await resumed.submit({ text: "try ensemble_read after rewind before init" });
    const afterRewindReadEv = must(
      resumed
        .durableEvents()
        .findLast(
          (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
            e.type === "tool.completed" && e.payload.name === "ensemble_read",
        ),
    );
    expect(afterRewindReadEv.payload.status).toBe("error");
    expect(afterRewindReadEv.payload.error?.code).toBe("unknown_tool");

    // 再次关闭并恢复：保持结束态，ensemble_read 依然卸载
    await resumed.close();
    openSessions.splice(openSessions.indexOf(resumed), 1);
    const rt3 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const resumedAfterEnd = await rt3.resumeSession(maestroId);
    openSessions.push(resumedAfterEnd);
    const resumedEndView = replaySessionView(resumedAfterEnd.durableEvents()).ensemble;
    expect(resumedEndView?.status).toBe("ended");
    expect(resumedEndView?.endedReason).toBe("rewound");
    expect(resumedAfterEnd.describeContext().request.tools.map((t) => t.name)).not.toContain(
      "ensemble_read",
    );
    expect(resumedAfterEnd.describeContext().request.tools.map((t) => t.name)).toContain("write");
  });
});
