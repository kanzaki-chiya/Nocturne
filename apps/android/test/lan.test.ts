import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptChannel,
  FRAME_TYPES,
  generateIdentity,
  type DeviceRelay,
  type FrameTransport,
  type Identity,
} from "@nocturne/remote";
import { RPC_PROTOCOL_VERSION, type RpcClient } from "@nocturne/rpc/client";
import { PhoneConnection } from "../../desktop/src/web/connection";
import { webPlatform } from "../../desktop/src/web/platform";
import { encode, type PairedHost } from "../../desktop/src/web/storage";
import { tauriHost } from "../src/host";
import {
  guardPreHandshakeTransport,
  LanPhoneConnection,
  memoryLanStore,
  normalizeLanEndpoints,
  OLD_RELAY_DRAIN_TIMEOUT_MS,
  type LanClock,
} from "../src/lan";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.restoreAllMocks();
});

class ManualClock implements LanClock {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { due: this.now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  }

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      let earliestId: number | undefined;
      let earliestDue = Infinity;
      for (const [id, entry] of this.timers) {
        if (entry.due <= target && entry.due < earliestDue) {
          earliestDue = entry.due;
          earliestId = id;
        }
      }
      if (earliestId === undefined) break;
      const entry = this.timers.get(earliestId);
      if (!entry) break;
      this.timers.delete(earliestId);
      this.now = entry.due;
      entry.fn();
    }
    this.now = target;
  }
}

function createMemoryFramePair(): [FrameTransport, FrameTransport] {
  let leftHandler: ((frame: Uint8Array) => void) | undefined;
  let rightHandler: ((frame: Uint8Array) => void) | undefined;
  let leftClose: (() => void) | undefined;
  let rightClose: (() => void) | undefined;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      leftClose?.();
      rightClose?.();
    });
  };

  return [
    {
      send(frame) {
        if (!closed) {
          const copy = new Uint8Array(frame);
          queueMicrotask(() => rightHandler?.(copy));
        }
      },
      onFrame(h) {
        leftHandler = h;
      },
      onClose(h) {
        leftClose = h;
      },
      close: closeBoth,
    },
    {
      send(frame) {
        if (!closed) {
          const copy = new Uint8Array(frame);
          queueMicrotask(() => leftHandler?.(copy));
        }
      },
      onFrame(h) {
        rightHandler = h;
      },
      onClose(h) {
        rightClose = h;
      },
      close: closeBoth,
    },
  ];
}

function makePairedHost(hostIdentity: Identity): PairedHost {
  return {
    origin: "https://relay.example",
    hostId: hostIdentity.id,
    hostPub: encode(hostIdentity.publicKey),
    name: "书房电脑",
    pairedAt: 1,
  };
}

interface FakeServerOptions {
  lanEndpoints?: () => string[];
  onInitializeDelay?: () => Promise<void>;
  customHandler?: (method: string, params: unknown) => Promise<unknown> | unknown;
}

/** 在给定 FrameTransport 上运行真实的电脑端 acceptChannel + 轻量 JSON-RPC 服务端 */
function serveEncryptedPeer(
  serverSide: FrameTransport,
  hostIdentity: Identity,
  allowedPhone: Identity,
  options: FakeServerOptions = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  let activeSecureClose: (() => void) | undefined;
  let notifyFn: ((method: string, params: unknown) => void) | undefined;

  const acceptedPromise = acceptChannel(serverSide, {
    identity: hostIdentity,
    lookupDevice: async (id) => (id === allowedPhone.id ? allowedPhone.publicKey : undefined),
  }).then((accepted) => {
    activeSecureClose = () => accepted.channel.close();
    notifyFn = (method, params) => {
      accepted.channel.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    };
    accepted.channel.onLine((line) => {
      void (async () => {
        const msg = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: unknown;
        };
        if (!msg.method) return;
        calls.push({ method: msg.method, params: msg.params });
        if (msg.id === undefined) return;

        if (msg.method === "initialize") {
          await options.onInitializeDelay?.();
          accepted.channel.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: RPC_PROTOCOL_VERSION,
                nocturneVersion: "0.39.1",
                capabilities: { push: false },
                sessionsDir: "/workspace/.nocturne/sessions",
              },
            }),
          );
          return;
        }
        if (msg.method === "remote.lanEndpoints") {
          accepted.channel.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { endpoints: options.lanEndpoints ? options.lanEndpoints() : [] },
            }),
          );
          return;
        }
        const customResult = options.customHandler
          ? await options.customHandler(msg.method, msg.params)
          : [];
        accepted.channel.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: customResult,
          }),
        );
      })();
    });
    return accepted;
  });

  // 防止被提前取消的中继握手触发 unhandled rejection
  void acceptedPromise.catch(() => undefined);

  return {
    calls,
    acceptedPromise,
    sendNotification: (method: string, params: unknown) => notifyFn?.(method, params),
    closeServer: () => {
      activeSecureClose?.();
      serverSide.close();
    },
  };
}

describe("安卓端局域网直连（ADR-0087）", () => {
  it("地址校验只保留 tcp://<私有网段 IPv4>:<端口>，丢弃 ws:// 与非私有地址", () => {
    expect(
      normalizeLanEndpoints([
        "tcp://192.168.1.5:41234",
        "tcp://10.0.2.2:9000/",
        "tcp://172.20.0.8:5000",
        "tcp://192.168.1.5:41234", // 重复去重
        "ws://192.168.1.5:41234",
        "wss://192.168.1.5:41234",
        "http://192.168.1.5:41234",
        "tcp://127.0.0.1:41234",
        "tcp://169.254.1.2:41234",
        "tcp://8.8.8.8:41234",
        "tcp://100.64.0.1:41234",
        "tcp://host.local:41234",
        "tcp://192.168.1.5:0",
        "tcp://192.168.1.5:70000",
        "tcp://192.168.1.5:41234/subpath",
      ]),
    ).toEqual(["tcp://192.168.1.5:41234", "tcp://10.0.2.2:9000", "tcp://172.20.0.8:5000"]);
  });

  it("5a. 存有可达直连地址时直连与中继同时发起：直连胜出，同时发起的中继连接被关闭且不触发重试", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore({
      [hostIdentity.id]: ["tcp://192.168.1.99:41000", "tcp://192.168.1.5:41000"],
    });

    // 慢候选挂起，快候选立即完成握手
    const [slowClientSide] = createMemoryFramePair();
    const slowClosed = vi.spyOn(slowClientSide, "close");

    const [fastClientSide, fastServerSide] = createMemoryFramePair();
    const peer = serveEncryptedPeer(fastServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:41000"],
    });

    // 同时发起的中继连接处于挂起等待握手状态，验证直连胜出后它被立即关闭且不触发断线回调或重试
    const [relayPhoneSide] = createMemoryFramePair();
    const relayTransportClose = vi.spyOn(relayPhoneSide, "close");
    let relayCloseCb: ((code: number) => void) | undefined;
    relayPhoneSide.onClose(() => {
      relayCloseCb?.(1000);
    });
    const relay: DeviceRelay = {
      online: true,
      transport: relayPhoneSide,
      onHostOnline: (fn) => fn(),
      subscribePush: vi.fn(),
      unsubscribePush: vi.fn(),
      onClose: (fn) => {
        relayCloseCb = fn;
      },
    };
    const connectRelay = vi.fn(async () => relay);
    const disconnected = vi.fn();

    let connectedClient: RpcClient | undefined;
    const conn = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store,
      connect: connectRelay,
      connectLan: async (url) =>
        url === "tcp://192.168.1.5:41000" ? fastClientSide : slowClientSide,
      changed: () => undefined,
      connected: async (client) => {
        connectedClient = client;
      },
      disconnected,
    });

    conn.start();
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    expect(conn.transportKind).toBe("lan");
    // 证明直连与中继确实同时发起
    expect(connectRelay).toHaveBeenCalledTimes(1);
    // 直连胜出后：其余直连候选与同时发起的中继连接都被关闭，且不触发 disconnected 或二次重试
    expect(slowClosed).toHaveBeenCalled();
    expect(relayTransportClose).toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    expect(connectRelay).toHaveBeenCalledTimes(1);

    if (!connectedClient) throw new Error("expected connectedClient");
    const sessions = await connectedClient.call("runtime.listSessions", {});
    expect(sessions).toEqual([]);
    expect(peer.calls.some((c) => c.method === "runtime.listSessions")).toBe(true);
    conn.stop();
  });

  it("5b. 地址不可达时不推进时钟中继就能直接上线（无回退等待）；无地址时只连中继", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const clock = new ManualClock();
    const store = memoryLanStore();

    const makeRelay = (endpoints: string[] = []) => {
      const [phoneSide, serverSide] = createMemoryFramePair();
      serveEncryptedPeer(serverSide, hostIdentity, phoneIdentity, {
        lanEndpoints: () => endpoints,
      });
      let onCloseCb: ((code: number) => void) | undefined;
      phoneSide.onClose(() => onCloseCb?.(1006));
      const relay: DeviceRelay = {
        online: true,
        transport: phoneSide,
        onHostOnline: (fn) => fn(),
        subscribePush: vi.fn(),
        unsubscribePush: vi.fn(),
        onClose: (fn) => {
          onCloseCb = fn;
        },
      };
      return { relay, phoneSide };
    };

    // 1) 无缓存地址时：只连中继，connectLan 不调用
    {
      const { relay } = makeRelay([]);
      const connectRelay = vi.fn(async () => relay);
      const connectLan = vi.fn();
      const conn = new LanPhoneConnection({
        origin: "https://relay.example",
        identity: phoneIdentity,
        host: makePairedHost(hostIdentity),
        endpointStore: store,
        clock,
        connect: connectRelay,
        connectLan,
        changed: () => undefined,
        connected: async () => undefined,
        disconnected: () => undefined,
      });
      conn.start();
      await vi.waitFor(() => expect(conn.state).toBe("online"));
      expect(connectLan).not.toHaveBeenCalled();
      expect(connectRelay).toHaveBeenCalledTimes(1);
      conn.stop();
    }

    // 2) 存有不可达地址（直连一直挂起）时：完全不推进 ManualClock，中继直接完成握手上线
    store.set(hostIdentity.id, ["tcp://192.168.1.99:42000"]);
    const [blackholePhone] = createMemoryFramePair();
    const { relay: liveRelay } = makeRelay(["tcp://192.168.1.99:42000"]);
    const connectRelay2 = vi.fn(async () => liveRelay);
    const connectLan2 = vi.fn(async () => blackholePhone);

    const conn2 = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store,
      clock,
      connect: connectRelay2,
      connectLan: connectLan2,
      changed: () => undefined,
      connected: async () => undefined,
      disconnected: () => undefined,
    });

    conn2.start();
    // 注意此处未调用任何 clock.advance(...)，clock.now 始终为 0
    await vi.waitFor(() => expect(conn2.state).toBe("online"));
    expect(clock.now).toBe(0);
    expect(connectLan2).toHaveBeenCalledTimes(1);
    expect(connectRelay2).toHaveBeenCalledTimes(1);
    expect(conn2.transportKind).toBe("relay");
    conn2.stop();
  });

  it("5c. 经中继连上后取直连地址并后台升级到直连：升级前在途调用与切换期排队调用均正常返回、电脑端各只收到一次，且旧连接等在途落定后再关", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore();
    const clock = new ManualClock();

    let releaseDirectInit!: () => void;
    let notifyDirectInitEntered!: () => void;
    const directInitEntered = new Promise<void>((r) => {
      notifyDirectInitEntered = r;
    });
    const directInitBarrier = new Promise<void>((r) => {
      releaseDirectInit = r;
    });

    let releaseInflightOnRelay!: () => void;
    let notifyInflightArrivedOnRelay!: () => void;
    const inflightArrivedOnRelay = new Promise<void>((r) => {
      notifyInflightArrivedOnRelay = r;
    });
    const inflightRelayBarrier = new Promise<void>((r) => {
      releaseInflightOnRelay = r;
    });

    let pauseLanProbe!: () => void;
    const lanProbeGate = new Promise<void>((r) => {
      pauseLanProbe = r;
    });

    const submitExecutions: string[] = [];

    // 中继侧加密对端：下发直连地址 tcp://192.168.1.5:43000
    const [relayPhoneSide, relayServerSide] = createMemoryFramePair();
    const relayCloseSpy = vi.spyOn(relayPhoneSide, "close");
    serveEncryptedPeer(relayServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:43000"],
      customHandler: async (method, params) => {
        if (method === "session.submit") {
          submitExecutions.push(`relay:${JSON.stringify(params)}`);
          notifyInflightArrivedOnRelay();
          await inflightRelayBarrier;
          return { via: "relay-inflight-ok" };
        }
        return [];
      },
    });
    const relay: DeviceRelay = {
      online: true,
      transport: relayPhoneSide,
      onHostOnline: (fn) => fn(),
      subscribePush: vi.fn(),
      unsubscribePush: vi.fn(),
      onClose: () => undefined,
    };

    // 直连侧加密对端
    const [directPhoneSide, directServerSide] = createMemoryFramePair();
    serveEncryptedPeer(directServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:43000"],
      onInitializeDelay: async () => {
        notifyDirectInitEntered();
        await directInitBarrier;
      },
      customHandler: (method, params) => {
        if (method === "session.submit") {
          submitExecutions.push(`lan:${JSON.stringify(params)}`);
          return { via: "lan-queued-ok" };
        }
        return [{ id: "restored-on-lan" }];
      },
    });

    const connectedCalls: { hasRelay: boolean }[] = [];
    let appClient: RpcClient | undefined;
    const disconnected = vi.fn();

    const conn = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store,
      clock,
      connect: async () => relay,
      connectLan: async () => {
        await lanProbeGate;
        return directPhoneSide;
      },
      changed: () => undefined,
      connected: async (client, r) => {
        connectedCalls.push({ hasRelay: r !== undefined });
        appClient = client;
        await client.runtime.listSessions();
      },
      disconnected,
    });

    conn.start();
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    if (!appClient) throw new Error("expected appClient");

    // 1) 升级切换开始前，在中继上发出一条在途调用（服务端暂不返回响应）
    const inflightBeforeUpgrade = appClient.call("session.submit", {
      sessionId: "sess-1",
      text: "升级前已在途的消息",
    });
    await inflightArrivedOnRelay;

    // 2) 放行后台直连探测进入切换窗口（directClient.initialize 正在进行）
    pauseLanProbe();
    await directInitEntered;
    expect(store.get(hostIdentity.id)).toEqual(["tcp://192.168.1.5:43000"]);

    // 3) 在切换窗口期再发一条排队调用
    const queuedDuringCutover = appClient.call("session.submit", {
      sessionId: "sess-1",
      text: "切换期间排队的消息",
    });

    // 4) 放行直连 initialize 完成恢复与切换
    releaseDirectInit();
    await expect(queuedDuringCutover).resolves.toEqual({ via: "lan-queued-ok" });
    await vi.waitFor(() => expect(conn.transportKind).toBe("lan"));

    // 此时升级前那条中继在途调用尚未返回，旧中继连接必须保持开启等待其落定
    expect(relayCloseSpy).not.toHaveBeenCalled();

    // 5) 放行旧中继上的在途响应：该调用正常 resolve、电脑端只收到一次，随后旧中继自动关闭
    releaseInflightOnRelay();
    await expect(inflightBeforeUpgrade).resolves.toEqual({ via: "relay-inflight-ok" });
    await vi.waitFor(() => expect(relayCloseSpy).toHaveBeenCalled());

    expect(connectedCalls).toEqual([{ hasRelay: true }, { hasRelay: false }]);
    expect(submitExecutions).toEqual([
      `relay:${JSON.stringify({ sessionId: "sess-1", text: "升级前已在途的消息" })}`,
      `lan:${JSON.stringify({ sessionId: "sess-1", text: "切换期间排队的消息" })}`,
    ]);
    expect(disconnected).not.toHaveBeenCalled();
    conn.stop();
  });

  it("5d. 同时发起时中继先上线、直连随后握手成功：自动切到直连，期间在途调用正常返回且电脑端只收到一次；超时 5 秒兜底关闭旧连接", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const clock = new ManualClock();
    const store = memoryLanStore({
      [hostIdentity.id]: ["tcp://192.168.1.5:43500"],
    });

    let releaseSlowLan!: () => void;
    const slowLanGate = new Promise<void>((r) => {
      releaseSlowLan = r;
    });

    let releaseRelayInflight!: () => void;
    let notifyRelayInflight!: () => void;
    const relayInflightEntered = new Promise<void>((r) => {
      notifyRelayInflight = r;
    });
    const relayInflightGate = new Promise<void>((r) => {
      releaseRelayInflight = r;
    });

    const receivedCalls: string[] = [];

    const [relayPhoneSide, relayServerSide] = createMemoryFramePair();
    const relayCloseSpy = vi.spyOn(relayPhoneSide, "close");
    serveEncryptedPeer(relayServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:43500"],
      customHandler: async (method, params) => {
        if (method === "session.submit") {
          receivedCalls.push(`relay:${JSON.stringify(params)}`);
          notifyRelayInflight();
          await relayInflightGate;
          return { delivered: true };
        }
        return [];
      },
    });
    const relay: DeviceRelay = {
      online: true,
      transport: relayPhoneSide,
      onHostOnline: (fn) => fn(),
      subscribePush: vi.fn(),
      unsubscribePush: vi.fn(),
      onClose: () => undefined,
    };

    const [directPhoneSide, directServerSide] = createMemoryFramePair();
    serveEncryptedPeer(directServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:43500"],
      customHandler: (method, params) => {
        if (method === "session.submit") {
          receivedCalls.push(`lan:${JSON.stringify(params)}`);
          return { delivered: true };
        }
        return [];
      },
    });

    const connectLan = vi.fn(async () => {
      await slowLanGate;
      return directPhoneSide;
    });

    let appClient: RpcClient | undefined;
    const conn = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store,
      clock,
      connect: async () => relay,
      connectLan,
      changed: () => undefined,
      connected: async (client) => {
        appClient = client;
      },
      disconnected: () => undefined,
    });

    conn.start();
    // 中继不等慢直连，立即先上线
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    expect(conn.transportKind).toBe("relay");
    // 同一时刻只允许一个直连尝试在进行：上线后 fetchEndpointsAndMaybeUpgrade 不会重复发起第二次 connectLan
    expect(connectLan).toHaveBeenCalledTimes(1);

    if (!appClient) throw new Error("expected appClient");
    const inflightCall = appClient.call("session.submit", {
      sessionId: "sess-parallel",
      text: "中继在线期间提交的消息",
    });
    await relayInflightEntered;

    // 随后初始那条直连完成握手 -> 自动走升级路径切到直连
    releaseSlowLan();
    await vi.waitFor(() => expect(conn.transportKind).toBe("lan"));
    expect(connectLan).toHaveBeenCalledTimes(1);

    // 在途请求尚未返回，推进 4999ms 时旧中继仍未强关
    clock.advance(OLD_RELAY_DRAIN_TIMEOUT_MS - 1);
    expect(relayCloseSpy).not.toHaveBeenCalled();

    // 在 5 秒内响应正常返回：调用 resolve，电脑端只收到一次，旧中继立即关闭
    releaseRelayInflight();
    await expect(inflightCall).resolves.toEqual({ delivered: true });
    await vi.waitFor(() => expect(relayCloseSpy).toHaveBeenCalled());
    expect(receivedCalls).toEqual([
      `relay:${JSON.stringify({ sessionId: "sess-parallel", text: "中继在线期间提交的消息" })}`,
    ]);

    // 再单独验证若旧中继在途请求超过 5 秒未响应，时钟到 5000ms 时强制关闭旧连接
    conn.stop();

    let notifyHungInflight!: () => void;
    const hungInflightEntered = new Promise<void>((r) => {
      notifyHungInflight = r;
    });
    const [relayPhone2, relayServer2] = createMemoryFramePair();
    const relayCloseSpy2 = vi.spyOn(relayPhone2, "close");
    serveEncryptedPeer(relayServer2, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:43501"],
      customHandler: async (method) => {
        if (method === "session.submit") {
          notifyHungInflight();
          await new Promise<void>(() => undefined);
        }
        return [];
      },
    });
    let releaseLan2!: () => void;
    const lanGate2 = new Promise<void>((r) => {
      releaseLan2 = r;
    });
    const [directPhone2, directServer2] = createMemoryFramePair();
    serveEncryptedPeer(directServer2, hostIdentity, phoneIdentity);

    const store2 = memoryLanStore({ [hostIdentity.id]: ["tcp://192.168.1.5:43501"] });
    let client2: RpcClient | undefined;
    const conn2 = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store2,
      clock,
      connect: async () => ({
        online: true,
        transport: relayPhone2,
        onHostOnline: (fn) => fn(),
        subscribePush: vi.fn(),
        unsubscribePush: vi.fn(),
        onClose: () => undefined,
      }),
      connectLan: async () => {
        await lanGate2;
        return directPhone2;
      },
      changed: () => undefined,
      connected: async (c) => {
        client2 = c;
      },
      disconnected: () => undefined,
    });
    conn2.start();
    await vi.waitFor(() => expect(conn2.state).toBe("online"));
    if (!client2) throw new Error("expected client2");
    const hungCall = client2.call("session.submit", { sessionId: "s", text: "hung" });
    void hungCall.catch(() => undefined);
    await hungInflightEntered;

    releaseLan2();
    await vi.waitFor(() => expect(conn2.transportKind).toBe("lan"));
    expect(relayCloseSpy2).not.toHaveBeenCalled();

    clock.advance(OLD_RELAY_DRAIN_TIMEOUT_MS);
    await vi.waitFor(() => expect(relayCloseSpy2).toHaveBeenCalled());
    conn2.stop();
  });

  it("6. 对公钥不符的地址验签失败即放弃、绝不发送任何数据帧，地址列表更新前不重试；发送失败同步关闭 Rust 连接", async () => {
    const genuineHost = await generateIdentity({ extractable: true });
    const imposterHost = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore({
      [genuineHost.id]: ["tcp://192.168.1.66:44000"],
    });

    // 传输守卫单测：未完成握手前主动拒绝任何 data 帧
    const [rawA] = createMemoryFramePair();
    const rawASent: Uint8Array[] = [];
    rawA.onFrame(() => undefined);
    const origSend = rawA.send.bind(rawA);
    rawA.send = (frame) => {
      rawASent.push(new Uint8Array(frame));
      origSend(frame);
    };
    const guarded = guardPreHandshakeTransport(rawA);
    expect(() => guarded.transport.send(new Uint8Array([FRAME_TYPES.data, 0, 1, 2]))).toThrow();
    expect(rawASent).toEqual([]);

    // 验证 tauriHost.connectLan 在 plugin:lan-tcp|send 被拒绝时同时调用 plugin:lan-tcp|close 关闭 Rust 侧连接
    const ipcCalls: { cmd: string; args: unknown }[] = [];
    vi.stubGlobal("__TAURI_INTERNALS__", {
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      invoke: async (cmd: string, args: unknown) => {
        ipcCalls.push({ cmd, args });
        if (cmd === "plugin:lan-tcp|connect") return 77;
        if (cmd === "plugin:lan-tcp|send") throw new Error("send rejected");
        return null;
      },
    });
    const nativeTransport = await tauriHost.connectLan?.("tcp://192.168.1.5:44000");
    if (!nativeTransport) throw new Error("expected tauriHost.connectLan");
    const nativeClosed = new Promise<void>((r) => nativeTransport.onClose(r));
    nativeTransport.send(new Uint8Array([FRAME_TYPES.init, 1, 2, 3]));
    await nativeClosed;
    await vi.waitFor(() =>
      expect(ipcCalls.some((c) => c.cmd === "plugin:lan-tcp|close")).toBe(true),
    );
    expect(ipcCalls.find((c) => c.cmd === "plugin:lan-tcp|close")?.args).toEqual({ id: 77 });

    // 伪造主机用 imposterHost 私钥签发 hs.resp，手机持有 genuineHost 公钥
    const sentToImposter: Uint8Array[] = [];
    let imposterAttempts = 0;

    const makeImposterTransport = () => {
      imposterAttempts++;
      const [phoneSide, serverSide] = createMemoryFramePair();
      const realSend = phoneSide.send.bind(phoneSide);
      phoneSide.send = (frame) => {
        sentToImposter.push(new Uint8Array(frame));
        realSend(frame);
      };
      void acceptChannel(serverSide, {
        identity: imposterHost,
        lookupDevice: async () => phoneIdentity.publicKey,
      }).catch(() => {
        serverSide.close();
      });
      return phoneSide;
    };

    const relayEndpointsToReturn: string[] = ["tcp://192.168.1.66:44000"];
    const makeGenuineRelay = () => {
      const [phoneSide, serverSide] = createMemoryFramePair();
      let closeCb: ((code: number) => void) | undefined;
      phoneSide.onClose(() => closeCb?.(1006));
      serveEncryptedPeer(serverSide, genuineHost, phoneIdentity, {
        lanEndpoints: () => relayEndpointsToReturn,
      });
      const relay: DeviceRelay = {
        online: true,
        transport: phoneSide,
        onHostOnline: (fn) => fn(),
        subscribePush: vi.fn(),
        unsubscribePush: vi.fn(),
        onClose: (fn) => {
          closeCb = fn;
        },
      };
      return relay;
    };

    let currentRelay = makeGenuineRelay();
    const clock = new ManualClock();
    const conn = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(genuineHost),
      endpointStore: store,
      clock,
      random: () => 0.5,
      connect: async () => currentRelay,
      connectLan: async () => makeImposterTransport(),
      changed: () => undefined,
      connected: async () => undefined,
      disconnected: () => undefined,
    });

    conn.start();
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    await vi.waitFor(() => expect(imposterAttempts).toBe(1));
    expect(conn.transportKind).toBe("relay");
    // 手机对伪造者绝未发过任何 data 帧或 hs.fin 帧
    for (const frame of sentToImposter) {
      expect(frame[0]).not.toBe(FRAME_TYPES.data);
      expect(frame[0]).not.toBe(FRAME_TYPES.finish);
    }

    // 断线重连且地址列表未更新：不再重试已被判公钥不符的 tcp://192.168.1.66:44000
    const nextRelay = makeGenuineRelay();
    const oldRelay = currentRelay;
    currentRelay = nextRelay;
    oldRelay.transport.close();
    clock.advance(1000);
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    expect(imposterAttempts).toBe(1);
    conn.stop();
  });

  it("7. 网页版构建产物与运行时路径不包含局域网直连代码路径", async () => {
    expect(webPlatform.createConnection).toBeUndefined();

    // 真实打包网页版入口 web.html（内存构建），检查全部 JS 产物不含直连代码路径
    const here = path.dirname(fileURLToPath(import.meta.url));
    const desktopDir = path.resolve(here, "../../desktop");
    const bundled = await viteBuild({
      root: desktopDir,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        rollupOptions: { input: path.join(desktopDir, "web.html") },
      },
    });
    const outputs = Array.isArray(bundled) ? bundled : [bundled];
    let jsChunkCount = 0;
    for (const result of outputs) {
      if (!("output" in result)) continue;
      for (const item of result.output) {
        if (item.type !== "chunk") continue;
        jsChunkCount++;
        expect(item.code).not.toContain("LanPhoneConnection");
        expect(item.code).not.toContain("plugin:lan-tcp");
        expect(item.code).not.toContain("nocturne.lan.endpoints");
        expect(item.code).not.toContain("tcp://");
      }
    }
    expect(jsChunkCount).toBeGreaterThan(0);

    // 验证网页版 PhoneConnection 只调用中继连接，无任何直连分支
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const [phoneSide, serverSide] = createMemoryFramePair();
    serveEncryptedPeer(serverSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["tcp://192.168.1.5:45000"],
    });
    const connectRelay = vi.fn(async (): Promise<DeviceRelay> => ({
      online: true,
      transport: phoneSide,
      onHostOnline: (fn) => fn(),
      subscribePush: vi.fn(),
      unsubscribePush: vi.fn(),
      onClose: () => undefined,
    }));
    const webConn = new PhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      connect: connectRelay,
      changed: () => undefined,
      connected: async () => undefined,
      disconnected: () => undefined,
    });
    webConn.start();
    await vi.waitFor(() => expect(webConn.state).toBe("online"));
    expect(connectRelay).toHaveBeenCalledTimes(1);
    webConn.stop();
  });
});
