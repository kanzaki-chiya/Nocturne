import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";
import { PhoneSessions } from "../../desktop/src/web/sessions";
import {
  Background,
  connectedText,
  reduceSessionMarks,
  summarizeLiveUpdate,
  type LiveUpdateSession,
} from "../src/background";
import { shellHost, type AppHost, type ServiceNotification } from "../src/host";
import { ProbeLog } from "../src/probe";

const computer = { hostId: "h", hostPub: "p", name: "电脑 1", pairedAt: 1 };

function fixture(overrides: Partial<AppHost> = {}) {
  const calls: { action: "start" | "update" | "stop"; notice?: ServiceNotification }[] = [];
  const host: AppHost = {
    ...shellHost,
    startService: (notice) => {
      calls.push({ action: "start", notice });
      return Promise.resolve();
    },
    updateService: (notice) => {
      calls.push({ action: "update", notice });
      return Promise.resolve();
    },
    stopService: () => {
      calls.push({ action: "stop" });
      return Promise.resolve();
    },
    ...overrides,
  };
  const probe = new ProbeLog(() => true);
  const background = new Background(host, probe);
  const settle = () => new Promise((done) => setTimeout(done, 0));
  return { calls, probe, background, settle };
}

function started(sessionId: string, seq = 1): RuntimeEvent {
  return {
    type: "turn.started",
    sessionId,
    seq,
    turnId: "t1",
    time: "2026-11-10T00:00:00Z",
    payload: { turnIndex: 1 },
  };
}

function completed(
  sessionId: string,
  reason: "done" | "error" | "aborted" = "done",
  recovered = false,
  seq = 3,
): RuntimeEvent {
  return {
    type: "turn.completed",
    sessionId,
    seq,
    turnId: "t1",
    time: "2026-11-10T00:01:00Z",
    payload: {
      reason,
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      ...(reason === "error" ? { error: { code: "err", message: "boom" } } : {}),
      ...(recovered ? { recovered: true } : {}),
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("常驻通知文案", () => {
  it("已连接显示电脑名，其余为正在连接", () => {
    expect(connectedText(computer, "online")).toBe("Nocturne 远程：已连接 电脑 1");
    for (const state of ["connecting", "offline", "revoked", "incompatible"] as const)
      expect(connectedText(computer, state)).toBe("Nocturne 远程：正在连接…");
    expect(connectedText(undefined, "online")).toBe("Nocturne 远程：正在连接…");
  });
});

describe("summarizeLiveUpdate 纯函数（岛上文字与优先级）", () => {
  it("覆盖全部状态行：待确认、出错、已完成、运行中、正在连接、电脑离线、空闲不上岛", () => {
    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: [{ id: "s1", status: "pending", title: "会话 A" }],
      }),
    ).toEqual({
      shortCriticalText: "待确认",
      promoted: true,
      sessionId: "s1",
      body: "会话 A",
    });

    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: [{ id: "s2", status: "idle", mark: "error", firstText: "第一行\n第二行" }],
      }),
    ).toEqual({
      shortCriticalText: "出错",
      promoted: true,
      sessionId: "s2",
      body: "第一行",
    });

    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: [{ id: "s3", status: "idle" }],
        marks: { s3: "done" },
      }),
    ).toEqual({
      shortCriticalText: "已完成",
      promoted: true,
      sessionId: "s3",
      body: "Nocturne",
    });

    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: [{ id: "s4", status: "running", title: "重构模块" }],
      }),
    ).toEqual({
      shortCriticalText: "运行中",
      promoted: true,
      sessionId: "s4",
      body: "重构模块",
    });

    expect(
      summarizeLiveUpdate({
        state: "connecting",
        sessions: [{ id: "s1", status: "pending", title: "会话 A" }],
      }),
    ).toEqual({
      shortCriticalText: "正在连接",
      promoted: true,
    });

    expect(
      summarizeLiveUpdate({
        state: "offline",
        sessions: [{ id: "s1", status: "running", title: "会话 A" }],
      }),
    ).toEqual({
      shortCriticalText: "电脑离线",
      promoted: true,
    });

    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: [{ id: "s5", status: "idle", title: "空闲会话" }],
      }),
    ).toEqual({
      promoted: false,
    });

    for (const state of ["revoked", "incompatible"] as const) {
      expect(summarizeLiveUpdate({ state, sessions: [] })).toEqual({ promoted: false });
    }
  });

  it("按优先级取最高项：待确认 > 出错 > 已完成 > 运行中", () => {
    const sessions: LiveUpdateSession[] = [
      { id: "run", status: "running", title: "正在跑" },
      { id: "done", status: "idle", mark: "done", title: "跑完了" },
      { id: "err", status: "idle", mark: "error", title: "挂了" },
      { id: "pend", status: "pending", title: "等审批" },
    ];
    expect(summarizeLiveUpdate({ state: "online", sessions })).toEqual({
      shortCriticalText: "待确认",
      promoted: true,
      sessionId: "pend",
      body: "等审批",
    });
    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: sessions.filter((s) => s.id !== "pend"),
      }),
    ).toEqual({
      shortCriticalText: "出错",
      promoted: true,
      sessionId: "err",
      body: "挂了",
    });
    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: sessions.filter((s) => s.id !== "pend" && s.id !== "err"),
      }),
    ).toEqual({
      shortCriticalText: "已完成",
      promoted: true,
      sessionId: "done",
      body: "跑完了",
    });
    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: sessions.filter((s) => s.id === "run"),
      }),
    ).toEqual({
      shortCriticalText: "运行中",
      promoted: true,
      sessionId: "run",
      body: "正在跑",
    });
  });

  it("运行中不暴露旧的出错/已完成留痕（与侧栏 rowTag 一致）", () => {
    expect(
      summarizeLiveUpdate({
        state: "online",
        sessions: [{ id: "s1", status: "running", mark: "error", title: "重跑中" }],
      }),
    ).toEqual({
      shortCriticalText: "运行中",
      promoted: true,
      sessionId: "s1",
      body: "重跑中",
    });
  });
});

describe("reduceSessionMarks 未看标记纯函数", () => {
  it("仅在实时且未在看时记录出错/已完成；重放、在看、恢复补写、用户中断不记", () => {
    let marks = reduceSessionMarks(
      {},
      {
        kind: "event",
        sessionId: "s1",
        event: completed("s1", "done"),
        live: false,
        watching: false,
      },
    );
    expect(marks).toEqual({});

    marks = reduceSessionMarks(marks, {
      kind: "event",
      sessionId: "s1",
      event: completed("s1", "done"),
      live: true,
      watching: true,
    });
    expect(marks).toEqual({});

    marks = reduceSessionMarks(marks, {
      kind: "event",
      sessionId: "s1",
      event: completed("s1", "aborted"),
      live: true,
      watching: false,
    });
    expect(marks).toEqual({});

    marks = reduceSessionMarks(marks, {
      kind: "event",
      sessionId: "s1",
      event: completed("s1", "error", true),
      live: true,
      watching: false,
    });
    expect(marks).toEqual({});

    marks = reduceSessionMarks(marks, {
      kind: "event",
      sessionId: "s1",
      event: completed("s1", "done"),
      live: true,
      watching: false,
    });
    expect(marks).toEqual({ s1: "done" });

    marks = reduceSessionMarks(marks, {
      kind: "event",
      sessionId: "s2",
      event: completed("s2", "error"),
      live: true,
      watching: false,
    });
    expect(marks).toEqual({ s1: "done", s2: "error" });
  });

  it("打开会话（seen）或新一轮实时开始（turn.started）时清除未看标记", () => {
    const initial = { s1: "done" as const, s2: "error" as const };
    const afterSeen = reduceSessionMarks(initial, { kind: "seen", sessionId: "s1" });
    expect(afterSeen).toEqual({ s2: "error" });

    // 回放的 turn.started 不清除实时留痕
    const afterReplayStart = reduceSessionMarks(afterSeen, {
      kind: "event",
      sessionId: "s2",
      event: started("s2"),
      live: false,
      watching: false,
    });
    expect(afterReplayStart).toEqual({ s2: "error" });

    const afterLiveStart = reduceSessionMarks(afterSeen, {
      kind: "event",
      sessionId: "s2",
      event: started("s2"),
      live: true,
      watching: false,
    });
    expect(afterLiveStart).toEqual({});
  });
});

describe("Background", () => {
  it("没有已配对电脑时不启动；有电脑后启动，通知随连接状态与会话状态更新并去抖", async () => {
    const { calls, background, settle } = fixture();
    background.observer.hosts?.([]);
    await settle();
    expect(calls).toEqual([]);
    background.observer.hosts?.([computer]);
    await settle();
    expect(calls).toEqual([
      {
        action: "start",
        notice: {
          title: "Nocturne 远程：正在连接…",
          shortCriticalText: "电脑离线",
          promoted: true,
        },
      },
    ]);
    background.observer.state?.(computer, "connecting", "");
    await settle();
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：正在连接…",
        shortCriticalText: "正在连接",
        promoted: true,
      },
    });
    background.observer.state?.(computer, "online", "");
    await settle();
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：已连接 电脑 1",
        promoted: false,
      },
    });

    // 运行中：状态直接来自 PhoneSessions 快照，流式增量不重复触发相同内容的 updateService
    background.observer.sessions?.("h", [{ id: "s1", status: "running", title: "任务 1" }]);
    background.observer.sessionEvent?.("h", "s1", started("s1"), true, { title: "任务 1" }, false);
    await settle();
    const countAfterStart = calls.length;
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：已连接 电脑 1",
        body: "任务 1",
        shortCriticalText: "运行中",
        promoted: true,
        target: { hostId: "h", sessionId: "s1" },
      },
    });
    background.observer.sessionEvent?.(
      "h",
      "s1",
      {
        type: "message.assistant.delta",
        sessionId: "s1",
        runId: "t1",
        eseq: 1,
        afterSeq: 1,
        time: "2026-11-10T00:00:01Z",
        payload: { messageId: "m1", kind: "text", delta: "hello" },
      },
      true,
      { title: "任务 1" },
      false,
    );
    await settle();
    expect(calls.length).toBe(countAfterStart);

    // 权限请求 & 提问 → 待确认
    background.observer.sessions?.("h", [{ id: "s1", status: "pending", title: "任务 1" }]);
    await settle();
    expect(calls.at(-1)?.notice?.shortCriticalText).toBe("待确认");

    // 完成后进入未看「已完成」（即使随后会话被 closeIfIdle 移除仍保留未看标记），用户查看后清除并回到不上岛
    background.observer.sessionEvent?.(
      "h",
      "s1",
      completed("s1", "done"),
      true,
      { title: "任务 1" },
      false,
    );
    background.observer.sessions?.("h", [{ id: "s1", status: "idle", title: "任务 1" }]);
    await settle();
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：已连接 电脑 1",
        body: "任务 1",
        shortCriticalText: "已完成",
        promoted: true,
        target: { hostId: "h", sessionId: "s1" },
      },
    });
    // 会话被关闭从活动列表移除后，「已完成」未看标记照旧保留
    background.observer.sessions?.("h", []);
    await settle();
    expect(calls.at(-1)?.notice?.shortCriticalText).toBe("已完成");

    background.observer.viewing?.({ hostId: "h", sessionId: "s1" });
    await settle();
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：已连接 电脑 1",
        promoted: false,
      },
    });

    // 提问也是待确认
    background.observer.sessions?.("h", [{ id: "s2", status: "pending", title: "提问会话" }]);
    await settle();
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：已连接 电脑 1",
        body: "提问会话",
        shortCriticalText: "待确认",
        promoted: true,
        target: { hostId: "h", sessionId: "s2" },
      },
    });

    background.observer.state?.(computer, "offline", "电脑已离线");
    await settle();
    expect(calls.at(-1)).toEqual({
      action: "update",
      notice: {
        title: "Nocturne 远程：正在连接…",
        shortCriticalText: "电脑离线",
        promoted: true,
      },
    });
  });

  it("回归：切走空闲会话触发 closeIfIdle，session.close 在途期间收到真实新轮事件序列，关闭后常驻通知同步清除运行中", async () => {
    const { calls, background, settle } = fixture();
    background.observer.hosts?.([computer]);
    background.observer.state?.(computer, "online", "");
    await settle();

    const sessionId = "202611191321-9369911a";
    let pushEvent: ((event: RuntimeEvent) => void) | undefined;
    let resolveClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const initialReplay: RuntimeEvent[] = [
      {
        type: "session.created",
        sessionId,
        seq: 1,
        time: "2026-11-19T13:21:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.54.0",
          cwd: "/repo",
          workspaceRoot: "/repo",
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
        },
      },
      {
        type: "session.titled",
        sessionId,
        seq: 2,
        time: "2026-11-19T13:21:01.000Z",
        payload: { title: "情形3-closeIfIdle竞态", source: "user" },
      },
      {
        type: "turn.started",
        sessionId,
        seq: 3,
        turnId: "turn-1-a6b8f365",
        time: "2026-11-19T13:21:02.000Z",
        payload: { turnIndex: 1 },
      },
      {
        type: "message.user",
        sessionId,
        seq: 4,
        turnId: "turn-1-a6b8f365",
        time: "2026-11-19T13:21:02.100Z",
        payload: { messageId: "u1", content: [{ type: "text", text: "init" }] },
      },
      {
        type: "message.assistant",
        sessionId,
        seq: 5,
        turnId: "turn-1-a6b8f365",
        time: "2026-11-19T13:21:02.200Z",
        payload: {
          messageId: "a1",
          model: { provider: "fake", model: "fake-1" },
          content: [{ type: "text", text: "ok" }],
          toolCalls: [],
          finishReason: "stop",
        },
      },
      {
        type: "turn.completed",
        sessionId,
        seq: 6,
        turnId: "turn-1-a6b8f365",
        time: "2026-11-19T13:21:02.300Z",
        payload: { reason: "done", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } },
      },
    ];

    const rpcSession = {
      id: sessionId,
      subscribe: vi.fn(async (listener: (event: RuntimeEvent) => void) => {
        pushEvent = listener;
        for (const ev of initialReplay) listener(ev);
        return {
          lastSeq: 6,
          unsubscribe: vi.fn(() => {
            pushEvent = undefined;
            return Promise.resolve();
          }),
        };
      }),
      close: vi.fn(() => closeGate),
      listShells: vi.fn(() => Promise.resolve([])),
      pendingInputs: vi.fn(() => Promise.resolve({ items: [], paused: false })),
      turnChanges: vi.fn(() => Promise.resolve([])),
    } as unknown as RpcSession;

    const client = {
      onNotification: vi.fn(() => () => undefined),
      runtime: {
        listSessions: vi.fn(() => Promise.resolve([])),
        resumeSession: vi.fn(() =>
          Promise.resolve({
            opened: {
              sessionId,
              meta: { cwd: "/repo" },
              config: {},
              warnings: [],
              lastSeq: 6,
            },
            session: rpcSession,
          }),
        ),
      },
      session: vi.fn(() => rpcSession),
    } as unknown as RpcClient;

    const sessions = new PhoneSessions(
      () => {
        background.observer.sessions?.("h", sessions.observedSessions());
      },
      undefined,
      (sid, event, live, entry) => {
        background.observer.sessionEvent?.(
          "h",
          sid,
          event,
          live,
          { ...(entry.view.title !== undefined ? { title: entry.view.title } : {}) },
          false,
        );
      },
    );

    await sessions.connected(client);
    await sessions.open(sessionId, true);
    await settle();
    expect(calls.at(-1)?.notice?.promoted).toBe(false);

    // 用户切回首页，空闲会话触发 closeIfIdle（session.close() 在中继在途）
    sessions.setSelected(undefined);
    expect(rpcSession.close).toHaveBeenCalledTimes(1);

    // 真实复现事件序列：在 session.close() 生效前，电脑端启动新轮并推来 4 条实时事件
    const realRacedEvents: RuntimeEvent[] = [
      {
        type: "turn.started",
        sessionId,
        seq: 7,
        turnId: "turn-2-0c6a1403",
        time: "2026-11-19T13:21:40.000Z",
        payload: { turnIndex: 2 },
      },
      {
        type: "message.user",
        sessionId,
        seq: 8,
        turnId: "turn-2-0c6a1403",
        time: "2026-11-19T13:21:40.010Z",
        payload: { messageId: "u2", content: [{ type: "text", text: "turn racing closeIfIdle" }] },
      },
      {
        type: "runtime.status",
        sessionId,
        turnId: "turn-2-0c6a1403",
        runId: "turn-2-0c6a1403",
        eseq: 5,
        afterSeq: 8,
        time: "2026-11-19T13:21:40.020Z",
        payload: { status: "thinking" },
      },
      {
        type: "message.assistant.delta",
        sessionId,
        turnId: "turn-2-0c6a1403",
        runId: "turn-2-0c6a1403",
        eseq: 6,
        afterSeq: 8,
        time: "2026-11-19T13:21:40.030Z",
        payload: { messageId: "a2", kind: "text", delta: "Turn 2 started... " },
      },
    ];
    for (const ev of realRacedEvents) pushEvent?.(ev);
    await settle();
    expect(calls.at(-1)?.notice?.shortCriticalText).toBe("运行中");

    // session.close() 在电脑端生效并退订，PhoneSessions 移除该会话（后续不会再收到 turn.completed）
    resolveClose();
    await settle();
    expect(sessions.opened.has(sessionId)).toBe(false);
    expect(calls.at(-1)?.notice).toEqual({
      title: "Nocturne 远程：已连接 电脑 1",
      promoted: false,
    });
  });

  it("回归：长会话回放期间收到历史 turn.started 不把通知闪成运行中，回放中途失败也同步清理", async () => {
    const { calls, background, settle } = fixture();
    background.observer.hosts?.([computer]);
    background.observer.state?.(computer, "online", "");
    await settle();

    const sessionId = "202611190224-079332c3";
    let rejectSubscribe!: (error: Error) => void;
    const rpcSession = {
      id: sessionId,
      subscribe: vi.fn((listener: (event: RuntimeEvent) => void) => {
        // 推送前几条历史事件（含 seq 3 turn.started），但尚未到达 seq 332 turn.completed
        listener({
          type: "session.created",
          sessionId,
          seq: 1,
          time: "2026-11-19T02:24:50.000Z",
          payload: {
            formatVersion: 1,
            nocturneVersion: "0.54.0",
            cwd: "/repo",
            workspaceRoot: "/repo",
            model: { provider: "fake", model: "fake-1" },
            permissionPreset: "default",
          },
        });
        listener({
          type: "turn.started",
          sessionId,
          seq: 3,
          turnId: "turn-1-750a062e",
          time: "2026-11-19T02:24:53.474Z",
          payload: { turnIndex: 1 },
        });
        return new Promise((_resolve, reject) => {
          rejectSubscribe = reject;
        });
      }),
      close: vi.fn(() => Promise.resolve()),
      listShells: vi.fn(() => Promise.resolve([])),
      pendingInputs: vi.fn(() => Promise.resolve({ items: [], paused: false })),
      turnChanges: vi.fn(() => Promise.resolve([])),
    } as unknown as RpcSession;

    const client = {
      onNotification: vi.fn(() => () => undefined),
      runtime: {
        listSessions: vi.fn(() => Promise.resolve([])),
        resumeSession: vi.fn(() =>
          Promise.resolve({
            opened: {
              sessionId,
              meta: { cwd: "/repo" },
              config: {},
              warnings: [],
              lastSeq: 1367,
            },
            session: rpcSession,
          }),
        ),
      },
      session: vi.fn(() => rpcSession),
    } as unknown as RpcClient;

    const sessions = new PhoneSessions(
      () => {
        background.observer.sessions?.("h", sessions.observedSessions());
      },
      undefined,
      (sid, event, live, entry) => {
        background.observer.sessionEvent?.(
          "h",
          sid,
          event,
          live,
          { ...(entry.view.title !== undefined ? { title: entry.view.title } : {}) },
          false,
        );
      },
    );

    await sessions.connected(client);
    const openPromise = sessions.open(sessionId, true);
    await settle();
    // 回放尚未完成：绝不因历史 turn.started 报运行中
    expect(calls.some((c) => c.notice?.shortCriticalText === "运行中")).toBe(false);

    // 订阅中途失败：entry 被清理，通知保持不上岛
    rejectSubscribe(new Error("connection_closed"));
    await expect(openPromise).rejects.toThrow("connection_closed");
    await settle();
    expect(sessions.opened.has(sessionId)).toBe(false);
    expect(calls.at(-1)?.notice?.promoted).toBe(false);
  });

  it("开关默认开，关闭后停止服务，再打开重新启动；设置存在本地", async () => {
    const { calls, background, settle } = fixture();
    expect(background.enabled).toBe(true);
    background.observer.hosts?.([computer]);
    await settle();
    background.enabled = false;
    await settle();
    expect(calls.map((c) => c.action)).toEqual(["start", "stop"]);
    expect(new Background(shellHost, new ProbeLog(() => true)).enabled).toBe(false);
    background.enabled = true;
    await settle();
    expect(calls.at(-1)?.action).toBe("start");
  });

  it("移除最后一台电脑后停止服务", async () => {
    const { calls, background, settle } = fixture();
    background.observer.hosts?.([computer]);
    await settle();
    background.observer.hosts?.([]);
    await settle();
    expect(calls.at(-1)?.action).toBe("stop");
  });

  it("服务启动失败只记入探针，不影响连接，之后可以重试", async () => {
    let fail = true;
    const { probe, background, settle, calls } = fixture({
      startService: (notice) => {
        if (fail) return Promise.reject(new Error("无权限"));
        calls.push({ action: "start", notice });
        return Promise.resolve();
      },
    });
    background.observer.hosts?.([computer]);
    await settle();
    expect(
      probe.all().some((entry) => entry[1] === "service" && entry[2].includes("error 无权限")),
    ).toBe(true);
    fail = false;
    background.observer.state?.(computer, "online", "");
    await settle();
    expect(calls.some((c) => c.action === "start")).toBe(true);
  });

  it("探针记录事件与断线：只有类型、会话 id、序号", () => {
    const { probe, background } = fixture();
    background.observer.event?.("s1", "message.delta", 3, true);
    background.observer.disconnected?.(computer, "网络断开");
    background.observer.state?.(computer, "online", "");
    const kinds = probe.all().map((entry) => entry[1]);
    expect(kinds).toContain("event");
    expect(kinds).toContain("disconnect");
    expect(kinds).toContain("connect");
    expect(probe.all().find((entry) => entry[1] === "event")?.[2]).toBe(
      "fg live s1 message.delta 3",
    );
  });
});

describe("tauriHost 经白名单命令调用插件", () => {
  it("每个方法都转成 plugin:background|call 的一个命令", async () => {
    const invoke = vi.fn((_cmd: string, args?: { command: string; payload?: unknown }) =>
      Promise.resolve(
        args?.command === "status"
          ? { running: true, ignoringBatteryOptimizations: false }
          : { text: "x" },
      ),
    );
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.resetModules();
    const { tauriHost } = await import("../src/host");
    await tauriHost.startService({
      title: "a",
      body: "会话",
      shortCriticalText: "运行中",
      promoted: true,
      target: { hostId: "h", sessionId: "s" },
    });
    await tauriHost.updateService({ title: "b", promoted: false });
    await tauriHost.stopService();
    await tauriHost.openSettings("autostart");
    await tauriHost.downloadApk(
      "https://github.com/kanzaki-chiya/Nocturne/releases/download/v1.0.0/nocturne-1.0.0.apk",
    );
    await tauriHost.setSystemBars(true, "#fbfaf6");
    expect(
      invoke.mock.calls.find(([, args]) => args?.command === "set_system_bars")?.[1]?.payload,
    ).toEqual({ light: true, background: "#fbfaf6" });
    expect(await tauriHost.backgroundStatus()).toEqual({
      supported: true,
      running: true,
      ignoringBatteryOptimizations: false,
    });
    expect(await tauriHost.nativeLog()).toBe("x");
    await tauriHost.clearNativeLog();
    expect(invoke.mock.calls.map(([name, args]) => [name, args?.command])).toEqual([
      ["plugin:background|call", "start"],
      ["plugin:background|call", "update"],
      ["plugin:background|call", "stop"],
      ["plugin:background|call", "open_settings"],
      ["plugin:background|call", "download_apk"],
      ["plugin:background|call", "set_system_bars"],
      ["plugin:background|call", "status"],
      ["plugin:background|call", "log"],
      ["plugin:background|call", "clear_log"],
    ]);
    expect(invoke.mock.calls[0]?.[1]?.payload).toEqual({
      title: "a",
      body: "会话",
      shortCriticalText: "运行中",
      promoted: true,
      hostId: "h",
      sessionId: "s",
    });
    expect(invoke.mock.calls[1]?.[1]?.payload).toEqual({
      title: "b",
      body: "",
      shortCriticalText: "",
      promoted: false,
      hostId: "",
      sessionId: "",
    });
    vi.doUnmock("@tauri-apps/api/core");
  });
});
