import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeProvider,
  type FakeScript,
  type RuntimeSession,
  type SessionSummary,
} from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { createRuntimeStub } from "@nocturne/core/testing";
import { createMemoryTransportPair, createRpcClient, type RpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { cleanupTmp, connectMany, MODEL, textScript, until, VISION_MODELS } from "./harness.js";

const WINDOW_MS = 300;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  cleanupTmp();
});

function countSessionsChanged(client: RpcClient): { count: () => number } {
  let count = 0;
  client.onNotification("runtime.sessionsChanged", (params) => {
    expect(params).toEqual({});
    count += 1;
  });
  return { count: () => count };
}

describe("runtime.listSessions 活动状态与 runtime.sessionsChanged", () => {
  it("打开着的会话在轮次进行中 listSessions 带 running，结束后不带，轮次开始和结束各触发一次 sessionsChanged", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let inProvider = false;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      handler: async (): Promise<FakeScript> => {
        inProvider = true;
        await turnGate;
        return textScript("完成");
      },
    });
    const h = await connectMany({ provider });
    const remote = await h.add();
    try {
      const { session } = await h.client.runtime.createSession({ model: MODEL });
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 100);
      const localChanged = countSessionsChanged(h.client);
      const remoteChanged = countSessionsChanged(remote.client);

      const initial = (await h.client.runtime.listSessions()).find((s) => s.id === session.id);
      expect(initial?.openHere).toBe(true);
      expect(initial !== undefined && "status" in initial).toBe(false);

      const turn = session.submit({ text: "开始跑" });
      await until(() => inProvider, "进入模型流");

      const during = (await remote.client.runtime.listSessions()).find((s) => s.id === session.id);
      expect(during).toMatchObject({ id: session.id, openHere: true, status: "running" });

      // 轮次开始触发第一次 runtime.sessionsChanged
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect([localChanged.count(), remoteChanged.count()]).toEqual([1, 1]);

      // 放行轮次结束：触发第二次 runtime.sessionsChanged，且 listSessions 不再带 status
      releaseTurn();
      expect(await turn).toBe("done");

      const after = (await remote.client.runtime.listSessions()).find((s) => s.id === session.id);
      expect(after?.openHere).toBe(true);
      expect(after !== undefined && "status" in after).toBe(false);

      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect([localChanged.count(), remoteChanged.count()]).toEqual([2, 2]);
    } finally {
      releaseTurn();
      await h.client.shutdown();
      await Promise.all([h.served, remote.served]);
    }
  });

  it("待确认权限时 listSessions 带 pending，回复后恢复 running，结束时不带，状态切换触发 sessionsChanged", async () => {
    let releaseAfterPermission!: () => void;
    const afterGate = new Promise<void>((resolve) => {
      releaseAfterPermission = resolve;
    });
    let step = 0;
    let enteredSecondStep = false;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      handler: async (): Promise<FakeScript> => {
        step += 1;
        if (step === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "w1",
              name: "write",
              input: { path: "note.txt", content: "hi" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        enteredSecondStep = true;
        await afterGate;
        return textScript("写好了");
      },
    });
    const h = await connectMany({ provider });
    const remote = await h.add();
    try {
      const { session } = await h.client.runtime.createSession({ model: MODEL });
      const events: RuntimeEvent[] = [];
      await session.subscribe((ev) => events.push(ev));
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 100);
      const changed = countSessionsChanged(remote.client);

      const turn = session.submit({ text: "写一个文件" });
      await until(() => events.some((ev) => ev.type === "permission.requested"), "等待权限请求");
      const req = events.find((ev) => ev.type === "permission.requested");
      if (req?.type !== "permission.requested") throw new Error("缺少 permission.requested");

      const pendingItem = (await remote.client.runtime.listSessions()).find(
        (s) => s.id === session.id,
      );
      expect(pendingItem).toMatchObject({ id: session.id, openHere: true, status: "pending" });

      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      const countAtPending = changed.count();
      expect(countAtPending).toBeGreaterThanOrEqual(1);

      await session.respondPermission(req.payload.requestId, { decision: "allow" });
      await until(() => enteredSecondStep, "权限回复后继续跑下一步");

      const resumedItem = (await remote.client.runtime.listSessions()).find(
        (s) => s.id === session.id,
      );
      expect(resumedItem).toMatchObject({ id: session.id, openHere: true, status: "running" });

      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect(changed.count()).toBe(countAtPending + 1);

      releaseAfterPermission();
      expect(await turn).toBe("done");

      const doneItem = (await remote.client.runtime.listSessions()).find(
        (s) => s.id === session.id,
      );
      expect(doneItem !== undefined && "status" in doneItem).toBe(false);
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect(changed.count()).toBe(countAtPending + 2);
    } finally {
      releaseAfterPermission();
      await h.client.shutdown();
      await Promise.all([h.served, remote.served]);
    }
  });

  it("待回答提问时 listSessions 带 pending，回答后恢复 running，结束时不带", async () => {
    let releaseAfterAnswer!: () => void;
    const afterGate = new Promise<void>((resolve) => {
      releaseAfterAnswer = resolve;
    });
    let step = 0;
    let enteredSecondStep = false;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      handler: async (): Promise<FakeScript> => {
        step += 1;
        if (step === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "q1",
              name: "ask_user",
              input: {
                questions: [
                  {
                    question: "继续吗？",
                    options: [{ label: "是" }, { label: "否" }],
                  },
                ],
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        enteredSecondStep = true;
        await afterGate;
        return textScript("好的");
      },
    });
    const h = await connectMany({ provider });
    const remote = await h.add();
    try {
      const { session } = await h.client.runtime.createSession({ model: MODEL });
      const events: RuntimeEvent[] = [];
      await session.subscribe((ev) => events.push(ev));
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 100);
      const changed = countSessionsChanged(remote.client);

      const turn = session.submit({ text: "问我一个问题" });
      await until(() => events.some((ev) => ev.type === "question.requested"), "等待提问请求");
      const req = events.find((ev) => ev.type === "question.requested");
      if (req?.type !== "question.requested") throw new Error("缺少 question.requested");

      expect(
        (await remote.client.runtime.listSessions()).find((s) => s.id === session.id),
      ).toMatchObject({ id: session.id, openHere: true, status: "pending" });

      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      const countAtQuestion = changed.count();
      expect(countAtQuestion).toBeGreaterThanOrEqual(1);

      await session.respondQuestion(req.payload.requestId, {
        answers: [{ selected: ["是"] }],
      });
      await until(() => enteredSecondStep, "回答提问后进入下一步");

      expect(
        (await remote.client.runtime.listSessions()).find((s) => s.id === session.id),
      ).toMatchObject({ id: session.id, openHere: true, status: "running" });

      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect(changed.count()).toBe(countAtQuestion + 1);

      releaseAfterAnswer();
      expect(await turn).toBe("done");

      const doneItem = (await remote.client.runtime.listSessions()).find(
        (s) => s.id === session.id,
      );
      expect(doneItem !== undefined && "status" in doneItem).toBe(false);
    } finally {
      releaseAfterAnswer();
      await h.client.shutdown();
      await Promise.all([h.served, remote.served]);
    }
  });

  it("其他进程持有的会话即使正在运行，本后台 listSessions 仍只有 locked 且不带 status", async () => {
    let releaseOther!: () => void;
    const otherGate = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    let otherRunning = false;
    const otherProvider = new FakeProvider({
      models: VISION_MODELS,
      handler: async (): Promise<FakeScript> => {
        otherRunning = true;
        await otherGate;
        return textScript("ok");
      },
    });
    const h = await connectMany();
    const other = await connectMany({
      sessionsDir: h.sessionsDir,
      ws: h.ws,
      provider: otherProvider,
    });
    try {
      const { session } = await other.client.runtime.createSession({ model: MODEL });
      const turn = session.submit({ text: "在另一个后台跑" });
      await until(() => otherRunning, "另一个后台进入模型");

      const fromOther = (await other.client.runtime.listSessions()).find(
        (s) => s.id === session.id,
      );
      expect(fromOther).toMatchObject({
        id: session.id,
        locked: true,
        openHere: true,
        status: "running",
      });

      const fromHere = (await h.client.runtime.listSessions()).find((s) => s.id === session.id);
      expect(fromHere).toMatchObject({ id: session.id, locked: true, openHere: false });
      expect(fromHere !== undefined && "status" in fromHere).toBe(false);

      releaseOther();
      await turn;
    } finally {
      releaseOther();
      await other.client.shutdown();
      await other.served;
      await h.client.shutdown();
      await h.served;
    }
  });

  it("使用 createRuntimeStub：子代理转发待确认与非状态事件按规则触发 sessionsChanged", async () => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) listener(event);
    };
    const fakeSummary: SessionSummary = {
      id: "s-stub",
      createdAt: "2026-11-19T00:00:00Z",
      cwd: "Z:/stub-ws",
      workspaceRoot: "Z:/stub-ws",
      model: { provider: "fake", model: "fake-model" },
      mtimeMs: 1000,
      firstText: "测试会话",
      locked: true,
    };
    const fakeSession = {
      id: "s-stub",
      durableEvents: () => [],
      subscribe: (listener: (event: RuntimeEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      isIdle: () => true,
      onIdle: () => () => undefined,
      interrupt: () => undefined,
      close: async () => undefined,
      warnings: [],
      state: () => ({
        meta: {
          id: "s-stub",
          cwd: "Z:/stub-ws",
          workspaceRoot: "Z:/stub-ws",
          createdAt: "2026-11-19T00:00:00Z",
          formatVersion: 1,
          nocturneVersion: "0.0.0",
        },
        config: {
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
        },
        history: [],
        todos: [],
        notes: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        lastSeq: 0,
        openTurn: undefined,
        unsettledCalls: new Map(),
      }),
    } as unknown as RuntimeSession;

    const runtime = createRuntimeStub({
      listSessions: async () => [fakeSummary],
      resumeSession: async () => fakeSession,
      close: async () => undefined,
    });

    const server = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => ({ runtime }),
    });
    const [clientTransport, serverTransport] = createMemoryTransportPair();
    const served = server.serve(serverTransport, { origin: "local" });
    const client = createRpcClient(clientTransport, { clientName: "test", interactive: true });
    try {
      await client.initialize();
      await client.runtime.resumeSession("s-stub");
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);

      const changed = countSessionsChanged(client);

      // 非状态变化事件不发 sessionsChanged
      emit({
        type: "runtime.warning",
        sessionId: "s-stub",
        runId: "run-1",
        eseq: 1,
        afterSeq: 0,
        time: "2026-11-19T00:00:01Z",
        payload: { code: "test", message: "noop" },
      });
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect(changed.count()).toBe(0);

      // 后台子代理转发待确认权限：即使父会话无 Turn 也切为 pending 并触发通知
      emit({
        type: "subagent.permissions",
        sessionId: "s-stub",
        runId: "run-1",
        eseq: 2,
        afterSeq: 0,
        time: "2026-11-19T00:00:02Z",
        payload: {
          pending: [
            {
              childSessionId: "child-1",
              parentCallId: "parent-c1",
              afterSeq: 0,
              order: 1,
              callId: "c1",
              requestId: "r1",
              toolName: "write",
              subjects: [{ kind: "edit", target: "a.txt" }],
              reason: "写入文件",
              options: ["allow_once", "deny"],
              profile: "explore",
              taskSummary: "检查",
            },
          ],
        },
      });
      expect((await client.runtime.listSessions())[0]).toMatchObject({
        id: "s-stub",
        openHere: true,
        status: "pending",
      });
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect(changed.count()).toBe(1);

      // 子代理权限清空：恢复空闲，不带 status 并再触发一次通知
      emit({
        type: "subagent.permissions",
        sessionId: "s-stub",
        runId: "run-1",
        eseq: 3,
        afterSeq: 0,
        time: "2026-11-19T00:00:03Z",
        payload: { pending: [] },
      });
      const afterClear = (await client.runtime.listSessions())[0];
      expect(afterClear?.openHere).toBe(true);
      expect(afterClear !== undefined && "status" in afterClear).toBe(false);
      await vi.advanceTimersByTimeAsync(WINDOW_MS + 50);
      expect(changed.count()).toBe(2);
    } finally {
      await client.shutdown();
      await served;
    }
  });
});
