import { afterEach, describe, expect, it } from "vitest";
import { createRpcClient, type LineTransport } from "@nocturne/rpc/client";
import {
  acceptChannel,
  connectChannel,
  createMemoryFramePair,
  generateIdentity,
} from "@nocturne/remote";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { cleanupTmp, connectMany, MODEL, textScript, until } from "./harness.js";

afterEach(cleanupTmp);

async function secure(h: Awaited<ReturnType<typeof connectMany>>) {
  const host = await generateIdentity({ extractable: true });
  const phone = await generateIdentity({ extractable: false });
  const [p, s] = createMemoryFramePair();
  const [phoneChannel, accepted] = await Promise.all([
    connectChannel(p, { identity: phone, hostPublicKey: host.publicKey }),
    acceptChannel(s, {
      identity: host,
      lookupDevice: async (id) => (id === phone.id ? phone.publicKey : undefined),
    }),
  ]);
  const serverTransport = accepted.channel satisfies LineTransport;
  const clientTransport = phoneChannel satisfies LineTransport;
  const served = h.server.serve(serverTransport, { origin: "remote" });
  const client = createRpcClient(clientTransport, {
    clientName: "secure-phone",
    interactive: true,
  });
  await client.initialize();
  return { client, served, frames: p };
}

describe("加密通道承载 RPC", () => {
  it("远程加密握手、listSessions、resumeSession、subscribe 收到事件，shutdown 白名单仍拒绝", async () => {
    const h = await connectMany({ scripts: [textScript("加密回复")] });
    const { session: local } = await h.client.runtime.createSession({ model: MODEL });
    const remote = await secure(h);
    expect((await remote.client.runtime.listSessions()).some((s) => s.id === local.id)).toBe(true);
    const { session } = await remote.client.runtime.resumeSession(local.id);
    const events: RuntimeEvent[] = [];
    await session.subscribe((event) => events.push(event));
    expect(await session.submit({ text: "手机文字" })).toBe("done");
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    await expect(remote.client.shutdown()).rejects.toMatchObject({ code: "remote_not_allowed" });
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  });

  it("关闭手机帧传输只清理远程连接，Turn 不中断且本机收到完成事件", async () => {
    const h = await connectMany({ scripts: [[{ type: "wait", ms: 150 }, ...textScript("完成")]] });
    const { session: local } = await h.client.runtime.createSession({ model: MODEL });
    const events: RuntimeEvent[] = [];
    await local.subscribe((event) => events.push(event));
    const remote = await secure(h);
    const { session } = await remote.client.runtime.resumeSession(local.id);
    const turn = session.submit({ text: "慢任务" });
    const rejected = expect(turn).rejects.toMatchObject({ code: "connection_closed" });
    await until(() => h.provider.requests.length > 0);
    remote.frames.close();
    await remote.served;
    await rejected;
    await until(() => events.some((event) => event.type === "turn.completed"));
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
      payload: { reason: "done" },
    });
    await h.client.shutdown();
    await h.served;
  });
});
