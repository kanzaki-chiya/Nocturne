import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { PhoneSessions } from "../src/web/sessions";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import type { PhonePlatform } from "../src/web/platform";

const shared = vi.hoisted(() => ({
  connect: undefined as ((client: unknown, relay: unknown) => Promise<void>) | undefined,
}));
vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "online";
    message = "";
    constructor(options: { connected: typeof shared.connect }) {
      shared.connect = options.connected;
    }
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn();
  },
}));

const summary = (id: string) => ({
  id,
  cwd: "Z:/work",
  workspaceRoot: "Z:/work",
  createdAt: "",
  mtimeMs: 1,
  model: { provider: "p", model: "m" },
  locked: true,
  firstText: `消息 ${id}`,
});
const started = (id: string, seq: number, time: string): RuntimeEvent => ({
  sessionId: id,
  seq,
  time,
  turnId: "turn",
  type: "turn.started",
  payload: { turnIndex: 1 },
});
const completed = (id: string, seq: number, time: string): RuntimeEvent => ({
  sessionId: id,
  seq,
  time,
  turnId: "turn",
  type: "turn.completed",
  payload: { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
});
let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("PhoneSessions 回放以订阅开始时间区分 live，turn.started 回放时间传给通知，临时事件实时", async () => {
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  let receive: ((event: RuntimeEvent) => void) | undefined;
  const session = {
    id: "s",
    subscribe: vi.fn(async (callback: typeof receive) => {
      receive = callback;
      callback?.(started("s", 1, new Date(now - 60_000).toISOString()));
      callback?.(completed("s", 2, new Date(now - 1).toISOString()));
      callback?.(started("s", 3, new Date(now).toISOString()));
      return { lastSeq: 3, unsubscribe: vi.fn() };
    }),
    turnChanges: vi.fn(async () => []),
  } as unknown as RpcSession;
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({
    session,
    opened: { warnings: [] as string[] } as SessionOpened,
  } as Awaited<ReturnType<typeof client.runtime.resumeSession>>);
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  const observed = vi.fn();
  const events = vi.fn();
  const sessions = new PhoneSessions(vi.fn(), observed, events);
  await sessions.connected(client);
  await sessions.open("s");
  expect(session.subscribe).toHaveBeenCalledWith(expect.any(Function), { afterSeq: 0 });
  expect(observed.mock.calls.map(([, , seq, live]) => [seq, live])).toEqual([
    [1, false],
    [2, false],
    [3, true],
  ]);
  expect(events.mock.calls.map(([, , live, , turnStart]) => [live, turnStart])).toEqual([
    [false, now - 60_000],
    [false, now - 60_000],
    [true, now],
  ]);
  receive?.(completed("s", 4, new Date(now + 1).toISOString()));
  receive?.({
    sessionId: "s",
    runId: "turn",
    eseq: 1,
    afterSeq: 4,
    time: new Date(now - 100_000).toISOString(),
    type: "runtime.warning",
    payload: { code: "test", message: "x" },
  });
  expect(events.mock.calls.slice(-2).map(([, , live, , turnStart]) => [live, turnStart])).toEqual([
    [true, now],
    [true, now],
  ]);
  client.close();
});

it("新持锁会话经 runtime.sessionsChanged 订阅后把事件传到通知观察者", async () => {
  const [transport, server] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  let receive: ((event: RuntimeEvent) => void) | undefined;
  const session = {
    id: "new",
    subscribe: vi.fn(async (fn: typeof receive) => {
      receive = fn;
      return { lastSeq: 0, unsubscribe: vi.fn() };
    }),
    turnChanges: vi.fn(async () => []),
  } as unknown as RpcSession;
  const list = vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({
    session,
    opened: { warnings: [] as string[] } as SessionOpened,
  } as Awaited<ReturnType<typeof client.runtime.resumeSession>>);
  const onEvent = vi.fn();
  const sessions = new PhoneSessions(vi.fn(), undefined, onEvent);
  await sessions.connected(client);
  list.mockResolvedValue([summary("new")]);
  server.send(JSON.stringify({ jsonrpc: "2.0", method: "runtime.sessionsChanged", params: {} }));
  await vi.waitFor(() => expect(receive).toBeTypeOf("function"));
  receive?.(started("new", 1, new Date().toISOString()));
  expect(onEvent).toHaveBeenCalledWith(
    "new",
    expect.objectContaining({ type: "turn.started" }),
    true,
    expect.objectContaining({ session }),
    expect.any(Number),
  );
  client.close();
});

it("通知目标冷启动与暖启动切到指定电脑/会话；只在原生前台且当前会话未遮盖时 watching，返回按层级处理", async () => {
  const storage = memoryStorage();
  for (const hostId of ["a", "b"])
    await storage.putHost({
      hostId,
      hostPub: "pub",
      name: hostId,
      pairedAt: hostId === "a" ? 2 : 1,
    });
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const callbacks = new Map<string, (event: RuntimeEvent) => void>();
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([summary("sa"), summary("sb")]);
  vi.spyOn(client.runtime, "resumeSession").mockImplementation(
    async (id) =>
      ({
        session: new Proxy(
          {
            id,
            subscribe: async (fn: (event: RuntimeEvent) => void) => {
              callbacks.set(id, fn);
              return { lastSeq: 0, unsubscribe: vi.fn() };
            },
            turnChanges: async () => [],
          },
          {
            get: (object, key) =>
              key in object
                ? object[key as keyof typeof object]
                : () => Promise.reject(new Error(`未实现 ${String(key)}`)),
          },
        ) as unknown as RpcSession,
        opened: { warnings: [] as string[] } as SessionOpened,
      }) as Awaited<ReturnType<typeof client.runtime.resumeSession>>,
  );
  let targetListener: ((target: { hostId: string; sessionId: string }) => void) | undefined;
  let back: (() => void) | undefined;
  let foreground = true;
  const observer = vi.fn();
  const dismiss = vi.fn();
  const moveTaskToBack = vi.fn();
  const platform: PhonePlatform = {
    relay: "page",
    notificationTarget: async () => ({ hostId: "b", sessionId: "sb" }),
    onNotificationTarget: (fn) => {
      targetListener = fn;
      return () => {
        targetListener = undefined;
      };
    },
    onAndroidBack: (fn) => {
      back = fn;
      return () => {
        back = undefined;
      };
    },
    moveTaskToBack,
    dismissNotification: dismiss,
    isForeground: () => foreground,
    observer: { sessionEvent: observer },
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={storage} platform={platform} />);
  });
  await vi.waitFor(() => expect(shared.connect).toBeTypeOf("function"));
  await act(async () => {
    await shared.connect?.(client, {});
  });
  await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith("b", "sb"));
  expect(container.textContent).toContain("消息 sb");
  const emit = async (id: string) => {
    await act(() => callbacks.get(id)?.(started(id, 1, new Date().toISOString())));
  };
  await emit("sb");
  expect(observer).toHaveBeenLastCalledWith(
    "b",
    "sb",
    expect.anything(),
    true,
    expect.anything(),
    true,
    expect.any(Number),
  );
  foreground = false;
  await emit("sa");
  expect(observer.mock.lastCall?.[5]).toBe(false);
  foreground = true;
  await act(() =>
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { kind: "settings", hostId: "b" } }),
    ),
  );
  await emit("sb");
  expect(observer.mock.lastCall?.[5]).toBe(false);
  const historyBack = vi
    .spyOn(history, "back")
    .mockImplementation(() =>
      window.dispatchEvent(new PopStateEvent("popstate", { state: { kind: "home", hostId: "b" } })),
    );
  await act(() => back?.());
  expect(historyBack).toHaveBeenCalledOnce();
  await act(() => back?.());
  expect(moveTaskToBack).toHaveBeenCalledOnce();
  await act(() => targetListener?.({ hostId: "a", sessionId: "sa" }));
  await act(async () => {
    await shared.connect?.(client, {});
  });
  await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith("a", "sa"));
  expect(container.textContent).toContain("消息 sa");
  client.close();
});
