import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptPairingHello,
  createMemoryFramePair,
  createPairingOffer,
  generateIdentity,
  RemoteChannelError,
  RelayError,
  type DeviceRelay,
} from "@nocturne/remote";
import {
  createMemoryTransportPair,
  type RpcClient,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import { memoryStorage, encode, type PairedHost } from "../src/web/storage";
import { pairPhone, pairingError, parsePairingLink, takePairingFragment } from "../src/web/pairing";
import { PhoneConnection, retryDelay, versionMessage } from "../src/web/connection";
import { PhoneSessions, phoneStatus } from "../src/web/sessions";
import { phoneProjects, plainWorkspaceOf, projectSessions, shortDate } from "../src/web/projects";
import {
  applyTheme,
  clearDisconnects,
  closeReason,
  loadDisconnects,
  loadTheme,
  recordDisconnect,
  saveTheme,
} from "../src/web/local";
import { createSessionView } from "@nocturne/core/protocol";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe.each([["内存", memoryStorage]] as const)("手机存储契约：%s", (_name, factory) => {
  it("只生成一份不可导出身份，电脑增改删不影响身份", async () => {
    const store = factory();
    const identity = await store.identity();
    expect(identity.privateKey.extractable).toBe(false);
    expect(await store.identity()).toBe(identity);
    await expect(crypto.subtle.exportKey("jwk", identity.privateKey)).rejects.toThrow();
    const computer: PairedHost = { hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 };
    await store.putHost(computer);
    await store.putHost({ ...computer, name: "工作电脑" });
    const list = await store.hosts();
    expect(list[0]?.name).toBe("工作电脑");
    if (list[0]) list[0].name = "修改副本";
    expect((await store.hosts())[0]?.name).toBe("工作电脑");
    await store.removeHost("host");
    expect(await store.hosts()).toEqual([]);
    expect(await store.identity()).toBe(identity);
  });
});
it("扫码片段在解析和联网前清理", () => {
  const replaceState = vi.fn();
  expect(
    takePairingFragment({ hash: "#pair=secret", pathname: "/", search: "?x=1" }, { replaceState }),
  ).toBe("#pair=secret");
  expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1");
});
it.each(["扫码", "粘贴链接", "粘贴片段"])("%s 入口用真实配对存下电脑", async (entry) => {
  const host = await generateIdentity({ extractable: true });
  const offer = await createPairingOffer(host, "AAAAAAAAAAAAAAAAAAAAAA");
  const store = memoryStorage();
  const input =
    entry === "粘贴链接" ? `https://relay.example/#${offer.fragment}` : `#${offer.fragment}`;
  const [phone, computer] = createMemoryFramePair();
  computer.onFrame((frame) => {
    void acceptPairingHello(host, offer.secret, frame).then(({ reply }) => {
      computer.send(reply);
    });
  });
  const paired = await pairPhone(
    store,
    parsePairingLink(input, "https://relay.example"),
    "https://relay.example",
    "测试手机",
    () => Promise.resolve(phone),
  );
  expect(paired.hostId).toBe(host.id);
  expect(await store.hosts()).toEqual([paired]);
});
it.each([
  ["fingerprint_mismatch", "指纹不匹配"],
  ["bad_mac", "密钥校验失败"],
  ["closed", "槽位无效"],
  ["timeout", "配对超时"],
] as const)("配对 %s 给中文说明和重试提示", (code, text) => {
  expect(pairingError(new RemoteChannelError(code))).toContain(text);
  expect(pairingError(new RemoteChannelError(code))).toContain("重新点『配对新手机』");
});
it("配对超时关闭传输且不保存电脑", async () => {
  const offer = await createPairingOffer(
    await generateIdentity({ extractable: true }),
    "AAAAAAAAAAAAAAAAAAAAAA",
  );
  const [p] = createMemoryFramePair();
  const close = vi.spyOn(p, "close");
  const store = memoryStorage();
  await expect(
    pairPhone(
      store,
      parsePairingLink(offer.fragment, "https://relay.example"),
      "https://relay.example",
      "手机",
      () => Promise.resolve(p),
      10,
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(close).toHaveBeenCalled();
  expect(await store.hosts()).toEqual([]);
});
it("两种版本不兼容提示和抖动退避上限", () => {
  expect(versionMessage(2)).toContain("网页版本过旧");
  expect(versionMessage(0)).toContain("更新电脑");
  expect([0, 1, 2, 5, 10].map((n) => retryDelay(n, () => 0.5))).toEqual([
    1000, 2000, 4000, 30000, 30000,
  ]);
  expect(retryDelay(0, () => 0)).toBe(800);
  expect(retryDelay(0, () => 1)).toBeCloseTo(1200);
});
async function connectionHarness(online = false) {
  const identity = await generateIdentity({ extractable: false });
  let closed: ((code: number) => void) | undefined;
  const [transport] = createMemoryFramePair();
  const relay: DeviceRelay = {
    online,
    transport,
    onHostOnline: vi.fn(),
    subscribePush: vi.fn(),
    unsubscribePush: vi.fn(),
    onClose: (fn) => {
      closed = fn;
    },
  };
  const connect = vi.fn(() => Promise.resolve(relay));
  const disconnected = vi.fn();
  const c = new PhoneConnection({
    identity,
    host: { hostId: identity.id, hostPub: encode(identity.publicKey), name: "电脑", pairedAt: 1 },
    origin: "https://relay.example",
    changed: vi.fn(),
    connected: vi.fn(),
    disconnected,
    connect,
  });
  c.start();
  await vi.waitFor(() => expect(c.relay).toBe(relay));
  return {
    c,
    connect,
    relay,
    close: (code: number) => {
      closed?.(code);
    },
  };
}
it.each([4003, 4004])("关闭 %i 停止重连", async (code) => {
  const h = await connectionHarness();
  vi.useFakeTimers();
  h.close(code);
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.c.state).toBe("revoked");
  expect(h.connect).toHaveBeenCalledTimes(1);
  h.c.stop();
});
it("4002 立即回到离线等待，普通断线退避，后台暂停重连前台立即恢复", async () => {
  const h = await connectionHarness();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  h.close(4002);
  expect(h.c.state).toBe("offline");
  await vi.advanceTimersByTimeAsync(0);
  expect(h.connect).toHaveBeenCalledTimes(2);
  h.close(1006);
  await vi.advanceTimersByTimeAsync(999);
  expect(h.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.connect).toHaveBeenCalledTimes(3);
  h.c.visibility(false);
  h.close(1006);
  await vi.advanceTimersByTimeAsync(30000);
  expect(h.connect).toHaveBeenCalledTimes(3);
  h.c.visibility(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.connect).toHaveBeenCalledTimes(4);
  h.c.stop();
});
it("认证阶段 4003 也停止重连", async () => {
  const identity = await generateIdentity({ extractable: false });
  const c = new PhoneConnection({
    identity,
    host: { hostId: identity.id, hostPub: encode(identity.publicKey), name: "电脑", pairedAt: 1 },
    origin: "https://relay.example",
    changed: vi.fn(),
    connected: vi.fn(),
    disconnected: vi.fn(),
    connect: () => Promise.reject(new RelayError("closed", 4003)),
  });
  c.start();
  await vi.waitFor(() => expect(c.state).toBe("revoked"));
  c.stop();
});
it("握手失败关闭触发 onClose 时只安排一次重连", async () => {
  const identity = await generateIdentity({ extractable: false });
  const [transport] = createMemoryFramePair();
  let closed: (() => void) | undefined;
  vi.spyOn(transport, "close").mockImplementation(() => closed?.());
  const relay: DeviceRelay = {
    online: true,
    transport,
    onClose: (fn) => {
      closed = () => fn(1006);
    },
    onHostOnline: (fn) => {
      queueMicrotask(fn);
    },
    subscribePush: vi.fn(),
    unsubscribePush: vi.fn(),
  };
  const connect = vi.fn(() => Promise.resolve(relay));
  const disconnected = vi.fn();
  const c = new PhoneConnection({
    identity,
    host: { hostId: identity.id, hostPub: encode(identity.publicKey), name: "电脑", pairedAt: 1 },
    origin: "https://relay.example",
    changed: vi.fn(),
    connected: vi.fn(),
    disconnected,
    connect,
    channel: () => Promise.reject(new Error("握手失败")),
  });
  vi.useFakeTimers();
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  expect(connect).toHaveBeenCalledTimes(1);
  c.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("重连续接 lastSeq 并保留显示视图，新建会话可用任意目录并带上草稿选项", async () => {
  const [transport] = createMemoryTransportPair();
  const { createRpcClient } = await import("@nocturne/rpc/client");
  const client = createRpcClient(transport, { clientName: "test" });
  const session = {
    id: "s",
    subscribe: vi.fn(async () => ({ lastSeq: 12, unsubscribe: vi.fn() })),
  } as unknown as RpcSession;
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({
    session,
    opened: { warnings: [] as string[] } as SessionOpened,
  } as Awaited<ReturnType<RpcClient["runtime"]["resumeSession"]>>);
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  const sessions = new PhoneSessions(vi.fn());
  const view = createSessionView();
  view.lastSeq = 12;
  sessions.opened.set("s", {
    session,
    client,
    workspace: "Z:/work",
    view,
    warnings: [],
    dead: true,
    listeners: new Set(),
    turnChanges: new Map(),
    changeDiffs: new Map(),
  });
  await sessions.connected(client);
  expect(sessions.opened.get("s")?.view).toBe(view);
  expect(session.subscribe).toHaveBeenCalledWith(expect.any(Function), { afterSeq: 12 });
  const entry = sessions.opened.get("s");
  if (!entry) throw new Error("缺少恢复会话");
  expect(phoneStatus(entry)).toBe("idle");
  const created = {
    id: "n",
    subscribe: vi.fn(async () => ({ lastSeq: 0, unsubscribe: vi.fn() })),
  } as unknown as RpcSession;
  const create = vi.spyOn(client.runtime, "createSession").mockResolvedValue({
    session: created,
    opened: { warnings: [] as string[] } as SessionOpened,
  } as Awaited<ReturnType<RpcClient["runtime"]["createSession"]>>);
  const model = { provider: "fake", model: "fake-1" };
  await sessions.create("Z:/other", { model, reasoningEffort: "high", permissionPreset: "auto" });
  expect(create).toHaveBeenCalledWith({
    model,
    cwd: "Z:/other",
    workspaceRoot: "Z:/other",
    reasoningEffort: "high",
    permissionPreset: "auto",
  });
  expect(sessions.opened.get("n")?.workspace).toBe("Z:/other");
  client.close();
});

it("连接只等列表，后台只订阅持锁会话", async () => {
  const [transport] = createMemoryTransportPair();
  const { createRpcClient } = await import("@nocturne/rpc/client");
  const client = createRpcClient(transport, { clientName: "test" });
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const resume = vi.spyOn(client.runtime, "resumeSession").mockImplementation(async (id) => {
    await gate;
    const session = {
      id,
      subscribe: vi.fn(async () => ({ lastSeq: 0, unsubscribe: vi.fn() })),
    } as unknown as RpcSession;
    return { session, opened: { warnings: [] as string[] } as SessionOpened } as Awaited<
      ReturnType<RpcClient["runtime"]["resumeSession"]>
    >;
  });
  const summary = (id: string, locked: boolean) => ({
    id,
    cwd: "Z:/work",
    workspaceRoot: "Z:/work",
    createdAt: "",
    mtimeMs: 1,
    model: { provider: "p", model: "m" },
    locked,
  });
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([
    summary("busy", true),
    summary("old", false),
  ]);
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(client);
  expect(sessions.list.map((s) => s.id)).toEqual(["busy", "old"]);
  release();
  await vi.waitFor(() => expect(sessions.opened.has("busy")).toBe(true));
  expect(sessions.opened.get("busy")?.replaying).toBe(false);
  expect(resume.mock.calls.map(([id]) => id)).toEqual(["busy"]);
  client.close();
});

it("推送点进来优先最近的待处理会话，没有则取最近会话", async () => {
  const [transport] = createMemoryTransportPair();
  const { createRpcClient } = await import("@nocturne/rpc/client");
  const client = createRpcClient(transport, { clientName: "test" });
  vi.spyOn(client.runtime, "resumeSession").mockImplementation(async (id) => {
    const session = {
      id,
      subscribe: vi.fn(async () => ({ lastSeq: 0, unsubscribe: vi.fn() })),
    } as unknown as RpcSession;
    return { session, opened: { warnings: [] as string[] } as SessionOpened } as Awaited<
      ReturnType<RpcClient["runtime"]["resumeSession"]>
    >;
  });
  const summary = (id: string, mtimeMs: number, locked: boolean) => ({
    id,
    cwd: "Z:/work",
    workspaceRoot: "Z:/work",
    createdAt: "",
    mtimeMs,
    model: { provider: "p", model: "m" },
    locked,
  });
  const list = vi
    .spyOn(client.runtime, "listSessions")
    .mockResolvedValue([summary("new", 3, false), summary("ask", 2, true)]);
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(client);
  expect(await sessions.attentionTarget()).toBe("new");
  const entry = sessions.opened.get("ask");
  if (!entry) throw new Error("持锁会话未订阅");
  entry.view.pendingQuestion = { requestId: "q" } as typeof entry.view.pendingQuestion;
  expect(await sessions.attentionTarget()).toBe("ask");
  list.mockResolvedValue([]);
  await sessions.refresh();
  expect(await sessions.attentionTarget()).toBeUndefined();
  client.close();
});

const SESSIONS_CHANGED = JSON.stringify({
  jsonrpc: "2.0",
  method: "runtime.sessionsChanged",
  params: {},
});
function listedSession(id: string, mtimeMs: number, locked: boolean, firstText?: string) {
  return {
    id,
    cwd: "Z:/work",
    workspaceRoot: "Z:/work",
    createdAt: "",
    mtimeMs,
    model: { provider: "p", model: "m" },
    locked,
    ...(firstText !== undefined ? { firstText } : {}),
  };
}
async function notifiedClient() {
  const [transport, server] = createMemoryTransportPair();
  const { createRpcClient } = await import("@nocturne/rpc/client");
  const client = createRpcClient(transport, { clientName: "test" });
  const resume = vi.spyOn(client.runtime, "resumeSession").mockImplementation(async (id) => {
    const session = {
      id,
      subscribe: vi.fn(async () => ({ lastSeq: 0, unsubscribe: vi.fn() })),
    } as unknown as RpcSession;
    return { session, opened: { warnings: [] as string[] } as SessionOpened } as Awaited<
      ReturnType<RpcClient["runtime"]["resumeSession"]>
    >;
  });
  const list = vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  return { client, server, resume, list };
}

it("收到 runtime.sessionsChanged 后刷新列表，新出现的持锁会话被订阅，重复刷新不重复打开", async () => {
  const { client, server, resume, list } = await notifiedClient();
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(client);
  expect(sessions.list).toEqual([]);
  list.mockResolvedValue([listedSession("new", 5, true, "新会话"), listedSession("old", 1, false)]);
  server.send(SESSIONS_CHANGED);
  await vi.waitFor(() => expect(sessions.list.map((s) => s.id)).toEqual(["new", "old"]));
  expect(sessions.list[0]?.firstText).toBe("新会话");
  await vi.waitFor(() => expect(sessions.opened.has("new")).toBe(true));
  // 标题更新：同一会话再来一次通知，不再 resume
  list.mockResolvedValue([
    listedSession("new", 6, true, "改过的标题"),
    listedSession("old", 1, false),
  ]);
  server.send(SESSIONS_CHANGED);
  await vi.waitFor(() => expect(sessions.list[0]?.firstText).toBe("改过的标题"));
  await sessions.refresh();
  expect(resume.mock.calls.map(([id]) => id)).toEqual(["new"]);
  client.close();
});

it("连续多条通知只触发有限次 listSessions：刷新中再来的合并成一次补拉", async () => {
  const { client, server, list } = await notifiedClient();
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(client);
  list.mockClear();
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let inflight = 0;
  let maxInflight = 0;
  list.mockImplementation(async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await gate;
    inflight -= 1;
    return [listedSession("a", 1, false)];
  });
  for (let i = 0; i < 6; i++) server.send(SESSIONS_CHANGED);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  release();
  await vi.waitFor(() => expect(sessions.list.map((s) => s.id)).toEqual(["a"]));
  await new Promise((done) => setTimeout(done, 30));
  expect(list).toHaveBeenCalledTimes(2);
  expect(maxInflight).toBe(1);
  client.close();
});

it("断线、清空、切换电脑之后，旧连接的通知不再触发 listSessions", async () => {
  const first = await notifiedClient();
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(first.client);
  first.list.mockClear();
  sessions.disconnected();
  first.server.send(SESSIONS_CHANGED);
  await new Promise((done) => setTimeout(done, 30));
  expect(first.list).not.toHaveBeenCalled();

  // 重连到另一台电脑：只有新连接的通知生效
  const second = await notifiedClient();
  await sessions.connected(second.client);
  first.list.mockClear();
  second.list.mockClear();
  sessions.clear();
  first.server.send(SESSIONS_CHANGED);
  second.server.send(SESSIONS_CHANGED);
  await new Promise((done) => setTimeout(done, 30));
  expect(first.list).not.toHaveBeenCalled();
  expect(second.list).not.toHaveBeenCalled();
  await sessions.connected(second.client);
  second.list.mockClear();
  first.server.send(SESSIONS_CHANGED);
  await new Promise((done) => setTimeout(done, 30));
  expect(first.list).not.toHaveBeenCalled();
  expect(second.list).not.toHaveBeenCalled();
  second.server.send(SESSIONS_CHANGED);
  await vi.waitFor(() => expect(second.list).toHaveBeenCalledTimes(1));
  first.client.close();
  second.client.close();
});

it("旧电脑没有这条通知：回前台时 refresh 照常补上新会话", async () => {
  const { client, list } = await notifiedClient();
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(client);
  list.mockResolvedValue([listedSession("cli", 9, true, "CLI 新开的")]);
  await sessions.refresh();
  expect(sessions.list.map((s) => s.id)).toEqual(["cli"]);
  await vi.waitFor(() => expect(sessions.opened.has("cli")).toBe(true));
  client.close();
});

/** 真实后台的约束：同一连接上同一会话只能 resume 一次，重复报 session_already_open */
function strictResume(resume: ReturnType<typeof vi.spyOn>, gates: Map<string, Promise<void>>) {
  const openOnConnection = new Set<string>();
  const calls: string[] = [];
  resume.mockImplementation((async (id: string) => {
    calls.push(id);
    if (openOnConnection.has(id)) throw new Error("session_already_open");
    openOnConnection.add(id);
    await gates.get(id);
    const session = {
      id,
      subscribe: vi.fn(async () => ({ lastSeq: 0, unsubscribe: vi.fn() })),
    } as unknown as RpcSession;
    return { session, opened: { warnings: [] as string[] } as SessionOpened };
  }) as never);
  return calls;
}
/** 已有一个被订阅的会话 A，连接断开（A 变成 dead），返回断线后的 PhoneSessions */
async function reconnectingAfterOpened() {
  const first = await notifiedClient();
  first.list.mockResolvedValue([listedSession("A", 9, true)]);
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(first.client);
  await vi.waitFor(() => expect(sessions.opened.get("A")?.dead).toBe(false));
  sessions.disconnected();
  first.client.close();
  expect(sessions.opened.get("A")?.dead).toBe(true);
  return sessions;
}

it("重连恢复 A 期间通知带来新持锁会话 B：B 只 resume 一次，连接初始化不失败", async () => {
  const sessions = await reconnectingAfterOpened();
  const second = await notifiedClient();
  second.list.mockResolvedValue([listedSession("B", 20, true), listedSession("A", 9, true)]);
  let release!: () => void;
  const gates = new Map([["A", new Promise<void>((done) => (release = done))]]);
  const calls = strictResume(second.resume, gates);
  const connecting = sessions.connected(second.client);
  await vi.waitFor(() => expect(calls).toEqual(["A"]));
  second.server.send(SESSIONS_CHANGED);
  await vi.waitFor(() => expect(sessions.opened.has("B")).toBe(true));
  release();
  await connecting;
  expect(calls.toSorted()).toEqual(["A", "B"]);
  expect(sessions.opened.get("A")?.dead).toBe(false);
  expect(sessions.opened.get("B")?.dead).toBe(false);
  second.client.close();
});

it("重连恢复期间用户点开尚未恢复的 A：与恢复合并，只 resume 一次，沿用旧视图", async () => {
  const sessions = await reconnectingAfterOpened();
  const staleView = sessions.opened.get("A")?.view;
  const second = await notifiedClient();
  second.list.mockResolvedValue([listedSession("A", 9, true)]);
  let release!: () => void;
  const gates = new Map([["A", new Promise<void>((done) => (release = done))]]);
  const calls = strictResume(second.resume, gates);
  const connecting = sessions.connected(second.client);
  await vi.waitFor(() => expect(calls).toEqual(["A"]));
  const opening = sessions.open("A");
  release();
  const [, entry] = await Promise.all([connecting, opening]);
  expect(calls).toEqual(["A"]);
  expect(entry.dead).toBe(false);
  expect(entry.view).toBe(staleView);
  expect(sessions.opened.get("A")).toBe(entry);
  second.client.close();
});

it("重连队列里靠后的 C 被用户抢先打开（仍在进行或已完成），恢复轮到时不再重复 resume", async () => {
  const first = await notifiedClient();
  first.list.mockResolvedValue([listedSession("A", 9, true), listedSession("C", 8, true)]);
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(first.client);
  await vi.waitFor(() => expect(sessions.opened.get("C")?.dead).toBe(false));
  sessions.disconnected();
  first.client.close();
  const second = await notifiedClient();
  second.list.mockResolvedValue([]);
  let releaseA!: () => void;
  let releaseC!: () => void;
  const gates = new Map([
    ["A", new Promise<void>((done) => (releaseA = done))],
    ["C", new Promise<void>((done) => (releaseC = done))],
  ]);
  const calls = strictResume(second.resume, gates);
  const connecting = sessions.connected(second.client);
  await vi.waitFor(() => expect(calls).toEqual(["A"]));
  // 用户在恢复 A 时点开队列里靠后的 C，恢复轮到 C 时这次打开仍在进行
  const opening = sessions.open("C");
  await vi.waitFor(() => expect(calls).toEqual(["A", "C"]));
  releaseA();
  await new Promise((done) => setTimeout(done, 20));
  releaseC();
  await Promise.all([connecting, opening]);
  expect(calls).toEqual(["A", "C"]);
  expect(sessions.opened.get("C")?.dead).toBe(false);
  second.client.close();
});

it("重连队列里靠后的 C 在轮到前已被用户打开完成：恢复直接跳过", async () => {
  const first = await notifiedClient();
  first.list.mockResolvedValue([listedSession("A", 9, true), listedSession("C", 8, true)]);
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(first.client);
  await vi.waitFor(() => expect(sessions.opened.get("C")?.dead).toBe(false));
  sessions.disconnected();
  first.client.close();
  const second = await notifiedClient();
  second.list.mockResolvedValue([]);
  let release!: () => void;
  const gates = new Map([["A", new Promise<void>((done) => (release = done))]]);
  const calls = strictResume(second.resume, gates);
  const connecting = sessions.connected(second.client);
  await vi.waitFor(() => expect(calls).toEqual(["A"]));
  await sessions.open("C");
  release();
  await connecting;
  expect(calls).toEqual(["A", "C"]);
  second.client.close();
});

it("断线后才返回的旧 listSessions 不覆写列表，也不订阅旧列表里的会话", async () => {
  const first = await notifiedClient();
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(first.client);
  let release!: (list: ReturnType<typeof listedSession>[]) => void;
  first.list.mockReturnValue(new Promise((done) => (release = done)));
  first.resume.mockClear();
  const stale = sessions.refresh();
  sessions.disconnected();
  release([listedSession("stale", 99, true, "旧电脑")]);
  await stale;
  expect(sessions.list).toEqual([]);
  expect(sessions.loaded).toBe(false);
  await new Promise((done) => setTimeout(done, 30));
  expect(first.resume).not.toHaveBeenCalled();
  expect(sessions.opened.has("stale")).toBe(false);
  first.client.close();
});

it("切换电脑（clear 后连新电脑）后才返回的旧 listSessions 不覆写新连接的列表", async () => {
  const first = await notifiedClient();
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(first.client);
  let release!: (list: ReturnType<typeof listedSession>[]) => void;
  first.list.mockReturnValue(new Promise((done) => (release = done)));
  first.resume.mockClear();
  const stale = sessions.refresh();
  sessions.clear();
  const second = await notifiedClient();
  second.list.mockResolvedValue([listedSession("fresh", 5, false, "新电脑")]);
  await sessions.connected(second.client);
  expect(sessions.list.map((s) => s.id)).toEqual(["fresh"]);
  release([listedSession("stale", 99, true, "旧电脑")]);
  await stale;
  await new Promise((done) => setTimeout(done, 30));
  expect(sessions.list.map((s) => s.id)).toEqual(["fresh"]);
  expect(sessions.opened.has("stale")).toBe(false);
  expect(first.resume).not.toHaveBeenCalled();
  expect(second.resume).not.toHaveBeenCalled();
  first.client.close();
  second.client.close();
});

it.each([0, 2])("RPC initialize 版本 %i 不兼容停止且正确提示", async (version) => {
  const identity = await generateIdentity({ extractable: false });
  const [transport] = createMemoryFramePair();
  const [server, client] = createMemoryTransportPair();
  server.onLine((line) => {
    const request = JSON.parse(line) as { id: number };
    server.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32004,
          message: `协议版本不一致：客户端 1，服务端 ${version}`,
          data: { code: "protocol_version_mismatch" },
        },
      }),
    );
  });
  const relay: DeviceRelay = {
    online: true,
    transport,
    onClose: vi.fn(),
    subscribePush: vi.fn(),
    unsubscribePush: vi.fn(),
    onHostOnline: (fn) => {
      queueMicrotask(fn);
    },
  };
  const c = new PhoneConnection({
    identity,
    host: { hostId: identity.id, hostPub: encode(identity.publicKey), name: "电脑", pairedAt: 1 },
    origin: "https://relay.example",
    changed: vi.fn(),
    connected: vi.fn(),
    disconnected: vi.fn(),
    connect: () => Promise.resolve(relay),
    channel: () =>
      Promise.resolve({ ...client, closeReason: undefined, flush: () => Promise.resolve() }),
  });
  c.start();
  await vi.waitFor(() => expect(c.state).toBe("incompatible"));
  expect(c.message).toBe(versionMessage(version));
  c.stop();
  server.close();
});

it("真实配对回复指纹错配拒绝且不保存电脑", async () => {
  const identity = await generateIdentity({ extractable: true });
  const offer = await createPairingOffer(identity, "AAAAAAAAAAAAAAAAAAAAAA");
  const parsed = parsePairingLink(offer.fragment, "https://relay.example");
  parsed.hostFingerprint[0] = (parsed.hostFingerprint[0] ?? 0) ^ 1;
  const [phone, computer] = createMemoryFramePair();
  computer.onFrame((frame) => {
    void acceptPairingHello(identity, offer.secret, frame).then(({ reply }) => {
      computer.send(reply);
    });
  });
  const storage = memoryStorage();
  await expect(
    pairPhone(storage, parsed, "https://relay.example", "手机", () => Promise.resolve(phone)),
  ).rejects.toMatchObject({ code: "fingerprint_mismatch" });
  expect(await storage.hosts()).toEqual([]);
});

it("首页按项目分组：普通对话在首位，子代理不计数，项目页列出该项目会话", () => {
  expect(plainWorkspaceOf(String.raw`C:\Users\a\.nocturne\sessions`)).toBe(
    String.raw`C:\Users\a\.nocturne\workspace`,
  );
  expect(plainWorkspaceOf("/home/a/.nocturne/sessions/")).toBe("/home/a/.nocturne/workspace");
  expect(plainWorkspaceOf(undefined)).toBeUndefined();
  const base = {
    createdAt: "2026-10-01T00:00:00.000Z",
    model: { provider: "fake", model: "fake-1" },
  };
  const list = [
    { ...base, id: "a", cwd: "Z:/work", workspaceRoot: "Z:/work", mtimeMs: 10, firstText: "甲" },
    { ...base, id: "b", cwd: "Z:/work", workspaceRoot: "Z:/work", mtimeMs: 30, firstText: "乙" },
    { ...base, id: "c", cwd: "Z:/old", workspaceRoot: "Z:/old", mtimeMs: 20, firstText: "丙" },
    {
      ...base,
      id: "d",
      cwd: "Z:/home/workspace",
      workspaceRoot: "Z:/home/workspace",
      mtimeMs: 5,
      firstText: "闲聊",
    },
    {
      ...base,
      id: "e",
      cwd: "Z:/work",
      workspaceRoot: "Z:/work",
      mtimeMs: 40,
      parent: { sessionId: "a", callId: "x" },
    },
  ];
  const projects = phoneProjects(list, "Z:/home/workspace");
  expect(projects.map((p) => [p.name, p.count, p.plain])).toEqual([
    ["普通对话", 1, true],
    ["work", 2, false],
    ["old", 1, false],
  ]);
  expect(projects[1]?.latest).toBe(30);
  expect(projectSessions(list, "Z:/work", "Z:/home/workspace").map((r) => r.id)).toEqual([
    "b",
    "a",
  ]);
  expect(projectSessions(list, "Z:/home/workspace", "Z:/home/workspace").map((r) => r.id)).toEqual([
    "d",
  ]);
  const now = new Date(2026, 9, 15, 12).getTime();
  expect(shortDate(new Date(2026, 8, 3).getTime(), now)).toBe("09-03");
  expect(shortDate(new Date(2025, 8, 3).getTime(), now)).toBe("2025-09-03");
});

it("主题与断线诊断只存在手机本地，诊断最多保留 8 条", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  expect(loadTheme()).toBe("system");
  saveTheme("dark");
  expect(loadTheme()).toBe("dark");
  applyTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  applyTheme("system");
  expect(document.documentElement.dataset.theme).toBeUndefined();
  for (let i = 0; i < 10; i++) recordDisconnect("电脑 1", `原因 ${i}`, i);
  const log = loadDisconnects();
  expect(log).toHaveLength(8);
  expect(log[0]?.reason).toBe("原因 9");
  clearDisconnects();
  expect(loadDisconnects()).toEqual([]);
  expect(closeReason(4002)).toContain("离线");
  expect(closeReason(undefined)).not.toBe("");
});

it("改动摘要在订阅后与 Turn 结束时刷新；回退后刷新；分叉打开新会话", async () => {
  const [transport] = createMemoryTransportPair();
  const { createRpcClient } = await import("@nocturne/rpc/client");
  const client = createRpcClient(transport, { clientName: "test" });
  let emit: ((event: Parameters<Parameters<RpcSession["subscribe"]>[0]>[0]) => void) | undefined;
  const turn = { seq: 3, files: [], shellCalls: 0 };
  const session = {
    id: "s",
    subscribe: vi.fn(async (listener: typeof emit) => {
      emit = listener;
      return { lastSeq: 0, unsubscribe: vi.fn() };
    }),
    turnChanges: vi.fn(async () => [turn]),
    turnChangeDiff: vi.fn(async () => ({ diff: "" })),
    rewind: vi.fn(async () => undefined),
  } as unknown as RpcSession;
  const forked = {
    id: "f",
    subscribe: vi.fn(async () => ({ lastSeq: 0, unsubscribe: vi.fn() })),
    turnChanges: vi.fn(async () => []),
  } as unknown as RpcSession;
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  vi.spyOn(client.runtime, "resumeSession").mockImplementation(
    async (id) =>
      ({
        session: id === "f" ? forked : session,
        opened: { warnings: [] as string[] } as SessionOpened,
      }) as Awaited<ReturnType<RpcClient["runtime"]["resumeSession"]>>,
  );
  const fork = vi.spyOn(client.runtime, "forkSession").mockResolvedValue("f");
  const sessions = new PhoneSessions(vi.fn());
  await sessions.connected(client);
  const entry = await sessions.open("s");
  await vi.waitFor(() => {
    expect(entry.turnChanges.get(3)).toBe(turn);
  });
  expect(session.turnChanges).toHaveBeenCalledTimes(1);
  emit?.({
    sessionId: "s",
    seq: 1,
    time: new Date().toISOString(),
    turnId: "t",
    type: "turn.completed",
    payload: { reason: "completed", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
  } as never);
  await vi.waitFor(() => {
    expect(session.turnChanges).toHaveBeenCalledTimes(2);
  });
  await sessions.turnChangeDiff(entry, 3, "a.ts");
  await sessions.turnChangeDiff(entry, 3, "a.ts");
  expect(session.turnChangeDiff).toHaveBeenCalledTimes(1);

  await sessions.rewind(entry, 3, "files");
  expect(session.rewind).toHaveBeenCalledWith(3, "files");
  expect(session.turnChanges).toHaveBeenCalledTimes(3);

  const opened = await sessions.fork(entry, 3);
  expect(fork).toHaveBeenCalledWith("s", { targetSeq: 3 });
  expect(opened.session.id).toBe("f");
  expect(sessions.opened.get("f")?.workspace).toBe(entry.workspace);
  client.close();
});
