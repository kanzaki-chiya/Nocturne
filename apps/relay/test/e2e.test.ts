import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRuntime, FakeProvider } from "@nocturne/core";
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
