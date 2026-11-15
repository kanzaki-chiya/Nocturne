/**
 * 用户发言时间旁路（<sessionsDir>/<id>.activity.json）：写入维护、系统消息排除、
 * 损坏/缺失降级、写失败诊断、分叉不继承与恢复修复。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatform, type Platform } from "../src/platform/index.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { createSessionStore } from "../src/session/index.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix = "nct-activity-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const textScript = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

async function waitForDiagnostic(diagFile: string, kind: string): Promise<void> {
  await vi.waitFor(() => {
    const lines = existsSync(diagFile)
      ? readFileSync(diagFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const matched = lines.some((line) => (JSON.parse(line) as { kind?: string }).kind === kind);
    expect(matched).toBe(true);
  });
}

async function setupRuntime(
  options: { scripts?: FakeScript[]; runtime?: Partial<RuntimeOptions> } = {},
) {
  const root = tmpRoot();
  const workspace = path.join(root, "ws");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(workspace);
  const diag = path.join(root, "diagnostic.jsonl");
  const provider = new FakeProvider({
    ...(options.scripts !== undefined ? { scripts: options.scripts } : {}),
  });
  const runtime: Runtime = await createRuntime({
    cwd: workspace,
    sessionsDir,
    providers: [provider],
    debug: { enabled: true, file: diag },
    ...options.runtime,
  });
  return { root, workspace, sessionsDir, diag, runtime };
}

function activityPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.activity.json`);
}

describe("activity.json 旁路与 lastUserMs", () => {
  it("用户消息写入 { at, seq } 旁路文件，四种系统注入消息不写", async () => {
    const root = tmpRoot();
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir);
    const store = createSessionStore({ platform: createPlatform(), sessionsDir });
    const session = await store.create({
      cwd: root,
      workspaceRoot: root,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      nocturneVersion: "0.0.0-test",
    });

    expect(existsSync(activityPath(sessionsDir, session.id))).toBe(false);

    const userEvent = await session.emit(
      "message.user",
      { messageId: "u-1", content: [{ type: "text", text: "普通用户消息" }] },
      { turnId: "t-1" },
    );
    const expectedAt = Date.parse(userEvent.time);
    const expectedSeq = userEvent.seq;
    expect(JSON.parse(readFileSync(activityPath(sessionsDir, session.id), "utf8"))).toEqual({
      at: expectedAt,
      seq: expectedSeq,
    });

    // 四种系统注入消息均不得更新 activity.json
    await session.emit(
      "message.user",
      {
        messageId: "sys-subagent",
        content: [{ type: "text", text: "子代理结果" }],
        subagent: { childSessionId: "c1", callId: "call-1", status: "ok" },
      },
      { turnId: "t-2" },
    );
    await session.emit(
      "message.user",
      {
        messageId: "sys-bg",
        content: [{ type: "text", text: "后台命令结果" }],
        backgroundShell: { taskId: "bg-1", callId: "call-2", status: "exited", exitCode: 0 },
      },
      { turnId: "t-3" },
    );
    await session.emit(
      "message.user",
      {
        messageId: "sys-ensemble",
        content: [{ type: "text", text: "合奏投递" }],
        ensemble: { postNumber: 1, from: "maestro", fromKind: "maestro" },
      },
      { turnId: "t-4" },
    );
    await session.emit(
      "message.user",
      {
        messageId: "sys-runtime-mode",
        content: [{ type: "text", text: "目标续跑" }],
        workMode: { name: "goal", body: "继续检查", source: "runtime" },
      },
      { turnId: "t-5" },
    );
    expect(JSON.parse(readFileSync(activityPath(sessionsDir, session.id), "utf8"))).toEqual({
      at: expectedAt,
      seq: expectedSeq,
    });

    // steer 插话与普通 workMode 用户消息都会更新
    const steerEvent = await session.emit(
      "message.user",
      {
        messageId: "u-steer",
        content: [{ type: "text", text: "用户插话" }],
        steer: true,
        workMode: { name: "goal", body: "用户目标" },
      },
      { turnId: "t-5" },
    );
    expect(JSON.parse(readFileSync(activityPath(sessionsDir, session.id), "utf8"))).toEqual({
      at: Date.parse(steerEvent.time),
      seq: steerEvent.seq,
    });
    await session.close();

    const listed = await store.list();
    expect(listed[0]?.lastUserMs).toBe(Date.parse(steerEvent.time));
  });

  it("Runtime submit、enqueueInput 排队/插话更新旁路，list() 不回退读整份日志", async () => {
    const s = await setupRuntime({
      scripts: [[{ type: "wait", ms: 80 }, ...textScript("第一轮完成")], textScript("排队完成")],
    });
    const session = await s.runtime.createSession({ model: "fake/fake-1" });
    const firstTurn = session.submit({ text: "你好" });
    await vi.waitFor(() => expect(existsSync(activityPath(s.sessionsDir, session.id))).toBe(true));
    const firstSidecar = JSON.parse(
      readFileSync(activityPath(s.sessionsDir, session.id), "utf8"),
    ) as { at: number; seq: number };

    await session.enqueueInput("queue", { text: "排队消息" });
    await firstTurn;
    await vi.waitFor(() => {
      const next = JSON.parse(readFileSync(activityPath(s.sessionsDir, session.id), "utf8")) as {
        at: number;
        seq: number;
      };
      expect(next.seq).toBeGreaterThan(firstSidecar.seq);
    });
    await session.close();

    // 确认 list() 取 lastUserMs 时不读整份 .jsonl 日志
    const base = createPlatform();
    let jsonlFullReads = 0;
    const counted: Platform = {
      ...base,
      fs: {
        ...base.fs,
        readFile: (p) => {
          if (p.endsWith(".jsonl")) jsonlFullReads += 1;
          return base.fs.readFile(p);
        },
        readTextFile: (p) => {
          if (p.endsWith(".jsonl")) jsonlFullReads += 1;
          return base.fs.readTextFile(p);
        },
      },
    };
    const store = createSessionStore({ platform: counted, sessionsDir: s.sessionsDir });
    const summaries = await store.list();
    expect(summaries[0]?.lastUserMs).toBeGreaterThanOrEqual(firstSidecar.at);
    expect(jsonlFullReads).toBe(0);
  });

  it("旁路缺失或损坏时 list() 不带 lastUserMs 且损坏记诊断", async () => {
    const s = await setupRuntime({ scripts: [textScript("ok")] });
    const session = await s.runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "第一句" });
    await session.close();

    const sidecar = activityPath(s.sessionsDir, session.id);
    rmSync(sidecar);
    const missingList = await s.runtime.listSessions();
    expect(missingList[0]).toBeDefined();
    expect("lastUserMs" in (missingList[0] ?? {})).toBe(false);

    for (const bad of [
      "{broken",
      "null",
      JSON.stringify({ at: -1, seq: 2 }),
      JSON.stringify({ at: "123", seq: 2 }),
      JSON.stringify({ at: 1000, seq: 0 }),
    ]) {
      writeFileSync(sidecar, bad);
      const list = await s.runtime.listSessions();
      expect("lastUserMs" in (list[0] ?? {})).toBe(false);
    }
    await waitForDiagnostic(s.diag, "session.activity_sidecar_invalid");
  });

  it("写旁路失败只记诊断，不回滚日志也不让会话进入 failed", async () => {
    const root = tmpRoot();
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir);
    const diagnostics: { id: string; reason: string }[] = [];
    const base = createPlatform();
    const faulty: Platform = {
      ...base,
      fs: {
        ...base.fs,
        rename: async (from, to) => {
          if (to.endsWith(".activity.json")) throw new Error("disk full");
          return base.fs.rename(from, to);
        },
      },
    };
    const store = createSessionStore({
      platform: faulty,
      sessionsDir,
      onActivityDiagnostic: (id, reason) => diagnostics.push({ id, reason }),
    });
    const session = await store.create({
      cwd: root,
      workspaceRoot: root,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      nocturneVersion: "0.0.0-test",
    });
    const ev = await session.emit(
      "message.user",
      { messageId: "m1", content: [{ type: "text", text: "仍然落盘" }] },
      { turnId: "t1" },
    );
    expect(session.health).toBe("ok");
    expect(session.durableEvents().some((e) => e.seq === ev.seq)).toBe(true);
    expect(diagnostics).toEqual([{ id: session.id, reason: "write_failed" }]);
    expect(existsSync(activityPath(sessionsDir, session.id))).toBe(false);
    await session.close();
  });

  it("分叉不继承源会话的 activity.json，恢复时也不从源消息重建", async () => {
    const s = await setupRuntime({ scripts: [textScript("一"), textScript("二")] });
    const source = await s.runtime.createSession({ model: "fake/fake-1" });
    await source.submit({ text: "源消息" });
    const targetSeq = source.durableEvents().find((e) => e.type === "message.user")?.seq;
    if (targetSeq === undefined) throw new Error("缺少用户消息");
    expect(existsSync(activityPath(s.sessionsDir, source.id))).toBe(true);

    const forkFullId = await s.runtime.forkSession(source.id);
    const forkAtSeqId = await s.runtime.forkSession(source.id, { targetSeq });
    expect(existsSync(activityPath(s.sessionsDir, forkFullId))).toBe(false);
    expect(existsSync(activityPath(s.sessionsDir, forkAtSeqId))).toBe(false);
    await source.close();

    // 恢复分叉但未发新消息，仍不继承源会话的 lastUserMs
    const resumedFork = await s.runtime.resumeSession(forkFullId);
    await resumedFork.close();
    const resumedRewoundFork = await s.runtime.resumeSession(forkAtSeqId);
    await resumedRewoundFork.close();

    const list = await s.runtime.listSessions();
    const forkSummary = list.find((item) => item.id === forkFullId);
    const rewoundSummary = list.find((item) => item.id === forkAtSeqId);
    expect(forkSummary?.lastUserMs).toBeUndefined();
    expect(rewoundSummary?.lastUserMs).toBeUndefined();

    // 分叉后发出新用户消息才建立自己的 activity.json
    const activeFork = await s.runtime.resumeSession(forkFullId);
    await activeFork.submit({ text: "分叉后的新发言" });
    await activeFork.close();
    const updatedList = await s.runtime.listSessions();
    expect(updatedList.find((item) => item.id === forkFullId)?.lastUserMs).toEqual(
      expect.any(Number),
    );
  });

  it("恢复修复：缺失、损坏或过期的旁路在 load 时按日志最后一条用户消息修复；归档不改动旁路", async () => {
    const s = await setupRuntime({ scripts: [textScript("回复")] });
    const session = await s.runtime.createSession({ model: "fake/fake-1" });
    await session.submit({ text: "用户消息" });
    const userMsg = session.durableEvents().findLast((e) => e.type === "message.user");
    expect(userMsg).toBeDefined();
    const expectedAt = Date.parse(userMsg!.time);
    const expectedSeq = userMsg!.seq;
    await session.close();

    const sidecar = activityPath(s.sessionsDir, session.id);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ at: expectedAt, seq: expectedSeq });

    // 归档与取消归档不动 activity.json
    await s.runtime.archiveSession(session.id);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ at: expectedAt, seq: expectedSeq });
    expect(
      (await s.runtime.listSessions({ includeArchived: true })).find((i) => i.id === session.id)
        ?.lastUserMs,
    ).toBe(expectedAt);
    await s.runtime.unarchiveSession(session.id);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ at: expectedAt, seq: expectedSeq });

    // 缺失、损坏、过期在 resume 时修复
    for (const bad of [null, "broken", JSON.stringify({ at: 123, seq: 999 })]) {
      if (bad === null) rmSync(sidecar);
      else writeFileSync(sidecar, bad);
      const resumed = await s.runtime.resumeSession(session.id);
      expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
        at: expectedAt,
        seq: expectedSeq,
      });
      await resumed.close();
    }
  });
});
