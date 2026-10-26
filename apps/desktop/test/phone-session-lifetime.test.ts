import { afterEach, expect, it, vi } from "vitest";
import {
  createRpcClient,
  createMemoryTransportPair,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import { PhoneSessions } from "../src/web/sessions";
import type { RuntimeEvent } from "@nocturne/core/protocol";

function harness() {
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "lifetime" });
  const listeners = new Map<string, (event: RuntimeEvent) => void>();
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  const resume = vi.spyOn(client.runtime, "resumeSession").mockImplementation(async (id) => {
    const close = vi.fn(async () => undefined);
    closes.set(id, close);
    const session = {
      id,
      close,
      turnChanges: async () => [],
      subscribe: async (listener: (event: RuntimeEvent) => void) => {
        listeners.set(id, listener);
        return { lastSeq: 0, unsubscribe: vi.fn() };
      },
    } as unknown as RpcSession;
    return { session, opened: { warnings: [] } as unknown as SessionOpened };
  });
  const list = vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  const sessions = new PhoneSessions(vi.fn());
  const emit = (id: string, status: string) =>
    listeners.get(id)?.({
      type: "runtime.status",
      sessionId: id,
      time: new Date().toISOString(),
      payload: { status },
    } as RuntimeEvent);
  return { client, sessions, resume, list, emit, closes };
}
afterEach(() => vi.restoreAllMocks());

it("常驻连接：离开的运行会话在 Turn 结束并空闲后关闭，当前会话保留", async () => {
  const h = harness();
  await h.sessions.connected(h.client);
  const entry = await h.sessions.open("running");
  h.emit("running", "running_model");
  h.sessions.setSelected(undefined);
  expect(h.closes.get("running")).not.toHaveBeenCalled();
  entry.view.currentTurn = "turn";
  h.emit("running", "idle");
  expect(h.closes.get("running")).not.toHaveBeenCalled();
  entry.view.currentTurn = undefined;
  h.emit("running", "idle");
  await vi.waitFor(() => expect(h.sessions.opened.has("running")).toBe(false));
  expect(entry.session.close).toHaveBeenCalledTimes(1);
  await h.sessions.open("viewing");
  h.emit("viewing", "idle");
  expect(h.closes.get("viewing")).not.toHaveBeenCalled();
  h.client.close();
});

it.each(["pendingPermission", "pendingQuestion"] as const)(
  "%s 保留直到请求清除且空闲",
  async (field) => {
    const h = harness();
    await h.sessions.connected(h.client);
    const entry = await h.sessions.open("pending");
    entry.view[field] = { requestId: "request" } as never;
    h.sessions.setSelected(undefined);
    h.emit("pending", "idle");
    expect(h.closes.get("pending")).not.toHaveBeenCalled();
    entry.view[field] = undefined;
    h.emit("pending", "idle");
    await vi.waitFor(() => expect(h.sessions.opened.has("pending")).toBe(false));
    h.client.close();
  },
);

it("openHere 优先于锁；旧后台回退 locked，回放空闲会话立即释放", async () => {
  const h = harness();
  h.list.mockResolvedValue([
    { id: "external", locked: true, openHere: false },
    { id: "here", locked: false, openHere: true },
    { id: "legacy", locked: true },
  ] as Awaited<ReturnType<typeof h.client.runtime.listSessions>>);
  await h.sessions.connected(h.client);
  await h.sessions.attentionTarget();
  expect(h.resume.mock.calls.map(([id]) => id)).toEqual(["here", "legacy"]);
  expect(h.sessions.opened.size).toBe(0);
  expect(h.closes.get("here")).toHaveBeenCalledTimes(1);
  expect(h.closes.get("legacy")).toHaveBeenCalledTimes(1);
  h.client.close();
});

it("重连只恢复当前、运行和待处理会话，不恢复历史空闲项", async () => {
  const h = harness();
  await h.sessions.connected(h.client);
  const running = await h.sessions.open("running");
  h.emit("running", "running_model");
  const pending = await h.sessions.open("pending");
  pending.view.pendingQuestion = { requestId: "question" } as never;
  await h.sessions.open("viewing");
  h.sessions.disconnected();
  h.sessions.opened.set("history", {
    ...running,
    session: { id: "history" } as RpcSession,
    view: { ...running.view, status: "idle" },
    dead: true,
  });
  const next = harness();
  await h.sessions.connected(next.client);
  expect(next.resume.mock.calls.map(([id]) => id)).toEqual(["running", "pending", "viewing"]);
  expect(h.sessions.opened.has("history")).toBe(false);
  h.client.close();
  next.client.close();
});

it("关闭进行中重新打开会等待关闭完成再 resume", async () => {
  const h = harness();
  await h.sessions.connected(h.client);
  const entry = await h.sessions.open("s");
  let release!: () => void;
  vi.mocked(entry.session.close).mockImplementation(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  h.sessions.setSelected(undefined);
  const reopening = h.sessions.open("s");
  expect(h.resume).toHaveBeenCalledTimes(1);
  release();
  const reopened = await reopening;
  expect(h.resume).toHaveBeenCalledTimes(2);
  expect(h.sessions.opened.get("s")).toBe(reopened);
  h.client.close();
});
