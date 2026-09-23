import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNodeFileSystem, createPlatform } from "../platform/index.js";
import type { RuntimeEvent } from "../protocol/index.js";
import { createSessionStore, type SessionStore } from "./index.js";

let dir: string;
let store: SessionStore;
const realFs = createNodeFileSystem();
const paths = createPlatform().paths;

const INPUT = {
  cwd: "Z:\\repo",
  workspaceRoot: "Z:\\repo",
  model: { provider: "fake", model: "fake-1" },
  permissionPreset: "phase1",
  nocturneVersion: "0.0.0",
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-session-"));
  store = createSessionStore({ fs: realFs, paths, sessionsDir: dir });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function readLines(p: string): Promise<string[]> {
  return fs.readFile(p, "utf8").then((t) => t.split("\n").filter((l) => l !== ""));
}

describe("create + emit", () => {
  it("create 写入 session.created(seq=1)，状态折叠出 meta/config", async () => {
    const s = await store.create(INPUT);
    const lines = await readLines(s.logPath);
    expect(lines).toHaveLength(1);
    const first = JSON.parse(lines[0] ?? "") as { type: string; seq: number };
    expect(first.type).toBe("session.created");
    expect(first.seq).toBe(1);

    const state = s.state();
    expect(state.meta.id).toBe(s.id);
    expect(state.meta.cwd).toBe(INPUT.cwd);
    expect(state.config.model).toEqual(INPUT.model);
    expect(state.lastSeq).toBe(1);
  });

  it("持久化事件：先写日志再发布，seq 连续", async () => {
    const s = await store.create(INPUT);
    const seen: RuntimeEvent[] = [];
    const fileAtPublish: string[] = [];
    s.subscribe((e) => {
      seen.push(e);
      // 发布时该行必须已在日志中（先写后发）——异步读取无法同步验证，
      // 这里记录条数，发布后比对 seq 是否已落入 events
      fileAtPublish.push(`${e.type}@${s.durableEvents().length}`);
    });
    await s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s.emit(
      "message.user",
      { messageId: "m1", content: [{ type: "text", text: "hi" }] },
      { turnId: "t1" },
    );
    expect(fileAtPublish).toEqual(["turn.started@2", "message.user@3"]);
    const lines = await readLines(s.logPath);
    expect(lines).toHaveLength(3);
    expect((seen[0] as { seq: number }).seq).toBe(2);
    expect((seen[1] as { seq: number }).seq).toBe(3);
  });

  it("临时事件：runId + eseq + afterSeq，不写日志不占 seq", async () => {
    const s = await store.create(INPUT);
    const seen: RuntimeEvent[] = [];
    s.subscribe((e) => seen.push(e));
    s.emitEphemeral("runtime.status", { status: "thinking" }, { turnId: "t1" });
    await s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    s.emitEphemeral("runtime.status", { status: "idle" }, { turnId: "t1" });

    const eph1 = seen[0] as { eseq: number; afterSeq: number; runId: string };
    const eph2 = seen[2] as { eseq: number; afterSeq: number };
    expect(eph1.eseq).toBe(1);
    expect(eph1.afterSeq).toBe(1); // 只有 session.created 已发布
    expect(eph1.runId).toBe(s.runId);
    expect(eph2.eseq).toBe(2);
    expect(eph2.afterSeq).toBe(2); // turn.started 已发布
    expect(await readLines(s.logPath)).toHaveLength(2);
  });

  it("订阅者抛异常不影响分发与其他订阅者", async () => {
    const s = await store.create(INPUT);
    const seen: string[] = [];
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe((e) => seen.push(e.type));
    await s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    expect(seen).toEqual(["session.created", "turn.started"].slice(1));
    expect(s.diagnostics()).toHaveLength(1);
  });
});

describe("load / 状态折叠", () => {
  it("load 重建状态：新 runId、seq 继续、历史完整", async () => {
    const s1 = await store.create(INPUT);
    await s1.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s1.emit(
      "message.user",
      { messageId: "m1", content: [{ type: "text", text: "hi" }] },
      { turnId: "t1" },
    );
    await s1.emit(
      "message.assistant",
      {
        messageId: "m2",
        model: INPUT.model,
        content: [{ type: "text", text: "reading" }],
        toolCalls: [{ callId: "c1", providerCallId: "p1", name: "read" }],
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "tool_calls",
      },
      { turnId: "t1" },
    );
    await s1.emit(
      "tool.completed",
      { callId: "c1", name: "read", status: "ok", modelContent: "content" },
      { turnId: "t1" },
    );
    await s1.emit(
      "turn.completed",
      { reason: "done", steps: 1, usage: { inputTokens: 10, outputTokens: 5 } },
      { turnId: "t1" },
    );
    await s1.close();

    const s2 = await store.load(s1.id);
    expect(s2.runId).not.toBe(s1.runId);
    const state = s2.state();
    expect(state.lastSeq).toBe(6);
    expect(state.openTurn).toBeUndefined();
    expect(state.unsettledCalls.size).toBe(0);
    expect(state.history.map((h) => h.kind)).toEqual(["user", "assistant", "tool"]);
    expect(state.usage.inputTokens).toBe(10);
    // seq 继续递增
    const ev = await s2.emit("turn.started", { turnIndex: 2 }, { turnId: "t2" });
    expect(ev.seq).toBe(7);
  });

  it("openTurn 与 unsettledCalls 正确折叠（含 tool.started 标记）", async () => {
    const s = await store.create(INPUT);
    await s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s.emit(
      "message.assistant",
      {
        messageId: "m1",
        model: INPUT.model,
        content: [],
        toolCalls: [
          { callId: "c1", name: "read" },
          { callId: "c2", name: "grep" },
        ],
        finishReason: "tool_calls",
      },
      { turnId: "t1" },
    );
    await s.emit(
      "tool.started",
      {
        callId: "c1",
        name: "read",
        input: {},
        subjects: [],
        permission: { action: "allow", source: "rule" },
      },
      { turnId: "t1" },
    );
    const state = s.state();
    expect(state.openTurn).toEqual({ turnId: "t1", turnIndex: 1 });
    expect(state.unsettledCalls.get("c1")?.started).toBe(true);
    expect(state.unsettledCalls.get("c2")?.started).toBe(false);
  });

  it("session.config_changed 更新 config", async () => {
    const s = await store.create(INPUT);
    await s.emit("session.config_changed", {
      model: { provider: "fake", model: "fake-2" },
    });
    expect(s.state().config.model.model).toBe("fake-2");
    expect(s.state().config.permissionPreset).toBe("phase1");
  });
});

describe("load 校验（events.md 第 8 节）", () => {
  async function writeLog(name: string, lines: unknown[]): Promise<string> {
    const p = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return name;
  }
  const base = {
    sessionId: "x",
    time: "2026-01-01T00:00:00.000Z",
  };
  const created = (over: object = {}) => ({
    ...base,
    type: "session.created",
    seq: 1,
    payload: { ...INPUT, formatVersion: 1, ...over },
  });

  it("不认识的持久化事件类型 → session_log_newer", async () => {
    await writeLog("newer1", [created(), { ...base, type: "future.event", seq: 2, payload: {} }]);
    await expect(store.load("newer1")).rejects.toMatchObject({
      code: "session_log_newer",
    });
  });

  it("formatVersion 更高 → session_log_newer", async () => {
    await writeLog("newer2", [created({ formatVersion: 99 })]);
    await expect(store.load("newer2")).rejects.toMatchObject({
      code: "session_log_newer",
    });
  });

  it("中间行损坏 → session_log_corrupt", async () => {
    const p = path.join(dir, "corrupt1.jsonl");
    await fs.writeFile(p, `${JSON.stringify(created())}\n{bad json\n`);
    await expect(store.load("corrupt1")).rejects.toMatchObject({
      code: "session_log_corrupt",
    });
  });

  it("seq 不连续 → session_log_corrupt", async () => {
    await writeLog("corrupt2", [
      created(),
      { ...base, type: "turn.started", seq: 5, payload: { turnIndex: 1 } },
    ]);
    await expect(store.load("corrupt2")).rejects.toMatchObject({
      code: "session_log_corrupt",
    });
  });

  it("首行不是 session.created → session_log_corrupt", async () => {
    await writeLog("corrupt3", [
      { ...base, type: "turn.started", seq: 1, payload: { turnIndex: 1 } },
    ]);
    await expect(store.load("corrupt3")).rejects.toMatchObject({
      code: "session_log_corrupt",
    });
  });

  it("不存在的会话 → session_not_found", async () => {
    await expect(store.load("nope-nothing")).rejects.toMatchObject({
      code: "session_not_found",
    });
  });
});

describe("写入失败 → failed", () => {
  it("append 失败：health=failed、failedSignal 中止、后续 emit 拒绝、发出 runtime.error", async () => {
    const s = await store.create(INPUT);
    const ephemeral: RuntimeEvent[] = [];
    s.subscribe((e) => {
      if (!("seq" in e)) ephemeral.push(e);
    });
    // 把日志路径替换成目录，appendFile 必败
    await fs.rm(s.logPath);
    await fs.mkdir(s.logPath);

    await expect(s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" })).rejects.toMatchObject({
      code: "session_failed",
    });
    expect(s.health).toBe("failed");
    expect(s.failedSignal.aborted).toBe(true);
    await expect(s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" })).rejects.toMatchObject({
      code: "session_failed",
    });
    const err = ephemeral.find((e) => e.type === "runtime.error");
    expect(err).toBeDefined();
  });
});

describe("list", () => {
  it("列出会话摘要并可按 cwd 过滤", async () => {
    const s = await store.create(INPUT);
    const all = await store.list();
    expect(all.some((x) => x.id === s.id)).toBe(true);
    const filtered = await store.list({ cwd: "D:\\nowhere" });
    expect(filtered.some((x) => x.id === s.id)).toBe(false);
  });
});
