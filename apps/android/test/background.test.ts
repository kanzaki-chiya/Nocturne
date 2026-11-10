import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@nocturne/core/protocol";
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

function permissionRequested(sessionId: string, seq = 2): RuntimeEvent {
  return {
    type: "permission.requested",
    sessionId,
    seq,
    turnId: "t1",
    time: "2026-11-10T00:00:01Z",
    payload: {
      requestId: "r1",
      callId: "c1",
      reason: "need approval",
      subjects: [{ kind: "shell", target: "ls" }],
      options: ["allow_once"],
    },
  };
}

function questionRequested(sessionId: string): RuntimeEvent {
  return {
    type: "question.requested",
    sessionId,
    runId: "t1",
    eseq: 1,
    afterSeq: 1,
    time: "2026-11-10T00:00:01Z",
    payload: {
      requestId: "q1",
      callId: "c2",
      questions: [{ question: "继续吗？" }],
    },
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

    // 运行中：流式增量不重复触发相同内容的 updateService
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
    background.observer.sessionEvent?.(
      "h",
      "s1",
      permissionRequested("s1"),
      true,
      { title: "任务 1" },
      false,
    );
    await settle();
    expect(calls.at(-1)?.notice?.shortCriticalText).toBe("待确认");

    // 完成后进入未看「已完成」，用户查看后清除并回到不上岛
    background.observer.sessionEvent?.(
      "h",
      "s1",
      completed("s1", "done"),
      true,
      { title: "任务 1" },
      false,
    );
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
    background.observer.sessionEvent?.(
      "h",
      "s2",
      started("s2"),
      true,
      { title: "提问会话" },
      false,
    );
    background.observer.sessionEvent?.(
      "h",
      "s2",
      questionRequested("s2"),
      true,
      { title: "提问会话" },
      false,
    );
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
