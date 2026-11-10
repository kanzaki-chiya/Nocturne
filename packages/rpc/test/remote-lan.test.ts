import { createHash, randomBytes } from "node:crypto";
import { createServer as createTcpServer, connect as connectRawTcp } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore, createPlatform, createRuntime, FakeProvider } from "@nocturne/core";
import {
  connectLanWebSocket,
  createMemoryTransportPair,
  createRpcServer,
  isPrivateLanIPv4,
  isPrivateRemoteAddress,
  type ListenLanDirectOptions,
} from "@nocturne/rpc/server";
import { createRpcClient } from "@nocturne/rpc/client";
import {
  connectChannel,
  createMemoryFramePair,
  createPairingHello,
  finishPairing,
  FRAME_TYPES,
  generateIdentity,
  MAX_FRAME,
  parsePairingFragment,
  type HostRelay,
  type RelayConnection,
  type RelayDevice,
} from "@nocturne/remote";
import { loadRegistration } from "../src/server/remote/storage.js";
import { until } from "./harness.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const invite = "nocturne-invite:relay.example/AAAAAAAAAAAAAAAAAAAAAAAA";
const homes: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function createHostHarness(
  options: {
    home?: string;
    credentials?: Awaited<ReturnType<typeof createCredentialStore>>["store"];
    initialDevices?: RelayDevice[];
    addresses?: () => readonly string[];
    addressPollMs?: number;
    lanHandshakeTimeoutMs?: number;
    maxHandshaking?: number;
    maxConnections?: number;
    resolveRemoteAddress?: ListenLanDirectOptions["resolveRemoteAddress"];
  } = {},
) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "remote-lan-")));
  if (!options.home) homes.push(home);
  const credentials =
    options.credentials ??
    (await createCredentialStore(createPlatform(), home, { backend: "memory" })).store;

  let connectionHandler: ((c: RelayConnection) => void) | undefined;
  let devices: RelayDevice[] = [...(options.initialDevices ?? [])];
  const acceptedLan: { deviceId: string; remoteAddress: string; port: number }[] = [];

  const relay: HostRelay = {
    onConnection: (fn) => {
      connectionHandler = fn;
    },
    onClose: () => undefined,
    close: vi.fn(),
    openPairingSlot: vi.fn(() =>
      Promise.resolve({ slot: "AAAAAAAAAAAAAAAAAAAAAA", expiresAt: Date.now() + 300_000 }),
    ),
    allowDevice: vi.fn((d) => {
      devices.push({
        id: d.id,
        name: d.name,
        createdAt: Date.now(),
        lastSeenAt: null,
        online: false,
        push: false,
      });
      return Promise.resolve();
    }),
    removeDevice: vi.fn((id) => {
      devices = devices.filter((d) => d.id !== id);
      return Promise.resolve();
    }),
    listDevices: vi.fn(() => Promise.resolve(devices)),
    push: vi.fn(() => Promise.resolve(0)),
    unregister: vi.fn(() => Promise.resolve()),
  };

  const connectRelay = vi.fn(() => Promise.resolve(relay));
  const register = vi.fn(({ identity }: { identity: { id: string } }) =>
    Promise.resolve({ hostId: identity.id }),
  );

  const server = createRpcServer({
    nocturneVersion: "0.39.1",
    remote: {
      home,
      credentials,
      connect: { connectHostRelay: connectRelay, registerHost: register },
      ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
      lan: {
        // 测试绑定 127.0.0.1 避免触发宿主机防火墙弹窗；0.0.0.0 默认行为另行覆盖
        host: "127.0.0.1",
        listAddresses: options.addresses ?? (() => ["192.168.1.5", "10.0.0.8"]),
        addressPollMs: options.addressPollMs ?? 0,
        ...(options.lanHandshakeTimeoutMs !== undefined
          ? { handshakeTimeoutMs: options.lanHandshakeTimeoutMs }
          : {}),
        ...(options.maxHandshaking !== undefined ? { maxHandshaking: options.maxHandshaking } : {}),
        ...(options.resolveRemoteAddress !== undefined
          ? { resolveRemoteAddress: options.resolveRemoteAddress }
          : {}),
        onAccepted: (info) => acceptedLan.push(info),
      },
    },
    createRuntime: async () => ({
      runtime: await createRuntime({
        cwd: home,
        sessionsDir: join(home, "sessions"),
        providers: [new FakeProvider({ scripts: [] })],
      }),
    }),
  });

  const [serverSide, clientSide] = createMemoryTransportPair();
  const served = server.serve(serverSide);
  const client = createRpcClient(clientSide, { clientName: "local" });
  const stop = async () => {
    client.close();
    await served;
  };
  cleanups.push(stop);
  await client.initialize();

  return {
    home,
    credentials,
    server,
    client,
    relay,
    connectRelay,
    acceptedLan,
    stop,
    setDevices: (next: RelayDevice[]) => {
      devices = next;
    },
    openRelayRoute: (route: RelayConnection) => {
      connectionHandler?.(route);
    },
  };
}

async function registerAndPair(h: Awaited<ReturnType<typeof createHostHarness>>) {
  await h.client.call("remote.register", { invite });
  await until(() => h.connectRelay.mock.calls.length > 0);
  await vi.waitFor(async () =>
    expect((await h.client.call("remote.describe", {})).connection).toBe("online"),
  );
  const offer = await h.client.call("remote.startPairing", {});
  const phone = await generateIdentity({ extractable: false });
  const parsed = parsePairingFragment(new URL(offer.url).hash);
  const hello = await createPairingHello(phone, parsed, "安卓测试机");
  const [phonePair, hostPair] = createMemoryFramePair();
  const replyPromise = new Promise<Uint8Array>((resolve) => phonePair.onFrame(resolve));
  h.openRelayRoute({ conn: 1, kind: "pair", slot: parsed.slot, transport: hostPair });
  phonePair.send(hello.message);
  const paired = await finishPairing(hello.state, await replyPromise);
  await vi.waitFor(async () =>
    expect((await h.client.call("remote.describe", {})).pairing).toBeUndefined(),
  );
  return { phone, hostPublicKey: paired.hostPublicKey, hostId: paired.hostId };
}

function extractPort(endpoint: string | undefined): number {
  if (!endpoint) throw new Error("expected endpoint");
  return Number(new URL(endpoint).port);
}

/** 建立原始 WebSocket TCP 连接，供构造超大帧或非法顺序帧测试服务端防御 */
function openRawWebSocket(port: number): Promise<{
  sendRawFrame: (headerAndBody: Buffer) => void;
  sendMaskedBinary: (payload: Uint8Array) => void;
  waitClosed: () => Promise<void>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = connectRawTcp({ host: "127.0.0.1", port });
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    let closed = false;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((r) => {
      resolveClosed = r;
    });
    socket.once("close", () => {
      closed = true;
      resolveClosed();
    });
    socket.once("error", (err) => {
      if (!closed) reject(err);
    });
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const idx = header.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.off("data", onData);
      // 持续排空后续收到的数据以便底层连接关闭事件及时到达
      socket.on("data", () => undefined);
      const text = header.subarray(0, idx).toString("latin1");
      if (!text.startsWith("HTTP/1.1 101") || !text.includes(expected)) {
        socket.destroy();
        reject(new Error(`升级失败: ${text}`));
        return;
      }
      resolve({
        sendRawFrame: (buf) => {
          if (!closed) socket.write(buf);
        },
        sendMaskedBinary: (payload) => {
          if (closed) return;
          const mask = randomBytes(4);
          const len = payload.byteLength;
          const head =
            len < 126
              ? Buffer.from([0x82, 0x80 | len])
              : Buffer.from([0x82, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
          const body = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) body[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
          socket.write(Buffer.concat([head, mask, body]));
        },
        waitClosed: () => closedPromise,
        close: () => {
          socket.destroy();
        },
      });
    };
    socket.on("data", onData);
    socket.once("connect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}

describe("电脑端局域网直连（ADR-0087）", () => {
  it("1. 电脑端监听 + 手机端直连，握手成功后完成 RPC 往返且受相同远程权限约束", async () => {
    const h = await createHostHarness();
    const { phone, hostPublicKey } = await registerAndPair(h);

    const status = await h.client.call("remote.setLanDirect", { enabled: true });
    expect(status.lanDirect).toBe(true);

    const { endpoints } = await h.client.call("remote.lanEndpoints", {});
    expect(endpoints).toHaveLength(2);
    const port = extractPort(endpoints[0]);
    expect(endpoints).toEqual([`ws://192.168.1.5:${port}`, `ws://10.0.0.8:${port}`]);

    const wsTransport = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(async () => wsTransport.close());
    const secure = await connectChannel(wsTransport, {
      identity: phone,
      hostPublicKey,
    });
    const remoteClient = createRpcClient(secure, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    cleanups.push(async () => remoteClient.close());

    const init = await remoteClient.initialize();
    expect(init.nocturneVersion).toBe("0.39.1");
    expect(await remoteClient.runtime.listSessions()).toEqual([]);
    expect(await remoteClient.call("remote.lanEndpoints", {})).toEqual({ endpoints });
    // 直连同样套用远程方法白名单：手机不能修改本机直连开关
    await expect(
      remoteClient.call("remote.setLanDirect", { enabled: false }),
    ).rejects.toMatchObject({ code: "remote_not_allowed" });

    const described = await h.client.call("remote.describe", {});
    expect(described.connections).toHaveLength(1);
    expect(described.connections[0]?.deviceId).toBe(phone.id);
    expect(described.devices.find((d) => d.id === phone.id)?.online).toBe(true);
    expect(h.acceptedLan[0]?.deviceId).toBe(phone.id);
  });

  it("2. 未知设备、已移除设备连入被拒；移除或断开设备时直连与中继两种连接一并断开；超设备连接上限被拒", async () => {
    const h = await createHostHarness({ maxConnections: 2 });
    const { phone, hostPublicKey } = await registerAndPair(h);
    await h.client.call("remote.setLanDirect", { enabled: true });
    const port = extractPort((await h.client.call("remote.lanEndpoints", {})).endpoints[0]);

    // 未知设备连入被 unknown_device 拒绝
    const stranger = await generateIdentity({ extractable: false });
    const strangerWs = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    await expect(
      connectChannel(strangerWs, { identity: stranger, hostPublicKey }),
    ).rejects.toMatchObject({ code: "unknown_device" });

    // 同一设备同时建立一条中继连接和一条局域网直连
    const [relayPhoneSide, relayHostSide] = createMemoryFramePair();
    h.openRelayRoute({ conn: 10, kind: "device", device: phone.id, transport: relayHostSide });
    const relayChannel = await connectChannel(relayPhoneSide, { identity: phone, hostPublicKey });
    const relayClient = createRpcClient(relayChannel, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    await relayClient.initialize();

    const lanWs = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    const lanChannel = await connectChannel(lanWs, { identity: phone, hostPublicKey });
    const lanClient = createRpcClient(lanChannel, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    await lanClient.initialize();

    // 已达 maxConnections=2，第三条连接握手后立即被关闭
    const extraWs = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    const extraClosed = new Promise<void>((resolve) => extraWs.onClose(resolve));
    const extraChannel = await connectChannel(extraWs, { identity: phone, hostPublicKey });
    const extraChannelClosed = new Promise<void>((resolve) => extraChannel.onClose(resolve));
    await Promise.race([extraClosed, extraChannelClosed]);

    // disconnectDevice 同时断开中继与直连
    await h.client.call("remote.disconnectDevice", { id: phone.id });
    await Promise.all([relayClient.closed, lanClient.closed]);

    // 重新建立中继 + 直连后测试 removeDevice：两种连接同时断开，之后再连被拒
    const [relayPhone2, relayHost2] = createMemoryFramePair();
    h.openRelayRoute({ conn: 11, kind: "device", device: phone.id, transport: relayHost2 });
    const relayClient2 = createRpcClient(
      await connectChannel(relayPhone2, { identity: phone, hostPublicKey }),
      { clientName: "nocturne-phone", interactive: true },
    );
    await relayClient2.initialize();

    const lanWs2 = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    const lanClient2 = createRpcClient(
      await connectChannel(lanWs2, { identity: phone, hostPublicKey }),
      { clientName: "nocturne-phone", interactive: true },
    );
    await lanClient2.initialize();

    await h.client.call("remote.removeDevice", { id: phone.id });
    await Promise.all([relayClient2.closed, lanClient2.closed]);

    // 已移除设备再次直连被拒
    const afterRemoveWs = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    await expect(
      connectChannel(afterRemoveWs, { identity: phone, hostPublicKey }),
    ).rejects.toMatchObject({ code: "unknown_device" });
  });

  it("3. 未认证防护：握手前数据帧、超大帧、握手超时、16 并发握手上限、非私有网段来源各自被关闭", async () => {
    // 先验证私有网段判定规则全集
    for (const allowed of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "192.168.1.5",
      "169.254.10.20",
      "127.0.0.1",
      "::1",
      "::ffff:192.168.1.5",
      "::ffff:10.0.2.2",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1%eth0",
    ]) {
      expect(isPrivateRemoteAddress(allowed), allowed).toBe(true);
    }
    for (const denied of [
      "",
      undefined,
      "8.8.8.8",
      "100.64.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.169.1.1",
      "::ffff:8.8.8.8",
      "2001:4860:4860::8888",
      "fec0::1",
    ]) {
      expect(isPrivateRemoteAddress(denied), String(denied)).toBe(false);
    }
    expect(isPrivateLanIPv4("192.168.1.5")).toBe(true);
    expect(isPrivateLanIPv4("127.0.0.1")).toBe(false);
    expect(isPrivateLanIPv4("169.254.1.2")).toBe(false);

    let simulatedAddress = "192.168.1.50";
    const h = await createHostHarness({
      lanHandshakeTimeoutMs: 120,
      resolveRemoteAddress: () => simulatedAddress,
    });
    const { phone, hostPublicKey } = await registerAndPair(h);
    await h.client.call("remote.setLanDirect", { enabled: true });
    const port = extractPort((await h.client.call("remote.lanEndpoints", {})).endpoints[0]);

    // (a) 握手前直接发送数据帧 -> 立即被关闭
    {
      const raw = await openRawWebSocket(port);
      raw.sendMaskedBinary(new Uint8Array([FRAME_TYPES.data, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
      await raw.waitClosed();
    }

    // (b) 握手前连发两帧（未等 hs.resp） -> 立即被关闭
    {
      const raw = await openRawWebSocket(port);
      const fakeInit = Buffer.concat([
        Buffer.from([FRAME_TYPES.init]),
        Buffer.from(JSON.stringify({ v: 1, id: phone.id, e: "x", n: "y" }), "utf8"),
      ]);
      raw.sendMaskedBinary(fakeInit);
      raw.sendMaskedBinary(fakeInit);
      await raw.waitClosed();
    }

    // (c) 超大帧（帧头声明 MAX_FRAME + 1 字节） -> 在读完负载前即被关闭
    {
      const raw = await openRawWebSocket(port);
      const header = Buffer.alloc(14);
      header[0] = 0x82; // FIN + binary
      header[1] = 0x80 | 127; // masked + 64-bit length
      header.writeBigUInt64BE(BigInt(MAX_FRAME + 1), 2);
      raw.sendRawFrame(header);
      await raw.waitClosed();
    }

    // (d) 握手超时 -> 连接升级后不发 hs.init，超时自动关闭
    {
      const raw = await openRawWebSocket(port);
      await raw.waitClosed();
    }

    // (e) 握手阶段并发上限 16：占满 16 条未完成握手的连接后，第 17 条立即被拒绝
    {
      const slow = await createHostHarness({ lanHandshakeTimeoutMs: 5_000 });
      await registerAndPair(slow);
      await slow.client.call("remote.setLanDirect", { enabled: true });
      const slowPort = extractPort(
        (await slow.client.call("remote.lanEndpoints", {})).endpoints[0],
      );
      const occupied = await Promise.all(
        Array.from({ length: 16 }, () => openRawWebSocket(slowPort)),
      );
      cleanups.push(async () => {
        for (const item of occupied) item.close();
      });
      await expect(connectLanWebSocket(`ws://127.0.0.1:${slowPort}`)).rejects.toThrow();
      const firstOccupied = occupied[0];
      if (!firstOccupied) throw new Error("expected occupied[0]");
      firstOccupied.close();
      await firstOccupied.waitClosed();
      // 释放一个槽位后可再次接入
      const recovered = await openRawWebSocket(slowPort);
      recovered.close();
      for (const item of occupied) item.close();
    }

    // (f) 非私有网段来源 -> 直接拒绝关闭
    simulatedAddress = "8.8.8.8";
    await expect(connectLanWebSocket(`ws://127.0.0.1:${port}`)).rejects.toThrow();

    // 切回私有网段后正常握手成功
    simulatedAddress = "192.168.1.50";
    const okWs = await connectLanWebSocket(`ws://127.0.0.1:${port}`);
    const okChannel = await connectChannel(okWs, { identity: phone, hostPublicKey });
    okChannel.close();
    okWs.close();
  });

  it("4. 默认关闭不监听；打开后端口写入设置并在重启后沿用、占用时重新分配；网卡变化经加密通道发通知", async () => {
    let currentAddresses = ["192.168.1.5"];
    const h1 = await createHostHarness({
      addresses: () => currentAddresses,
      addressPollMs: 25,
    });
    const { phone, hostPublicKey } = await registerAndPair(h1);
    const persistedRelayDevices: RelayDevice[] = [
      {
        id: phone.id,
        name: "安卓测试机",
        createdAt: 1,
        lastSeenAt: null,
        online: false,
        push: false,
      },
    ];

    // 默认关闭：不监听、地址列表为空
    expect((await h1.client.call("remote.describe", {})).lanDirect).toBe(false);
    expect(await h1.client.call("remote.lanEndpoints", {})).toEqual({ endpoints: [] });
    const savedInitial = JSON.parse(await readFile(join(h1.home, "remote.json"), "utf8")) as {
      lanDirect?: boolean;
      lanPort?: number;
    };
    expect(savedInitial.lanDirect).toBe(false);
    expect(savedInitial.lanPort).toBeUndefined();

    // 先建立一条中继加密连接，验证打开开关与地址变化通知只发给加密通道
    const [relayPhone, relayHost] = createMemoryFramePair();
    h1.openRelayRoute({ conn: 20, kind: "device", device: phone.id, transport: relayHost });
    const remoteClient = createRpcClient(
      await connectChannel(relayPhone, { identity: phone, hostPublicKey }),
      { clientName: "nocturne-phone", interactive: true },
    );
    await remoteClient.initialize();
    const remoteNotices: string[][] = [];
    const localNotices: unknown[] = [];
    remoteClient.onNotification("remote.lanEndpointsChanged", ({ endpoints }) => {
      remoteNotices.push(endpoints);
    });
    h1.client.onNotification("remote.lanEndpointsChanged", (payload) => {
      localNotices.push(payload);
    });

    // 打开局域网直连：分配端口并持久化写入 remote.json
    await h1.client.call("remote.setLanDirect", { enabled: true });
    const firstEndpoints = (await h1.client.call("remote.lanEndpoints", {})).endpoints;
    expect(firstEndpoints).toHaveLength(1);
    const firstPort = extractPort(firstEndpoints[0]);
    expect(firstPort).toBeGreaterThan(0);

    const loadedAfterOpen = await loadRegistration(h1.home);
    expect(loadedAfterOpen.registration?.lanDirect).toBe(true);
    expect(loadedAfterOpen.registration?.lanPort).toBe(firstPort);
    await vi.waitFor(() => expect(remoteNotices).toContainEqual([`ws://192.168.1.5:${firstPort}`]));
    expect(localNotices).toEqual([]);

    // 网卡地址变化时自动向加密通道发通知
    currentAddresses = ["192.168.1.5", "172.16.0.9"];
    await vi.waitFor(() =>
      expect(remoteNotices).toContainEqual([
        `ws://192.168.1.5:${firstPort}`,
        `ws://172.16.0.9:${firstPort}`,
      ]),
    );
    currentAddresses = ["192.168.1.5"];

    // 关闭开关时停止监听，返回空数组并通知加密通道
    await h1.client.call("remote.setLanDirect", { enabled: false });
    expect(await h1.client.call("remote.lanEndpoints", {})).toEqual({ endpoints: [] });
    await expect(connectLanWebSocket(`ws://127.0.0.1:${firstPort}`)).rejects.toThrow();

    // 再次打开沿用已记录的端口
    await h1.client.call("remote.setLanDirect", { enabled: true });
    expect(extractPort((await h1.client.call("remote.lanEndpoints", {})).endpoints[0])).toBe(
      firstPort,
    );
    remoteClient.close();
    await h1.stop();

    // 重启后台进程后沿用同一端口
    const h2 = await createHostHarness({
      home: h1.home,
      credentials: h1.credentials,
      initialDevices: persistedRelayDevices,
      addresses: () => currentAddresses,
    });
    await vi.waitFor(async () =>
      expect((await h2.client.call("remote.lanEndpoints", {})).endpoints).toEqual([
        `ws://192.168.1.5:${firstPort}`,
      ]),
    );
    await h2.stop();

    // 模拟原端口被其它进程占用 -> 重启后重新分配新端口并写回设置文件
    const blocker = createTcpServer();
    await new Promise<void>((resolve) => blocker.listen(firstPort, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        }),
    );

    currentAddresses = ["192.168.1.9"];
    const h3 = await createHostHarness({
      home: h1.home,
      credentials: h1.credentials,
      initialDevices: persistedRelayDevices,
      addresses: () => currentAddresses,
    });
    await vi.waitFor(async () =>
      expect((await h3.client.call("remote.lanEndpoints", {})).endpoints).toHaveLength(1),
    );
    const reassignedPort = extractPort(
      (await h3.client.call("remote.lanEndpoints", {})).endpoints[0],
    );
    expect(reassignedPort).not.toBe(firstPort);
    expect((await loadRegistration(h1.home)).registration?.lanPort).toBe(reassignedPort);

    // 关闭「允许远程访问」时停止监听并断开直连
    const directWs = await connectLanWebSocket(`ws://127.0.0.1:${reassignedPort}`);
    const directClient = createRpcClient(
      await connectChannel(directWs, { identity: phone, hostPublicKey }),
      { clientName: "nocturne-phone", interactive: true },
    );
    await directClient.initialize();
    await h3.client.call("remote.setEnabled", { enabled: false });
    await directClient.closed;
    expect(await h3.client.call("remote.lanEndpoints", {})).toEqual({ endpoints: [] });
  });
});
