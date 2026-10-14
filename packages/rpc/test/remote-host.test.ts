import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCredentialStore, createPlatform, createRuntime, FakeProvider } from "@nocturne/core";
import { createRpcServer, createMemoryTransportPair, REMOTE_METHODS } from "@nocturne/rpc/server";
import { createRpcClient } from "@nocturne/rpc/client";
import {
  connectChannel,
  createMemoryFramePair,
  createPairingHello,
  finishPairing,
  generateIdentity,
  parsePairingFragment,
  RelayError,
  type HostRelay,
  type RelayConnection,
  type RelayDevice,
} from "@nocturne/remote";
import { RemoteHost } from "../src/server/remote/host.js";
import { saveRegistration } from "../src/server/remote/storage.js";
import { until } from "./harness.js";

const homes: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const invite = "nocturne-invite:relay.example/AAAAAAAAAAAAAAAAAAAAAAAA";
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function harness(
  options: { remote?: boolean; backend?: "memory" | "none"; initialize?: boolean } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "remote-host-"));
  homes.push(home);
  const { store: credentials } = await createCredentialStore(createPlatform(), home, {
    backend: options.backend ?? "memory",
  });
  let connectionHandler: ((c: RelayConnection) => void) | undefined;
  let closeHandler: ((code: number) => void) | undefined;
  let devices: RelayDevice[] = [];
  const order: string[] = [];
  const relay: HostRelay = {
    onConnection: (fn) => {
      connectionHandler = fn;
    },
    onClose: (fn) => {
      closeHandler = fn;
    },
    close: vi.fn(() => {
      order.push("relay");
    }),
    openPairingSlot: vi.fn(() =>
      Promise.resolve({ slot: "AAAAAAAAAAAAAAAAAAAAAA", expiresAt: Date.now() + 300000 }),
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
    push: vi.fn(() => Promise.resolve(2)),
    unregister: vi.fn(() => Promise.resolve()),
  };
  const connect = vi.fn(() => Promise.resolve(relay));
  const register = vi.fn(({ identity }: { identity: { id: string } }) =>
    Promise.resolve({ hostId: identity.id }),
  );
  const server = createRpcServer({
    nocturneVersion: "test",
    ...(options.remote === false
      ? {}
      : {
          remote: {
            home,
            credentials,
            connect: { connectHostRelay: connect, registerHost: register },
          },
        }),
    createRuntime: async () => ({
      runtime: await createRuntime({
        cwd: home,
        sessionsDir: join(home, "sessions"),
        providers: [new FakeProvider({ scripts: [] })],
      }),
    }),
  });
  const [s, c] = createMemoryTransportPair();
  const served = server.serve(s);
  const client = createRpcClient(c, { clientName: "local" });
  cleanups.push(async () => {
    client.close();
    await served;
  });
  if (options.initialize !== false) await client.initialize();
  return {
    home,
    credentials,
    server,
    client,
    served,
    relay,
    connect,
    register,
    order,
    open: (route: RelayConnection) => {
      connectionHandler?.(route);
    },
    close: (code: number) => {
      closeHandler?.(code);
    },
    setDevices: (list: RelayDevice[]) => {
      devices = list;
    },
  };
}
async function registered() {
  const h = await harness();
  await h.client.call("remote.register", { invite });
  await until(() => h.connect.mock.calls.length > 0);
  await vi.waitFor(async () =>
    expect((await h.client.call("remote.describe", {})).connection).toBe("online"),
  );
  return h;
}
async function pair(h: Awaited<ReturnType<typeof harness>>) {
  const offer = await h.client.call("remote.startPairing", {});
  const phone = await generateIdentity({ extractable: false });
  const parsed = parsePairingFragment(new URL(offer.url).hash);
  const hello = await createPairingHello(phone, parsed, "测试手机");
  const [p, s] = createMemoryFramePair();
  const reply = new Promise<Uint8Array>((resolve) => p.onFrame(resolve));
  h.open({ conn: 1, kind: "pair", slot: parsed.slot, transport: s });
  p.send(hello.message);
  const result = await finishPairing(hello.state, await reply);
  await vi.waitFor(async () =>
    expect((await h.client.call("remote.describe", {})).pairing).toBeUndefined(),
  );
  return { phone, ...result };
}
async function phoneConnection(
  h: Awaited<ReturnType<typeof harness>>,
  phone: Awaited<ReturnType<typeof pair>>,
) {
  const [p, s] = createMemoryFramePair();
  h.open({ conn: 2, kind: "device", device: phone.phone.id, transport: s });
  const channel = await connectChannel(p, {
    identity: phone.phone,
    hostPublicKey: phone.hostPublicKey,
  });
  const client = createRpcClient(channel, { clientName: "phone" });
  await client.initialize();
  return client;
}

it("未提供 remote 时全部方法报 remote_unavailable，且 remote.* 不在远程白名单", async () => {
  const h = await harness({ remote: false });
  for (const method of h.server.methods.filter((name) => name.startsWith("remote."))) {
    await expect(
      h.client.call(
        method,
        method === "remote.register"
          ? { invite }
          : method === "remote.setEnabled"
            ? { enabled: true }
            : method.endsWith("Device")
              ? { id: "id" }
              : {},
      ),
    ).rejects.toMatchObject({ code: "remote_unavailable", rpcCode: -32004 });
    expect(REMOTE_METHODS as readonly string[]).not.toContain(method);
  }
  expect(h.connect).not.toHaveBeenCalled();
});
it("未登记及本机握手前不连接；登记写入凭据和文件，重复登记拒绝", async () => {
  const h = await harness({ initialize: false });
  expect(h.connect).not.toHaveBeenCalled();
  await h.client.initialize();
  expect(h.connect).not.toHaveBeenCalled();
  await h.client.call("remote.register", { invite });
  expect(h.credentials.has("remote/host-identity")).toBe(true);
  expect(JSON.parse(await readFile(join(h.home, "remote.json"), "utf8"))).toMatchObject({
    version: 1,
    enabled: true,
  });
  await expect(h.client.call("remote.register", { invite })).rejects.toMatchObject({
    code: "remote_already_registered",
  });
});
it("凭据后端 none 拒绝登记且不调用登记工厂", async () => {
  const h = await harness({ backend: "none" });
  await expect(h.client.call("remote.register", { invite })).rejects.toMatchObject({
    code: "credential_backend_unavailable",
  });
  expect(h.register).not.toHaveBeenCalled();
});
it("中继登记失败不留下凭据或文件，并保留中继错误码", async () => {
  const h = await harness();
  h.register.mockRejectedValueOnce(new RelayError("invalid_invite"));
  await expect(h.client.call("remote.register", { invite })).rejects.toMatchObject({
    code: "invalid_invite",
  });
  expect(h.credentials.has("remote/host-identity")).toBe(false);
  await expect(readFile(join(h.home, "remote.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("文件写入失败回滚已经写入的凭据", async () => {
  const h = await harness();
  await writeFile(join(h.home, "remote.json"), "old");
  // 把 home 改为文件，确保后端写入后原子文件写入失败。
  await rm(h.home, { recursive: true });
  await writeFile(h.home, "not a directory");
  await expect(h.client.call("remote.register", { invite })).rejects.toMatchObject({
    code: "remote_storage_failed",
  });
  expect(h.credentials.has("remote/host-identity")).toBe(false);
});
it("配对成功通知本机；加密设备 RPC 白名单生效且不会收到 remote.statusChanged", async () => {
  const h = await registered();
  const paired: unknown[] = [];
  h.client.onNotification("remote.paired", (p) => paired.push(p));
  const p = await pair(h);
  expect(paired).toHaveLength(1);
  const phone = await phoneConnection(h, p),
    remoteStatuses: unknown[] = [];
  phone.onNotification("remote.statusChanged", (status) => remoteStatuses.push(status));
  expect(await phone.runtime.listSessions()).toEqual([]);
  await expect(phone.call("remote.describe", {})).rejects.toMatchObject({
    code: "remote_not_allowed",
  });
  await h.client.call("remote.disconnectDevice", { id: p.phone.id });
  expect(remoteStatuses).toEqual([]);
  phone.close();
});
it("未知设备握手失败只关闭该连接", async () => {
  const h = await registered();
  const raw = await h.credentials.get("remote/host-identity");
  const { importIdentity } = await import("@nocturne/remote");
  const host = await importIdentity(raw ?? "", { extractable: true });
  const phone = await generateIdentity({ extractable: false });
  const [p, s] = createMemoryFramePair();
  h.open({ conn: 3, kind: "device", device: phone.id, transport: s });
  await expect(
    connectChannel(p, { identity: phone, hostPublicKey: host.publicKey }),
  ).rejects.toMatchObject({ code: "unknown_device" });
  expect((await h.client.call("remote.describe", {})).connection).toBe("online");
});
it.each(["remote.disconnectDevice", "remote.removeDevice"] as const)(
  "%s 关闭对应设备连接",
  async (method) => {
    const h = await registered();
    const p = await pair(h);
    const phone = await phoneConnection(h, p);
    await h.client.call(method, { id: p.phone.id });
    await vi.waitFor(async () =>
      expect((await h.client.call("remote.describe", {})).connections).toHaveLength(0),
    );
    await expect(phone.runtime.listSessions()).rejects.toMatchObject({ code: "connection_closed" });
  },
);
it("setEnabled(false) 关闭远程连接，关闭后不连接，离线推送为零", async () => {
  const h = await registered();
  const p = await pair(h);
  const phone = await phoneConnection(h, p);
  expect((await h.client.call("remote.push", {})).sent).toBe(2);
  expect((await h.client.call("remote.setEnabled", { enabled: false })).connection).toBe("off");
  expect((await h.client.call("remote.push", {})).sent).toBe(0);
  await expect(phone.runtime.listSessions()).rejects.toMatchObject({ code: "connection_closed" });
});
it.each([4003, 4004, 4001])("关闭码 %i 停止重连并报告终止状态", async (code) => {
  const h = await registered();
  h.close(code);
  expect((await h.client.call("remote.describe", {})).connection).toBe(
    code === 4001 ? "replaced" : "revoked",
  );
  expect(h.connect).toHaveBeenCalledTimes(1);
});
it("错误配对密钥发 pairingFailed，非当前槽位连接立即关闭", async () => {
  const h = await registered();
  const offer = await h.client.call("remote.startPairing", {});
  const failures: { code: string }[] = [];
  h.client.onNotification("remote.pairingFailed", (p) => failures.push(p));
  const [unused, wrong] = createMemoryFramePair();
  const closed = vi.fn();
  unused.onClose(closed);
  h.open({ conn: 4, kind: "pair", slot: "wrong", transport: wrong });
  await until(() => closed.mock.calls.length > 0);
  const parsed = parsePairingFragment(new URL(offer.url).hash);
  parsed.key[0] = (parsed.key[0] ?? 0) ^ 1;
  const hello = await createPairingHello(
    await generateIdentity({ extractable: false }),
    parsed,
    "手机",
  );
  const [p, s] = createMemoryFramePair();
  h.open({ conn: 5, kind: "pair", slot: parsed.slot, transport: s });
  p.send(hello.message);
  await until(() => failures.length > 0);
  expect(failures[0]?.code).toBe("bad_mac");
});
it("本机断开先关闭中继，再关闭远程连接", async () => {
  const h = await registered();
  const p = await pair(h);
  const phone = await phoneConnection(h, p);
  const close = vi.spyOn(h.relay, "close");
  h.client.close();
  await h.served;
  expect(close).toHaveBeenCalled();
  await expect(phone.runtime.listSessions()).rejects.toMatchObject({ code: "connection_closed" });
});
it("损坏的 remote.json 保留且带警告，describe 不联网", async () => {
  const h = await harness();
  await writeFile(join(h.home, "remote.json"), "broken");
  const host = new RemoteHost({ home: h.home, credentials: h.credentials }, vi.fn(), () =>
    Promise.resolve(),
  );
  expect(await host.describe()).toMatchObject({
    registered: false,
    warnings: [expect.any(String)],
  });
  expect(await readFile(join(h.home, "remote.json"), "utf8")).toBe("broken");
  expect(h.connect).not.toHaveBeenCalled();
});
it("enabled:false 的已登记主机不连接", async () => {
  const h = await harness();
  const identity = await generateIdentity({ extractable: true });
  await saveRegistration(h.home, {
    version: 1,
    origin: "https://relay.example",
    hostId: identity.id,
    enabled: false,
    devices: [],
  });
  const factory = vi.fn();
  const host = new RemoteHost(
    { home: h.home, credentials: h.credentials, connect: { connectHostRelay: factory } },
    vi.fn(),
    () => Promise.resolve(),
  );
  await host.start();
  expect(factory).not.toHaveBeenCalled();
  host.stop();
});

it("失败重连指数退避 1/2/4 秒至 60 秒上限，并应用抖动", async () => {
  const h = await registered();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  h.connect.mockRejectedValue(new RelayError("closed"));
  h.close(1006);
  for (const seconds of [1, 2, 4, 8, 16, 32, 60, 60]) {
    const count = h.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
    expect(h.connect).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    // WebCrypto 在原生事件循环异步完成，等下一次离线状态。
    await vi.waitFor(() => {
      expect(h.connect).toHaveBeenCalledTimes(count + 1);
    });
    await vi.waitFor(async () => {
      expect((await h.client.call("remote.describe", {})).connection).toBe("offline");
    });
  }
  h.client.close();
  await h.served;
});

it("配对连接 60 秒未发首帧报告 timeout", async () => {
  const h = await registered();
  const offer = await h.client.call("remote.startPairing", {}),
    parsed = parsePairingFragment(new URL(offer.url).hash);
  const failures: { code: string }[] = [];
  h.client.onNotification("remote.pairingFailed", (p) => {
    failures.push(p);
  });
  vi.useFakeTimers();
  const [p, s] = createMemoryFramePair();
  h.open({ conn: 7, kind: "pair", slot: parsed.slot, transport: s });
  await vi.advanceTimersByTimeAsync(60000);
  expect(failures).toEqual([{ code: "timeout" }]);
  p.close();
  h.client.close();
  await h.served;
});
