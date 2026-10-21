/**
 * 子会话只读观察服务（rpc.md 4.1）：登记簿 + 只读日志读取 + list/observe/readAttachment。
 * 直接用真实 SessionStore 手写父子日志，观察服务一侧注入「任何写入即失败」的文件系统，
 * 证明只读路径不写文件、不取锁、不修复。
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform, type Platform } from "../src/platform/index.js";
import type {
  ImageAttachment,
  RuntimeEvent,
  SubagentReadEnd,
  SubagentSummary,
  TurnEndReason,
} from "../src/protocol/index.js";
import {
  createSessionStore,
  createSubagentObservation,
  createSubagentRegistry,
  summarizeSubagentTask,
  type Session,
  type SubagentRegistration,
} from "../src/session/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

const MUTATORS = new Set([
  "writeFile",
  "createExclusive",
  "appendFile",
  "truncate",
  "mkdir",
  "mkdtemp",
  "rm",
  "unlink",
  "rename",
  "fsync",
]);

/** 观察服务使用的平台：任何写入/锁类调用都记录并抛错 */
function readOnlyPlatform(): { platform: Platform; writes: string[] } {
  const base = createPlatform();
  const writes: string[] = [];
  const fs = new Proxy(base.fs, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && MUTATORS.has(prop)) {
        return () => {
          writes.push(prop);
          throw new Error(`只读观察不应调用 fs.${prop}`);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { platform: { ...base, fs }, writes };
}

interface Fixture {
  sessionsDir: string;
  store: ReturnType<typeof createSessionStore>;
  registry: ReturnType<typeof createSubagentRegistry>;
  guard: ReturnType<typeof readOnlyPlatform>;
  service: ReturnType<typeof createSubagentObservation>;
  logPath: (id: string) => string;
  list: () => string[];
}

function fixture(): Fixture {
  const sessionsDir = tmpDir("nct-obs-");
  const real = createPlatform();
  const store = createSessionStore({ platform: real, sessionsDir });
  const registry = createSubagentRegistry();
  const guard = readOnlyPlatform();
  return {
    sessionsDir,
    store,
    registry,
    guard,
    service: createSubagentObservation({ platform: guard.platform, sessionsDir, registry }),
    logPath: (id) => path.join(sessionsDir, `${id}.jsonl`),
    list: () => readdirSync(sessionsDir).sort(),
  };
}

const base = {
  cwd: "Z:\\repo",
  workspaceRoot: "Z:\\repo",
  model: { provider: "fake", model: "fake-1" },
  permissionPreset: "default",
  nocturneVersion: "0.0.0",
};
const usage = { inputTokens: 1, outputTokens: 1 };

/** 父会话：一条 task 调用（可选已结算），会话保持打开直到测试关闭 */
async function makeParent(
  f: Fixture,
  callId: string,
  options: {
    input?: Record<string, unknown>;
    completed?: { status: "ok" | "error" | "cancelled"; durationMs?: number };
    track?: boolean;
  } = {},
): Promise<Session> {
  const parent = await f.store.create(base);
  if (options.track !== false) f.registry.trackSession(parent);
  const turnId = `p-${callId}`;
  await parent.emit("turn.started", { turnIndex: 1 }, { turnId });
  await emitTaskStarted(parent, callId, turnId, options.input ?? { task: "整理\n日志   文件" });
  if (options.completed !== undefined) {
    await parent.emit(
      "tool.completed",
      {
        callId,
        name: "task",
        status: options.completed.status,
        modelContent: "done",
        ...(options.completed.durationMs !== undefined
          ? { durationMs: options.completed.durationMs }
          : {}),
        ...(options.completed.status === "error"
          ? { error: { code: "subagent_no_result", message: "没有 finish" } }
          : {}),
      },
      { turnId },
    );
  }
  return parent;
}

async function emitTaskStarted(
  session: Session,
  callId: string,
  turnId: string,
  input: Record<string, unknown>,
): Promise<void> {
  await session.emit(
    "tool.started",
    {
      callId,
      name: "task",
      input,
      subjects: [],
      permission: { action: "allow", source: "rule" },
    },
    { turnId },
  );
}

async function makeChild(
  f: Fixture,
  parent: Session,
  callId: string,
  options: { register?: boolean } = {},
): Promise<{ child: Session; registration: SubagentRegistration | undefined }> {
  const child = await f.store.create({ ...base, parent: { sessionId: parent.id, callId } });
  const registration =
    options.register === true
      ? f.registry.register({
          child,
          parentSessionId: parent.id,
          callId,
          profile: "default",
          taskSummary: "整理 日志 文件",
        })
      : undefined;
  return { child, registration };
}

/** 子会话一个 Turn：任务消息 →（可选）finish → turn.completed（open 时不收束） */
async function childTurn(
  child: Session,
  index: number,
  options: { finish?: boolean; reason?: TurnEndReason; open?: boolean; text?: string } = {},
): Promise<void> {
  const turnId = `c${index}`;
  await child.emit("turn.started", { turnIndex: index }, { turnId });
  await child.emit(
    "message.user",
    { messageId: `m${index}`, content: [{ type: "text", text: options.text ?? `任务 ${index}` }] },
    { turnId },
  );
  if (options.finish === true) {
    await child.emit(
      "tool.started",
      {
        callId: `f${index}`,
        name: "finish",
        input: { result: "好了" },
        subjects: [],
        permission: { action: "allow", source: "rule" },
      },
      { turnId },
    );
    await child.emit(
      "tool.completed",
      { callId: `f${index}`, name: "finish", status: "ok", modelContent: "结果已提交给父会话。" },
      { turnId },
    );
  }
  if (options.open !== true) {
    await child.emit(
      "turn.completed",
      { reason: options.reason ?? "done", steps: 1, usage },
      { turnId },
    );
  }
}

interface Collected {
  events: RuntimeEvent[];
  ends: SubagentReadEnd[];
  /** onEnd 到达时已交付的事件数 */
  eventsAtEnd: number[];
}
function collector(): { observer: Parameters<Fixture["service"]["observe"]>[1]; got: Collected } {
  const got: Collected = { events: [], ends: [], eventsAtEnd: [] };
  return {
    got,
    observer: {
      onEvent: (event) => {
        got.events.push(event);
      },
      onEnd: (end) => {
        got.eventsAtEnd.push(got.events.length);
        got.ends.push(end);
      },
    },
  };
}
const durableSeqs = (events: RuntimeEvent[]): number[] =>
  events.flatMap((event) => ("seq" in event ? [event.seq] : []));

/** 完整结束的子会话：finish 成功、父 task 已结算 */
async function endedPair(
  f: Fixture,
  options: { durationMs?: number } = {},
): Promise<{ parent: Session; child: Session }> {
  const parent = await makeParent(f, "call-1", {
    completed: {
      status: "ok",
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    },
  });
  const { child } = await makeChild(f, parent, "call-1");
  await childTurn(child, 1, { finish: true });
  await child.close();
  return { parent, child };
}

describe("只读快照：已结束的子会话", () => {
  it("固定快照整段回放，summary 取父结算，不写文件不取锁", async () => {
    const f = fixture();
    const { parent, child } = await endedPair(f, { durationMs: 4321 });
    await parent.close();
    const before = f.list();
    const bytes = readFileSync(f.logPath(child.id));

    const { observer, got } = collector();
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      observer,
    );

    expect(observation.mode).toBe("snapshot");
    expect(durableSeqs(got.events)).toEqual(child.durableEvents().map((e) => e.seq));
    expect(got.events).toEqual([...child.durableEvents()]);
    expect(got.ends).toHaveLength(1);
    expect(got.eventsAtEnd).toEqual([got.events.length]);
    const end = got.ends[0];
    expect(end).toMatchObject({
      source: "snapshot",
      tailIgnored: false,
      lastSeq: child.durableEvents().at(-1)?.seq,
    });
    expect(end?.summary).toMatchObject({
      parentSessionId: parent.id,
      callId: "call-1",
      childSessionId: child.id,
      profile: "default",
      taskSummary: "整理 日志 文件",
      state: "ended",
      durationMs: 4321,
      outcome: { status: "ok" },
    });
    expect(end?.summary.durationApproximate).toBeUndefined();
    expect(end?.summary.endedAt).toBeDefined();
    expect(observation.summary).toEqual(end?.summary);
    expect(observation.lastSeq).toBe(end?.lastSeq);
    expect(f.guard.writes).toEqual([]);
    expect(f.list()).toEqual(before);
    expect(readFileSync(f.logPath(child.id)).equals(bytes)).toBe(true);
  });

  it("父未结算但子已成功 finish：ended，耗时按事件时间差并标近似，没有 outcome", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child } = await makeChild(f, parent, "call-1");
    await childTurn(child, 1, { finish: true });
    await child.close();
    const { observer, got } = collector();
    await f.service.observe({ parentSessionId: parent.id, childSessionId: child.id }, observer);
    const summary = got.ends[0]?.summary;
    expect(summary?.state).toBe("ended");
    expect(summary?.outcome).toBeUndefined();
    expect(summary?.durationApproximate).toBe(true);
    expect(typeof summary?.durationMs).toBe("number");
    await parent.close();
  });

  it("afterSeq 只回放之后的事件；超过高水位或非法值报 invalid_after_seq", async () => {
    const f = fixture();
    const { parent, child } = await endedPair(f);
    const all = child.durableEvents();
    const pivot = all[3]?.seq ?? 0;
    const { observer, got } = collector();
    await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id, afterSeq: pivot },
      observer,
    );
    expect(durableSeqs(got.events)).toEqual(all.filter((e) => e.seq > pivot).map((e) => e.seq));
    expect(got.ends[0]?.lastSeq).toBe(all.at(-1)?.seq);

    for (const afterSeq of [all.length + 1, -1, 1.5, Number.NaN]) {
      const second = collector();
      await expect(
        f.service.observe(
          { parentSessionId: parent.id, childSessionId: child.id, afterSeq },
          second.observer,
        ),
      ).rejects.toMatchObject({ code: "invalid_after_seq" });
      expect(second.got.events).toEqual([]);
      expect(second.got.ends).toEqual([]);
    }
    // 恰等于高水位：没有事件，仍然自然结束
    const tail = collector();
    await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id, afterSeq: all.length },
      tail.observer,
    );
    expect(tail.got.events).toEqual([]);
    expect(tail.got.ends).toHaveLength(1);
    await parent.close();
  });
});

describe("只读解析：损坏与边界", () => {
  async function loggedChild(f: Fixture): Promise<{ parent: Session; child: Session }> {
    const pair = await endedPair(f);
    await pair.parent.close();
    return pair;
  }

  it.each([
    ["未终止的最后一行（即使能解析）", (line: string) => line],
    ["已终止但无法解析的最后一行", () => '{"type":"turn.sta\n'],
  ])("%s只在内存里略过，不写、不截断、不另存", async (_name, makeTail) => {
    const f = fixture();
    const { parent, child } = await loggedChild(f);
    const last = JSON.stringify({
      type: "turn.started",
      sessionId: child.id,
      seq: (child.durableEvents().at(-1)?.seq ?? 0) + 1,
      time: new Date().toISOString(),
      turnId: "late",
      payload: { turnIndex: 9 },
    });
    appendFileSync(f.logPath(child.id), makeTail(last));
    const before = f.list();
    const bytes = readFileSync(f.logPath(child.id));

    const { observer, got } = collector();
    await f.service.observe({ parentSessionId: parent.id, childSessionId: child.id }, observer);
    expect(got.ends[0]?.tailIgnored).toBe(true);
    expect(durableSeqs(got.events)).toEqual(child.durableEvents().map((e) => e.seq));
    expect(f.list()).toEqual(before);
    expect(readFileSync(f.logPath(child.id)).equals(bytes)).toBe(true);
    expect(f.guard.writes).toEqual([]);
  });

  it("中间损坏、seq 空洞、sessionId 不匹配、更高版本、未知事件类型一律报错，不拼接后文", async () => {
    const f = fixture();
    const { parent, child } = await loggedChild(f);
    const original = readFileSync(f.logPath(child.id), "utf8");
    const lines = original.trimEnd().split("\n");
    const rewrite = (next: string[]): void => {
      writeFileSync(f.logPath(child.id), `${next.join("\n")}\n`);
    };
    const attempt = () =>
      f.service.observe(
        { parentSessionId: parent.id, childSessionId: child.id },
        collector().observer,
      );

    rewrite([lines[0] ?? "", "不是 JSON", ...lines.slice(2)]);
    await expect(attempt()).rejects.toMatchObject({ code: "session_log_corrupt" });

    rewrite([lines[0] ?? "", ...lines.slice(2)]);
    await expect(attempt()).rejects.toMatchObject({ code: "session_log_corrupt" });

    rewrite(lines.map((line, i) => (i === 2 ? line.replace(child.id, "other-id") : line)));
    await expect(attempt()).rejects.toMatchObject({ code: "session_log_corrupt" });

    rewrite([
      (lines[0] ?? "").replace('"formatVersion":1', '"formatVersion":99'),
      ...lines.slice(1),
    ]);
    await expect(attempt()).rejects.toMatchObject({ code: "session_log_newer" });

    // 未知持久事件类型即使在最后一行也不当普通坏尾
    const future = JSON.stringify({
      type: "future.thing",
      sessionId: child.id,
      seq: lines.length + 1,
      time: new Date().toISOString(),
      payload: {},
    });
    rewrite([...lines, future]);
    await expect(attempt()).rejects.toMatchObject({ code: "session_log_newer" });

    // 空日志：没有 session.created
    writeFileSync(f.logPath(child.id), "");
    await expect(attempt()).rejects.toMatchObject({ code: "session_log_corrupt" });
    expect(f.guard.writes).toEqual([]);
  });

  it("不存在、非法 id、父子关系不符各有明确错误码，三个方法一致", async () => {
    const f = fixture();
    const { parent, child } = await loggedChild(f);
    const other = await f.store.create(base);
    await other.close();
    const input = { parentSessionId: parent.id, childSessionId: child.id };
    const calls = (patch: Partial<typeof input>, file = "x.png") => ({
      list: () =>
        f.service.list({ parentSessionId: patch.parentSessionId ?? input.parentSessionId }),
      observe: () => f.service.observe({ ...input, ...patch }, collector().observer),
      attach: () => f.service.readAttachment({ ...input, ...patch, file }),
    });

    for (const bad of ["", "../x", "a/b", "a\\b", "x.y", "a".repeat(129), "中文"]) {
      await expect(calls({ parentSessionId: bad }).list()).rejects.toMatchObject({
        code: "invalid_session_id",
      });
      await expect(calls({ parentSessionId: bad }).observe()).rejects.toMatchObject({
        code: "invalid_session_id",
      });
      await expect(calls({ childSessionId: bad }).observe()).rejects.toMatchObject({
        code: "invalid_session_id",
      });
      await expect(calls({ childSessionId: bad }).attach()).rejects.toMatchObject({
        code: "invalid_session_id",
      });
    }
    await expect(calls({ childSessionId: "no-such-child" }).observe()).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(calls({ parentSessionId: "no-such-parent" }).list()).rejects.toMatchObject({
      code: "session_not_found",
    });
    // 顶层会话当 child，或 child 属于别的 parent
    await expect(calls({ childSessionId: other.id }).observe()).rejects.toMatchObject({
      code: "subagent_parent_mismatch",
    });
    await expect(calls({ childSessionId: other.id }).attach()).rejects.toMatchObject({
      code: "subagent_parent_mismatch",
    });
    await expect(calls({ parentSessionId: other.id }).observe()).rejects.toMatchObject({
      code: "subagent_parent_mismatch",
    });
    await expect(calls({ parentSessionId: other.id }).attach()).rejects.toMatchObject({
      code: "subagent_parent_mismatch",
    });
    expect(f.guard.writes).toEqual([]);
  });
});

describe("状态：未收束的日志不能伪装成功", () => {
  async function stateOf(f: Fixture, parent: Session, child: Session): Promise<SubagentSummary> {
    const [summary] = (await f.service.list({ parentSessionId: parent.id })).filter(
      (s) => s.childSessionId === child.id,
    );
    if (summary === undefined) throw new Error("child 不在 list 中");
    return summary;
  }

  it("尚有未闭合 Turn：始终 unsealed，没有结束时间、耗时与结果；observe 同口径", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1", { completed: { status: "ok", durationMs: 9 } });
    const { child } = await makeChild(f, parent, "call-1");
    await childTurn(child, 1, { finish: true });
    await childTurn(child, 2, { open: true });
    await child.close();

    const summary = await stateOf(f, parent, child);
    expect(summary.state).toBe("unsealed");
    expect(summary.endedAt).toBeUndefined();
    expect(summary.durationMs).toBeUndefined();
    // 父结算是父调用自己的事实，仍如实给出
    expect(summary.outcome).toEqual({ status: "ok" });

    const { observer, got } = collector();
    await f.service.observe({ parentSessionId: parent.id, childSessionId: child.id }, observer);
    expect(got.ends[0]?.summary.state).toBe("unsealed");
    expect(got.ends).toHaveLength(1);
    await parent.close();
  });

  it("旧 turn.completed(done) 缺 finish 且父未结算：unsealed（可能还有催促轮）", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child } = await makeChild(f, parent, "call-1");
    await childTurn(child, 1, { reason: "done" });
    await child.close();
    expect((await stateOf(f, parent, child)).state).toBe("unsealed");
    await parent.close();
  });

  it("父已结算且 Turn 闭合：ended；最后一轮明确以非 done 结束：ended", async () => {
    const f = fixture();
    const settled = await makeParent(f, "call-1", { completed: { status: "error" } });
    const a = await makeChild(f, settled, "call-1");
    await childTurn(a.child, 1, { reason: "done" });
    await a.child.close();
    const settledSummary = await stateOf(f, settled, a.child);
    expect(settledSummary.state).toBe("ended");
    expect(settledSummary.outcome).toMatchObject({
      status: "error",
      error: { code: "subagent_no_result" },
    });

    const open = await makeParent(f, "call-2");
    const b = await makeChild(f, open, "call-2");
    await childTurn(b.child, 1, { reason: "max_steps" });
    await b.child.close();
    expect((await stateOf(f, open, b.child)).state).toBe("ended");
    await settled.close();
    await open.close();
  });

  it("没有任何 Turn 的子日志：父未结算 unsealed，父已结算 ended", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child } = await makeChild(f, parent, "call-1");
    await child.close();
    expect((await stateOf(f, parent, child)).state).toBe("unsealed");
    await parent.emit(
      "tool.completed",
      { callId: "call-1", name: "task", status: "error", modelContent: "x" },
      { turnId: "p-call-1" },
    );
    expect((await stateOf(f, parent, child)).state).toBe("ended");
    await parent.close();
  });
});

describe("listSubagents", () => {
  it("直接子会话按 startedAt、id 升序；档位与摘要取启动参数；不含顶层与别人的子会话", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1", {
      input: { task: "  第一\n行  任务  ", profile: "quick" },
      completed: { status: "ok", durationMs: 100 },
    });
    await emitTaskStarted(parent, "call-2", "p-call-1", { task: "x".repeat(300), agent: "legacy" });
    await emitTaskStarted(parent, "call-3", "p-call-1", {});
    const first = await makeChild(f, parent, "call-1");
    await childTurn(first.child, 1, { finish: true });
    await first.child.close();
    const second = await makeChild(f, parent, "call-2");
    await childTurn(second.child, 1, { open: true });
    await second.child.close();
    // 旧日志缺启动参数：档位 default，摘要回退首条子 message.user
    const third = await makeChild(f, parent, "call-3");
    await childTurn(third.child, 1, { text: "子里的\n首条消息", open: true });
    await third.child.close();
    const stranger = await makeParent(f, "call-9");
    const foreign = await makeChild(f, stranger, "call-9");
    await foreign.child.close();

    const list = await f.service.list({ parentSessionId: parent.id });
    expect(list.map((s) => s.childSessionId)).toEqual(
      [first.child.id, second.child.id, third.child.id].sort((a, b) => {
        const sa = list.find((s) => s.childSessionId === a)?.startedAt ?? "";
        const sb = list.find((s) => s.childSessionId === b)?.startedAt ?? "";
        return sa.localeCompare(sb) || a.localeCompare(b);
      }),
    );
    const by = (id: string) => list.find((s) => s.childSessionId === id);
    expect(by(first.child.id)).toMatchObject({
      callId: "call-1",
      profile: "quick",
      taskSummary: "第一 行 任务",
      state: "ended",
      durationMs: 100,
    });
    expect(by(second.child.id)).toMatchObject({ profile: "legacy", state: "unsealed" });
    expect(Array.from(by(second.child.id)?.taskSummary ?? "")).toHaveLength(120);
    expect(by(third.child.id)).toMatchObject({
      profile: "default",
      taskSummary: "子里的 首条消息",
    });
    expect(list.some((s) => s.childSessionId === foreign.child.id)).toBe(false);
    expect(list.some((s) => s.childSessionId === parent.id)).toBe(false);
    expect(f.guard.writes).toEqual([]);
    await parent.close();
    await stranger.close();
  });

  it("同一父调用意外出现多个 child 时各自保留；父会话未被打开时只读父日志", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1", {
      completed: { status: "ok", durationMs: 7 },
      track: false,
    });
    const a = await makeChild(f, parent, "call-1");
    const b = await makeChild(f, parent, "call-1");
    await childTurn(a.child, 1, { finish: true });
    await childTurn(b.child, 1, { finish: true });
    await a.child.close();
    await b.child.close();
    await parent.close();
    const list = await f.service.list({ parentSessionId: parent.id });
    expect(list.map((s) => s.childSessionId).sort()).toEqual([a.child.id, b.child.id].sort());
    expect(list.every((s) => s.callId === "call-1" && s.state === "ended")).toBe(true);
  });

  it("活动项来自登记簿（running，无结束事实）；结束后回到日志映射；嵌套 child 可作为 parent", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const live = await makeChild(f, parent, "call-1", { register: true });
    await childTurn(live.child, 1, { open: true });
    // 孙会话：以活动 child 作为 parent（child 自己是 live session）
    await emitTaskStarted(live.child, "call-g", "c1", { task: "孙任务", profile: "deep" });
    const grand = await makeChild(f, live.child, "call-g");
    await childTurn(grand.child, 1, { finish: true });
    await grand.child.close();

    const running = await f.service.list({ parentSessionId: parent.id });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      childSessionId: live.child.id,
      state: "running",
      profile: "default",
      taskSummary: "整理 日志 文件",
    });
    expect(running[0]?.endedAt).toBeUndefined();
    expect(running[0]?.durationMs).toBeUndefined();
    // 顶层概览只列直接子级；孙级要用 child 作 parent 查询
    const nested = await f.service.list({ parentSessionId: live.child.id });
    expect(nested.map((s) => s.childSessionId)).toEqual([grand.child.id]);
    expect(nested[0]).toMatchObject({ profile: "deep", taskSummary: "孙任务" });

    await live.child.close();
    live.registration?.end();
    const afterEnd = await f.service.list({ parentSessionId: parent.id });
    expect(afterEnd[0]?.state).toBe("unsealed");
    await parent.close();
  });
});

describe("活动子会话：先监听后取前缀，终止信号与事件衔接", () => {
  it("回放期间积累的 400 条临时事件也分批冲刷，不在同一轮卡住后台", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", { register: true });
    await childTurn(child, 1, { open: true });
    let queued = false;
    let delivered = 0;
    let deliveredAtYield = 0;
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      {
        onEvent: (event) => {
          if (!queued) {
            queued = true;
            for (let i = 0; i < 400; i++)
              child.emitEphemeral("runtime.status", { status: "thinking" });
          }
          if (event.type === "runtime.status") {
            delivered++;
            if (delivered === 1)
              setImmediate(() => {
                deliveredAtYield = delivered;
              });
          }
        },
        onEnd: () => undefined,
      },
    );
    expect(delivered).toBe(400);
    // timer 与 immediate 的调度先后因平台而异；要求回调能在缓冲全部送完前获得执行。
    expect(deliveredAtYield).toBeGreaterThan(0);
    expect(deliveredAtYield).toBeLessThan(400);
    observation.unsubscribe();
    await child.close();
    registration?.end();
    await parent.close();
  });

  it("launcher 关闭但 Turn 未闭合：自然结束仍为 unsealed，不能编造最终耗时", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", { register: true });
    await childTurn(child, 1, { open: true });
    const { observer, got } = collector();
    await f.service.observe({ parentSessionId: parent.id, childSessionId: child.id }, observer);
    await child.close();
    registration?.end();
    expect(got.ends[0]?.summary.state).toBe("unsealed");
    expect(got.ends[0]?.summary.endedAt).toBeUndefined();
    expect(got.ends[0]?.summary.durationMs).toBeUndefined();
    await parent.close();
  });

  it("建立后的 signal 取消仍退订实时事件，不影响子会话", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", { register: true });
    const controller = new AbortController();
    const { observer, got } = collector();
    await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id, signal: controller.signal },
      observer,
    );
    const count = got.events.length;
    controller.abort();
    await childTurn(child, 1, { finish: true });
    await child.close();
    registration?.end();
    expect(got.events).toHaveLength(count);
    expect(got.ends).toEqual([]);
    await parent.close();
  });

  it("回放前缀 + 实时持久/临时事件，close 完成后才自然结束，不触碰锁", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", { register: true });
    await childTurn(child, 1, { text: "第一轮" });
    const prefixLength = child.durableEvents().length;

    const { observer, got } = collector();
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      observer,
    );
    expect(observation.mode).toBe("live");
    expect(observation.summary.state).toBe("running");
    expect(observation.lastSeq).toBe(prefixLength);
    expect(durableSeqs(got.events)).toEqual(child.durableEvents().map((e) => e.seq));

    // 催促轮：第一轮的 turn.completed(done) 之后观察必须仍然存活
    expect(got.ends).toEqual([]);
    child.emitEphemeral("runtime.status", { status: "thinking" });
    await childTurn(child, 2, { finish: true });
    expect(got.events.some((e) => e.type === "runtime.status")).toBe(true);
    expect(got.ends).toEqual([]);
    const lockFiles = f.list().filter((name) => name.endsWith(".lock"));
    expect(lockFiles).toContain(`${child.id}.lock`);

    // 异步 close 期间登记项仍在，close 完成后 end 才排入终止标记
    const closing = child.close();
    expect(f.registry.find(child.id)).toBeDefined();
    expect(got.ends).toEqual([]);
    await closing;
    expect(got.ends).toEqual([]);
    registration?.end();
    expect(got.ends).toHaveLength(1);
    expect(got.ends[0]).toMatchObject({
      source: "launcher",
      tailIgnored: false,
      lastSeq: child.durableEvents().at(-1)?.seq,
    });
    expect(got.ends[0]?.summary.state).toBe("ended");
    expect(got.ends[0]?.summary.durationApproximate).toBe(true);
    expect(durableSeqs(got.events)).toEqual(child.durableEvents().map((e) => e.seq));
    expect(f.registry.find(child.id)).toBeUndefined();
    expect(f.guard.writes).toEqual([]);

    // 结束后重复 end、再观察：落到固定快照
    registration?.end();
    expect(got.ends).toHaveLength(1);
    const again = collector();
    const snapshot = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      again.observer,
    );
    expect(snapshot.mode).toBe("snapshot");
    await parent.close();
  });

  it("unsubscribe 幂等，之后不再交付，也不产生 onEnd，运行不受影响", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", { register: true });
    const { observer, got } = collector();
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      observer,
    );
    await childTurn(child, 1, { open: true });
    const seen = got.events.length;
    observation.unsubscribe();
    observation.unsubscribe();
    await childTurn(child, 2, { finish: true });
    expect(got.events).toHaveLength(seen);
    await child.close();
    registration?.end();
    expect(got.ends).toEqual([]);
    expect(child.health).toBe("closed");
    await parent.close();
  });

  it("观察者抛错被吞掉：不影响运行、其他观察者与终止信号", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", { register: true });
    let thrown = 0;
    await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      {
        onEvent: () => {
          thrown += 1;
          throw new Error("观察者自己的错误");
        },
        onEnd: () => {
          thrown += 1;
          throw new Error("观察者自己的错误");
        },
      },
    );
    const good = collector();
    await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      good.observer,
    );
    await childTurn(child, 1, { finish: true });
    await child.close();
    registration?.end();
    expect(thrown).toBeGreaterThan(2);
    expect(child.health).toBe("closed");
    expect(good.got.ends).toHaveLength(1);
    expect(durableSeqs(good.got.events)).toEqual(child.durableEvents().map((e) => e.seq));
    await parent.close();
  });

  it("parent 不符的活动 child 报 subagent_parent_mismatch", async () => {
    const f = fixture();
    const parent = await makeParent(f, "call-1");
    const { child } = await makeChild(f, parent, "call-1", { register: true });
    const other = await makeParent(f, "call-2");
    await expect(
      f.service.observe(
        { parentSessionId: other.id, childSessionId: child.id },
        collector().observer,
      ),
    ).rejects.toMatchObject({ code: "subagent_parent_mismatch" });
    await expect(
      f.service.readAttachment({
        parentSessionId: other.id,
        childSessionId: child.id,
        file: "img-1.png",
      }),
    ).rejects.toMatchObject({ code: "subagent_parent_mismatch" });
    await child.close();
    await parent.close();
    await other.close();
  });
});

describe("几百条事件的回放：分批让出事件循环", () => {
  async function bulkChild(f: Fixture, count: number) {
    const parent = await makeParent(f, "call-1");
    const registered = await makeChild(f, parent, "call-1", { register: true });
    await registered.child.emit("turn.started", { turnIndex: 1 }, { turnId: "c1" });
    for (let i = 0; i < count; i++) {
      await registered.child.emit(
        "message.user",
        { messageId: `m${i}`, content: [{ type: "text", text: `第 ${i} 条` }] },
        { turnId: "c1" },
      );
    }
    return { parent, ...registered };
  }

  it("600 条前缀按序、不丢不重地送达，批间事件循环得以运转", async () => {
    const f = fixture();
    const { parent, child, registration } = await bulkChild(f, 600);
    let ticks = 0;
    let stop = false;
    const ticker = (async () => {
      while (!stop) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        ticks += 1;
      }
    })();
    const { observer, got } = collector();
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      observer,
    );
    stop = true;
    await ticker;
    expect(got.events).toHaveLength(child.durableEvents().length);
    expect(durableSeqs(got.events)).toEqual(child.durableEvents().map((e) => e.seq));
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(observation.lastSeq).toBe(child.durableEvents().length);
    await child.close();
    registration?.end();
    await parent.close();
  });

  it("回放期间产生的新事件被缓冲，冲刷时按 seq 去重", async () => {
    const f = fixture();
    const { parent, child, registration } = await bulkChild(f, 600);
    const delivered: RuntimeEvent[] = [];
    let spawned: Promise<unknown> | undefined;
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      {
        onEvent: (event) => {
          delivered.push(event);
          if (delivered.length === 5) {
            spawned = (async () => {
              for (let i = 0; i < 40; i++) {
                await child.emit(
                  "message.user",
                  { messageId: `late${i}`, content: [{ type: "text", text: `晚到 ${i}` }] },
                  { turnId: "c1" },
                );
              }
            })();
          }
        },
        onEnd: () => undefined,
      },
    );
    // 返回时的高水位就是已交付的最后一个持久 seq；之后的事件走实时通道
    expect(observation.lastSeq).toBe(durableSeqs(delivered).at(-1));
    expect(observation.lastSeq).toBeGreaterThanOrEqual(602);
    await spawned;
    const seqs = durableSeqs(delivered);
    expect(seqs).toEqual(child.durableEvents().map((e) => e.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toHaveLength(642);
    await child.close();
    registration?.end();
    await parent.close();
  });

  it("回放中结束：终止标记被缓冲，冲刷完成后恰好一次 onEnd，响应时已是结束状态", async () => {
    const f = fixture();
    const { parent, child, registration } = await bulkChild(f, 600);
    // launcher 的收尾阶段：Turn 已闭合、child 已 close，但登记项在 end() 之前仍可被查到
    await child.emit("turn.completed", { reason: "error", steps: 1, usage }, { turnId: "c1" });
    await child.close();
    expect(f.registry.find(child.id)).toBeDefined();
    const { observer, got } = collector();
    const observation = await f.service.observe(
      { parentSessionId: parent.id, childSessionId: child.id },
      {
        onEvent: (event) => {
          observer.onEvent(event);
          if (got.events.length === 10) registration?.end();
        },
        onEnd: observer.onEnd,
      },
    );
    expect(f.registry.find(child.id)).toBeUndefined();
    expect(got.ends).toHaveLength(1);
    // onEnd 在最后一条事件之后
    expect(got.eventsAtEnd[0]).toBe(child.durableEvents().length);
    expect(durableSeqs(got.events)).toEqual(child.durableEvents().map((e) => e.seq));
    expect(got.events.at(-1)?.type).toBe("turn.completed");
    expect(observation.mode).toBe("live");
    expect(observation.summary.state).toBe("ended");
    expect(observation.summary).toEqual(got.ends[0]?.summary);
    expect(got.ends[0]).toMatchObject({
      source: "launcher",
      lastSeq: child.durableEvents().length,
    });
    await parent.close();
  });

  it("建立期间取消：停止回放、退订监听、不复活", async () => {
    const f = fixture();
    const { parent, child, registration } = await bulkChild(f, 600);
    const controller = new AbortController();
    const delivered: RuntimeEvent[] = [];
    await expect(
      f.service.observe(
        { parentSessionId: parent.id, childSessionId: child.id, signal: controller.signal },
        {
          onEvent: (event) => {
            delivered.push(event);
            if (delivered.length === 10) controller.abort();
          },
          onEnd: () => {
            throw new Error("取消后不应有 onEnd");
          },
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    const stoppedAt = delivered.length;
    expect(stoppedAt).toBe(10);
    await child.emit(
      "message.user",
      { messageId: "after", content: [{ type: "text", text: "取消之后" }] },
      { turnId: "c1" },
    );
    await child.close();
    registration?.end();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(delivered).toHaveLength(stoppedAt);
    await parent.close();
  });

  it("快照回放同样分批，建立期间取消即停", async () => {
    const f = fixture();
    const { parent, child, registration } = await bulkChild(f, 600);
    await child.close();
    registration?.end();
    const controller = new AbortController();
    const delivered: RuntimeEvent[] = [];
    await expect(
      f.service.observe(
        { parentSessionId: parent.id, childSessionId: child.id, signal: controller.signal },
        {
          onEvent: (event) => {
            delivered.push(event);
            if (delivered.length === 10) controller.abort();
          },
          onEnd: () => {
            throw new Error("取消后不应有 onEnd");
          },
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(delivered).toHaveLength(10);
    await parent.close();
  });
});

describe("readAttachment：复用附件校验，只认 child 自己的登记", () => {
  async function withAttachment(f: Fixture, options: { register?: boolean } = {}) {
    const parent = await makeParent(f, "call-1");
    const { child, registration } = await makeChild(f, parent, "call-1", options);
    const dir = path.join(f.sessionsDir, "attachments", child.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "img-1.png"), PNG_2x3);
    const ref: ImageAttachment = {
      type: "image",
      file: "img-1.png",
      mimeType: "image/png",
      bytes: PNG_2x3.byteLength,
      sha256: createHash("sha256").update(PNG_2x3).digest("hex"),
      source: "read",
    };
    await child.emit("turn.started", { turnIndex: 1 }, { turnId: "c1" });
    await child.emit(
      "tool.completed",
      {
        callId: "r1",
        name: "read",
        status: "ok",
        modelContent: "image",
        attachments: [ref],
      },
      { turnId: "c1" },
    );
    return { parent, child, registration, dir, ref };
  }

  it("已结束 child：读到字节，大小与哈希每次校验，不借父目录、不写文件", async () => {
    const f = fixture();
    const { parent, child, dir } = await withAttachment(f);
    await child.close();
    const input = { parentSessionId: parent.id, childSessionId: child.id };
    const result = await f.service.readAttachment({ ...input, file: "img-1.png" });
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toBe(PNG_2x3.byteLength);
    expect(Array.from(result.data)).toEqual(Array.from(PNG_2x3));

    // 父目录里放同名文件也不会被借用：未登记的文件名就是 attachment_not_found
    const parentDir = path.join(f.sessionsDir, "attachments", parent.id);
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(path.join(parentDir, "img-2.png"), PNG_2x3);
    await expect(f.service.readAttachment({ ...input, file: "img-2.png" })).rejects.toMatchObject({
      code: "attachment_not_found",
    });
    for (const file of ["../img-1.png", "a/b.png", "a\\b.png", "", "CON", "img-1.png.", "x:y"]) {
      await expect(f.service.readAttachment({ ...input, file })).rejects.toMatchObject({
        code: "invalid_attachment_file",
      });
    }
    await expect(
      f.service.readAttachment({ ...input, file: 1 as unknown as string }),
    ).rejects.toMatchObject({ code: "invalid_attachment_file" });

    writeFileSync(path.join(dir, "img-1.png"), new Uint8Array([...PNG_2x3].reverse()));
    await expect(f.service.readAttachment({ ...input, file: "img-1.png" })).rejects.toMatchObject({
      code: "attachment_corrupt",
    });
    writeFileSync(path.join(dir, "img-1.png"), new Uint8Array([1, 2, 3]));
    await expect(f.service.readAttachment({ ...input, file: "img-1.png" })).rejects.toMatchObject({
      code: "attachment_corrupt",
    });
    rmSync(path.join(dir, "img-1.png"));
    await expect(f.service.readAttachment({ ...input, file: "img-1.png" })).rejects.toMatchObject({
      code: "attachment_missing",
    });
    expect(f.guard.writes).toEqual([]);
    await parent.close();
  });

  it("目录链接被拒绝", async () => {
    const f = fixture();
    const { parent, child, dir } = await withAttachment(f);
    await child.close();
    const elsewhere = tmpDir("nct-obs-link-");
    writeFileSync(path.join(elsewhere, "img-1.png"), PNG_2x3);
    rmSync(dir, { recursive: true, force: true });
    try {
      symlinkSync(elsewhere, dir, "junction");
    } catch {
      await parent.close();
      return; // 没有创建链接的权限时跳过
    }
    await expect(
      f.service.readAttachment({
        parentSessionId: parent.id,
        childSessionId: child.id,
        file: "img-1.png",
      }),
    ).rejects.toMatchObject({ code: "invalid_attachment_file" });
    expect(existsSync(path.join(elsewhere, "img-1.png"))).toBe(true);
    await parent.close();
  });

  it("活动 child：授权集合取自它已提交的持久事件", async () => {
    const f = fixture();
    const { parent, child, registration } = await withAttachment(f, { register: true });
    const input = { parentSessionId: parent.id, childSessionId: child.id };
    const result = await f.service.readAttachment({ ...input, file: "img-1.png" });
    expect(result.bytes).toBe(PNG_2x3.byteLength);
    await expect(f.service.readAttachment({ ...input, file: "img-9.png" })).rejects.toMatchObject({
      code: "attachment_not_found",
    });
    await child.close();
    registration?.end();
    await parent.close();
  });
});

describe("summarizeSubagentTask", () => {
  it("压成单行、按 Unicode 码点截断；空文本回退「子任务」", () => {
    expect(summarizeSubagentTask("  a\n\tb   c  ")).toBe("a b c");
    expect(Array.from(summarizeSubagentTask("😀".repeat(200)))).toHaveLength(120);
    expect(summarizeSubagentTask(" \n ")).toBe("子任务");
  });
});
