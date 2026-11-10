import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptChannel,
  createMemoryFramePair,
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
import {
  guardPreHandshakeTransport,
  LAN_RACE_TIMEOUT_MS,
  LanPhoneConnection,
  memoryLanStore,
  type LanClock,
} from "../src/lan";

const here = path.dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class ManualClock implements LanClock {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { due: this.now + Math.max(0, ms), fn: callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
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

interface MiniRpcPeer {
  calls: { method: string; params: unknown }[];
  sendNotification: (method: string, params: unknown) => void;
  closeServer: () => void;
}

/** 在给定 FrameTransport 服务端侧跑真实 acceptChannel 握手 + JSON-RPC 应答 */
function serveEncryptedPeer(
  serverTransport: FrameTransport,
  hostIdentity: Identity,
  allowedPhone: Identity,
  options: {
    lanEndpoints?: () => string[];
    onInitializeDelay?: () => Promise<void>;
    customHandler?: (method: string, params: unknown) => unknown | Promise<unknown>;
  } = {},
): MiniRpcPeer {
  const calls: { method: string; params: unknown }[] = [];
  let sendLine: ((line: string) => void) | undefined;

  void acceptChannel(serverTransport, {
    identity: hostIdentity,
    lookupDevice: async (id) => (id === allowedPhone.id ? allowedPhone.publicKey : undefined),
  })
    .then(({ channel }) => {
      sendLine = (line) => channel.send(line);
      channel.onLine((line) => {
        void (async () => {
          const msg = JSON.parse(line) as { id?: number; method: string; params?: unknown };
          calls.push({ method: msg.method, params: msg.params });
          if (msg.id === undefined) return;
          if (msg.method === "initialize") {
            await options.onInitializeDelay?.();
            channel.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: RPC_PROTOCOL_VERSION,
                  nocturneVersion: "0.39.1",
                  sessionsDir: "/tmp/sessions",
                },
              }),
            );
            return;
          }
          if (msg.method === "remote.lanEndpoints") {
            channel.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { endpoints: options.lanEndpoints?.() ?? [] },
              }),
            );
            return;
          }
          const result = options.customHandler
            ? await options.customHandler(msg.method, msg.params)
            : [];
          channel.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        })();
      });
    })
    .catch(() => {
      serverTransport.close();
    });

  return {
    calls,
    sendNotification(method, params) {
      sendLine?.(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    closeServer() {
      serverTransport.close();
    },
  };
}

function makePairedHost(hostIdentity: Identity): PairedHost {
  return {
    hostId: hostIdentity.id,
    hostPub: encode(hostIdentity.publicKey),
    name: "书房电脑",
    origin: "https://relay.example",
    pairedAt: 1,
  };
}

describe("手机端局域网直连（apps/android，ADR-0087）", () => {
  it("5a. 存有多个直连地址且可达时并行竞速，首个握手成功者胜出并关闭其余候选，不连中继设备入口", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore();
    store.set(hostIdentity.id, ["ws://192.168.1.10:41000", "ws://192.168.1.5:41000"]);

    const [slowPhone, slowServer] = createMemoryFramePair();
    const slowCloseSpy = vi.spyOn(slowPhone, "close");
    // slowServer 不回包，模拟慢/挂起网卡
    void slowServer;

    const [fastPhone, fastServer] = createMemoryFramePair();
    const peer = serveEncryptedPeer(fastServer, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["ws://192.168.1.5:41000"],
      customHandler: (method) => (method === "runtime.listSessions" ? [{ id: "s1" }] : null),
    });

    const connectRelay = vi.fn();
    let connectedClient: RpcClient | undefined;

    const conn = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store,
      connect: connectRelay,
      connectLan: async (url) => (url.includes("192.168.1.5") ? fastPhone : slowPhone),
      changed: () => undefined,
      connected: async (client) => {
        connectedClient = client;
      },
      disconnected: () => undefined,
    });

    conn.start();
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    expect(conn.transportKind).toBe("lan");
    expect(connectRelay).not.toHaveBeenCalled();
    expect(slowCloseSpy).toHaveBeenCalled();

    if (!connectedClient) throw new Error("expected connectedClient");
    const sessions = await connectedClient.call("runtime.listSessions", {});
    expect(sessions).toEqual([{ id: "s1" }]);
    expect(peer.calls.some((c) => c.method === "runtime.listSessions")).toBe(true);
    conn.stop();
  });

  it("5b. 无地址直接走中继；存有不可达地址时精确在 1.5 秒（可注入时钟）关闭直连并回退中继，断开直连后重连仍遵同一顺序", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore();
    const clock = new ManualClock();

    const makeRelay = () => {
      const [phoneSide, serverSide] = createMemoryFramePair();
      const peer = serveEncryptedPeer(serverSide, hostIdentity, phoneIdentity);
      const relay: DeviceRelay = {
        online: true,
        transport: phoneSide,
        onHostOnline: (fn) => fn(),
        subscribePush: vi.fn(),
        unsubscribePush: vi.fn(),
        onClose: () => undefined,
      };
      return { relay, peer };
    };

    // 没存地址时：0ms 直接连接中继，不调 connectLan
    {
      const { relay } = makeRelay();
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

    // 存有不可达地址时：1499ms 内不连中继，推进到 1500ms 后关闭直连尝试并走中继
    store.set(hostIdentity.id, ["ws://192.168.1.99:42000"]);
    const [blackholePhone] = createMemoryFramePair();
    const blackholeClose = vi.spyOn(blackholePhone, "close");
    const { relay: fallbackRelay } = makeRelay();
    const connectRelay2 = vi.fn(async () => fallbackRelay);

    let lanReachable = false;
    const [laterLanPhone, laterLanServer] = createMemoryFramePair();
    const laterLanPeer = serveEncryptedPeer(laterLanServer, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["ws://192.168.1.99:42000"],
    });

    const disconnected = vi.fn();
    const conn2 = new LanPhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      endpointStore: store,
      clock,
      random: () => 0.5,
      connect: connectRelay2,
      connectLan: async () => (lanReachable ? laterLanPhone : blackholePhone),
      changed: () => undefined,
      connected: async () => undefined,
      disconnected,
    });

    conn2.start();
    await vi.waitFor(() => expect(blackholeClose).not.toHaveBeenCalled());
    clock.advance(LAN_RACE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(connectRelay2).not.toHaveBeenCalled();

    clock.advance(1);
    await vi.waitFor(() => expect(conn2.state).toBe("online"));
    expect(blackholeClose).toHaveBeenCalled();
    expect(connectRelay2).toHaveBeenCalledTimes(1);
    expect(conn2.transportKind).toBe("relay");

    // 重新存入地址并模拟 Wi-Fi 恢复后：中继断开触发重连，重连仍先走直连并胜出
    store.set(hostIdentity.id, ["ws://192.168.1.99:42000"]);
    lanReachable = true;
    fallbackRelay.transport.close();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    clock.advance(1000);
    await vi.waitFor(() => expect(conn2.state).toBe("online"));
    expect(conn2.transportKind).toBe("lan");
    expect(connectRelay2).toHaveBeenCalledTimes(1);

    // 直连断开时同样走现有重连逻辑
    laterLanPeer.closeServer();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(2));
    conn2.stop();
  });

  it("5c. 经中继连上后取直连地址并后台无缝升级到直连，升级期间排队的一次 RPC 调用不丢、不重复，且随后关闭中继连接", async () => {
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore();

    let releaseDirectInit!: () => void;
    let notifyDirectInitEntered!: () => void;
    const directInitEntered = new Promise<void>((r) => {
      notifyDirectInitEntered = r;
    });
    const directInitBarrier = new Promise<void>((r) => {
      releaseDirectInit = r;
    });

    const submitExecutions: string[] = [];

    // 中继侧加密对端：下发直连地址 ws://192.168.1.5:43000
    const [relayPhoneSide, relayServerSide] = createMemoryFramePair();
    const relayCloseSpy = vi.spyOn(relayPhoneSide, "close");
    const relayPeer = serveEncryptedPeer(relayServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["ws://192.168.1.5:43000"],
      customHandler: (method, params) => {
        if (method === "session.submit") {
          submitExecutions.push(`relay:${JSON.stringify(params)}`);
          return null;
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

    // 直连侧加密对端：在 initialize 处可控暂停，以便确定性模拟「升级切换窗口期间」的用户输入调用
    const [directPhoneSide, directServerSide] = createMemoryFramePair();
    const directPeer = serveEncryptedPeer(directServerSide, hostIdentity, phoneIdentity, {
      lanEndpoints: () => ["ws://192.168.1.5:43000"],
      onInitializeDelay: async () => {
        notifyDirectInitEntered();
        await directInitBarrier;
      },
      customHandler: (method, params) => {
        if (method === "session.submit") {
          submitExecutions.push(`lan:${JSON.stringify(params)}`);
          return null;
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
      connect: async () => relay,
      connectLan: async () => directPhoneSide,
      changed: () => undefined,
      connected: async (client, r) => {
        connectedCalls.push({ hasRelay: r !== undefined });
        appClient = client;
        // 模拟现有的重连恢复路径（拉取会话列表 / 恢复会话）
        await client.runtime.listSessions();
      },
      disconnected,
    });

    conn.start();
    // 等待先经中继上线并进入后台直连升级的切换窗口
    await directInitEntered;
    expect(store.get(hostIdentity.id)).toEqual(["ws://192.168.1.5:43000"]);

    // 在升级切换正在进行的窗口期，发起一次用户输入提交 RPC 调用
    if (!appClient) throw new Error("expected appClient");
    const queuedSubmit = appClient.call("session.submit", {
      sessionId: "sess-1",
      text: "切换期间发送的消息",
    });

    // 放行直连 initialize 完成恢复与切换
    releaseDirectInit();
    await expect(queuedSubmit).resolves.toBeNull();
    await vi.waitFor(() => expect(conn.transportKind).toBe("lan"));

    // 验证：1) 走重连恢复路径调用了第二次 connected（无 relay）；2) 排队的 RPC 精确执行一次且落在直连上；
    // 3) 旧中继设备连接已被关闭；4) 全程零断线闪烁（未触发 disconnected）
    expect(connectedCalls).toEqual([{ hasRelay: true }, { hasRelay: false }]);
    expect(submitExecutions).toEqual([
      `lan:${JSON.stringify({ sessionId: "sess-1", text: "切换期间发送的消息" })}`,
    ]);
    expect(relayPeer.calls.some((c) => c.method === "session.submit")).toBe(false);
    expect(directPeer.calls.some((c) => c.method === "session.submit")).toBe(true);
    expect(relayCloseSpy).toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();

    // 验证收到通知时也会更新存储
    directPeer.sendNotification("remote.lanEndpointsChanged", {
      endpoints: ["ws://192.168.1.88:43000"],
    });
    await vi.waitFor(() => expect(store.get(hostIdentity.id)).toEqual(["ws://192.168.1.88:43000"]));
    conn.stop();
  });

  it("6. 对公钥不符的地址验签失败即放弃，绝不发送任何数据帧，且在地址列表更新前不再重试该地址", async () => {
    const genuineHost = await generateIdentity({ extractable: true });
    const imposterHost = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const store = memoryLanStore();
    store.set(genuineHost.id, ["ws://192.168.1.66:44000"]);

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

    let relayEndpointsToReturn: string[] = ["ws://192.168.1.66:44000"];
    const makeGenuineRelay = () => {
      const [phoneSide, serverSide] = createMemoryFramePair();
      serveEncryptedPeer(serverSide, genuineHost, phoneIdentity, {
        lanEndpoints: () => relayEndpointsToReturn,
      });
      const relay: DeviceRelay = {
        online: true,
        transport: phoneSide,
        onHostOnline: (fn) => fn(),
        subscribePush: vi.fn(),
        unsubscribePush: vi.fn(),
        onClose: () => undefined,
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
    expect(conn.transportKind).toBe("relay");
    expect(imposterAttempts).toBe(1);
    // 手机对伪造者绝未发过任何 data 帧或 hs.fin 帧（只发过 hs.init 与可能的 hs.err）
    for (const frame of sentToImposter) {
      expect(frame[0]).not.toBe(FRAME_TYPES.data);
      expect(frame[0]).not.toBe(FRAME_TYPES.finish);
    }

    // 断线重连且地址列表未更新：不再重试已被判公钥不符的 ws://192.168.1.66:44000
    currentRelay.transport.close();
    currentRelay = makeGenuineRelay();
    await vi.waitFor(() => expect(conn.state).toBe("offline"));
    clock.advance(1000);
    await vi.waitFor(() => expect(conn.state).toBe("online"));
    expect(imposterAttempts).toBe(1);

    // 当加密通道下发了更新后的地址列表后，允许尝试新地址
    relayEndpointsToReturn = ["ws://192.168.1.77:44000"];
    currentRelay.transport.close();
    currentRelay = makeGenuineRelay();
    await vi.waitFor(() => expect(conn.state).toBe("offline"));
    clock.advance(1000);
    await vi.waitFor(() => expect(imposterAttempts).toBe(2));
    conn.stop();
  });

  it("7. 网页版构建产物与运行时路径不包含局域网直连，也不会发起 ws:// 直连连接", async () => {
    expect(webPlatform.createConnection).toBeUndefined();

    // 真实打包网页版入口 web.html（内存构建），检查全部 JS 产物不含直连代码路径
    const desktopDir = path.resolve(here, "../../desktop");
    const bundled = await viteBuild({
      root: desktopDir,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(desktopDir, "web.html"),
        },
      },
    });
    const outputs = Array.isArray(bundled) ? bundled : [bundled];
    let jsChunkCount = 0;
    for (const out of outputs) {
      if (!("output" in out)) continue;
      for (const item of out.output) {
        if (item.type !== "chunk") continue;
        jsChunkCount++;
        expect(item.code).not.toContain("LanPhoneConnection");
        expect(item.code).not.toContain("plugin:lan-ws");
        expect(item.code).not.toContain("nocturne.lan.endpoints");
        expect(item.code).not.toContain("guardPreHandshakeTransport");
        expect(item.code).not.toContain("ws://");
      }
    }
    expect(jsChunkCount).toBeGreaterThan(0);

    // 网页版 PhoneConnection 只调用 connectDeviceRelay，不发起任何 ws:// 直连
    const wsSpy = vi.fn();
    vi.stubGlobal("WebSocket", wsSpy);
    const hostIdentity = await generateIdentity({ extractable: true });
    const phoneIdentity = await generateIdentity({ extractable: false });
    const [phoneSide, serverSide] = createMemoryFramePair();
    serveEncryptedPeer(serverSide, hostIdentity, phoneIdentity);
    const relay: DeviceRelay = {
      online: true,
      transport: phoneSide,
      onHostOnline: (fn) => fn(),
      subscribePush: vi.fn(),
      unsubscribePush: vi.fn(),
      onClose: () => undefined,
    };
    const webConn = new PhoneConnection({
      origin: "https://relay.example",
      identity: phoneIdentity,
      host: makePairedHost(hostIdentity),
      connect: async () => relay,
      changed: () => undefined,
      connected: async () => undefined,
      disconnected: () => undefined,
    });
    webConn.start();
    await vi.waitFor(() => expect(webConn.state).toBe("online"));
    expect(wsSpy).not.toHaveBeenCalled();
    webConn.stop();
  });
});
