import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, createPlatform, createCredentialStore } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { createRpcServer, createMemoryTransportPair } from "@nocturne/rpc/server";
import { createRpcClient } from "@nocturne/rpc/client";
import {
  generateIdentity,
  registerHost,
  connectHostRelay,
  connectDeviceRelay,
  connectPairRelay,
  createPairingOffer,
  parsePairingFragment,
  createPairingHello,
  acceptPairingHello,
  finishPairing,
  acceptChannel,
  connectChannel,
} from "@nocturne/remote";
import { RelayServer, type RelayLog } from "../src/server.js";
import { PhoneConnection } from "../../desktop/src/web/connection.js";
import { pairPhone, parsePairingLink } from "../../desktop/src/web/pairing.js";
import { memoryStorage } from "../../desktop/src/web/storage.js";
import { PhoneSessions } from "../../desktop/src/web/sessions.js";

it("手机经本机中继完成扫码配对、加密 RPC 初始化、列表、恢复与事件订阅，日志和数据无会话内容", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-e2e-"));
  const logs: RelayLog[] = [];
  const relay = new RelayServer(
    { publicOrigin: "http://127.0.0.1:1", listen: "127.0.0.1:0", dataDir: join(dir, "relay") },
    (log) => logs.push(log),
  );
  const port = await relay.start();
  const origin = `http://127.0.0.1:${port}`;
  relay.config.publicOrigin = origin;
  const marker = "SECRET_SESSION_CONTENT_71429";
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "text_delta", text: marker },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const server = createRpcServer({
    nocturneVersion: "0.9.0",
    createRuntime: async (init) => ({
      runtime: await createRuntime({
        cwd: dir,
        sessionsDir: join(dir, "sessions"),
        providers: [provider],
        interactive: init.interactive,
      }),
      sessionsDir: join(dir, "sessions"),
      dispose: () => {
        /* 测试无额外宿主资源。 */
      },
    }),
  });
  const [localServer, localClient] = createMemoryTransportPair();
  const localServed = server.serve(localServer);
  const local = createRpcClient(localClient, { clientName: "local", interactive: true });
  const served: Promise<void>[] = [];
  try {
    await local.initialize();
    const { session: localSession } = await local.runtime.createSession({
      model: "fake/fake-model",
    });
    const hostIdentity = await generateIdentity({ extractable: true }),
      phone = await generateIdentity({ extractable: false });
    const invite = await relay.store.invite(origin, 10000);
    const code = invite.split("/").at(-1) ?? "";
    await registerHost({ origin, code, identity: hostIdentity });
    const host = await connectHostRelay({
      origin,
      identity: hostIdentity,
      hostId: hostIdentity.id,
    });
    const { slot } = await host.openPairingSlot();
    const offer = await createPairingOffer(hostIdentity, slot);
    let paired: { id: string; publicKey: Uint8Array; name: string } | undefined;
    let pairedResolve: () => void = () => {
      throw new Error("尚未创建配对等待器");
    };
    const pairedDone = new Promise<void>((done) => {
      pairedResolve = done;
    });
    let failure: unknown;
    host.onConnection((conn) => {
      if (conn.kind === "pair")
        conn.transport.onFrame((frame) => {
          void acceptPairingHello(hostIdentity, offer.secret, frame)
            .then(async (result) => {
              paired = result.device;
              await host.allowDevice(result.device);
              conn.transport.send(result.reply);
              pairedResolve();
            })
            .catch((error) => {
              failure = error;
              pairedResolve();
            });
        });
      else
        served.push(
          acceptChannel(conn.transport, {
            identity: hostIdentity,
            lookupDevice: async (id) => (paired?.id === id ? paired.publicKey : undefined),
          }).then((accepted) => server.serve(accepted.channel, { origin: "remote" })),
        );
    });
    const pair = await connectPairRelay({ origin, slot });
    const hello = await createPairingHello(phone, parsePairingFragment(offer.fragment), "测试手机");
    const reply = new Promise<Uint8Array>((done) => pair.onFrame(done));
    pair.send(hello.message);
    const result = await finishPairing(hello.state, await reply);
    await pairedDone;
    if (failure) throw failure;
    pair.close();
    const device = await connectDeviceRelay({ origin, identity: phone, hostId: result.hostId });
    const channel = await connectChannel(device.transport, {
      identity: phone,
      hostPublicKey: result.hostPublicKey,
    });
    const client = createRpcClient(channel, { clientName: "phone", interactive: true });
    await client.initialize();
    expect((await client.runtime.listSessions()).some((s) => s.id === localSession.id)).toBe(true);
    const { session } = await client.runtime.resumeSession(localSession.id);
    const events: RuntimeEvent[] = [];
    await session.subscribe((event) => events.push(event));
    expect(await session.submit({ text: marker })).toBe("done");
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(marker);
    expect(JSON.stringify(logs)).not.toContain(code);
    expect(await readFile(join(dir, "relay", "relay-data.json"), "utf8")).not.toContain(marker);
    await local.shutdown();
    await Promise.all([localServed, ...served]);
    host.close();
  } finally {
    localClient.close();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("桌面后台登记、配对并服务手机加密 RPC，移除设备后拒绝认证", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-desktop-e2e-"));
  let pushes = 0;
  const push = createServer((request, response) => {
    request.resume();
    pushes++;
    response.writeHead(201);
    response.end();
  });
  await new Promise<void>((resolve) => push.listen(0, "127.0.0.1", resolve));
  const pushAddress = push.address() as { port: number };
  const relay = new RelayServer({
    publicOrigin: "http://127.0.0.1:1",
    listen: "127.0.0.1:0",
    dataDir: join(dir, "relay"),
    allowInsecurePush: true,
    pushHosts: ["127.0.0.1"],
  });
  const port = await relay.start(),
    origin = `http://127.0.0.1:${port}`;
  relay.config.publicOrigin = origin;
  const { store: credentials } = await createCredentialStore(createPlatform(), join(dir, "home"), {
    backend: "memory",
  });
  const server = createRpcServer({
    nocturneVersion: "test",
    remote: {
      home: join(dir, "home"),
      credentials,
      connect: {
        registerHost: (options) => registerHost({ ...options, origin }),
        connectHostRelay: (options) => connectHostRelay({ ...options, origin }),
      },
    },
    createRuntime: async () => ({
      runtime: await createRuntime({
        cwd: dir,
        sessionsDir: join(dir, "sessions"),
        providers: [new FakeProvider({ scripts: [] })],
      }),
    }),
  });
  const [s, c] = createMemoryTransportPair(),
    served = server.serve(s);
  const local = createRpcClient(c, { clientName: "desktop" });
  try {
    await local.initialize();
    const invite = await relay.store.invite(origin, 10000),
      code = invite.split("/").at(-1) ?? "";
    await local.call("remote.register", { invite: `nocturne-invite:relay.example/${code}` });
    await vi.waitFor(async () => {
      expect((await local.call("remote.describe", {})).connection).toBe("online");
    });
    const offer = await local.call("remote.startPairing", {}),
      parsed = parsePairingFragment(new URL(offer.url).hash);
    const phone = await generateIdentity({ extractable: false }),
      pair = await connectPairRelay({ origin, slot: parsed.slot });
    const hello = await createPairingHello(phone, parsed, "端到端手机"),
      reply = new Promise<Uint8Array>((resolve) => pair.onFrame(resolve));
    pair.send(hello.message);
    const result = await finishPairing(hello.state, await reply);
    await vi.waitFor(async () => {
      expect((await local.call("remote.describe", {})).devices).toHaveLength(1);
    });
    const device = await connectDeviceRelay({ origin, identity: phone, hostId: result.hostId });
    const channel = await connectChannel(device.transport, {
      identity: phone,
      hostPublicKey: result.hostPublicKey,
    });
    const client = createRpcClient(channel, { clientName: "phone" });
    await client.initialize();
    expect(await client.runtime.listSessions()).toEqual([]);
    await device.subscribePush({
      endpoint: `http://127.0.0.1:${pushAddress.port}/push`,
      p256dh: Buffer.from(phone.publicKey).toString("base64url"),
      auth: Buffer.alloc(16).toString("base64url"),
    });
    expect(await local.call("remote.push", {})).toEqual({ sent: 1 });
    expect(pushes).toBe(1);
    await local.call("remote.removeDevice", { id: phone.id });
    await client.closed;
    await expect(
      connectDeviceRelay({ origin, identity: phone, hostId: result.hostId }),
    ).rejects.toMatchObject({ code: "closed", closeCode: 4004 });
    expect(await local.call("remote.push", {})).toEqual({ sent: 0 });
    await local.shutdown();
    await served;
  } finally {
    local.close();
    await served;
    await relay.close();
    await new Promise<void>((resolve) => push.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("网页连接模块经真实中继与桌面主机：配对、列表、提交、事件、权限回复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-phone-e2e-"));
  const relay = new RelayServer(
    { publicOrigin: "http://127.0.0.1:1", listen: "127.0.0.1:0", dataDir: join(dir, "relay") },
    () => undefined,
  );
  const port = await relay.start();
  const origin = `http://127.0.0.1:${port}`;
  relay.config.publicOrigin = origin;
  const { store: credentials } = await createCredentialStore(createPlatform(), join(dir, "home"), {
    backend: "memory",
  });
  const server = createRpcServer({
    nocturneVersion: "test",
    remote: {
      home: join(dir, "home"),
      credentials,
      connect: {
        registerHost: (o) => registerHost({ ...o, origin }),
        connectHostRelay: (o) => connectHostRelay({ ...o, origin }),
      },
    },
    createRuntime: async () => ({
      runtime: await createRuntime({
        cwd: dir,
        sessionsDir: join(dir, "sessions"),
        interactive: true,
        providers: [
          new FakeProvider({
            scripts: [
              [
                { type: "text_delta", text: "准备修改" },
                {
                  type: "tool_call",
                  toolCallId: "w1",
                  name: "write",
                  input: { path: "output.txt", content: "测试内容" },
                },
                { type: "finish", reason: "tool_calls" },
              ],
              [
                { type: "text_delta", text: "修改完成" },
                { type: "finish", reason: "stop" },
              ],
            ],
          }),
        ],
      }),
    }),
  });
  const [s, c] = createMemoryTransportPair();
  const served = server.serve(s);
  const local = createRpcClient(c, { clientName: "desktop" });
  let connection: PhoneConnection | undefined;
  try {
    await local.initialize();
    const { session: localSession } = await local.runtime.createSession({ model: "fake/fake-1" });
    const invite = await relay.store.invite(origin, 10000);
    await local.call("remote.register", {
      invite: `nocturne-invite:relay.example/${invite.split("/").at(-1) ?? ""}`,
    });
    await vi.waitFor(async () => {
      expect((await local.call("remote.describe", {})).connection).toBe("online");
    });
    const offer = await local.call("remote.startPairing", {});
    const storage = memoryStorage();
    const host = await pairPhone(
      storage,
      parsePairingLink(offer.url, "https://relay.example"),
      origin,
      "网页测试手机",
    );
    const sessions = new PhoneSessions(() => undefined);
    connection = new PhoneConnection({
      origin,
      identity: await storage.identity(),
      host,
      changed: () => undefined,
      connected: (client) => sessions.connected(client),
      disconnected: () => sessions.disconnected(),
    });
    connection.start();
    await vi.waitFor(() => {
      expect(connection?.state).toBe("online");
    });
    expect(sessions.list.some((item) => item.id === localSession.id)).toBe(true);
    const entry = await sessions.open(localSession.id);
    const turn = entry.session.submit({ text: "写入测试内容" });
    await vi.waitFor(() => {
      expect(entry.view.pendingPermission).toBeDefined();
    });
    const pending = entry.view.pendingPermission;
    if (!pending) throw new Error("缺少权限请求");
    await entry.session.respondPermission(pending.requestId, {
      decision: "allow",
      remember: "session",
    });
    expect(await turn).toBe("done");
    expect(entry.view.pendingPermission).toBeUndefined();
    expect(await readFile(join(dir, "output.txt"), "utf8")).toBe("测试内容");
    expect(JSON.stringify(entry.view.entries)).toContain("修改完成");
  } finally {
    connection?.stop();
    local.close();
    await served;
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
