/**
 * 组曲（Suite）一期 Core 集成与单元覆盖测试（ADR-0097）：
 * 全部离线运行（临时 NOCTURNE_HOME 与 FakeProvider），逐项覆盖 ADR-0097 §6 一期验收。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { worktreeGit } from "../src/agent/worktree.js";
import { loadConfig } from "../src/config/index.js";
import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import {
  allPendingPermissions,
  encodeDurableEvent,
  LOG_FORMAT_VERSION,
  reduceSessionView,
  replaySessionView,
  type DurableEvent,
  type RuntimeEvent,
  type SessionView,
} from "../src/protocol/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be defined");
  return value;
}

const tempRoots: string[] = [];
const openedRuntimes: Runtime[] = [];
const openedSessions: RuntimeSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of openedSessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const rt of openedRuntimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "nct-suites-"): string {
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
  writeFileSync(path.join(dir, "README.md"), "# Suite Repo\n", "utf8");
  writeFileSync(path.join(dir, "app.txt"), "base\n", "utf8");
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

function systemText(req: ModelRequest): string {
  return req.system.map((s) => s.text).join("\n");
}

function requestKind(req: ModelRequest): "coordinator" | "thread" | "normal" {
  const sys = systemText(req);
  if (sys.includes("working as the persistent coordinator of a long-running Suite")) {
    return "coordinator";
  }
  if (sys.includes("working in a persistent thread of a Suite")) return "thread";
  return "normal";
}

async function setupSuiteEnv(options: {
  git?: boolean;
  interactive?: boolean;
  handler: (req: ModelRequest) => FakeScript | Promise<FakeScript>;
}) {
  const platform = createPlatform();
  const root = await platform.resolveReal(makeTmpRoot());
  const home = path.join(root, "home");
  const ws = path.join(root, "ws");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  if (options.git) {
    await initGitRepo(ws);
  }
  const config = await loadConfig(platform, {
    nocturneHome: home,
    env: () => undefined,
  });
  const requests: ModelRequest[] = [];
  const provider = new FakeProvider({
    id: "fake",
    models: [
      {
        ref: { provider: "fake", model: "m1" },
        protocol: "openai-compatible",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "visible",
          reasoningEffort: ["low", "medium", "high"],
          imageInput: false,
          promptCache: false,
          editTool: "edit",
        },
      },
      {
        ref: { provider: "fake", model: "m2" },
        protocol: "openai-compatible",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "none",
          imageInput: false,
          promptCache: false,
          editTool: "apply_patch",
        },
      },
    ],
    roleHandler: () => stopText("Suite Title"),
    handler: async (req) => {
      requests.push(structuredClone(req));
      return await options.handler(req);
    },
  });

  const makeRuntime = async () => {
    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      config,
      providers: [provider],
      interactive: options.interactive ?? true,
      subagent: { background: true, maxConcurrent: 4 },
      shell: { background: true },
      turn: { retryBaseDelayMs: 1 },
    });
    openedRuntimes.push(rt);
    return rt;
  };

  const runtime = await makeRuntime();
  return {
    platform,
    root,
    home,
    ws,
    sessionsDir,
    config,
    provider,
    requests,
    runtime,
    makeRuntime,
  };
}

function makeTmpRoot(): string {
  return makeTempDir("nct-suites-root-");
}

describe("组曲（Suite）一期 Core（ADR-0097）", { timeout: 30_000 }, () => {
  it("开组曲、suite.json 持久化、指挥会话不进默认列表、旧日志无 meta.suite 照常恢复", async () => {
    const env = await setupSuiteEnv({
      handler: () => stopText("coordinator ready"),
    });

    const suite = await env.runtime.createSuite({
      name: "Plugin Compat",
      goal: "Align plugin hooks and memory scopes",
      workspaces: [env.ws],
      instructions: "Always run targeted vitest suites before finishing.",
      threadDefaults: { model: "fake/m1", preset: "general", isolated: false },
      model: "fake/m1",
      permissionPreset: "bypass",
    });

    const suiteFile = path.join(env.home, "suites", suite.id, "suite.json");
    expect(existsSync(suiteFile)).toBe(true);
    expect(JSON.parse(readFileSync(suiteFile, "utf8"))).toMatchObject({
      version: 1,
      id: suite.id,
      name: "Plugin Compat",
      coordinatorSessionId: suite.coordinatorSessionId,
    });
    expect(existsSync(path.join(env.home, "suites", suite.id, "memory.md"))).toBe(false);

    // 默认 listSessions 不包含指挥会话，includeSuiteCoordinators: true 才包含
    expect(await env.runtime.listSessions()).toEqual([]);
    const withCoord = await env.runtime.listSessions({ includeSuiteCoordinators: true });
    expect(withCoord).toHaveLength(1);
    expect(withCoord[0]).toMatchObject({
      id: suite.coordinatorSessionId,
      suite: { id: suite.id, role: "coordinator" },
    });

    // createSession 创建普通会话：默认 listSessions 只出现普通会话
    const normal = await env.runtime.createSession({ model: "fake/m1" });
    openedSessions.push(normal);
    expect((await env.runtime.listSessions()).map((s) => s.id)).toEqual([normal.id]);

    // updateSuite 与 archiveSuite
    const updated = await env.runtime.updateSuite({
      id: suite.id,
      name: "Plugin Compat v2",
      goal: null,
    });
    expect(updated.name).toBe("Plugin Compat v2");
    expect(updated.goal).toBeUndefined();

    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);
    expect(coord.id).toBe(suite.coordinatorSessionId);
    expect(coord.state().meta.suite).toEqual({ id: suite.id, role: "coordinator" });
    await coord.submit({ text: "hello" });

    // 旧日志（无 meta.suite）照常恢复
    const legacyId = "20261101-legacy-no-suite";
    const legacyEvents: DurableEvent[] = [
      {
        type: "session.created",
        sessionId: legacyId,
        seq: 1,
        time: "2026-11-01T00:00:00.000Z",
        payload: {
          formatVersion: LOG_FORMAT_VERSION,
          nocturneVersion: "0.0.0",
          cwd: env.ws,
          workspaceRoot: env.ws,
          model: { provider: "fake", model: "m1" },
          permissionPreset: "default",
        },
      },
      {
        type: "turn.started",
        sessionId: legacyId,
        seq: 2,
        time: "2026-11-01T00:00:01.000Z",
        turnId: "t1",
        payload: { turnIndex: 1 },
      },
      {
        type: "message.user",
        sessionId: legacyId,
        seq: 3,
        time: "2026-11-01T00:00:01.000Z",
        turnId: "t1",
        payload: { messageId: "u1", content: [{ type: "text", text: "legacy hi" }] },
      },
      {
        type: "turn.completed",
        sessionId: legacyId,
        seq: 4,
        time: "2026-11-01T00:00:02.000Z",
        turnId: "t1",
        payload: { reason: "done", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      },
    ];
    writeFileSync(
      path.join(env.sessionsDir, `${legacyId}.jsonl`),
      legacyEvents.map((e) => `${encodeDurableEvent(e)}\n`).join(""),
      "utf8",
    );
    const legacySession = await env.runtime.resumeSession(legacyId);
    openedSessions.push(legacySession);
    expect(legacySession.state().meta.suite).toBeUndefined();
    expect(replaySessionView(legacySession.durableEvents()).suite).toBeUndefined();
    expect((await env.runtime.listSessions()).map((s) => s.id)).toContain(legacyId);

    // 归档后默认 listSuites 不列，includeArchived: true 可见
    await env.runtime.archiveSuite(suite.id);
    expect(await env.runtime.listSuites()).toEqual([]);
    expect((await env.runtime.listSuites({ includeArchived: true })).map((s) => s.id)).toEqual([
      suite.id,
    ]);
  });

  it("指挥工具集不含改文件工具；线程不含 memory_write/thread_*/task，且组曲记忆仅指挥可写、线程只读", async () => {
    let coordPhase = 0;
    const env = await setupSuiteEnv({
      handler: (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          coordPhase += 1;
          if (coordPhase === 1) {
            return [
              callTool("mw1", "memory_write", {
                scope: "suite",
                name: "conventions",
                description: "Suite shared coding conventions",
                type: "project",
                content: "Always check protocol types first.",
              }),
              callTool("ts1", "thread_start", {
                title: "Inspect conventions",
                task: "Read suite memory conventions and reply",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coordinator got thread report");
        }
        if (kind === "thread") {
          const hasTool = req.messages.some((m) => m.role === "tool");
          if (!hasTool) {
            return [
              callTool("mr1", "memory_read", { scope: "suite", name: "conventions" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("thread read suite memory ok");
        }
        return stopText("unexpected");
      },
    });

    const suite = await env.runtime.createSuite({
      name: "Memory & Tools Suite",
      goal: "Verify tool surface and suite memory scope",
      workspaces: [env.ws],
      instructions: "Keep changes minimal.",
      permissionPreset: "bypass",
    });
    const skillDir = path.join(env.home, "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill for test\n---\nDemo body.\n",
      "utf8",
    );
    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);

    const coordToolNames = coord.describeContext().request.tools.map((t) => t.name);
    for (const forbidden of ["write", "edit", "apply_patch", "task"]) {
      expect(coordToolNames).not.toContain(forbidden);
    }
    for (const expected of [
      "read",
      "grep",
      "glob",
      "web_fetch",
      "shell",
      "shell_output",
      "shell_kill",
      "apply_subagent_changes",
      "todo_write",
      "ask_user",
      "skill",
      "memory_read",
      "memory_write",
      "memory_delete",
      "thread_start",
      "thread_send",
      "thread_list",
      "thread_read",
      "thread_resolve",
    ]) {
      expect(coordToolNames).toContain(expected);
    }

    await coord.submit({ text: "Write suite memory and start a thread" });
    await vi.waitFor(() => {
      const v = replaySessionView(coord.durableEvents());
      expect(v.suite?.threads).toHaveLength(1);
      expect(v.suite?.threads[0]?.lastReportLine).toBe("thread read suite memory ok");
      expect(coord.isIdle()).toBe(true);
    });

    // 验证组曲记忆落盘位置与 describeMemory({ suiteId })
    const memDesc = await env.runtime.describeMemory({ suiteId: suite.id });
    expect(memDesc.suite?.entries.map((e) => e.name)).toEqual(["conventions"]);
    expect(existsSync(path.join(env.home, "memory", "suites", suite.id, "conventions.md"))).toBe(
      true,
    );

    // 验证线程工具集与系统上下文
    const threadId = must(
      replaySessionView(coord.durableEvents()).suite?.threads[0],
    ).childSessionId;
    const threadSession = await env.runtime.resumeSession(threadId);
    const threadToolNames = threadSession.describeContext().request.tools.map((t) => t.name);
    expect(threadToolNames).toContain("memory_read");
    for (const forbidden of [
      "memory_write",
      "memory_delete",
      "task",
      "thread_start",
      "thread_send",
      "thread_list",
      "thread_read",
      "thread_resolve",
    ]) {
      expect(threadToolNames).not.toContain(forbidden);
    }

    // 线程请求系统上下文带 suite 记忆索引与组曲说明
    const threadReq = must(env.requests.find((r) => requestKind(r) === "thread"));
    const threadSys = systemText(threadReq);
    expect(threadSys).toContain("Keep changes minimal.");
    expect(threadSys).toContain("conventions");
    expect(threadSys).toContain("Suite shared coding conventions");
  });

  it("thread_start 开独立工作树线程，每轮增量提交并经 apply_subagent_changes 并回", async () => {
    let threadChildId = "";
    const env = await setupSuiteEnv({
      git: true,
      handler: (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          const hasReport = req.messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("<thread-report"),
          );
          if (!hasReport) {
            const hasStarted = req.messages.some(
              (m) => m.role === "tool" && m.name === "thread_start",
            );
            if (!hasStarted) {
              return [
                callTool("ts1", "thread_start", {
                  title: "Implement feature",
                  task: "Create feature.txt with content hello-suite",
                  isolated: true,
                }),
                { type: "finish", reason: "tool_calls" },
              ];
            }
            return stopText("dispatched thread");
          }
          const hasApplied = req.messages.some(
            (m) => m.role === "tool" && m.name === "apply_subagent_changes",
          );
          if (!hasApplied) {
            return [
              callTool("ap1", "apply_subagent_changes", { id: threadChildId, mode: "clean" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("merged feature into main workspace");
        }
        if (kind === "thread") {
          if (!req.messages.some((m) => m.role === "tool")) {
            return [
              callTool("w1", "write", { path: "feature.txt", content: "hello-suite\n" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("Created feature.txt in worktree");
        }
        return stopText("unexpected");
      },
    });

    const suite = await env.runtime.createSuite({
      name: "Worktree Suite",
      workspaces: [env.ws],
      permissionPreset: "bypass",
    });
    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);

    const view = replaySessionView([]);
    coord.subscribe((ev) => reduceSessionView(view, ev));

    await coord.submit({ text: "Start an isolated thread to write feature.txt" });
    await vi.waitFor(() => {
      expect(view.suite?.threads).toHaveLength(1);
      threadChildId = view.suite?.threads[0]?.childSessionId ?? "";
      expect(threadChildId).not.toBe("");
      expect(coord.isIdle()).toBe(true);
      expect(view.entries.some((e) => e.kind === "assistant" && e.text.includes("merged"))).toBe(
        true,
      );
    });

    // 主工作区已并回 feature.txt，且未并回标记清除、分组回落为 idle
    expect(readFileSync(path.join(env.ws, "feature.txt"), "utf8")).toBe("hello-suite\n");
    const finalView = replaySessionView(coord.durableEvents());
    const tView = must(finalView.suite?.threads[0]);
    expect(tView.isolated).toBe(true);
    expect(tView.worktree).toBeDefined();
    expect(tView.hasUnmergedWorktree).toBe(false);
    expect(tView.group).toBe("idle");
  });

  it("线程一轮结束后指挥收到 <thread-report>（指挥忙时排队），并支持 thread_list / thread_read", async () => {
    let resolveCoordGate: (() => void) | undefined;
    const coordGate = new Promise<void>((resolve) => {
      resolveCoordGate = resolve;
    });
    let releaseThreadNow: (() => void) | undefined;
    const threadCanFinish = new Promise<void>((resolve) => {
      releaseThreadNow = resolve;
    });

    let coordTurn = 0;
    const env = await setupSuiteEnv({
      handler: async (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          coordTurn += 1;
          if (coordTurn === 1) {
            return [
              callTool("ts1", "thread_start", {
                title: "Background audit",
                task: "Audit config files",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (coordTurn === 2) {
            // 指挥继续在 Turn 1 的工具后续步中阻塞，等线程先结束汇报
            await coordGate;
            return stopText("coord finished turn 1");
          }
          if (coordTurn === 3) {
            return [
              callTool("tl1", "thread_list", {}),
              callTool("tr1", "thread_read", { thread: "t1", limit: 2 }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coord processed report");
        }
        if (kind === "thread") {
          await threadCanFinish;
          return stopText("Audit line 1\nAudit line 2");
        }
        return stopText("unexpected");
      },
    });

    const suite = await env.runtime.createSuite({
      name: "Queue Report Suite",
      workspaces: [env.ws],
      permissionPreset: "bypass",
    });
    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);

    const submitPromise = coord.submit({ text: "Audit the project" });
    await vi.waitFor(() => expect(coordTurn).toBe(2));

    // 放行线程使其在指挥仍忙时完成
    releaseThreadNow?.();
    await vi.waitFor(() => {
      const snap = coord.pendingInputs();
      expect(snap.items.some((i) => i.mode === "suite")).toBe(true);
    });
    const queuedItem = must(coord.pendingInputs().items.find((i) => i.mode === "suite"));
    expect(queuedItem.text).toContain(
      '<thread-report thread="t1" title="Background audit" status="idle">',
    );
    expect(queuedItem.text).toContain("Audit line 1\nAudit line 2");

    // 放行指挥第一轮，排队的 <thread-report> 自动触发指挥下一轮
    resolveCoordGate?.();
    expect(await submitPromise).toBe("done");

    await vi.waitFor(() => {
      expect(coord.isIdle()).toBe(true);
      const v = replaySessionView(coord.durableEvents());
      expect(v.suite?.threads[0]?.lastReportLine).toBe("Audit line 1");
      expect(
        coord
          .durableEvents()
          .some((e) => e.type === "message.user" && e.payload.suiteReport?.threadId === "t1"),
      ).toBe(true);
      expect(
        coord
          .durableEvents()
          .some((e) => e.type === "tool.completed" && e.payload.name === "thread_read"),
      ).toBe(true);
    });

    const readTool = coord
      .durableEvents()
      .find(
        (e): e is Extract<DurableEvent, { type: "tool.completed" }> =>
          e.type === "tool.completed" && e.payload.name === "thread_read",
      );
    expect(readTool?.payload.modelContent).toContain("Audit line 1\nAudit line 2");
  });

  it("thread_send 忙时插话、空闲开新一轮，且 thread_resolve 支持完成与重开", async () => {
    let threadCallCount = 0;
    let releaseBusyThread: (() => void) | undefined;
    const busyThreadGate = new Promise<void>((resolve) => {
      releaseBusyThread = resolve;
    });

    let coordPhase = 0;
    const env = await setupSuiteEnv({
      handler: async (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          coordPhase += 1;
          if (coordPhase === 1) {
            return [
              callTool("ts1", "thread_start", {
                title: "Steerable thread",
                task: "Start initial work",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (coordPhase === 2) {
            // 指挥在线程忙时发 thread_send 插话
            return [
              callTool("tsend1", "thread_send", {
                thread: "t1",
                text: "STEER-NOTE: include edge cases",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coord ack");
        }
        if (kind === "thread") {
          threadCallCount += 1;
          if (threadCallCount === 1) {
            // 先调用一次 read 停在工具间隙，让插话可以在安全点并入同一 Turn
            await busyThreadGate;
            return [
              callTool("r1", "glob", { pattern: "*" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          const sawSteer = req.messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("STEER-NOTE"),
          );
          if (threadCallCount === 2) {
            expect(sawSteer).toBe(true);
            return stopText("turn-1 with steer done");
          }
          return stopText("turn-2 after idle thread_send");
        }
        return stopText("unexpected");
      },
    });

    const suite = await env.runtime.createSuite({
      name: "Steer Suite",
      workspaces: [env.ws],
      permissionPreset: "bypass",
    });
    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);

    await coord.submit({ text: "Start and steer t1" });
    await vi.waitFor(() => expect(threadCallCount).toBe(1));

    // 确认 coord 执行了 thread_send 插话后再放行线程
    await vi.waitFor(() =>
      expect(
        coord
          .durableEvents()
          .some((e) => e.type === "tool.completed" && e.payload.name === "thread_send"),
      ).toBe(true),
    );
    releaseBusyThread?.();

    await vi.waitFor(() => {
      const v = replaySessionView(coord.durableEvents());
      expect(v.suite?.threads[0]?.lastReportLine).toBe("turn-1 with steer done");
      expect(coord.isIdle()).toBe(true);
    });

    // 验证线程日志中插话带 steer: true 且 Turn 1 只有一个 turn.completed
    const t1SessionId = must(
      replaySessionView(coord.durableEvents()).suite?.threads[0],
    ).childSessionId;
    const t1 = await env.runtime.resumeSession(t1SessionId);
    expect(
      t1
        .durableEvents()
        .some(
          (e) =>
            e.type === "message.user" &&
            e.payload.steer === true &&
            JSON.stringify(e.payload.content).includes("STEER-NOTE"),
        ),
    ).toBe(true);
    expect(t1.durableEvents().filter((e) => e.type === "turn.completed")).toHaveLength(1);

    // 线程空闲时通过 sendToThread（同走 thread_send 核心）开启第二轮
    await coord.sendToThread({ thread: "t1", text: "Second round check" });
    await vi.waitFor(() => {
      const v = replaySessionView(coord.durableEvents());
      expect(v.suite?.threads[0]?.lastReportLine).toBe("turn-2 after idle thread_send");
      expect(coord.isIdle()).toBe(true);
    });
    expect(t1.durableEvents().filter((e) => e.type === "turn.completed")).toHaveLength(2);

    // 完成与重开
    await coord.resolveThread({ thread: "t1" });
    expect(replaySessionView(coord.durableEvents()).suite?.threads[0]?.group).toBe("resolved");
    await coord.resolveThread({ thread: "t1", reopen: true });
    expect(replaySessionView(coord.durableEvents()).suite?.threads[0]?.group).toBe("idle");
  });

  it("线程权限请求冒泡到指挥可见，并能经 respondSubagentPermission 确认放行", async () => {
    let coordPhase = 0;
    const env = await setupSuiteEnv({
      interactive: true,
      handler: (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          coordPhase += 1;
          if (coordPhase === 1) {
            return [
              callTool("ts1", "thread_start", {
                title: "Needs approval",
                task: "Write approved.txt",
              }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coord saw approved thread");
        }
        if (kind === "thread") {
          if (!req.messages.some((m) => m.role === "tool")) {
            return [
              callTool("w1", "write", { path: "approved.txt", content: "ok\n" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("wrote approved.txt");
        }
        return stopText("unexpected");
      },
    });

    const suite = await env.runtime.createSuite({
      name: "Permission Bubble Suite",
      workspaces: [env.ws],
      permissionPreset: "default",
    });
    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);

    const view = replaySessionView([]);
    coord.subscribe((ev) => reduceSessionView(view, ev));

    await coord.submit({ text: "Start thread needing permission" });
    await vi.waitFor(() => {
      expect(view.pendingSubagentPermissions).toHaveLength(1);
      expect(view.suite?.threads[0]?.group).toBe("needs_attention");
      expect(view.suite?.needsAttentionThreads).toEqual(["t1"]);
    });

    const agg = allPendingPermissions(view);
    expect(agg).toHaveLength(1);
    const pending = must(view.pendingSubagentPermissions[0]);
    await coord.respondSubagentPermission(pending.childSessionId, pending.requestId, {
      decision: "allow",
    });

    await vi.waitFor(() => {
      expect(view.pendingSubagentPermissions).toHaveLength(0);
      expect(view.suite?.threads[0]?.lastReportLine).toBe("wrote approved.txt");
      expect(view.suite?.threads[0]?.group).toBe("idle");
      expect(coord.isIdle()).toBe(true);
    });
    expect(readFileSync(path.join(env.ws, "approved.txt"), "utf8")).toBe("ok\n");
  });

  it("重启后补报：线程末轮已结束但尚未写入指挥 suite.thread_reported 时以暂停状态补回", async () => {
    const env = await setupSuiteEnv({
      handler: () => stopText("coord ok"),
    });

    const suite = await env.runtime.createSuite({
      name: "Restart Backfill Suite",
      workspaces: [env.ws],
      permissionPreset: "bypass",
    });
    const childId = "20261119-thread-unreported";

    // 直接构造“指挥已发出 suite.thread_reported 但尚未落盘为指挥 message.user”的落盘状态
    const coordEvents: DurableEvent[] = [
      {
        type: "suite.thread_started",
        sessionId: suite.coordinatorSessionId,
        seq: 2,
        time: "2026-11-19T00:00:01.000Z",
        payload: {
          threadId: "t1",
          childSessionId: childId,
          title: "Crashed before report delivered",
          task: "Produce result",
          workspace: env.ws,
          model: { provider: "fake", model: "m1" },
          preset: "general",
          isolated: false,
        },
      },
      {
        type: "suite.thread_reported",
        sessionId: suite.coordinatorSessionId,
        seq: 3,
        time: "2026-11-19T00:00:05.000Z",
        payload: {
          threadId: "t1",
          childSessionId: childId,
          turnId: "child-turn-1",
          status: "idle",
          report: "Recovered child output",
          summaryLine: "Recovered child output",
        },
      },
    ];
    const coordLogPath = path.join(env.sessionsDir, `${suite.coordinatorSessionId}.jsonl`);
    writeFileSync(
      coordLogPath,
      readFileSync(coordLogPath, "utf8") +
        coordEvents.map((e) => `${encodeDurableEvent(e)}\n`).join(""),
      "utf8",
    );

    const rt2 = await env.makeRuntime();
    const coord = await rt2.openSuite(suite.id);
    openedSessions.push(coord);

    const view = replaySessionView(coord.durableEvents());
    expect(view.suite?.threads[0]).toMatchObject({
      threadId: "t1",
      status: "idle",
      group: "idle",
      lastReportLine: "Recovered child output",
      lastReportTurnId: "child-turn-1",
    });
    const pending = coord.pendingInputs();
    expect(pending.paused).toBe(true);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.mode).toBe("suite");
    expect(pending.items[0]?.paused).toBe(true);
    expect(pending.items[0]?.text).toContain('status="idle"');
    expect(pending.items[0]?.text).toContain("Recovered child output");
    // 恢复后绝不自动唤醒指挥
    expect(
      coord
        .durableEvents()
        .some((e) => e.type === "message.user" && e.payload.suiteReport !== undefined),
    ).toBe(false);
  });

  it("指挥回退不影响线程，且指挥会话分叉被拒绝（线程分叉仍正常）", async () => {
    let coordPhase = 0;
    let threadTurn = 0;
    const env = await setupSuiteEnv({
      handler: (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          coordPhase += 1;
          if (coordPhase === 1) {
            return [
              callTool("ts1", "thread_start", { title: "Survivor", task: "Run task 1" }),
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText(`coord-${coordPhase}`);
        }
        if (kind === "thread") {
          threadTurn += 1;
          return stopText(`thread-output-${threadTurn}`);
        }
        return stopText("unexpected");
      },
    });

    const suite = await env.runtime.createSuite({
      name: "Rewind & Fork Suite",
      workspaces: [env.ws],
      permissionPreset: "bypass",
    });
    const coord = await env.runtime.openSuite(suite.id);
    openedSessions.push(coord);

    await coord.submit({ text: "Turn 1: start thread" });
    await vi.waitFor(() => {
      const v = replaySessionView(coord.durableEvents());
      expect(v.suite?.threads[0]?.lastReportLine).toBe("thread-output-1");
      expect(coord.isIdle()).toBe(true);
    });

    await coord.submit({ text: "Turn 2: anchor to rewind" });
    const targets = await coord.rewindTargets();
    const turn2Target = must(targets.find((t) => t.text.includes("Turn 2")));
    await coord.rewind(turn2Target.seq, "both");

    // 指挥回退后线程名单、汇报与活跃线程均不受影响
    const afterRewind = replaySessionView(coord.durableEvents());
    expect(afterRewind.suite?.threads).toHaveLength(1);
    expect(afterRewind.suite?.threads[0]?.lastReportLine).toBe("thread-output-1");

    await coord.sendToThread({ thread: "t1", text: "Still alive after coordinator rewind" });
    await vi.waitFor(() => {
      expect(replaySessionView(coord.durableEvents()).suite?.threads[0]?.lastReportLine).toBe(
        "thread-output-2",
      );
      expect(coord.isIdle()).toBe(true);
    });

    // 指挥会话不允许分叉
    await expect(env.runtime.forkSession(coord.id)).rejects.toMatchObject({
      code: "invalid_command",
    });

    // 线程会话允许分叉
    const childId = must(afterRewind.suite?.threads[0]).childSessionId;
    const forkedThreadId = await env.runtime.forkSession(childId);
    expect(forkedThreadId).not.toBe(childId);
  });

  it("SessionView.suite 五个分组（needs_attention / running / unmerged / idle / resolved）归约正确", () => {
    const baseCreated = (suiteId: string): DurableEvent => ({
      type: "session.created",
      sessionId: "coord-1",
      seq: 1,
      time: "2026-11-19T00:00:00.000Z",
      payload: {
        formatVersion: LOG_FORMAT_VERSION,
        nocturneVersion: "0.0.0",
        cwd: "/ws",
        workspaceRoot: "/ws",
        model: { provider: "fake", model: "m1" },
        permissionPreset: "default",
        suite: { id: suiteId, role: "coordinator" },
      },
    });
    const started = (seq: number, threadId: string, isolated = false): DurableEvent => ({
      type: "suite.thread_started",
      sessionId: "coord-1",
      seq,
      time: "2026-11-19T00:00:01.000Z",
      payload: {
        threadId,
        childSessionId: `child-${threadId}`,
        title: `Thread ${threadId}`,
        task: "Do work",
        workspace: "/ws",
        model: { provider: "fake", model: "m1" },
        preset: "general",
        isolated,
      },
    });

    const view: SessionView = replaySessionView([
      baseCreated("s1"),
      started(2, "t1"), // needs_attention (paused)
      started(3, "t2"), // running (working via ephemeral)
      started(4, "t3", true), // unmerged (hasUnmergedWorktree)
      started(5, "t4"), // idle
      started(6, "t5"), // resolved
      {
        type: "suite.thread_reported",
        sessionId: "coord-1",
        seq: 7,
        time: "2026-11-19T00:00:02.000Z",
        payload: {
          threadId: "t1",
          childSessionId: "child-t1",
          turnId: "turn-1",
          status: "paused",
          report: "failed",
          error: { code: "provider_error", message: "boom" },
        },
      },
      {
        type: "suite.thread_reported",
        sessionId: "coord-1",
        seq: 8,
        time: "2026-11-19T00:00:03.000Z",
        payload: {
          threadId: "t3",
          childSessionId: "child-t3",
          turnId: "turn-3",
          status: "idle",
          report: "committed",
          hasUnmergedWorktree: true,
        },
      },
      {
        type: "suite.thread_resolved",
        sessionId: "coord-1",
        seq: 9,
        time: "2026-11-19T00:00:04.000Z",
        payload: { threadId: "t5", source: "coordinator" },
      },
    ]);

    const t2Update: RuntimeEvent = {
      type: "suite.thread_updated",
      sessionId: "coord-1",
      runId: "r1",
      eseq: 1,
      afterSeq: 9,
      time: "2026-11-19T00:00:05.000Z",
      payload: {
        threadId: "t2",
        status: "working",
        toolActivity: { tool: "grep", detail: "foo" },
      },
    };
    reduceSessionView(view, t2Update);

    const groups = new Map(view.suite?.threads.map((t) => [t.threadId, t.group]));
    expect(groups.get("t1")).toBe("needs_attention");
    expect(groups.get("t2")).toBe("running");
    expect(groups.get("t3")).toBe("unmerged");
    expect(groups.get("t4")).toBe("idle");
    expect(groups.get("t5")).toBe("resolved");
    expect(view.suite?.needsAttentionThreads).toEqual(["t1"]);

    // 临时 pendingQuestion 同样将线程归入 needs_attention
    reduceSessionView(view, {
      type: "suite.thread_updated",
      sessionId: "coord-1",
      runId: "r1",
      eseq: 2,
      afterSeq: 9,
      time: "2026-11-19T00:00:06.000Z",
      payload: { threadId: "t4", status: "idle", hasPendingQuestion: true },
    });
    expect(view.suite?.threads.find((t) => t.threadId === "t4")?.group).toBe("needs_attention");
    expect(view.suite?.needsAttentionThreads).toEqual(["t1", "t4"]);

    // apply_subagent_changes 成功落盘清除 unmerged
    reduceSessionView(view, {
      type: "tool.completed",
      sessionId: "coord-1",
      seq: 10,
      turnId: "ct1",
      time: "2026-11-19T00:00:07.000Z",
      payload: {
        callId: "ap1",
        name: "apply_subagent_changes",
        status: "ok",
        modelContent: "applied",
        output: { id: "child-t3" },
      },
    });
    expect(view.suite?.threads.find((t) => t.threadId === "t3")?.group).toBe("idle");
  });
});
