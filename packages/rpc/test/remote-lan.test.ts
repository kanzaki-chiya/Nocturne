import { createServer as createTcpServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore, createPlatform, createRuntime, FakeProvider } from "@nocturne/core";
import {
  connectChannel,
  createMemoryFramePair,
  createPairingHello,
  finishPairing,
  FRAME_TYPES,
  generateIdentity,
  MAX_FRAME,
  parsePairingFragment,
  type FrameTransport,
  type HostRelay,
  type RelayConnection,
  type RelayDevice,
} from "@nocturne/remote";
import { createRpcClient } from "../src/client/index.js";
import {
  createMemoryTransportPair,
  createRpcServer,
  encodeLengthPrefixedFrame,
  isPrivateLanIPv4,
  isPrivateRemoteAddress,
  listenLanDirect,
} from "../src/server/index.js";
import { loadRegistration } from "../src/server/remote/storage.js";
import { connectLanTcpClient, openRawLanTcp } from "./helpers/lan-tcp-client.js";

const INVITE = "nocturne-invite:relay.example/AAAAAAAAAAAAAAAAAAAAAAAA";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
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
    resolveRemoteAddress?: (socket: Socket) => string | undefined;
  } = {},
) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "nocturne-lan-")));
  if (!options.home) {
    cleanups.push(() => rm(home, { recursive: true, force: true }));
  }
  const credentials =
    options.credentials ??
    (await createCredentialStore(createPlatform(), home, { backend: "memory" })).store;

  const devices: RelayDevice[] = [...(options.initialDevices ?? [])];
  let routeHandler: ((conn: RelayConnection) => void) | undefined;
  const acceptedLan: { deviceId: string; remoteAddress: string; port: number }[] = [];

  const relay: HostRelay = {
    openPairingSlot: vi.fn(async () => ({
      slot: "AAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: Date.now() + 60_000,
    })),
    allowDevice: vi.fn(async ({ id, name }) => {
      const idx = devices.findIndex((d) => d.id === id);
      const next: RelayDevice = {
        id,
        name,
        createdAt: 1,
        lastSeenAt: null,
        online: false,
        push: false,
      };
      if (idx === -1) devices.push(next);
      else devices[idx] = next;
    }),
    removeDevice: vi.fn(async (id) => {
      const idx = devices.findIndex((d) => d.id === id);
      if (idx !== -1) devices.splice(idx, 1);
    }),
    listDevices: vi.fn(async () => [...devices]),
    push: vi.fn(async () => 0),
    unregister: vi.fn(async () => undefined),
    onConnection: (fn) => {
      routeHandler = fn;
    },
    onClose: () => undefined,
    close: vi.fn(),
  };

  const server = createRpcServer({
    nocturneVersion: "0.39.1",
    createRuntime: async () => ({
      runtime: await createRuntime({
        cwd: home,
        sessionsDir: join(home, "sessions"),
        providers: [new FakeProvider({ scripts: [] })],
      }),
    }),
    remote: {
      home,
      credentials,
      connect: {
        registerHost: vi.fn(async ({ identity }) => ({ hostId: identity.id })),
        connectHostRelay: vi.fn(async () => relay),
      },
      lan: {
        host: "127.0.0.1",
        listAddresses: options.addresses ?? (() => ["192.168.1.5", "10.0.0.8"]),
        addressPollMs: options.addressPollMs ?? 0,
        handshakeTimeoutMs: options.lanHandshakeTimeoutMs,
        maxHandshaking: options.maxHandshaking,
        resolveRemoteAddress: options.resolveRemoteAddress,
        onAccepted: (info) => {
          acceptedLan.push(info);
        },
      },
    },
  });

  const [clientSide, serverSide] = createMemoryTransportPair();
  const served = server.serve(serverSide);
  const client = createRpcClient(clientSide, { clientName: "desktop-test", interactive: true });
  await client.initialize();

  const stop = async () => {
    try {
      await client.shutdown();
    } catch {
      /* 已关闭 */
    }
    client.close();
    await served;
  };
  cleanups.push(stop);

  return {
    home,
    credentials,
    client,
    relay,
    devices,
    acceptedLan,
    openRelayRoute: (conn: RelayConnection) => routeHandler?.(conn),
    stop,
  };
}

async function registerAndPair(h: Awaited<ReturnType<typeof createHostHarness>>) {
  await h.client.call("remote.register", { invite: INVITE });
  await vi.waitFor(async () =>
    expect((await h.client.call("remote.describe", {})).connection).toBe("online"),
  );
  const pairing = await h.client.call("remote.startPairing", {});
  const parsed = parsePairingFragment(new URL(pairing.url).hash);
  const phone = await generateIdentity({ extractable: false });
  const hello = await createPairingHello(phone, parsed, "安卓测试机");
  const [phoneSide, hostSide] = createMemoryFramePair();
  const replyPromise = new Promise<Uint8Array>((resolve) => phoneSide.onFrame(resolve));
  h.openRelayRoute({ conn: 1, kind: "pair", slot: parsed.slot, transport: hostSide });
  phoneSide.send(hello.message);
  const finished = await finishPairing(hello.state, await replyPromise);
  await vi.waitFor(async () =>
    expect((await h.client.call("remote.describe", {})).pairing).toBeUndefined(),
  );
  return { phone, hostPublicKey: finished.hostPublicKey };
}

function extractPort(endpoint: string | undefined): number {
  if (!endpoint) throw new Error("expected endpoint");
  const colon = endpoint.lastIndexOf(":");
  return Number(endpoint.slice(colon + 1));
}

describe("电脑端局域网直连（ADR-0087）", () => {
  it("1. 电脑端监听 + 手机端 TCP 长度前缀直连，握手成功后完成 RPC 往返且受相同远程权限约束", async () => {
    const h = await createHostHarness();
    const { phone, hostPublicKey } = await registerAndPair(h);

    const status = await h.client.call("remote.setLanDirect", { enabled: true });
    expect(status.lanDirect).toBe(true);

    const { endpoints } = await h.client.call("remote.lanEndpoints", {});
    expect(endpoints).toHaveLength(2);
    const port = extractPort(endpoints[0]);
    expect(endpoints).toEqual([`tcp://192.168.1.5:${port}`, `tcp://10.0.0.8:${port}`]);

    const tcpTransport = await connectLanTcpClient(`tcp://127.0.0.1:${port}`);
    cleanups.push(async () => tcpTransport.close());
    const secure = await connectChannel(tcpTransport, {
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

  it("2. 未知设备、已移除设备连入被拒；移除或断开设备时直连与中继两种连接一并断开", async () => {
    const h = await createHostHarness();
    const { phone, hostPublicKey } = await registerAndPair(h);
    await h.client.call("remote.setLanDirect", { enabled: true });
    const port = extractPort((await h.client.call("remote.lanEndpoints", {})).endpoints[0]);

    // 未知设备连入被 unknown_device 拒绝
    const stranger = await generateIdentity({ extractable: false });
    const strangerTcp = await connectLanTcpClient(`tcp://127.0.0.1:${port}`);
    await expect(
      connectChannel(strangerTcp, { identity: stranger, hostPublicKey }),
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

    const lanTcp = await connectLanTcpClient(`tcp://127.0.0.1:${port}`);
    const lanChannel = await connectChannel(lanTcp, { identity: phone, hostPublicKey });
    const lanClient = createRpcClient(lanChannel, {
      clientName: "nocturne-phone",
      interactive: true,
    });
    await lanClient.initialize();

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

    const lanTcp2 = await connectLanTcpClient(`tcp://127.0.0.1:${port}`);
    const lanClient2 = createRpcClient(
      await connectChannel(lanTcp2, { identity: phone, hostPublicKey }),
      { clientName: "nocturne-phone", interactive: true },
    );
    await lanClient2.initialize();

    await h.client.call("remote.removeDevice", { id: phone.id });
    await Promise.all([relayClient2.closed, lanClient2.closed]);

    // 已移除设备再次直连被拒
    const afterRemoveTcp = await connectLanTcpClient(`tcp://127.0.0.1:${port}`);
    await expect(
      connectChannel(afterRemoveTcp, { identity: phone, hostPublicKey }),
    ).rejects.toMatchObject({ code: "unknown_device" });
  });

  it("3. 未认证防护：握手前数据帧、长度为 0、长度超 MAX_FRAME、先发 HTTP 文本、16 并发空 TCP 连接上限与超时归零、非私有网段来源各自被断开", async () => {
    // 验证私有网段判定规则全集
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

    // (a) 握手前直接发送数据帧 -> 立即断开
    {
      const raw = await openRawLanTcp(port);
      raw.writeFrame(new Uint8Array([FRAME_TYPES.data, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
      await raw.waitClosed();
    }

    // (b) 握手前连发两帧（未等 hs.resp） -> 立即断开
    {
      const raw = await openRawLanTcp(port);
      const fakeInit = Buffer.concat([
        Buffer.from([FRAME_TYPES.init]),
        Buffer.from(JSON.stringify({ v: 1, id: phone.id, e: "x", n: "y" }), "utf8"),
      ]);
      raw.writeFrame(fakeInit);
      raw.writeFrame(fakeInit);
      await raw.waitClosed();
    }

    // (c) 长度前缀为 0 -> 读到 4 字节头立即断开
    {
      const raw = await openRawLanTcp(port);
      raw.writeBytes(new Uint8Array([0, 0, 0, 0]));
      await raw.waitClosed();
    }

    // (d) 长度前缀超过 MAX_FRAME（只写 4 字节头，不发后续负载） -> 读到长度头立即断开
    {
      const raw = await openRawLanTcp(port);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME + 1, 0);
      raw.writeBytes(header);
      await raw.waitClosed();
    }

    // (e) 先发一段 HTTP 请求文本 -> 立即被断开
    {
      const raw = await openRawLanTcp(port);
      raw.writeBytes(Buffer.from("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "utf8"));
      await raw.waitClosed();
    }

    // (f) 从 TCP 接入起计入 16 并发未认证上限：只建 TCP 不发任何数据占满 16 个名额，第 17 条立即被拒，超时后 handshakingCount 回到 0
    {
      const listener = await listenLanDirect({
        host: "127.0.0.1",
        handshakeTimeoutMs: 180,
        onConnection: () => undefined,
      });
      cleanups.push(() => listener.close());

      const idleConns = await Promise.all(
        Array.from({ length: 16 }, () => openRawLanTcp(listener.port)),
      );
      cleanups.push(() => {
        for (const c of idleConns) c.close();
      });

      await vi.waitFor(() => expect(listener.handshakingCount()).toBe(16));

      // 第 17 条只建 TCP 也会被立即销毁关闭
      const seventeenth = await openRawLanTcp(listener.port);
      await seventeenth.waitClosed();
      expect(listener.handshakingCount()).toBe(16);

      // 等待握手超时：全部只建 TCP 不发数据的连接被销毁，handshakingCount 回到 0
      await Promise.all(idleConns.map((c) => c.waitClosed()));
      expect(listener.handshakingCount()).toBe(0);
    }

    // (g) 非私有网段来源 -> 直接拒绝关闭
    simulatedAddress = "8.8.8.8";
    const publicConn = await openRawLanTcp(port);
    await publicConn.waitClosed();

    // 切回私有网段后正常握手成功
    simulatedAddress = "192.168.1.50";
    const okTcp = await connectLanTcpClient(`tcp://127.0.0.1:${port}`);
    const okChannel = await connectChannel(okTcp, { identity: phone, hostPublicKey });
    okChannel.close();
    okTcp.close();
  });

  it("3b. hs.fin 之后紧跟 20 条数据帧一次写入 TCP，握手通过后 20 条按序全部送达", async () => {
    const h = await createHostHarness();
    const { phone, hostPublicKey } = await registerAndPair(h);
    await h.client.call("remote.setLanDirect", { enabled: true });
    const port = extractPort((await h.client.call("remote.lanEndpoints", {})).endpoints[0]);

    const raw = await openRawLanTcp(port);
    cleanups.push(() => raw.close());

    // 在客户端侧拦截 hs.fin 及随后发出的 20 条加密数据帧，合并为单次 socket.write 一次性写入服务端
    let inboundHandler: ((frame: Uint8Array) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    let batchHold = false;
    const heldFrames: Buffer[] = [];

    let readBuf = Buffer.alloc(0) as Buffer;
    raw.socket.on("data", (chunk: Buffer) => {
      readBuf = readBuf.length === 0 ? chunk : Buffer.concat([readBuf, chunk]);
      while (readBuf.length >= 4) {
        const len = readBuf.readUInt32BE(0);
        if (readBuf.length < 4 + len) return;
        const body = new Uint8Array(readBuf.subarray(4, 4 + len));
        readBuf = readBuf.subarray(4 + len);
        inboundHandler?.(body);
      }
    });
    raw.socket.once("close", () => closeHandler?.());

    const customTransport: FrameTransport = {
      send(frame) {
        if (frame[0] === FRAME_TYPES.finish) {
          batchHold = true;
        }
        if (batchHold) {
          heldFrames.push(encodeLengthPrefixedFrame(frame));
        } else {
          raw.writeFrame(frame);
        }
      },
      onFrame(fn) {
        inboundHandler = fn;
      },
      onClose(fn) {
        closeHandler = fn;
      },
      close() {
        raw.close();
      },
    };

    const secure = await connectChannel(customTransport, { identity: phone, hostPublicKey });
    // 第 1 条加密数据帧：initialize（id = 1），紧接着第 2..20 条：19 次顺序请求（id = 2..20），共 20 条 data 帧
    const receivedIds: number[] = [];
    let allTwentyResolved!: () => void;
    const allTwentyDone = new Promise<void>((resolve) => {
      allTwentyResolved = resolve;
    });
    secure.onLine((line) => {
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number") {
        receivedIds.push(msg.id);
        if (receivedIds.length === 20) allTwentyResolved();
      }
    });

    secure.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientName: "burst-test", interactive: true },
      }),
    );
    for (let id = 2; id <= 20; id++) {
      secure.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "runtime.listSessions",
          params: {},
        }),
      );
    }

    // 等待客户端 WebCrypto 异步加密把 hs.fin + 20 条 data 帧全部压入 heldFrames（共计 21 帧）
    await vi.waitFor(() => expect(heldFrames).toHaveLength(21));
    batchHold = false;
    // 单次 write 把 hs.fin 与紧随其后的 20 条数据帧一次性写入 TCP 连接
    raw.writeBytes(Buffer.concat(heldFrames));

    await allTwentyDone;
    expect(receivedIds).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    secure.close();
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
    await vi.waitFor(() =>
      expect(remoteNotices).toContainEqual([`tcp://192.168.1.5:${firstPort}`]),
    );
    expect(localNotices).toEqual([]);

    // 网卡地址变化时自动向加密通道发通知
    currentAddresses = ["192.168.1.5", "172.16.0.9"];
    await vi.waitFor(() =>
      expect(remoteNotices).toContainEqual([
        `tcp://192.168.1.5:${firstPort}`,
        `tcp://172.16.0.9:${firstPort}`,
      ]),
    );
    currentAddresses = ["192.168.1.5"];

    // 关闭开关时停止监听，返回空数组并通知加密通道
    await h1.client.call("remote.setLanDirect", { enabled: false });
    expect(await h1.client.call("remote.lanEndpoints", {})).toEqual({ endpoints: [] });
    await expect(connectLanTcpClient(`tcp://127.0.0.1:${firstPort}`)).rejects.toThrow();

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
        `tcp://192.168.1.5:${firstPort}`,
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
    const directTcp = await connectLanTcpClient(`tcp://127.0.0.1:${reassignedPort}`);
    const directClient = createRpcClient(
      await connectChannel(directTcp, { identity: phone, hostPublicKey }),
      { clientName: "nocturne-phone", interactive: true },
    );
    await directClient.initialize();
    await h3.client.call("remote.setEnabled", { enabled: false });
    await directClient.closed;
    expect(await h3.client.call("remote.lanEndpoints", {})).toEqual({ endpoints: [] });
  });
});
