/**
 * ADR-0131 合奏概览（ensemble_overview）单元与集成测试：
 * 规范化与校验、原子性（失败零写入）、base 乐观并发、同输入幂等重试、
 * 线排序与级联删除、负责人/帖号引用校验、重启恢复与跨重启幂等、
 * 结束后拒绝更新且快照保留、ensemble_read 附带概览。
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
  type EnsembleOverviewWriteOutput,
  type EnsembleReadOutput,
  type EnsembleWorktreeHandle,
  type ManagedMemberSession,
} from "../src/ensemble/index.js";
import { createRuntime, type RuntimeSession } from "../src/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
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

function makeTempDir(prefix = "nocturne-ensemble-ov-"): string {
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
  writeFileSync(path.join(dir, "README.md"), "# Ensemble Overview Test\n", "utf8");
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
  const worktrees = new Map<string, EnsembleWorktreeHandle>();

  durable.push({
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
  });

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
  return { controller, durable, memberSpecs, deps };
}

async function setupEnsemble(
  controller: ReturnType<typeof makeControllerHarness>["controller"],
  memberNames: string[] = ["impl-1"],
) {
  const tools = controller.maestroTools();
  const byName = (name: string) => must(tools.find((t) => t.name === name));
  await byName("ensemble_init").execute({ title: "Overview Test" }, {} as never);
  for (const name of memberNames) {
    await byName("ensemble_add_member").execute(
      {
        name,
        charter: { owns: `${name} scope`, handsOff: "rest", doneWhen: `${name} done` },
      },
      {} as never,
    );
  }
  return byName;
}

const INITIAL_PLAN = {
  goal: "把设置页迁移到新表单组件并补齐测试",
  checkpoints: ["表单组件迁移完成", "测试全绿"],
  lines: [
    {
      id: "line-settings",
      title: "设置页迁移",
      owner: "impl-1",
      progress: { text: "进行中" },
    },
  ],
  tasks: [
    {
      id: "task-migrate",
      line: "line-settings",
      title: "迁移表单组件",
      status: "work",
      owner: "impl-1",
    },
    {
      id: "task-test",
      line: "line-settings",
      title: "补测试",
      status: "todo",
      owner: "impl-1",
    },
  ],
};

describe("ADR-0131 ensemble_overview 控制器单元测试", { timeout: 30_000 }, () => {
  it("首次写入 base=0 成功，revision=1；视图归约得到完整概览结构", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    const res = await tool.execute({ base: 0, ...INITIAL_PLAN }, {} as never);
    expect(res.status).toBe("ok");
    expect((res.output as EnsembleOverviewWriteOutput).revision).toBe(1);
    expect((res.output as EnsembleOverviewWriteOutput).deduplicated).toBe(false);

    // 恰好多了一条持久事件
    const events = durable.filter((ev) => ev.type === "ensemble.overview_updated");
    expect(events).toHaveLength(1);
    const payload = events[0]?.type === "ensemble.overview_updated" ? events[0].payload : undefined;
    expect(payload?.revision).toBe(1);
    expect(typeof payload?.fingerprint).toBe("string");

    // 视图归约出完整结构
    const view = replaySessionView(durable);
    const overview = must(view.ensemble?.overview);
    expect(overview.revision).toBe(1);
    expect(overview.goal).toBe(INITIAL_PLAN.goal);
    expect(overview.checkpoints).toEqual(INITIAL_PLAN.checkpoints);
    expect(overview.lines).toHaveLength(1);
    expect(overview.lines[0]?.title).toBe("设置页迁移");
    expect(overview.lines[0]?.progress?.text).toBe("进行中");
    expect(overview.lines[0]?.tasks.map((t) => t.id)).toEqual(["task-migrate", "task-test"]);
    expect(overview.lines[0]?.tasks[0]?.status).toBe("work");
  });

  it("base 不匹配的旧更新被拒绝且不写事件；正确的 base 接受后 revision 递增", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute({ base: 0, ...INITIAL_PLAN }, {} as never);
    const before = durable.filter((ev) => ev.type === "ensemble.overview_updated").length;

    // 过期 base=0 再次写不同内容 → 拒绝
    const stale = await tool.execute(
      { base: 0, tasks: [{ id: "task-migrate", line: "line-settings", status: "done" }] },
      {} as never,
    );
    expect(stale.status).toBe("error");
    expect(stale.modelContent).toContain("does not match the current revision");
    expect(durable.filter((ev) => ev.type === "ensemble.overview_updated")).toHaveLength(before);
    // 状态未被覆盖：任务仍是 work
    let view = replaySessionView(durable);
    expect(view.ensemble?.overview?.lines[0]?.tasks[0]?.status).toBe("work");

    // 正确 base=1 接受
    const ok = await tool.execute(
      { base: 1, tasks: [{ id: "task-migrate", line: "line-settings", status: "done" }] },
      {} as never,
    );
    expect(ok.status).toBe("ok");
    expect((ok.output as EnsembleOverviewWriteOutput).revision).toBe(2);
    view = replaySessionView(durable);
    expect(view.ensemble?.overview?.revision).toBe(2);
    expect(view.ensemble?.overview?.lines[0]?.tasks[0]?.status).toBe("done");
  });

  it("幂等重试：完全相同的输入重复提交返回成功且不新增 revision 与事件", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    const input = {
      base: 0,
      ...INITIAL_PLAN,
    };
    const first = await tool.execute(input, {} as never);
    expect(first.status).toBe("ok");
    expect((first.output as EnsembleOverviewWriteOutput).revision).toBe(1);
    expect((first.output as EnsembleOverviewWriteOutput).deduplicated).toBe(false);
    const eventsAfterFirst = durable.filter((ev) => ev.type === "ensemble.overview_updated").length;

    // 完全相同的输入重试（即使 base 现在已过期）→ 幂等成功
    const retry = await tool.execute(input, {} as never);
    expect(retry.status).toBe("ok");
    expect((retry.output as EnsembleOverviewWriteOutput).revision).toBe(1);
    expect((retry.output as EnsembleOverviewWriteOutput).deduplicated).toBe(true);
    expect(durable.filter((ev) => ev.type === "ensemble.overview_updated")).toHaveLength(
      eventsAfterFirst,
    );

    // 中间插入新更新后再重试旧输入 → 正常 base 拒绝而非幂等通过
    await tool.execute(
      { base: 1, tasks: [{ id: "task-test", line: "line-settings", status: "work" }] },
      {} as never,
    );
    const staleRetry = await tool.execute(input, {} as never);
    expect(staleRetry.status).toBe("error");
  });

  it("重试同一 upsert 不会复制任务：相同 id 原地更新", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute({ base: 0, ...INITIAL_PLAN }, {} as never);
    // 合法的幂等语义：同 id upsert 多次不产生重复任务
    await tool.execute(
      { base: 1, tasks: [{ id: "task-migrate", line: "line-settings", status: "wait" }] },
      {} as never,
    );
    await tool.execute(
      { base: 2, tasks: [{ id: "task-migrate", line: "line-settings", status: "wait" }] },
      {} as never,
    );
    const view = replaySessionView(durable);
    const tasks = view.ensemble?.overview?.lines[0]?.tasks ?? [];
    expect(tasks.filter((t) => t.id === "task-migrate")).toHaveLength(1);
    expect(tasks.find((t) => t.id === "task-migrate")?.status).toBe("wait");
  });

  it("原子校验：多个错误一次性返回且零写入（未知负责人、缺失必填、环引用 before、未发帖子）", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute({ base: 0, ...INITIAL_PLAN }, {} as never);
    const eventsBefore = durable.length;

    const bad = await tool.execute(
      {
        base: 1,
        lines: [
          { id: "line-bad-owner", title: "x", owner: "ghost-member" },
          { id: "line-no-title", owner: "impl-1" },
          { id: "line-new-a", title: "a", owner: "impl-1", before: "line-never-exists" },
        ],
        tasks: [
          {
            id: "task-x",
            line: "line-settings",
            title: "x",
            status: "work",
            owner: "impl-1",
            post: 99,
          },
          { id: "task-no-line", line: "line-missing", title: "y", status: "todo", owner: "impl-1" },
        ],
      },
      {} as never,
    );
    expect(bad.status).toBe("error");
    expect(bad.modelContent).toContain('unknown owner "ghost-member"');
    expect(bad.modelContent).toContain("new lines require a non-empty");
    expect(bad.modelContent).toContain('before` target "line-never-exists" is not a known line');
    expect(bad.modelContent).toContain("post #99 does not exist yet");
    expect(bad.modelContent).toContain('line "line-missing" does not exist');
    // 零写入
    expect(durable).toHaveLength(eventsBefore);
    const view = replaySessionView(durable);
    expect(view.ensemble?.overview?.lines).toHaveLength(1);
    expect(view.ensemble?.overview?.lines[0]?.tasks).toHaveLength(2);
  });

  it("before 排序：同批靠前新建的线可作为插入目标；移动既有线", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute(
      {
        base: 0,
        lines: [
          { id: "line-a", title: "A", owner: "impl-1" },
          { id: "line-c", title: "C", owner: "impl-1" },
        ],
      },
      {} as never,
    );
    // 同批：先新建 line-b（before line-c），再把 line-a 移到 line-c 前
    const res = await tool.execute(
      {
        base: 1,
        lines: [
          { id: "line-b", title: "B", owner: "impl-1", before: "line-c" },
          { id: "line-a", before: "line-b" },
        ],
      },
      {} as never,
    );
    expect(res.status).toBe("ok");
    const view = replaySessionView(durable);
    expect(view.ensemble?.overview?.lines.map((l) => l.id)).toEqual(["line-a", "line-b", "line-c"]);
  });

  it("移除线级联删除其任务；upsert+remove 同 id 报错；remove 未知 id 幂等忽略", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute({ base: 0, ...INITIAL_PLAN }, {} as never);

    const conflict = await tool.execute(
      { base: 1, lines: [{ id: "line-settings", title: "x" }], removeLines: ["line-settings"] },
      {} as never,
    );
    expect(conflict.status).toBe("error");
    expect(conflict.modelContent).toContain("appears in both lines and removeLines");

    const res = await tool.execute(
      {
        base: 1,
        removeLines: ["line-settings", "line-never-existed"],
        removeTasks: ["task-never-existed"],
      },
      {} as never,
    );
    expect(res.status).toBe("ok");
    const view = replaySessionView(durable);
    expect(view.ensemble?.overview?.lines).toHaveLength(0);
  });

  it("任务跨线移动；负责人允许引用已移除成员；goal 清除与 checkpoints 替换", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller, ["impl-1", "verify-1"]);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute(
      {
        base: 0,
        goal: "g",
        lines: [
          { id: "l1", title: "L1", owner: "impl-1" },
          { id: "l2", title: "L2", owner: "maestro" },
        ],
        tasks: [{ id: "t1", line: "l1", title: "T1", status: "todo", owner: "impl-1" }],
      },
      {} as never,
    );

    // 移除成员 verify-1 后仍可引用其名字（历史归属），但引用从未加入的成员被拒绝
    await must(controller.maestroTools().find((t) => t.name === "ensemble_remove_member")).execute(
      { name: "verify-1", reason: "done" },
      {} as never,
    );
    const res = await tool.execute(
      {
        base: 1,
        tasks: [{ id: "t1", line: "l2", owner: "verify-1", status: "done" }],
        goal: null,
        checkpoints: ["only one"],
      },
      {} as never,
    );
    expect(res.status).toBe("ok");
    const view = replaySessionView(durable);
    const ov = must(view.ensemble?.overview);
    expect(ov.goal).toBeUndefined();
    expect(ov.checkpoints).toEqual(["only one"]);
    expect(ov.lines.find((l) => l.id === "l1")?.tasks).toHaveLength(0);
    const moved = ov.lines.find((l) => l.id === "l2")?.tasks;
    expect(moved).toHaveLength(1);
    expect(moved?.[0]?.owner).toBe("verify-1");
    expect(moved?.[0]?.status).toBe("done");
  });

  it("progress 可清除（null），wait 标记往返一致；帖号引用在发帖后接受", async () => {
    const { controller, durable } = makeControllerHarness();
    const byName = await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    // 发一帖（charter #1 已存在；这条是 #2）
    await byName("ensemble_post").execute({ text: "@impl-1 开始实现" }, {} as never);

    const res = await tool.execute(
      {
        base: 0,
        lines: [
          {
            id: "l1",
            title: "L1",
            owner: "impl-1",
            post: 2,
            progress: { text: "等 verify-1 确认", post: 2, wait: true },
          },
        ],
      },
      {} as never,
    );
    expect(res.status).toBe("ok");
    let view = replaySessionView(durable);
    let line = must(view.ensemble?.overview?.lines[0]);
    expect(line.post).toBe(2);
    expect(line.progress?.wait).toBe(true);
    expect(line.progress?.post).toBe(2);

    const cleared = await tool.execute(
      { base: 1, lines: [{ id: "l1", progress: null, post: null }] },
      {} as never,
    );
    expect(cleared.status).toBe("ok");
    view = replaySessionView(durable);
    line = must(view.ensemble?.overview?.lines[0]);
    expect(line.progress).toBeUndefined();
    expect(line.post).toBeUndefined();
  });

  it("输入形状校验：未知字段、非法 status、空 title、非整数 base 一次性报错", async () => {
    const { controller } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    const res = await tool.execute(
      {
        base: -1,
        bogus: true,
        lines: [{ id: "l", title: "  " }],
        tasks: [{ id: "t", line: "l", status: "running" }],
      },
      {} as never,
    );
    expect(res.status).toBe("error");
    expect(res.modelContent).toContain('Unknown field "bogus"');
    expect(res.modelContent).toContain("non-negative integer");
    expect(res.modelContent).toContain("must not be empty");
    expect(res.modelContent).toContain("must be one of todo, work, wait, done");
  });

  it("ensemble_read 输出附带概览快照与 revision 提示；未写入时提示 base: 0", async () => {
    const { controller } = makeControllerHarness();
    await setupEnsemble(controller);
    const readTool = must(controller.maestroTools().find((t) => t.name === "ensemble_read"));

    const before = await readTool.execute({}, {} as never);
    expect(before.status).toBe("ok");
    expect((before.output as EnsembleReadOutput).overview).toBeUndefined();
    expect(before.modelContent).toContain("# Overview (revision 0)");
    expect(before.modelContent).toContain("base: 0");

    await must(controller.maestroTools().find((t) => t.name === "ensemble_overview")).execute(
      { base: 0, ...INITIAL_PLAN },
      {} as never,
    );

    const after = await readTool.execute({}, {} as never);
    const output = after.output as EnsembleReadOutput;
    expect(output.overview?.revision).toBe(1);
    expect(output.overview?.goal).toBe(INITIAL_PLAN.goal);
    expect(output.overview?.lines[0]?.tasks).toHaveLength(2);
    expect(after.modelContent).toContain("# Overview (revision 1)");
    expect(after.modelContent).toContain("goal: 把设置页迁移到新表单组件并补齐测试");
    expect(after.modelContent).toContain("pass base: 1");
  });

  it("结束后拒绝更新；结束快照在视图中保留；新一场合奏不继承旧概览", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tools = controller.maestroTools();
    const byName = (name: string) => must(tools.find((t) => t.name === name));

    await byName("ensemble_overview").execute({ base: 0, ...INITIAL_PLAN }, {} as never);
    await byName("ensemble_end").execute({ summary: "done" }, {} as never);

    // 结束后调用拒绝（控制器侧）；且工具集已卸载在 Runtime 层由 syncMaestroTools 负责
    const endRes = await byName("ensemble_overview").execute(
      { base: 1, goal: "late" },
      {} as never,
    );
    expect(endRes.status).toBe("error");
    expect(endRes.modelContent).toContain("No active ensemble");

    // 快照保留在视图
    let view = replaySessionView(durable);
    expect(view.ensemble?.status).toBe("ended");
    expect(view.ensemble?.overview?.revision).toBe(1);
    expect(view.ensemble?.overview?.lines).toHaveLength(1);

    // 新一场合奏：概览重置为空（新 created 后 view 重建）
    await byName("ensemble_init").execute({ title: "Second Round" }, {} as never);
    view = replaySessionView(durable);
    expect(view.ensemble?.status).toBe("active");
    expect(view.ensemble?.overview).toBeUndefined();

    // 新一场 base 从 0 开始
    const res = await byName("ensemble_overview").execute(
      { base: 0, goal: "new goal" },
      {} as never,
    );
    expect(res.status).toBe("ok");
    expect((res.output as EnsembleOverviewWriteOutput).revision).toBe(1);
  });

  it("回退到建立点之前：重建后概览消失；回退到中间点：概览回到当时状态", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute({ base: 0, goal: "first" }, {} as never);
    await tool.execute({ base: 1, goal: "second" }, {} as never);

    // 模拟回退：截断到第一次 overview 更新之后（视图层语义由 replay + 截断验证）
    const idxSecond = durable.findIndex(
      (ev) => ev.type === "ensemble.overview_updated" && ev.payload.revision === 2,
    );
    expect(idxSecond).toBeGreaterThan(-1);
    const truncated = durable.slice(0, idxSecond);
    let view = replaySessionView(truncated);
    expect(view.ensemble?.overview?.goal).toBe("first");
    expect(view.ensemble?.overview?.revision).toBe(1);

    const idxFirst = durable.findIndex((ev) => ev.type === "ensemble.overview_updated");
    const beforeAny = durable.slice(0, idxFirst);
    view = replaySessionView(beforeAny);
    expect(view.ensemble?.overview).toBeUndefined();
  });
});

describe("ADR-0131 ensemble_overview Runtime 集成测试", { timeout: 30_000 }, () => {
  it("事件日志 encode/decode 往返一致；重启后指纹幂等仍生效", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = path.join(ws, ".sessions");

    // ── 第一次启动：写入概览两次，第二次与第一次相同（验证跨重启幂等） ──
    const plan = {
      goal: "集成验收",
      lines: [{ id: "l1", title: "线一", owner: "maestro" }],
      tasks: [{ id: "t1", line: "l1", title: "任务一", status: "work", owner: "maestro" }],
    };
    let step = 0;
    const provider1 = createFakeProvider((_req, role) => {
      if (role !== "maestro") return stopText("member idle");
      step++;
      if (step === 1) {
        return [
          callTool("init", "ensemble_init", { title: "Restart Test" }),
          callTool("ov1", "ensemble_overview", { base: 0, ...plan }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (step === 2) {
        // 同输入重试（base 此时已过期——幂等应兜底）
        return [
          callTool("ov1-retry", "ensemble_overview", { base: 0, ...plan }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (step === 3) {
        return [
          callTool("ov2", "ensemble_overview", {
            base: 1,
            tasks: [{ id: "t1", line: "l1", status: "done" }],
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("done");
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
    openSessions.push(s1);
    await s1.submit({ text: "go", workMode: "ensemble" });
    // 等待若干轮工具循环完成
    const waitFor = async (fn: () => boolean, ms = 8000) => {
      await vi.waitFor(fn, { timeout: ms, interval: 25 });
    };
    await waitFor(() =>
      s1
        .durableEvents()
        .some((ev) => ev.type === "ensemble.overview_updated" && ev.payload.revision === 2),
    );
    const events = s1.durableEvents().filter((ev) => ev.type === "ensemble.overview_updated");
    // 幂等重试不写第二条 rev=1 事件：总共只有 rev1 + rev2 两条
    expect(
      events.map((ev) => (ev.type === "ensemble.overview_updated" ? ev.payload.revision : 0)),
    ).toEqual([1, 2]);

    // 事件 encode/decode 往返保持一致（持久化格式验证）
    for (const ev of s1.durableEvents()) {
      if (ev.type !== "ensemble.overview_updated") continue;
      const roundTripped = decodeDurableEvent(encodeDurableEvent(ev));
      expect(roundTripped.type).toBe("ensemble.overview_updated");
      if (roundTripped.type === "ensemble.overview_updated") {
        expect(roundTripped.payload).toEqual(ev.payload);
      }
    }

    const sessionId = s1.id;
    await s1.close();
    openSessions.length = 0;

    // ── 重启恢复：概览镜像、revision 与指纹从日志重建 ──
    let step2 = 0;
    const provider2 = createFakeProvider((_req, role) => {
      if (role !== "maestro") return stopText("member idle");
      step2++;
      if (step2 === 1) {
        return [callTool("read", "ensemble_read", {}), { type: "finish", reason: "tool_calls" }];
      }
      if (step2 === 2) {
        // 重试与重启前最后一次成功更新相同的输入 → 跨重启幂等命中
        return [
          callTool("ov2-retry", "ensemble_overview", {
            base: 1,
            tasks: [{ id: "t1", line: "l1", status: "done" }],
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (step2 === 3) {
        // 正确的后续更新 base=2
        return [
          callTool("ov3", "ensemble_overview", { base: 2, goal: "重启后续写" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("done");
    });

    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider2],
      interactive: true,
      subagent: { background: true },
    });
    const s2 = await rt2.resumeSession(sessionId);
    openSessions.push(s2);

    // 恢复后视图立刻可见完整概览（只读快照）
    const restored = replaySessionView(s2.durableEvents()).ensemble?.overview;
    expect(restored).toBeDefined();
    expect(restored?.revision).toBe(2);
    expect(restored?.goal).toBe("集成验收");
    expect(restored?.lines[0]?.tasks[0]?.status).toBe("done");

    // 通过用户消息触发指挥 turn（ensemble 恢复后成员帖唤醒复杂，直接发普通消息走 maestro turn）
    await s2.submit({ text: "continue" });
    await waitFor(() =>
      s2
        .durableEvents()
        .some((ev) => ev.type === "ensemble.overview_updated" && ev.payload.revision === 3),
    );

    // 跨重启幂等：rev=2 没有重复事件；rev=3 正常追加
    const events2 = s2.durableEvents().filter((ev) => ev.type === "ensemble.overview_updated");
    const revisions = events2.map((ev) =>
      ev.type === "ensemble.overview_updated" ? ev.payload.revision : 0,
    );
    expect(revisions).toEqual([1, 2, 3]);
    expect(replaySessionView(s2.durableEvents()).ensemble?.overview?.goal).toBe("重启后续写");
  });

  it("持久写失败：revision/指纹/视图不推进，错误显式可重试；相同请求重试成功且不误去重", async () => {
    const { controller, durable, deps } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    // 基线写入 rev1
    const first = await tool.execute({ base: 0, goal: "基线目标" }, {} as never);
    expect(first.status).toBe("ok");
    expect((first.output as EnsembleOverviewWriteOutput).revision).toBe(1);

    // 劫持 emitDurable 仅对 ensemble.overview_updated 失败一次
    const originalEmit = deps.emitDurable;
    let failWrites = true;
    deps.emitDurable = (type, payload) => {
      if (type === "ensemble.overview_updated" && failWrites) {
        return Promise.reject(new Error("simulated disk full"));
      }
      return originalEmit(type, payload);
    };

    const input = {
      base: 1,
      tasks: [{ id: "t-x", line: "line-x", title: "x", status: "todo", owner: "impl-1" }],
      lines: [{ id: "line-x", title: "线", owner: "impl-1" }],
    };
    const failed = await tool.execute(input, {} as never);
    expect(failed.status).toBe("error");
    expect(failed.modelContent).toContain("nothing was written");
    expect(failed.modelContent).toContain("safe to retry");

    // 未落盘进展不得被当作成功：事件没有多写、视图与 revision 仍是旧状态
    expect(durable.filter((ev) => ev.type === "ensemble.overview_updated")).toHaveLength(1);
    const viewBefore = replaySessionView(durable);
    expect(viewBefore.ensemble?.overview?.revision).toBe(1);
    expect(viewBefore.ensemble?.overview?.lines).toHaveLength(0);

    // 相同请求重试：不能被误去重（第一次并未成功落盘），必须真正执行写入
    failWrites = false;
    const retry = await tool.execute(input, {} as never);
    expect(retry.status).toBe("ok");
    expect((retry.output as EnsembleOverviewWriteOutput).revision).toBe(2);
    expect((retry.output as EnsembleOverviewWriteOutput).deduplicated).toBe(false);
    expect(durable.filter((ev) => ev.type === "ensemble.overview_updated")).toHaveLength(2);
    const viewAfter = replaySessionView(durable);
    expect(viewAfter.ensemble?.overview?.revision).toBe(2);
    expect(viewAfter.ensemble?.overview?.lines[0]?.tasks[0]?.id).toBe("t-x");

    // 第三次相同输入才是真正的幂等重试
    const dedup = await tool.execute(input, {} as never);
    expect(dedup.status).toBe("ok");
    expect((dedup.output as EnsembleOverviewWriteOutput).deduplicated).toBe(true);
    expect(durable.filter((ev) => ev.type === "ensemble.overview_updated")).toHaveLength(2);

    deps.emitDurable = originalEmit;
  });

  it("同基线并发竞争：串行化后恰有一次接受，另一次以 base 不匹配拒绝或幂等去重，revision 连续", async () => {
    const { controller, durable } = makeControllerHarness();
    await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    await tool.execute({ base: 0, goal: "并发基线" }, {} as never);

    // 并发触发两个同 base=1 的不同更新（不 await，直接同 tick 发出）
    const inputA = { base: 1, goal: "更新A" };
    const inputB = { base: 1, lines: [{ id: "line-b", title: "B线", owner: "impl-1" }] };
    const [resA, resB] = await Promise.all([
      tool.execute(inputA, {} as never),
      tool.execute(inputB, {} as never),
    ]);

    const results = [resA, resB];
    const accepted = results.filter((r) => r.status === "ok");
    const rejected = results.filter((r) => r.status === "error");
    // 恰一次成功一次拒绝：串行队列保证后入队者看到 rev 已推进
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.modelContent).toContain("does not match the current revision");

    // revision 连续、视图与事件一致
    const events = durable.filter((ev) => ev.type === "ensemble.overview_updated");
    expect(
      events.map((ev) => (ev.type === "ensemble.overview_updated" ? ev.payload.revision : 0)),
    ).toEqual([1, 2]);
    const view = replaySessionView(durable);
    expect(view.ensemble?.overview?.revision).toBe(2);

    // 相同输入并发（两个完全相同的更新）：一个写入、一个幂等去重，不产生重复事件
    const inputC = { base: 2, goal: "相同并发" };
    const [c1, c2] = await Promise.all([
      tool.execute(inputC, {} as never),
      tool.execute(inputC, {} as never),
    ]);
    const okCount = [c1, c2].filter((r) => r.status === "ok").length;
    expect(okCount).toBe(2);
    const dedupCount = [c1, c2].filter(
      (r) => r.status === "ok" && (r.output as EnsembleOverviewWriteOutput).deduplicated === true,
    ).length;
    expect(dedupCount).toBe(1);
    expect(durable.filter((ev) => ev.type === "ensemble.overview_updated")).toHaveLength(3);
  });

  it("跨线移动保持同一任务 ID 且计数不重复；已移除成员仍可作历史负责人", async () => {
    const { controller, durable } = makeControllerHarness();
    const byName = await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    // 先让指挥发一帖，供帖号引用校验
    await byName("ensemble_post").execute({ text: "@impl-1 开始" }, {} as never);

    await tool.execute(
      {
        base: 0,
        lines: [
          { id: "l1", title: "一线", owner: "maestro" },
          { id: "l2", title: "二线", owner: "maestro" },
        ],
        tasks: [
          { id: "t-move", line: "l1", title: "移交的任务", status: "todo", owner: "maestro" },
          { id: "t2", line: "l2", title: "留守", status: "todo", owner: "maestro" },
        ],
      },
      {} as never,
    );

    // 成员不存在时移交被拒（校验在场身份）
    const reject = await tool.execute(
      { base: 1, tasks: [{ id: "t-move", line: "l2", status: "work", owner: "member-b" }] },
      {} as never,
    );
    expect(reject.status).toBe("error");

    // 加入 member-b 后跨线移交：同一 ID 只出现一次
    await byName("ensemble_add_member").execute(
      { name: "member-b", charter: { owns: "o", handsOff: "h", doneWhen: "d" } },
      {} as never,
    );
    const moved = await tool.execute(
      {
        base: 1,
        tasks: [{ id: "t-move", line: "l2", status: "work", owner: "member-b", post: 1 }],
      },
      {} as never,
    );
    expect(moved.status).toBe("ok");
    let view = replaySessionView(durable);
    expect(view.ensemble?.overview?.lines.find((l) => l.id === "l1")?.tasks).toHaveLength(0);
    const target = view.ensemble?.overview?.lines.find((l) => l.id === "l2");
    expect(target?.tasks.map((t) => t.id).sort()).toEqual(["t-move", "t2"]);
    expect(target?.tasks.find((t) => t.id === "t-move")).toMatchObject({
      status: "work",
      owner: "member-b",
      post: 1,
    });

    // 移除 member-b 后：历史负责人仍合法（ADR-0131 §2）
    await byName("ensemble_remove_member").execute({ name: "member-b" }, {} as never);
    const reassign = await tool.execute(
      {
        base: 2,
        tasks: [
          { id: "t3", line: "l1", title: "交给已移除成员", status: "todo", owner: "member-b" },
        ],
      },
      {} as never,
    );
    expect(reassign.status).toBe("ok");
    view = replaySessionView(durable);
    expect(view.ensemble?.overview?.lines.find((l) => l.id === "l1")?.tasks[0]?.owner).toBe(
      "member-b",
    );

    // 从未在场的名字仍被拒
    const ghost = await tool.execute(
      {
        base: 3,
        tasks: [{ id: "t4", line: "l1", title: "x", status: "todo", owner: "never-existed" }],
      },
      {} as never,
    );
    expect(ghost.status).toBe("error");
    expect(ghost.modelContent).toContain("never-existed");
  });

  it("分叉不继承合奏：新会话视图无 ensemble 与概览；回退到创建之前后概览随 ended 事件留在折叠段", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = path.join(ws, ".sessions");

    let step = 0;
    const provider = createFakeProvider((_req, role) => {
      if (role !== "maestro") return stopText("ok");
      step++;
      if (step === 1) {
        return [
          callTool("init", "ensemble_init", { title: "Fork Boundary" }),
          callTool("ov", "ensemble_overview", {
            base: 0,
            goal: "分叉边界",
            lines: [{ id: "l1", title: "线", owner: "maestro" }],
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("done");
    });
    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    openSessions.push(session);
    await session.submit({ text: "go", workMode: "ensemble" });
    const waitFor = async (fn: () => boolean, ms = 8000) => {
      await vi.waitFor(fn, { timeout: ms, interval: 25 });
    };
    await waitFor(() =>
      session.durableEvents().some((ev) => ev.type === "ensemble.overview_updated"),
    );
    expect(replaySessionView(session.durableEvents()).ensemble?.overview?.goal).toBe("分叉边界");

    // 分叉：新会话不继承合奏（ADR-0089 §9），自然也没有概览
    const forkedId = await rt.forkSession(session.id);
    const forked = await rt.resumeSession(forkedId);
    openSessions.push(forked);
    expect(replaySessionView(forked.durableEvents()).ensemble).toBeUndefined();

    // 回退到建立合奏的用户消息之前：写入 ensemble.ended(reason: "rewound")，视图结束但快照保留
    const goMsg = session
      .durableEvents()
      .find(
        (ev) => ev.type === "message.user" && ev.payload.content.some((b) => b.text.includes("go")),
      );
    expect(goMsg).toBeDefined();
    if (goMsg === undefined) throw new Error("找不到续跑消息");
    await session.rewind(goMsg.seq, "conversation");
    await waitFor(() =>
      session
        .durableEvents()
        .some((ev) => ev.type === "ensemble.ended" && ev.payload.reason === "rewound"),
    );
    const afterRewind = replaySessionView(session.durableEvents()).ensemble;
    expect(afterRewind?.status).toBe("ended");
    expect(afterRewind?.overview?.goal).toBe("分叉边界");
  });

  it("新一场合奏：概览重新从空开始，revision 回到 1，旧场快照留在折叠段", async () => {
    const { controller, durable } = makeControllerHarness();
    const byName = await setupEnsemble(controller);
    const tool = must(controller.maestroTools().find((t) => t.name === "ensemble_overview"));

    const first = await tool.execute(
      { base: 0, goal: "第一场目标", lines: [{ id: "l1", title: "线", owner: "impl-1" }] },
      {} as never,
    );
    expect(first.status).toBe("ok");

    // 结束第一场再开第二场
    await byName("ensemble_end").execute({}, {} as never);
    const reinit = await byName("ensemble_init").execute({ title: "第二场" }, {} as never);
    expect(reinit.status).toBe("ok");

    // 旧概览已清空：base 重新从 0 起；沿用旧 base=1 写新场被拒
    const stale = await tool.execute({ base: 1, goal: "第二场目标" }, {} as never);
    expect(stale.status).toBe("error");
    const second = await tool.execute({ base: 0, goal: "第二场目标" }, {} as never);
    expect(second.status).toBe("ok");
    if (second.status === "ok") {
      expect((second.output as EnsembleOverviewWriteOutput).revision).toBe(1);
    }
    const view = replaySessionView(durable);
    expect(view.ensemble?.overview?.goal).toBe("第二场目标");
    expect(view.ensemble?.overview?.lines).toHaveLength(0);
  });

  it("旧日志（无概览事件）恢复：概览缺省，首次写入 base=0 可用——旧合奏兼容", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = path.join(ws, ".sessions");

    // 第一场：只建合奏不写概览（模拟旧版本日志）
    let step = 0;
    const provider1 = createFakeProvider((_req, role) => {
      if (role !== "maestro") return stopText("ok");
      step++;
      if (step === 1) {
        return [
          callTool("init", "ensemble_init", { title: "Legacy Ensemble" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("done");
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
    openSessions.push(s1);
    await s1.submit({ text: "go", workMode: "ensemble" });
    const waitFor = async (fn: () => boolean, ms = 8000) => {
      await vi.waitFor(fn, { timeout: ms, interval: 25 });
    };
    await waitFor(() => replaySessionView(s1.durableEvents()).ensemble?.status === "active");
    expect(replaySessionView(s1.durableEvents()).ensemble?.overview).toBeUndefined();
    const sessionId = s1.id;
    await s1.close();
    openSessions.length = 0;

    // 重启：旧合奏仍可写第一次概览
    let step2 = 0;
    const provider2 = createFakeProvider((_req, role) => {
      if (role !== "maestro") return stopText("ok");
      step2++;
      if (step2 === 1) {
        return [
          callTool("ov", "ensemble_overview", {
            base: 0,
            goal: "旧合奏补写概览",
            lines: [{ id: "l1", title: "补写", owner: "maestro" }],
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("done");
    });
    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider2],
      interactive: true,
      subagent: { background: true },
    });
    const s2 = await rt2.resumeSession(sessionId);
    openSessions.push(s2);
    await s2.submit({ text: "write overview now" });
    await waitFor(() => s2.durableEvents().some((ev) => ev.type === "ensemble.overview_updated"));
    expect(replaySessionView(s2.durableEvents()).ensemble?.overview?.goal).toBe("旧合奏补写概览");
    expect(replaySessionView(s2.durableEvents()).ensemble?.overview?.revision).toBe(1);
  });
});
