// @vitest-environment jsdom
/**
 * 桌面会话手动 `/compact` 即时反馈与计时（ADR-0123）：
 * - 请求未返回时命令已立即清除、会话末尾显示「正在压缩上下文 · 0 秒」并每秒递增
 * - 思考行样式与减少动态效果偏好同步
 * - 压缩期间允许编辑下一条草稿，异步回调不覆盖新输入
 * - 成功后与已有摘要回执合为一条「上下文已压缩 · 用时 N 秒」且秒数固定
 * - 手动停止显示「压缩已停止」，失败显示具体原因，提交前被拒报原因，均停止计时
 * - 重复提交被拦截、不重复发起 RPC 且不干扰进行中计时；输入历史记录 `/compact`
 * - 多会话与右侧面板（合奏成员 / 组曲线程）按会话归属，切走再回来进度与结果正确
 * - 旧历史无起始时间及自动压缩仍沿用原有摘要回执
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  reduceSessionView,
  type RuntimeEvent,
  type SessionView,
} from "@nocturne/core/protocol";
import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcClient,
  type RpcSession,
} from "@nocturne/rpc/client";

import { App } from "../src/App";
import { createAttachmentImageSource } from "../src/attachment-images";
import type { BackendMessage } from "../src/types";
import {
  CompactionFeedbackStore,
  compactionFailedText,
  compactionRunningText,
  compactionStoppedText,
  compactionSucceededText,
  isCompactionInterrupted,
} from "../src/compaction-feedback";
import { Composer, type ChoiceControl, type ComposerProps } from "../src/Composer";
import { Conversation } from "../src/Conversation";
import { EnsembleMemberPane } from "../src/EnsembleMemberPane";
import type { DesktopHost } from "../src/host";
import { SuiteThreadPane } from "../src/SuiteThreadPane";

function lastEventSeq(events: readonly RuntimeEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev && "seq" in ev && typeof ev.seq === "number") return ev.seq;
  }
  return 0;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function setMotionPreference(allow: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === "(prefers-reduced-motion: no-preference)" ? allow : !allow,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function emptyComposerControls(): ComposerProps["controls"] {
  const empty: ChoiceControl = {
    value: "",
    label: "默认",
    groups: [],
    onSelect: () => undefined,
  };
  return { model: empty, effort: empty, preset: empty };
}

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    variant: "session",
    running: false,
    onSubmit: vi.fn(async () => true),
    onInterrupt: vi.fn(),
    onSlash: vi.fn(async () => true),
    controls: emptyComposerControls(),
    fileRefs: null,
    pickImages: vi.fn(async () => []),
    ...overrides,
  };
}

function makeSessionStub(id = "s-1"): RpcSession {
  return {
    id,
    readAttachment: vi.fn(async () => new Uint8Array()),
    turnChangeDiff: vi.fn(),
    respondPermission: vi.fn(async () => undefined),
    respondSubagentPermission: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    interrupt: vi.fn(),
  } as unknown as RpcSession;
}

interface ControllableCompact {
  sessionId: string;
  id: unknown;
  resolve: (emitCompacted?: { seq: number; summary?: string }) => void;
  interrupt: () => void;
  fail: (message: string, code?: string) => void;
}

/**
 * 可控 `session.compact` 的真实 DesktopHost 假后台，支持多会话、事件推送、
 * 重放持久化历史、延迟/停止/失败手动压缩。
 */
function controllableAppHost() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const interrupts: string[] = [];
  const historyRecords: { sessionId: string; text: string }[] = [];
  const pendingCompacts: ControllableCompact[] = [];
  const persistedEvents = new Map<string, RuntimeEvent[]>([
    [
      "alpha",
      [
        {
          type: "session.created",
          seq: 1,
          time: "2026-11-26T00:00:00.000Z",
          sessionId: "alpha",
          payload: {
            cwd: "Z:/proj",
            workspaceRoot: "Z:/proj",
            formatVersion: 1,
            nocturneVersion: "0.68.0",
            model: { provider: "p", model: "m" },
          },
        } as RuntimeEvent,
        {
          type: "message.user",
          seq: 2,
          time: "2026-11-26T00:00:01.000Z",
          sessionId: "alpha",
          turnId: "t1",
          payload: { messageId: "u1", content: [{ type: "text", text: "alpha 首句" }] },
        } as RuntimeEvent,
        {
          type: "message.assistant",
          seq: 3,
          time: "2026-11-26T00:00:02.000Z",
          sessionId: "alpha",
          turnId: "t1",
          payload: {
            messageId: "a1",
            model: { provider: "p", model: "m" },
            content: [{ type: "text", text: "alpha 回复" }],
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        } as RuntimeEvent,
      ],
    ],
    [
      "beta",
      [
        {
          type: "session.created",
          seq: 1,
          time: "2026-11-26T00:01:00.000Z",
          sessionId: "beta",
          payload: {
            cwd: "Z:/proj",
            workspaceRoot: "Z:/proj",
            formatVersion: 1,
            nocturneVersion: "0.68.0",
            model: { provider: "p", model: "m" },
          },
        } as RuntimeEvent,
        {
          type: "message.user",
          seq: 2,
          time: "2026-11-26T00:01:01.000Z",
          sessionId: "beta",
          turnId: "t1",
          payload: { messageId: "u2", content: [{ type: "text", text: "beta 首句" }] },
        } as RuntimeEvent,
      ],
    ],
  ]);
  const subscribed = new Set<string>();
  const channels = new Map<number, (message: BackendMessage) => void>();
  let nextBackend = 1;
  let activeBackend = 0;

  const sendLine = (obj: unknown) => {
    channels.get(activeBackend)?.({ kind: "lines", lines: [JSON.stringify(obj)] });
  };

  const pushEvent = (sessionId: string, event: RuntimeEvent, persist = false) => {
    if (persist) {
      const list = persistedEvents.get(sessionId) ?? [];
      list.push(event);
      persistedEvents.set(sessionId, list);
    }
    if (subscribed.has(sessionId)) {
      sendLine({ jsonrpc: "2.0", method: "event", params: { sessionId, event } });
    }
  };

  const handleBackendLine = (line: string) => {
    const req = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = req.method ?? "";
    const params = req.params ?? {};
    calls.push({ method, params });
    if (method === "session.interrupt") {
      const sid = String(params.sessionId ?? "");
      interrupts.push(sid);
      const pending = pendingCompacts.find((item) => item.sessionId === sid);
      if (pending !== undefined) pending.interrupt();
      return;
    }
    if (req.id === undefined) return;
    const reply = (result: unknown) => {
      sendLine({ jsonrpc: "2.0", id: req.id, result });
    };
    const failRpc = (code: string, message: string) => {
      sendLine({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32001, message, data: { code, name: "RuntimeCommandError" } },
      });
    };
    switch (method) {
      case "initialize":
        reply({ protocolVersion: 1, nocturneVersion: "0.68.0" });
        return;
      case "runtime.listSessions":
        reply([
          {
            id: "alpha",
            cwd: "Z:/proj",
            workspaceRoot: "Z:/proj",
            createdAt: "2026-11-26T00:00:00.000Z",
            mtimeMs: 1_700_000_002_000,
            firstText: "alpha 首句",
          },
          {
            id: "beta",
            cwd: "Z:/proj",
            workspaceRoot: "Z:/proj",
            createdAt: "2026-11-26T00:01:00.000Z",
            mtimeMs: 1_700_000_001_000,
            firstText: "beta 首句",
          },
        ]);
        return;
      case "runtime.listModels":
        reply([{ ref: { provider: "p", model: "m" }, capabilities: {} }]);
        return;
      case "runtime.listRecentModels":
        reply([{ provider: "p", model: "m" }]);
        return;
      case "runtime.defaultModel":
        reply({ provider: "p", model: "m" });
        return;
      case "runtime.describeSettings":
        reply([
          { key: "reasoningEffort", effective: "low" },
          { key: "permissions.preset", effective: "default" },
        ]);
        return;
      case "schedule.list":
        reply({ tasks: [], scheduler: { running: false }, warnings: [] });
        return;
      case "suites.list":
        reply([]);
        return;
      case "workspace.branches":
        reply({ current: null, branches: [], busy: false, defaultBranch: null });
        return;
      case "runtime.listProviders":
        reply([]);
        return;
      case "runtime.listPages":
        reply([]);
        return;
      case "runtime.describeMcp":
        reply([]);
        return;
      case "runtime.describeSkills":
        reply({ skills: [], warnings: [], budget: {}, scannedDirs: [], homeDir: "Z:/home" });
        return;
      case "runtime.describeExternalAgents":
        reply({ agents: [], warnings: [] });
        return;
      case "runtime.remoteStatus":
        reply({ enabled: false, devices: [] });
        return;
      case "runtime.resumeSession": {
        const sid = String(params.sessionId ?? "");
        const events = persistedEvents.get(sid) ?? [];
        reply({
          sessionId: sid,
          meta: {
            id: sid,
            cwd: "Z:/proj",
            workspaceRoot: "Z:/proj",
            formatVersion: 1,
            nocturneVersion: "0.68.0",
          },
          config: { model: { provider: "p", model: "m" } },
          warnings: [],
          lastSeq: lastEventSeq(events),
        });
        return;
      }
      case "session.subscribe": {
        const sid = String(params.sessionId ?? "");
        subscribed.add(sid);
        const events = persistedEvents.get(sid) ?? [];
        for (const ev of events) {
          sendLine({
            jsonrpc: "2.0",
            method: "event",
            params: { sessionId: sid, event: ev },
          });
        }
        reply({ lastSeq: lastEventSeq(events) });
        return;
      }
      case "session.unsubscribe":
      case "session.close":
        subscribed.delete(String(params.sessionId ?? ""));
        reply(null);
        return;
      case "session.pendingInputs":
        reply({ items: [], paused: false });
        return;
      case "session.reasoningEffortInfo":
        reply({ current: "off", effective: "off", available: [] });
        return;
      case "session.state":
        reply({
          config: { model: { provider: "p", model: "m" }, permissionPreset: "default" },
          turnCount: 1,
        });
        return;
      case "session.turnChanges":
        reply([]);
        return;
      case "session.shellInfo":
        reply({ selected: "auto", source: "auto" });
        return;
      case "session.mcpServers":
        reply([]);
        return;
      case "session.describeSkills":
        reply({ skills: [], warnings: [], budget: {}, scannedDirs: [], homeDir: "Z:/home" });
        return;
      case "session.describeExternalAgents":
        reply({ agents: [], warnings: [] });
        return;
      case "session.listGrants":
        reply([]);
        return;
      case "session.readInputHistory":
        reply([]);
        return;
      case "session.recordInputHistory":
        historyRecords.push({
          sessionId: String(params.sessionId ?? ""),
          text: String(params.text ?? ""),
        });
        reply(null);
        return;
      case "session.contextUsage":
        reply({ estimatedTokens: 1000, budgetTokens: 100000, ratio: 0.01 });
        return;
      case "session.listBranches":
        reply({ isGit: false, branches: [] });
        return;
      case "session.compact": {
        const sid = String(params.sessionId ?? "");
        pushEvent(sid, {
          type: "runtime.status",
          time: new Date().toISOString(),
          sessionId: sid,
          payload: { status: "compacting" },
        } as RuntimeEvent);
        let settled = false;
        const removePending = () => {
          const idx = pendingCompacts.findIndex((item) => item.id === req.id);
          if (idx >= 0) pendingCompacts.splice(idx, 1);
        };
        const control: ControllableCompact = {
          sessionId: sid,
          id: req.id,
          resolve(emitCompacted) {
            if (settled) return;
            settled = true;
            removePending();
            if (emitCompacted !== undefined) {
              pushEvent(
                sid,
                {
                  type: "context.compacted",
                  seq: emitCompacted.seq,
                  time: new Date().toISOString(),
                  sessionId: sid,
                  payload: {
                    kind: "summary",
                    throughSeq: emitCompacted.seq - 1,
                    summary: emitCompacted.summary ?? "摘要内容",
                  },
                } as RuntimeEvent,
                true,
              );
            }
            pushEvent(sid, {
              type: "runtime.status",
              time: new Date().toISOString(),
              sessionId: sid,
              payload: { status: "idle" },
            } as RuntimeEvent);
            reply(null);
          },
          interrupt() {
            if (settled) return;
            settled = true;
            removePending();
            pushEvent(sid, {
              type: "runtime.status",
              time: new Date().toISOString(),
              sessionId: sid,
              payload: { status: "idle" },
            } as RuntimeEvent);
            failRpc("compaction_interrupted", "压缩被中断");
          },
          fail(message, code = "compaction_failed") {
            if (settled) return;
            settled = true;
            removePending();
            pushEvent(sid, {
              type: "runtime.status",
              time: new Date().toISOString(),
              sessionId: sid,
              payload: { status: "idle" },
            } as RuntimeEvent);
            failRpc(code, message);
          },
        };
        pendingCompacts.push(control);
        return;
      }
      default:
        sendLine({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `未模拟的方法 ${method}` },
        });
        return;
    }
  };

  const host: DesktopHost = {
    createChannel: (onMessage) => onMessage,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "node_probe":
          return { ok: true, path: "node", version: "22.0.0" };
        case "plain_workspace":
          return "Z:/plain";
        case "backend_open": {
          const id = nextBackend++;
          activeBackend = id;
          channels.set(id, args?.channel as (m: BackendMessage) => void);
          return id;
        }
        case "backend_send":
          handleBackendLine(String(args?.line ?? ""));
          return null;
        case "backend_close":
          return null;
        case "backend_stderr":
        case "shell_log":
        case "key_diag_log":
          return [];
        default:
          return null;
      }
    },
    openUrl: async () => undefined,
    openPath: async () => undefined,
    revealItem: async () => undefined,
    detectEditors: async () => ({ vscode: false, cursor: false }),
    listFonts: async () => [],
    openInEditor: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => "Z:/home",
    appVersion: async () => "0.68.0",
    checkUpdate: async () => null,
    relaunch: async () => undefined,
    note: () => undefined,
    notify: async () => ({ shown: false }),
    dismissNotification: async () => undefined,
    requestAttention: async () => undefined,
    onNotificationActivated: () => () => undefined,
  };

  return { host, calls, interrupts, historyRecords, pendingCompacts, pushEvent };
}

function controllableChildHarness(childSessionId: string) {
  const [clientEnd, serverEnd] = createMemoryTransportPair();
  const requests: { id?: unknown; method: string; params: Record<string, unknown> }[] = [];
  const persisted: RuntimeEvent[] = [
    {
      type: "session.created",
      seq: 1,
      time: "2026-11-26T00:00:00.000Z",
      sessionId: childSessionId,
      payload: {
        cwd: "Z:/proj",
        workspaceRoot: "Z:/proj",
        formatVersion: 1,
        nocturneVersion: "0.68.0",
        model: { provider: "p", model: "m" },
      },
    } as RuntimeEvent,
    {
      type: "message.user",
      seq: 2,
      time: "2026-11-26T00:00:01.000Z",
      sessionId: childSessionId,
      turnId: "t1",
      payload: { messageId: "u1", content: [{ type: "text", text: "子会话任务" }] },
    } as RuntimeEvent,
  ];
  let subscribed = false;
  let pendingCompact: ControllableCompact | undefined;

  const push = (event: RuntimeEvent, persist = false) => {
    if (persist) persisted.push(event);
    if (subscribed) {
      serverEnd.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { sessionId: childSessionId, event },
        }),
      );
    }
  };

  serverEnd.onLine((line) => {
    const req = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = req.method ?? "";
    const params = req.params ?? {};
    requests.push({ id: req.id, method, params });
    if (method === "session.interrupt") {
      pendingCompact?.interrupt();
      return;
    }
    if (req.id === undefined) return;
    const reply = (result: unknown) => {
      serverEnd.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    };
    const failRpc = (code: string, message: string) => {
      serverEnd.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32001, message, data: { code, name: "RuntimeCommandError" } },
        }),
      );
    };
    switch (method) {
      case "initialize":
        reply({ protocolVersion: 1, nocturneVersion: "0.68.0" });
        return;
      case "session.open":
        reply({
          sessionId: childSessionId,
          meta: {
            id: childSessionId,
            cwd: "Z:/proj",
            workspaceRoot: "Z:/proj",
            formatVersion: 1,
            nocturneVersion: "0.68.0",
          },
          config: { model: { provider: "p", model: "m" } },
          warnings: [],
          lastSeq: lastEventSeq(persisted),
        });
        return;
      case "session.subscribe":
        subscribed = true;
        for (const ev of persisted) {
          serverEnd.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "event",
              params: { sessionId: childSessionId, event: ev },
            }),
          );
        }
        reply({ lastSeq: lastEventSeq(persisted) });
        return;
      case "session.unsubscribe":
      case "session.close":
        subscribed = false;
        reply(null);
        return;
      case "session.pendingInputs":
        reply({ items: [], paused: false });
        return;
      case "session.describeSkills":
        reply({ skills: [], warnings: [], budget: {}, scannedDirs: [], homeDir: "Z:/home" });
        return;
      case "session.describeExternalAgents":
        reply({ agents: [], warnings: [] });
        return;
      case "session.shellInfo":
        reply({ selected: "auto", source: "auto" });
        return;
      case "session.readInputHistory":
        reply({ items: [] });
        return;
      case "session.recordInputHistory":
        reply(null);
        return;
      case "session.compact": {
        push({
          type: "runtime.status",
          time: new Date().toISOString(),
          sessionId: childSessionId,
          payload: { status: "compacting" },
        } as RuntimeEvent);
        let settled = false;
        pendingCompact = {
          sessionId: childSessionId,
          id: req.id,
          resolve(emitCompacted) {
            if (settled) return;
            settled = true;
            pendingCompact = undefined;
            if (emitCompacted !== undefined) {
              push(
                {
                  type: "context.compacted",
                  seq: emitCompacted.seq,
                  time: new Date().toISOString(),
                  sessionId: childSessionId,
                  payload: {
                    kind: "summary",
                    throughSeq: emitCompacted.seq - 1,
                    summary: emitCompacted.summary ?? "子会话摘要",
                  },
                } as RuntimeEvent,
                true,
              );
            }
            push({
              type: "runtime.status",
              time: new Date().toISOString(),
              sessionId: childSessionId,
              payload: { status: "idle" },
            } as RuntimeEvent);
            reply(null);
          },
          interrupt() {
            if (settled) return;
            settled = true;
            pendingCompact = undefined;
            push({
              type: "runtime.status",
              time: new Date().toISOString(),
              sessionId: childSessionId,
              payload: { status: "idle" },
            } as RuntimeEvent);
            failRpc("compaction_interrupted", "压缩被中断");
          },
          fail(message, code = "compaction_failed") {
            if (settled) return;
            settled = true;
            pendingCompact = undefined;
            push({
              type: "runtime.status",
              time: new Date().toISOString(),
              sessionId: childSessionId,
              payload: { status: "idle" },
            } as RuntimeEvent);
            failRpc(code, message);
          },
        };
        return;
      }
      default:
        reply(null);
    }
  });

  const client: RpcClient = createRpcClient(clientEnd, { clientName: "test", interactive: false });
  let initPromise: Promise<unknown> | undefined;
  return {
    requests,
    getPendingCompact: () => pendingCompact,
    ensureClient: async () => {
      initPromise ??= client.initialize();
      await initPromise;
      return client;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-reduce-motion");
  cleanup();
  localStorage.clear();
});

describe("CompactionFeedbackStore 纯逻辑", () => {
  it("按会话独立追踪、重放补齐耗时且保留历史自动压缩回执", () => {
    let clock = 10_000;
    const store = new CompactionFeedbackStore(() => clock);
    const run1 = store.begin("s1", []);
    expect(store.isRunning("s1")).toBe(true);
    expect(store.isRunning("s2")).toBe(false);

    clock = 22_400; // 12s
    store.succeed("s1", run1.id, []);
    expect(store.isRunning("s1")).toBe(false);
    expect(store.get("s1")?.active).toMatchObject({
      status: "succeeded",
      durationSeconds: 12,
    });
    const afterSucceed = store.get("s1")?.active;
    expect(
      afterSucceed?.status === "succeeded" ? afterSucceed.matchedSeq : "unexpected",
    ).toBeUndefined();

    // 切回重放：第一条 > baseline 的 compacted 绑定耗时，后续自动压缩保持无耗时
    const view = createSessionView();
    reduceSessionView(view, {
      type: "context.compacted",
      seq: 10,
      time: "2026-11-26T00:00:10.000Z",
      sessionId: "s1",
      payload: { kind: "summary", throughSeq: 9, summary: "手动摘要" },
    } as RuntimeEvent);
    reduceSessionView(view, {
      type: "context.compacted",
      seq: 20,
      time: "2026-11-26T00:00:20.000Z",
      sessionId: "s1",
      payload: { kind: "summary", throughSeq: 19, summary: "自动摘要" },
    } as RuntimeEvent);

    store.reconcile("s1", view.entries);
    expect(store.get("s1")?.durationsBySeq.get(10)).toBe(12);
    expect(store.get("s1")?.durationsBySeq.get(20)).toBeUndefined();

    expect(compactionRunningText(0)).toBe("正在压缩上下文 · 0 秒");
    expect(compactionSucceededText(12)).toBe("上下文已压缩 · 用时 12 秒");
    expect(compactionStoppedText()).toBe("压缩已停止");
    expect(compactionFailedText("Provider 500")).toBe("压缩失败：Provider 500");
    expect(compactionFailedText("压缩失败：超时")).toBe("压缩失败：超时");
    expect(isCompactionInterrupted({ code: "compaction_interrupted" })).toBe(true);
    expect(isCompactionInterrupted({ data: { code: "compaction_interrupted" } })).toBe(true);
    expect(isCompactionInterrupted({ code: "compaction_failed" })).toBe(false);
  });
});

describe("Composer `/compact` 即刻清草稿、草稿保护与输入历史", () => {
  it("提交 /compact 时不等 onSlash 返回即清空，新草稿不被旧回调擦除，且记入输入历史", async () => {
    const gate = deferred<boolean>();
    const onSlash = vi.fn(() => gate.promise);
    render(<Composer {...composerProps({ onSlash })} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");

    fireEvent.change(field, { target: { value: "/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });

    // 请求尚未返回，输入框已立即清空
    expect(onSlash).toHaveBeenCalledWith("/compact");
    expect(field.value).toBe("");

    // 期间编辑下一条草稿
    fireEvent.change(field, { target: { value: "压缩完继续排查构建" } });
    expect(field.value).toBe("压缩完继续排查构建");

    // 旧回调返回 true，不能清除新草稿
    await act(async () => {
      gate.resolve(true);
      await flushMicrotasks();
    });
    expect(field.value).toBe("压缩完继续排查构建");

    // 清空后按上箭头可调出历史里的 /compact
    fireEvent.change(field, { target: { value: "" } });
    field.setSelectionRange(0, 0);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("/compact");
  });

  it("提交前即被拒绝时显示原因并在未编辑时恢复命令，其他命令仍等返回再清", async () => {
    const onSlash = vi.fn((line: string) => {
      if (line === "/compact") throw new Error("已有压缩在进行中");
      return mcpGate.promise;
    });
    const mcpGate = deferred<boolean>();
    render(<Composer {...composerProps({ onSlash })} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");

    fireEvent.change(field, { target: { value: "/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByRole("alert").textContent).toContain("已有压缩在进行中");
    expect(field.value).toBe("/compact");

    // 其他命令（/mcp）沿用原行为：未返回前保持草稿，返回 true 后清空
    fireEvent.change(field, { target: { value: "/mcp" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("/mcp");
    await act(async () => {
      mcpGate.resolve(true);
      await flushMicrotasks();
    });
    expect(field.value).toBe("");
  });
});

describe("Conversation 手动压缩状态行、时钟与减少动态效果", () => {
  it("按测试时钟每秒递增，遵循减少动态效果，并在原位合入摘要回执且旧历史不变", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    setMotionPreference(true);

    const view: SessionView = createSessionView();
    // 旧历史中已有一条没有起始时间的摘要回执
    reduceSessionView(view, {
      type: "context.compacted",
      seq: 5,
      time: "2026-11-25T00:00:00.000Z",
      sessionId: "s-1",
      payload: { kind: "summary", throughSeq: 4, summary: "旧历史摘要" },
    } as RuntimeEvent);

    const store = new CompactionFeedbackStore();
    const run = store.begin("s-1", view.entries);
    const session = makeSessionStub("s-1");
    const images = createAttachmentImageSource();
    const subscribeEvents = () => () => undefined;

    const { container, rerender } = render(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/proj"
        subscribeEvents={subscribeEvents}
        images={images}
        busy
        compaction={store.get("s-1")}
      />,
    );

    // 旧历史保持原回执，末尾显示思考行样式的运行中状态
    expect(screen.getByText("上下文已压缩为摘要")).toBeTruthy();
    const runningRow = container.querySelector('[data-compaction-status="running"]');
    expect(runningRow?.className).toContain("think");
    expect(runningRow?.textContent).toBe("正在压缩上下文 · 0 秒");
    expect(runningRow?.querySelector(".think-label.shim")).not.toBeNull();

    // 减少动态效果关闭流光
    act(() => {
      document.documentElement.setAttribute("data-reduce-motion", "");
    });
    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/proj"
        subscribeEvents={subscribeEvents}
        images={images}
        busy
        compaction={store.get("s-1")}
      />,
    );
    expect(runningRow?.querySelector(".shim")).toBeNull();

    // 每秒递增
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('[data-compaction-status="running"]')?.textContent).toBe(
      "正在压缩上下文 · 3 秒",
    );

    // Core 先落盘 context.compacted（SessionStart hook 仍在跑）：不能同时出现两条
    reduceSessionView(view, {
      type: "context.compacted",
      seq: 12,
      time: "2026-11-26T10:00:03.000Z",
      sessionId: "s-1",
      payload: { kind: "summary", throughSeq: 11, summary: "不应直接露出的正文" },
    } as RuntimeEvent);
    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/proj"
        subscribeEvents={subscribeEvents}
        images={images}
        busy
        compaction={store.get("s-1")}
      />,
    );
    expect(container.querySelectorAll('[data-compaction-status="running"]').length).toBe(1);
    expect(screen.getAllByText("上下文已压缩为摘要").length).toBe(1); // 只有旧历史那一条

    // 压缩完成：原位变为「上下文已压缩 · 用时 3 秒」，只留一条，秒数固定不再递增
    store.succeed("s-1", run.id, view.entries);
    rerender(
      <Conversation
        session={session}
        view={view}
        openUrl={vi.fn()}
        cwd="Z:/proj"
        subscribeEvents={subscribeEvents}
        images={images}
        busy={false}
        compaction={store.get("s-1")}
      />,
    );
    expect(container.querySelector('[data-compaction-status="running"]')).toBeNull();
    expect(container.querySelectorAll('[data-compaction-status="succeeded"]').length).toBe(1);
    expect(screen.getByText("上下文已压缩 · 用时 3 秒")).toBeTruthy();
    expect(screen.getAllByText("上下文已压缩为摘要").length).toBe(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("上下文已压缩 · 用时 3 秒")).toBeTruthy();
  });
});

describe("桌面端完整链路：成功、停止、失败、重复提交与会话切换", () => {
  it("提交即清、计时递增、编辑新草稿、重复提交拒绝、成功后只留一条且秒数固定", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    setMotionPreference(true);
    const fx = controllableAppHost();

    render(<App host={fx.host} />);
    await act(async () => {
      await flushMicrotasks(12);
    });

    fireEvent.click(screen.getByRole("button", { name: /^alpha 首句/ }));
    await act(async () => {
      await flushMicrotasks(12);
    });

    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(field, { target: { value: "/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await flushMicrotasks();
    });

    // 命令已立即清走，停止按钮已出现，会话末尾显示 0 秒
    expect(field.value).toBe("");
    expect(screen.getByRole("button", { name: "中断" })).toBeTruthy();
    expect(screen.getByText("正在压缩上下文 · 0 秒")).toBeTruthy();
    expect(fx.historyRecords.some((r) => r.sessionId === "alpha" && r.text === "/compact")).toBe(
      true,
    );

    // 计时递增到 2 秒
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await flushMicrotasks();
    });
    expect(screen.getByText("正在压缩上下文 · 2 秒")).toBeTruthy();

    // 重复提交被拒，不发第二次 RPC，原计时不受干扰
    fireEvent.change(field, { target: { value: "/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fx.calls.filter((c) => c.method === "session.compact").length).toBe(1);
    expect(screen.getByRole("alert").textContent).toContain("已有压缩在进行中");
    expect(screen.getByText("正在压缩上下文 · 2 秒")).toBeTruthy();

    // 用户继续编辑下一条草稿
    fireEvent.change(field, { target: { value: "压缩好以后帮我写单测" } });
    expect(field.value).toBe("压缩好以后帮我写单测");

    // 再过 10 秒后成功返回（合计 12 秒）
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      fx.pendingCompacts[0]?.resolve({ seq: 4 });
      await flushMicrotasks(12);
    });

    expect(field.value).toBe("压缩好以后帮我写单测");
    expect(screen.queryByRole("button", { name: "中断" })).toBeNull();
    expect(screen.queryByText(/正在压缩上下文/)).toBeNull();
    expect(screen.getAllByText("上下文已压缩 · 用时 12 秒").length).toBe(1);
    expect(screen.queryByText("上下文已压缩为摘要")).toBeNull();

    // 完成后秒数固定
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await flushMicrotasks();
    });
    expect(screen.getByText("上下文已压缩 · 用时 12 秒")).toBeTruthy();
  });

  it("手动停止显示「压缩已停止」，失败显示实际原因，均停止计时且保留新草稿", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    const fx = controllableAppHost();

    render(<App host={fx.host} />);
    await act(async () => {
      await flushMicrotasks(12);
    });

    fireEvent.click(screen.getByRole("button", { name: /^alpha 首句/ }));
    await act(async () => {
      await flushMicrotasks(12);
    });

    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(field, { target: { value: "/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flushMicrotasks();
    });
    expect(screen.getByText("正在压缩上下文 · 3 秒")).toBeTruthy();

    fireEvent.change(field, { target: { value: "保留的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    await act(async () => {
      await flushMicrotasks(12);
    });

    expect(fx.interrupts).toContain("alpha");
    expect(screen.getByText("压缩已停止")).toBeTruthy();
    expect(screen.queryByText(/正在压缩上下文/)).toBeNull();
    expect(field.value).toBe("保留的草稿");

    // 再次提交 /compact 并让服务端返回真实失败原因
    fireEvent.change(field, { target: { value: "/compact" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await flushMicrotasks();
    });
    expect(screen.getByText("正在压缩上下文 · 2 秒")).toBeTruthy();

    await act(async () => {
      fx.pendingCompacts[0]?.fail("没有可行的压缩边界");
      await flushMicrotasks(12);
    });
    expect(screen.queryByText(/正在压缩上下文/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("没有可行的压缩边界");
  });

  it("提交前即被拒绝（无会话草稿页、会话已有 Turn 运行中）报原因且不产生压缩状态行", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    const fx = controllableAppHost();

    render(<App host={fx.host} />);
    await act(async () => {
      await flushMicrotasks(12);
    });

    // 1. 新会话草稿页直接执行 /compact
    const draftField = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(draftField, { target: { value: "/compact" } });
    fireEvent.keyDown(draftField, { key: "Enter" });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByRole("alert").textContent).toContain("请先打开会话");
    expect(fx.calls.filter((c) => c.method === "session.compact").length).toBe(0);

    // 2. 打开 alpha 并推入进行中的 Turn，此时提交 /compact 应报「会话正在运行」
    fireEvent.click(screen.getByRole("button", { name: /^alpha 首句/ }));
    await act(async () => {
      await flushMicrotasks(12);
    });
    await act(async () => {
      fx.pushEvent("alpha", {
        type: "turn.started",
        seq: 4,
        time: "2026-11-26T10:00:01.000Z",
        sessionId: "alpha",
        turnId: "t-busy",
        payload: { turnIndex: 2 },
      } as RuntimeEvent);
      await flushMicrotasks();
    });

    const sessionField = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(sessionField, { target: { value: "/compact" } });
    fireEvent.keyDown(sessionField, { key: "Enter" });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByRole("alert").textContent).toContain("会话正在运行");
    expect(screen.queryByText(/正在压缩上下文/)).toBeNull();
    expect(fx.calls.filter((c) => c.method === "session.compact").length).toBe(0);
  });

  it("切换到另一会话再返回：运行中保留正确秒数，后台完成后返回显示固定耗时", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    const fx = controllableAppHost();

    render(<App host={fx.host} />);
    await act(async () => {
      await flushMicrotasks(12);
    });

    fireEvent.click(screen.getByRole("button", { name: /^alpha 首句/ }));
    await act(async () => {
      await flushMicrotasks(12);
    });

    const alphaField = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(alphaField, { target: { value: "/compact" } });
    fireEvent.keyDown(alphaField, { key: "Enter" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await flushMicrotasks();
    });
    expect(screen.getByText("正在压缩上下文 · 2 秒")).toBeTruthy();

    // 切到 beta：beta 不显示 alpha 的压缩状态
    fireEvent.click(screen.getByRole("button", { name: /^beta 首句/ }));
    await act(async () => {
      vi.advanceTimersByTime(3000); // alpha 已运行 5 秒
      await flushMicrotasks(12);
    });
    expect(screen.queryByText(/正在压缩上下文/)).toBeNull();

    // 切回 alpha：立即看到 5 秒并继续递增
    fireEvent.click(screen.getByRole("button", { name: /^alpha 首句/ }));
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(screen.getByText("正在压缩上下文 · 5 秒")).toBeTruthy();

    // 再次切到 beta，期间 alpha 在后台以 7 秒完成并因空闲关闭
    fireEvent.click(screen.getByRole("button", { name: /^beta 首句/ }));
    await act(async () => {
      vi.advanceTimersByTime(2000); // 7 秒
      fx.pendingCompacts[0]?.resolve({ seq: 4 });
      await flushMicrotasks(12);
    });

    // 再过 10 秒后切回 alpha：重放 context.compacted 并显示固定耗时 7 秒
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await flushMicrotasks();
    });
    fireEvent.click(screen.getByRole("button", { name: /^alpha 首句/ }));
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(screen.getAllByText("上下文已压缩 · 用时 7 秒").length).toBe(1);
    expect(screen.queryByText("上下文已压缩为摘要")).toBeNull();
  });

  it("合奏成员面板与组曲线程面板均支持即时反馈、草稿保护与切标签后恢复", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    const store = new CompactionFeedbackStore();
    const images = createAttachmentImageSource();

    // 1. 合奏成员面板：发起 -> 切走（卸载）-> 后台完成 -> 切回（重新挂载）
    const member = controllableChildHarness("member-1");
    const memberProps = {
      childSessionId: "member-1",
      memberName: "researcher",
      memberStatus: "waiting" as const,
      ensembleStatus: "active" as const,
      workspace: "Z:/proj",
      ensureClient: member.ensureClient,
      images,
      openUrl: vi.fn(),
      pickImages: vi.fn(async () => []),
      compactionStore: store,
    };
    const memberView = render(<EnsembleMemberPane {...memberProps} />);
    await act(async () => {
      await flushMicrotasks(12);
    });

    const memberField = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(memberField, { target: { value: "/compact" } });
    fireEvent.keyDown(memberField, { key: "Enter" });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(memberField.value).toBe("");
    expect(screen.getByText("正在压缩上下文 · 0 秒")).toBeTruthy();
    expect(screen.getByRole("button", { name: "中断" })).toBeTruthy();

    // 卸载模拟切换面板标签，4 秒后在后台完成
    memberView.unmount();
    await act(async () => {
      vi.advanceTimersByTime(4000);
      member.getPendingCompact()?.resolve({ seq: 3 });
      await flushMicrotasks(12);
    });

    // 重新挂载模拟切回成员标签：显示固定耗时 4 秒且只留一条
    const memberView2 = render(<EnsembleMemberPane {...memberProps} />);
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(screen.getAllByText("上下文已压缩 · 用时 4 秒").length).toBe(1);
    memberView2.unmount();

    // 2. 组曲线程面板：发起 -> 计时 -> 停止
    const thread = controllableChildHarness("thread-1");
    render(
      <SuiteThreadPane
        threadId="th-1"
        childSessionId="thread-1"
        coordinatorSession={{ sendToThread: vi.fn(async () => undefined) } as unknown as RpcSession}
        workspace="Z:/proj"
        ensureClient={thread.ensureClient}
        images={images}
        openUrl={vi.fn()}
        pickImages={vi.fn(async () => [])}
        compactionStore={store}
      />,
    );
    await act(async () => {
      await flushMicrotasks(12);
    });

    const threadField = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.change(threadField, { target: { value: "/compact" } });
    fireEvent.keyDown(threadField, { key: "Enter" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await flushMicrotasks();
    });
    expect(threadField.value).toBe("");
    expect(screen.getByText("正在压缩上下文 · 2 秒")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    await act(async () => {
      await flushMicrotasks(12);
    });
    expect(screen.getByText("压缩已停止")).toBeTruthy();
  });
});
