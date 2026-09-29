import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../platform/index.js";
import { replaySessionView, type RuntimeEvent } from "../protocol/index.js";
import { createSessionStore, type SessionStore } from "./index.js";

let dir: string;
let store: SessionStore;
const platform = createPlatform();
const realFs = platform.fs;

const INPUT = {
  cwd: "Z:\\repo",
  workspaceRoot: "Z:\\repo",
  model: { provider: "fake", model: "fake-1" },
  permissionPreset: "phase1",
  nocturneVersion: "0.0.0",
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-session-"));
  store = createSessionStore({ platform, sessionsDir: dir });
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
  it("清单只跟随有效已落盘的完成事件，恢复与子会话隔离", async () => {
    const parent = await store.create(INPUT);
    const item = { text: "第一步", status: "completed" as const };
    const completed = (status: "ok" | "error" | "denied" | "interrupted", output: unknown) => ({
      callId: "todo",
      name: "todo_write",
      status,
      modelContent: "updated",
      output,
    });
    await parent.emit("tool.completed", completed("ok", { items: [item] }));
    await parent.emit("tool.started", {
      callId: "later",
      name: "todo_write",
      input: { items: [] },
      subjects: [],
      permission: { action: "allow", source: "rule" },
    });
    await parent.emit("tool.completed", completed("error", { items: [] }));
    await parent.emit("tool.completed", completed("denied", { items: [] }));
    await parent.emit("tool.completed", completed("interrupted", { items: [] }));
    await parent.emit(
      "tool.completed",
      completed("ok", { items: [{ text: "", status: "pending" }] }),
    );
    expect(parent.state().todos).toEqual([item]);
    expect(replaySessionView(parent.durableEvents()).todos).toEqual(parent.state().todos);
    const child = await store.create(INPUT);
    expect(child.state().todos).toEqual([]);
    await child.emit(
      "tool.completed",
      completed("ok", { items: [{ text: "子任务", status: "pending" }] }),
    );
    expect(parent.state().todos).toEqual([item]);
    await parent.close();
    const reopened = await store.load(parent.id);
    expect(reopened.state().todos).toEqual([item]);
    expect(replaySessionView(reopened.durableEvents()).todos).toEqual([item]);
    await reopened.emit("tool.completed", completed("ok", { items: [] }));
    expect(reopened.state().todos).toEqual([]);
    expect(replaySessionView(reopened.durableEvents()).todos).toEqual([]);
    await reopened.close();
    await child.close();
  });
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

  it("config_changed.shell 折叠为 config.shell 并在该位置留 note 条目（ADR-0022 第 4 节）", async () => {
    const s = await store.create(INPUT);
    await s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s.emit(
      "message.user",
      { messageId: "m1", content: [{ type: "text", text: "hi" }] },
      { turnId: "t1" },
    );
    await s.emit(
      "turn.completed",
      { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
      { turnId: "t1" },
    );
    await s.emit("session.config_changed", {
      shell: { kind: "pwsh", path: "C:\\ps\\pwsh.exe" },
    });
    await s.emit("turn.started", { turnIndex: 2 }, { turnId: "t2" });
    await s.emit(
      "message.user",
      { messageId: "m2", content: [{ type: "text", text: "next" }] },
      { turnId: "t2" },
    );

    const state = s.state();
    expect(state.config.shell).toEqual({ kind: "pwsh", path: "C:\\ps\\pwsh.exe" });
    // note 位于两条 user 消息之间（事件位置保持）
    const kinds = state.history.map((h) => h.kind);
    expect(kinds).toEqual(["user", "note", "user"]);
    const note = state.history[1];
    expect(note?.kind === "note" && note.text).toContain("[Environment change]");
    expect(note?.kind === "note" && note.text).toContain("pwsh");

    // 重新加载：config.shell 与 note 原样重建
    await s.close();
    const s2 = await store.load(s.id);
    expect(s2.state().config.shell).toEqual({ kind: "pwsh", path: "C:\\ps\\pwsh.exe" });
    expect(s2.state().history.map((h) => h.kind)).toEqual(["user", "note", "user"]);
  });
});

describe("图片附件字段（ADR-0023 第 2 节）", () => {
  const att = {
    type: "image" as const,
    file: "img-1.png",
    mimeType: "image/png" as const,
    bytes: 29,
    sha256: "ab".repeat(32),
    width: 2,
    height: 3,
    source: "read" as const,
  };

  it("message.user / tool.completed 的 attachments 折叠进历史；无字段时键不出现", async () => {
    const s = await store.create(INPUT);
    await s.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s.emit(
      "message.user",
      {
        messageId: "m1",
        content: [{ type: "text", text: "看图" }],
        attachments: [att],
      },
      { turnId: "t1" },
    );
    await s.emit(
      "tool.completed",
      {
        callId: "c1",
        name: "read",
        status: "ok",
        modelContent: "x",
        attachments: [att],
      },
      { turnId: "t1" },
    );
    await s.emit(
      "message.user",
      { messageId: "m2", content: [{ type: "text", text: "无图" }] },
      { turnId: "t1" },
    );

    const [u1, t1, u2] = s.state().history;
    expect(u1?.kind === "user" && u1.attachments?.[0]?.file).toBe("img-1.png");
    expect(u1?.kind === "user" && u1.attachments?.[0]?.source).toBe("read");
    expect(t1?.kind === "tool" && t1.attachments?.[0]?.sha256).toBe(att.sha256);
    // 旧日志形态：无附件的条目不含 attachments 键
    expect(u2?.kind === "user" && "attachments" in u2).toBe(false);
    await s.close();
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
    // 损坏行不在末尾：无法按尾部截断恢复（sessions.md 第 4 节第 3/4 步）
    await writeLog("corrupt1", [
      created(),
      "not-json-at-all",
      { ...base, type: "turn.started", seq: 3, payload: { turnIndex: 1 } },
    ]);
    await expect(store.load("corrupt1")).rejects.toMatchObject({
      code: "session_log_corrupt",
    });
  });

  it("损坏尾部：截断、另存 tail 文件、恢复后可用（sessions.md 4.3）", async () => {
    const p = path.join(dir, "tail1.jsonl");
    await fs.writeFile(
      p,
      `${JSON.stringify(created())}\n${JSON.stringify({ ...base, type: "turn.started", seq: 2, payload: { turnIndex: 1 }, turnId: "t1" })}\n{"type":"tool.`,
    );
    const s = await store.load("tail1");
    expect(s.recovery?.truncatedTail).toMatch(/^tail1\.jsonl\.tail-/);
    // 尾部另存为诊断文件
    const names = await fs.readdir(dir);
    expect(names.some((n) => n.startsWith("tail1.jsonl.tail-"))).toBe(true);
    // 未结束 Turn 被收束为 process_exited
    expect(s.recovery?.recoveredTurns).toBe(1);
    expect(s.state().openTurn).toBeUndefined();
    const lines = await readLines(s.logPath);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({
      type: "turn.completed",
      payload: { recovered: true },
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

describe("恢复修复（sessions.md 第 6 节）", () => {
  it("未结算调用补 tool.completed(interrupted)，未结束 Turn 收束为 process_exited", async () => {
    const s1 = await store.create(INPUT);
    await s1.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s1.emit(
      "message.assistant",
      {
        messageId: "m1",
        model: INPUT.model,
        content: [],
        toolCalls: [
          { callId: "c1", name: "read" },
          { callId: "c2", name: "write" },
        ],
        finishReason: "tool_calls",
      },
      { turnId: "t1" },
    );
    await s1.emit(
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
    // 模拟崩溃：不 close、不走正常收束——直接释放锁模拟进程死亡
    await s1.close();

    const s2 = await store.load(s1.id);
    expect(s2.recovery?.interruptedCalls).toBe(2);
    expect(s2.recovery?.recoveredTurns).toBe(1);
    const state = s2.state();
    expect(state.openTurn).toBeUndefined();
    expect(state.unsettledCalls.size).toBe(0);
    const toolEntries = state.history.filter((h) => h.kind === "tool");
    const c1 = toolEntries.find((h) => h.callId === "c1");
    const c2 = toolEntries.find((h) => h.callId === "c2");
    expect(c1?.status).toBe("interrupted");
    expect(c2?.status).toBe("interrupted");
    // started 的调用提示"可能已部分执行"；未 started 的提示"未执行"
    expect(c1?.modelContent).toContain("部分执行");
    expect(c2?.modelContent).toContain("未执行");
    // 恢复后可继续提交
    const ev = await s2.emit("turn.started", { turnIndex: 2 }, { turnId: "t2" });
    expect(ev.seq).toBe(state.lastSeq + 1);
  });
});

describe("会话锁（ADR-0009）", () => {
  it("同进程已持锁的会话再 load → session_locked；close 后可打开", async () => {
    const s1 = await store.create(INPUT);
    await expect(store.load(s1.id)).rejects.toMatchObject({ code: "session_locked" });
    // 锁文件存在
    const names = await fs.readdir(dir);
    expect(names).toContain(`${s1.id}.lock`);
    await s1.close();
    // 关闭释放锁
    const namesAfter = await fs.readdir(dir);
    expect(namesAfter).not.toContain(`${s1.id}.lock`);
    const s2 = await store.load(s1.id);
    expect(s2.id).toBe(s1.id);
    await s2.close();
  });

  it("force：强制清锁后打开", async () => {
    const s1 = await store.create(INPUT);
    const s2 = await store.load(s1.id, { force: true });
    expect(s2.id).toBe(s1.id);
    // 旧持有者释放时不得误删新锁（release 校验锁内容归属）
    await s1.close();
    expect(await realFs.exists(path.join(dir, `${s1.id}.lock`))).toBe(true);
    await s2.close();
  });

  it("失效锁（startedAt 早于开机）自动清理并打开", async () => {
    const s1 = await store.create(INPUT);
    const id = s1.id;
    await s1.close();
    // 手写一个远古锁
    await fs.writeFile(
      path.join(dir, `${id}.lock`),
      JSON.stringify({ pid: 999999, hostname: "other-host", startedAt: 1 }),
    );
    const s2 = await store.load(id);
    expect(s2.id).toBe(id);
    await s2.close();
  });

  it("list 标注 locked 状态", async () => {
    const s = await store.create(INPUT);
    const all = await store.list();
    expect(all.find((x) => x.id === s.id)?.locked).toBe(true);
    await s.close();
    const after = await store.list();
    expect(after.find((x) => x.id === s.id)?.locked).toBe(false);
  });
});

describe("写入失败 → failed", () => {
  it("append 失败：health=failed、failedSignal 中止、后续 emit 拒绝、发出 runtime.error", async () => {
    const s = await store.create(INPUT);
    const oldItems = [{ text: "保留旧清单", status: "pending" as const }];
    await s.emit("tool.completed", {
      callId: "old",
      name: "todo_write",
      status: "ok",
      modelContent: "updated",
      output: { items: oldItems },
    });
    const ephemeral: RuntimeEvent[] = [];
    s.subscribe((e) => {
      if (!("seq" in e)) ephemeral.push(e);
    });
    // 把日志路径替换成目录，appendFile 必败
    await fs.rm(s.logPath);
    await fs.mkdir(s.logPath);

    await expect(
      s.emit("tool.completed", {
        callId: "new",
        name: "todo_write",
        status: "ok",
        modelContent: "updated",
        output: { items: [] },
      }),
    ).rejects.toMatchObject({ code: "session_failed" });
    expect(s.health).toBe("failed");
    expect(s.failedSignal.aborted).toBe(true);
    expect(s.state().todos).toEqual(oldItems);
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
