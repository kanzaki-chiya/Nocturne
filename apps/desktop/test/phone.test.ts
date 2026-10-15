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
import { createMemoryTransportPair, type RpcClient, type RpcSession } from "@nocturne/rpc/client";
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
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({ session, opened: {} } as Awaited<
    ReturnType<RpcClient["runtime"]["resumeSession"]>
  >);
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  const sessions = new PhoneSessions(vi.fn());
  const view = createSessionView();
  view.lastSeq = 12;
  sessions.opened.set("s", {
    session,
    client,
    workspace: "Z:/work",
    view,
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
  const create = vi
    .spyOn(client.runtime, "createSession")
    .mockResolvedValue({ session: created } as Awaited<
      ReturnType<RpcClient["runtime"]["createSession"]>
    >);
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
    return { session, opened: {} } as Awaited<ReturnType<RpcClient["runtime"]["resumeSession"]>>;
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
    return { session, opened: {} } as Awaited<ReturnType<RpcClient["runtime"]["resumeSession"]>>;
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
      ({ session: id === "f" ? forked : session, opened: {} }) as Awaited<
        ReturnType<RpcClient["runtime"]["resumeSession"]>
      >,
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
