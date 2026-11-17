import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { loadConfig } from "../src/config/index.js";
import { createPlatform } from "../src/platform/index.js";
import { replaySessionView } from "../src/protocol/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import { createSessionStore } from "../src/session/index.js";
import {
  createExecutionScope,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  noteWriteTool,
  type PermissionGate,
} from "../src/tools/index.js";

const dirs: string[] = [];
function tempDir(prefix = "nct-notes-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const openRuntimes: { closeAll(): Promise<void> }[] = [];

afterEach(async () => {
  for (const rt of openRuntimes.splice(0)) {
    await rt.closeAll().catch(() => undefined);
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("ADR-0095 note_write 端到端集成测试", () => {
  it("同一步连续调用、跨轮更新、原子失败保留旧笔记、恢复/分叉/回退与严格前缀", async () => {
    const cwd = await createPlatform().resolveReal(tempDir("nct-notes-ws-"));
    const sessionsDir = tempDir("nct-notes-sess-");
    const recorded: ModelRequest[] = [];
    let step = 0;

    const provider = new FakeProvider({
      handler: (req): FakeScript => {
        recorded.push(structuredClone(req));
        step += 1;
        if (step === 1) {
          // 同一步先新增两条，再先删 1 后加一条（验证串行执行后状态立即同步与重排）
          return [
            {
              type: "tool_call",
              toolCallId: "n1",
              name: "note_write",
              input: { add: ["约束 A", "事实 B"] },
            },
            {
              type: "tool_call",
              toolCallId: "n2",
              name: "note_write",
              input: { remove: [1], add: ["决定 C"] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 2) {
          // 正常收尾前，请求应是严格前缀的追加
          return [
            { type: "text_delta", text: "第一轮完成" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (step === 3) {
          // 第二轮：故意删除不存在的编号 + 新增（应原子失败，不改旧笔记）
          return [
            {
              type: "tool_call",
              toolCallId: "n3-bad",
              name: "note_write",
              input: { remove: [99], add: ["不该写入"] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 4) {
          // 第二轮再合法删除 1 并新增
          return [
            {
              type: "tool_call",
              toolCallId: "n4-ok",
              name: "note_write",
              input: { remove: [1], add: ["事实 D"] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const rt = await createRuntime({
      cwd,
      sessionsDir,
      providers: [provider],
      subagent: { enabled: true },
    });
    const session = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
    openRuntimes.push({ closeAll: () => session.close() });

    await session.submit({ text: "第一轮任务" });
    const afterTurn1 = [
      { n: 1, text: "事实 B" },
      { n: 2, text: "决定 C" },
    ];
    expect(session.state().notes).toEqual(afterTurn1);
    expect(replaySessionView(session.durableEvents()).notes).toEqual(afterTurn1);

    // 验证第一轮第 2 次请求严格延续第 1 次请求前缀，且未注入重复 notes 块
    const req1 = recorded[0];
    const req2 = recorded[1];
    if (req1 === undefined || req2 === undefined) throw new Error("Expected 2 recorded requests");
    expect(req2.messages.slice(0, req1.messages.length)).toEqual(req1.messages);
    expect(req1.cachePrefix?.messages).toBe(req1.messages.length);
    expect(req2.cachePrefix?.messages).toBe(req2.messages.length);
    expect(session.describeContext().report.sections.some((s) => s.name === "notes")).toBe(false);

    await session.submit({ text: "第二轮任务" });
    const afterTurn2 = [
      { n: 1, text: "决定 C" },
      { n: 2, text: "事实 D" },
    ];
    expect(session.state().notes).toEqual(afterTurn2);
    expect(replaySessionView(session.durableEvents()).notes).toEqual(afterTurn2);

    // 分叉到第二轮用户消息之前：分叉会话保留第一轮末尾笔记，原会话保持第二轮末尾笔记
    const targets = await session.rewindTargets();
    expect(targets).toHaveLength(2);
    const turn2Target = targets.find((t) => t.text === "第二轮任务");
    if (turn2Target === undefined) throw new Error("Expected turn2 target");
    const turn2Seq = turn2Target.seq;
    const forkedId = await rt.forkSession(session.id, { targetSeq: turn2Seq });
    const forked = await rt.resumeSession(forkedId);
    try {
      expect(forked.state().notes).toEqual(afterTurn1);
      expect(replaySessionView(forked.durableEvents()).notes).toEqual(afterTurn1);
    } finally {
      await forked.close();
    }
    expect(session.state().notes).toEqual(afterTurn2);

    // 关闭再恢复：笔记完整保留
    const sessionId = session.id;
    await session.close();
    const resumed = await rt.resumeSession(sessionId);
    try {
      expect(resumed.state().notes).toEqual(afterTurn2);
      expect(replaySessionView(resumed.durableEvents()).notes).toEqual(afterTurn2);

      // 对话回退到第二轮之前：笔记回到第一轮末尾状态
      await resumed.rewind(turn2Seq, "conversation");
      expect(resumed.state().notes).toEqual(afterTurn1);
      expect(replaySessionView(resumed.durableEvents()).notes).toEqual(afterTurn1);
    } finally {
      await resumed.close();
    }
  });

  it("子会话隔离：不继承父会话笔记，子会话笔记不合并到父会话", async () => {
    const cwd = await createPlatform().resolveReal(tempDir("nct-notes-sub-ws-"));
    const sessionsDir = tempDir("nct-notes-sub-sess-");
    const childObservedRequests: ModelRequest[] = [];

    const isChildRequest = (req: ModelRequest) => req.tools.some((t) => t.name === "finish");
    let parentStep = 0;
    let childStep = 0;

    const provider = new FakeProvider({
      handler: (req): FakeScript => {
        if (isChildRequest(req)) {
          childObservedRequests.push(structuredClone(req));
          childStep += 1;
          if (childStep === 1) {
            return [
              {
                type: "tool_call",
                toolCallId: "cn1",
                name: "note_write",
                input: { add: ["子会话独立笔记"] },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cf1",
              name: "finish",
              input: { result: "子任务完成" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        parentStep += 1;
        if (parentStep === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "pn1",
              name: "note_write",
              input: { add: ["父会话私有笔记"] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (parentStep === 2) {
          return [
            {
              type: "tool_call",
              toolCallId: "pt1",
              name: "task",
              input: { task: "执行子任务并记一条笔记", preset: "general" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "完成" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const rt = await createRuntime({
      cwd,
      sessionsDir,
      providers: [provider],
      subagent: { enabled: true },
    });
    const session = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
    try {
      await session.submit({ text: "测试子会话隔离" });
      expect(session.state().notes).toEqual([{ n: 1, text: "父会话私有笔记" }]);
      expect(replaySessionView(session.durableEvents()).notes).toEqual([
        { n: 1, text: "父会话私有笔记" },
      ]);
      // 子会话第一条请求中绝不包含父会话私有笔记
      expect(JSON.stringify(childObservedRequests[0]?.messages)).not.toContain("父会话私有笔记");
      // 子会话新增的笔记编号从 1 开始（未继承父会话编号），且仅含子会话笔记
      const childToolMsg = childObservedRequests[1]?.messages.find((m) => m.role === "tool");
      expect(childToolMsg?.role === "tool" ? childToolMsg.content : "").toContain('"n":1');
      expect(childToolMsg?.role === "tool" ? childToolMsg.content : "").toContain("子会话独立笔记");
    } finally {
      await session.close();
    }
  });

  it("L2 压缩覆盖后在摘要处补注笔记并排在 todos 之前、计入 ContextReport 且后续请求保持严格前缀", async () => {
    const cwd = await createPlatform().resolveReal(tempDir("nct-notes-cmp-ws-"));
    const sessionsDir = tempDir("nct-notes-cmp-sess-");
    const postCompactRequests: ModelRequest[] = [];
    let phase: "turn1" | "turn2" | "compact" | "turn3" | "turn4" = "turn1";
    let step = 0;

    const provider = new FakeProvider({
      handler: (req): FakeScript => {
        if (phase === "compact") {
          return [
            { type: "text_delta", text: "1. 目标：验证压缩补注\n2. 已完成：初始化" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (phase === "turn3" || phase === "turn4") {
          postCompactRequests.push(structuredClone(req));
          return [
            { type: "text_delta", text: "继续完成" },
            { type: "finish", reason: "stop" },
          ];
        }
        step += 1;
        if (phase === "turn1" && step === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "cn",
              name: "note_write",
              input: { add: ["核心约束：接口 Y 不可改"] },
            },
            {
              type: "tool_call",
              toolCallId: "ct",
              name: "todo_write",
              input: { items: [{ text: "实现功能", status: "in_progress" }] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const config = await loadConfig(createPlatform(), {
      nocturneHome: tempDir("nct-notes-cmp-home-"),
      env: () => undefined,
    });
    const rt = await createRuntime({
      cwd,
      sessionsDir,
      config,
      providers: [provider],
    });
    const session = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
    try {
      await session.submit({ text: "记录约束并列计划" });
      phase = "turn2";
      await session.submit({ text: "做第二轮以形成可压缩闭合边界" });

      phase = "compact";
      await session.compact();

      const described = session.describeContext();
      const sectionNames = described.report.sections.map((s) => s.name);
      expect(sectionNames.filter((n) => n !== "instructions" && n !== "skills")).toEqual([
        "system",
        "tools",
        "environment",
        "notes",
        "todos",
        "history",
      ]);

      phase = "turn3";
      await session.submit({ text: "压缩后的第一轮" });
      phase = "turn4";
      await session.submit({ text: "压缩后的第二轮" });

      expect(postCompactRequests).toHaveLength(2);
      const r3 = postCompactRequests[0];
      const r4 = postCompactRequests[1];
      if (r3 === undefined || r4 === undefined) throw new Error("Expected 2 post-compact requests");
      // 摘要后紧跟 notes，再跟 todos
      const msgTexts = r3.messages.map((m) =>
        m.role === "user" ? m.content.map((b) => b.text).join("") : "",
      );
      const summaryIdx = msgTexts.findIndex(
        (t) =>
          t.includes("核心约束") === false &&
          t.includes("接口") === false &&
          t.includes("目标：验证压缩补注"),
      );
      const notesIdx = msgTexts.findIndex((t) => t.includes("核心约束：接口 Y 不可改"));
      const todosIdx = msgTexts.findIndex((t) => t.includes("实现功能"));
      expect(summaryIdx).toBeGreaterThanOrEqual(0);
      expect(notesIdx).toBe(summaryIdx + 1);
      expect(todosIdx).toBe(notesIdx + 1);
      // 连续请求保持严格前缀
      expect(r4.messages.slice(0, r3.messages.length)).toEqual(r3.messages);
    } finally {
      await session.close();
    }
  });

  it("Agent Loop 与 Context 源码不按 note_write 名字分支", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          scan(p);
        } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          const src = readFileSync(p, "utf8");
          if (src.includes('"note_write"') || src.includes("'note_write'")) {
            offenders.push(p);
          }
        }
      }
    };
    for (const d of ["agent", "context"]) scan(path.join(srcRoot, d));
    expect(offenders).toEqual([]);
  });

  it("真实 executor + session：1500 短条、8000 条合法最坏输出、500 恰上限完整落盘与恢复一致", async () => {
    const platform = createPlatform();
    const cwd = await platform.resolveReal(tempDir("nct-notes-exec-ws-"));
    const sessionsDir = tempDir("nct-notes-exec-sess-");
    const store = createSessionStore({ platform, sessionsDir });
    let session = await store.create({
      cwd,
      workspaceRoot: cwd,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "bypass",
      nocturneVersion: "0.0.0",
    });

    const registry = createToolRegistry();
    registry.register(noteWriteTool);
    const executor = createToolExecutor(registry);
    const allowAll: PermissionGate = {
      check: async (subjects) => ({
        subjects,
        decision: { action: "allow", source: "rule", reason: "test" },
      }),
      checkLexical: () => "allow",
    };

    const runNoteCall = (callId: string, input: unknown) =>
      executor.execute(
        { callId, name: "note_write", input },
        createExecutionScope(
          {
            platform,
            gate: allowAll,
            readState: createReadStateStore(platform.paths),
            notes: () => session.state().notes,
          },
          {
            cwd,
            workspaceRoot: cwd,
            sessionId: session.id,
            turnId: "t1",
            signal: new AbortController().signal,
            events: {
              emit: async (type, payload, opts) => {
                await session.emit(type, payload, opts);
              },
              emitEphemeral: (type, payload, opts) => session.emitEphemeral(type, payload, opts),
            },
          },
        ),
      );

    try {
      // 1) 1500 条短条：modelContent 与 output 均不被截断/丢弃
      const add1500 = Array.from({ length: 1500 }, (_, i) => `n${i}`);
      const exec1500 = await runNoteCall("c-1500", { add: add1500 });
      expect(exec1500.status).toBe("ok");
      expect(exec1500.result.modelContent).not.toContain("已省略");
      expect(exec1500.result.output).toEqual({
        notes: add1500.map((text, i) => ({ n: i + 1, text })),
      });
      expect(session.state().notes).toHaveLength(1500);

      // 清空以便测试 8000 条合法最坏输出
      const clearExec = await runNoteCall("c-clear-1", {
        remove: Array.from({ length: 1500 }, (_, i) => i + 1),
      });
      expect(clearExec.status).toBe("ok");
      expect(session.state().notes).toEqual([]);

      // 2) 8000 条单字符（正文恰 8000，含最坏 JSON 转义场景）
      const add8000 = Array.from({ length: 8000 }, () => '"');
      const exec8000 = await runNoteCall("c-8000", { add: add8000 });
      expect(exec8000.status).toBe("ok");
      expect(exec8000.result.modelContent).not.toContain("已省略");
      const expected8000 = add8000.map((text, i) => ({ n: i + 1, text }));
      expect(exec8000.result.output).toEqual({
        notes: expected8000,
      });
      expect(session.state().notes).toHaveLength(8000);
      // 清空前先验证 8000 短条的视图重放、落盘关闭与重新打开恢复完全一致
      expect(replaySessionView(session.durableEvents()).notes).toEqual(expected8000);
      await session.close();
      session = await store.load(session.id);
      expect(session.state().notes).toEqual(expected8000);
      expect(replaySessionView(session.durableEvents()).notes).toEqual(expected8000);

      // 3) 500 恰上限与 501 超单条上限
      const clearExec2 = await runNoteCall("c-clear-2", {
        remove: Array.from({ length: 8000 }, (_, i) => i + 1),
      });
      expect(clearExec2.status).toBe("ok");

      const exact500 = "z".repeat(500);
      const exec500 = await runNoteCall("c-500", { add: [exact500] });
      expect(exec500.status).toBe("ok");
      expect(session.state().notes).toEqual([{ n: 1, text: exact500 }]);

      const exec501 = await runNoteCall("c-501", { add: ["z".repeat(501)] });
      expect(exec501.status).toBe("error");
      expect(session.state().notes).toEqual([{ n: 1, text: exact500 }]);

      // 验证持久事件、视图重放与重新打开恢复一致
      const expected = [{ n: 1, text: exact500 }];
      expect(replaySessionView(session.durableEvents()).notes).toEqual(expected);
      await session.close();
      const reopened = await store.load(session.id);
      try {
        expect(reopened.state().notes).toEqual(expected);
        expect(replaySessionView(reopened.durableEvents()).notes).toEqual(expected);
      } finally {
        await reopened.close();
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it("端到端：摘要补注后多次更新与清空保持逐消息严格前缀，直到再次压缩才更新/撤去", async () => {
    const cwd = await createPlatform().resolveReal(tempDir("nct-notes-prefix-ws-"));
    const sessionsDir = tempDir("nct-notes-prefix-sess-");
    const postCompact: ModelRequest[] = [];
    let phase: "setup" | "compact1" | "after1" | "compact2" | "after2" = "setup";
    let step = 0;

    const provider = new FakeProvider({
      handler: (req): FakeScript => {
        if (phase === "compact1" || phase === "compact2") {
          return [
            { type: "text_delta", text: `摘要(${phase})` },
            { type: "finish", reason: "stop" },
          ];
        }
        if (phase === "after1" || phase === "after2") {
          postCompact.push(structuredClone(req));
        }
        step += 1;
        if (phase === "setup" && step === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "na",
              name: "note_write",
              input: { add: ["笔记 A"] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (phase === "after1") {
          // 同一次压缩边界后：第 1 步拿到 R1，调用更新 B；第 2 步拿到 R2，再清空；第 3 步拿到 R3
          if (postCompact.length === 1) {
            return [
              {
                type: "tool_call",
                toolCallId: "nb",
                name: "note_write",
                input: { add: ["笔记 B"] },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (postCompact.length === 2) {
            return [
              {
                type: "tool_call",
                toolCallId: "nc",
                name: "note_write",
                input: { remove: [1, 2] },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
        }
        return [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const rt = await createRuntime({ cwd, sessionsDir, providers: [provider] });
    const session = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
    try {
      await session.submit({ text: "写初始笔记 A" });
      phase = "compact1";
      await session.compact();

      phase = "after1";
      await session.submit({ text: "边界后更新与清空" });

      expect(postCompact).toHaveLength(3);
      const r1 = postCompact[0];
      const r2 = postCompact[1];
      const r3 = postCompact[2];
      if (r1 === undefined || r2 === undefined || r3 === undefined) {
        throw new Error("Expected 3 post-compact requests");
      }
      // R1 含 summary + notes(A)，R2（更新 B 后）与 R3（清空后）逐消息严格前缀延续
      expect(JSON.stringify(r1.messages)).toContain("笔记 A");
      expect(r2.messages.slice(0, r1.messages.length)).toEqual(r1.messages);
      expect(r3.messages.slice(0, r2.messages.length)).toEqual(r2.messages);
      expect(session.state().notes).toEqual([]);

      // 推进足够多的后续内容使下一次 compact 真正覆盖到清空边界之后（超过保留区上限 40k token）
      await session.submit({ text: "x".repeat(170_000) });
      phase = "compact2";
      await session.compact();
      phase = "after2";
      await session.submit({ text: "再次压缩后" });
      const r4 = postCompact[4];
      if (r4 === undefined) throw new Error("Expected r4");
      expect(JSON.stringify(r4.messages)).not.toContain("笔记 A");
      expect(session.describeContext().report.sections.some((s) => s.name === "notes")).toBe(false);
    } finally {
      await session.close();
    }
  });
});
