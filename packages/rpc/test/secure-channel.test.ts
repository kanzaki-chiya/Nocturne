import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRpcClient,
  RPC_PROTOCOL_VERSION,
  type CompressionAlgorithm,
  type LineTransport,
} from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import {
  acceptChannel,
  connectChannel,
  createMemoryFramePair,
  FRAME_TYPES,
  generateIdentity,
  supportsDeflateRawDecompression,
  type FrameTransport,
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

function tapFrames(inner: FrameTransport, onSend: (frame: Uint8Array) => void): FrameTransport {
  return {
    send(frame) {
      onSend(frame);
      inner.send(frame);
    },
    onFrame(handler) {
      inner.onFrame(handler);
    },
    onClose(handler) {
      inner.onClose(handler);
    },
    close() {
      inner.close();
    },
  };
}

describe("远程通道压缩协商", () => {
  it("新电脑端 + 新手机端：initialize 响应本身不压缩，之后电脑→手机消息压缩且管线化请求正常", async () => {
    const repeated = "压缩协商验证文本-".repeat(600);
    const h = await connectMany({ scripts: [textScript(repeated)] });
    const { session: local } = await h.client.runtime.createSession({ model: MODEL });

    const host = await generateIdentity({ extractable: true });
    const phone = await generateIdentity({ extractable: false });
    const [p, s] = createMemoryFramePair();
    const hostDataFrames: Uint8Array[] = [];
    const tappedServer = tapFrames(s, (frame) => {
      if (frame[0] === FRAME_TYPES.data) hostDataFrames.push(new Uint8Array(frame));
    });

    const [phoneChannel, accepted] = await Promise.all([
      connectChannel(p, { identity: phone, hostPublicKey: host.publicKey }),
      acceptChannel(tappedServer, {
        identity: host,
        lookupDevice: async (id) => (id === phone.id ? phone.publicKey : undefined),
      }),
    ]);

    const enableRecvSpy = vi.spyOn(phoneChannel, "enableReceiveCompression");
    const enableHostRecvSpy = vi.spyOn(accepted.channel, "enableReceiveCompression");

    const served = h.server.serve(accepted.channel, { origin: "remote" });
    const client = createRpcClient(phoneChannel, {
      clientName: "secure-phone",
      interactive: true,
      compression: ["deflate-raw"],
    });

    // 管线化：紧随 initialize 发出 listSessions，验证 initialize 响应未压缩而后续响应已压缩
    const initPromise = client.initialize();
    const listPromise = client.runtime.listSessions();
    const initResult = await initPromise;
    expect(initResult.compression).toBe("deflate-raw");
    expect(enableRecvSpy).toHaveBeenCalledTimes(1);
    expect(enableRecvSpy).toHaveBeenCalledWith("deflate-raw");
    // 只压缩电脑→手机方向，电脑侧不开启接收解压
    expect(enableHostRecvSpy).not.toHaveBeenCalled();

    const sessions = await listPromise;
    expect(sessions.some((item) => item.id === local.id)).toBe(true);
    // 首帧是未压缩的 initialize 响应：其长度应等于明文 JSON + 9(头) + 16(tag) + 1(flag)
    const initFrame = hostDataFrames[0];
    expect(initFrame).toBeDefined();
    const expectedInitPlainBytes = Buffer.byteLength(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: initResult }),
      "utf8",
    );
    expect(initFrame?.byteLength).toBe(expectedInitPlainBytes + 9 + 16 + 1);

    // 触发大体积回复，验证后续电脑→手机帧确实被大幅压缩
    const framesBeforeTurn = hostDataFrames.length;
    const { session } = await client.runtime.resumeSession(local.id);
    const events: RuntimeEvent[] = [];
    await session.subscribe((event) => events.push(event));
    expect(await session.submit({ text: "测试压缩" })).toBe("done");
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);

    const turnWireBytes = hostDataFrames
      .slice(framesBeforeTurn)
      .reduce((sum, frame) => sum + frame.byteLength, 0);
    const repeatedPlainBytes = Buffer.byteLength(repeated, "utf8");
    expect(turnWireBytes).toBeLessThan(repeatedPlainBytes * 0.5);

    await h.client.shutdown();
    await Promise.all([h.served, served]);
  });

  it("旧电脑端 + 新手机端：服务端忽略 capabilities.compression 且响应无 compression，双方不压缩", async () => {
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

    const enableRecvSpy = vi.spyOn(phoneChannel, "enableReceiveCompression");
    let receivedInitCaps: unknown;
    // 模拟旧版电脑端：只读 capabilities.interactive，响应中不带 compression，也不开启发送压缩
    accepted.channel.onLine((line) => {
      const msg = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: { capabilities?: unknown };
      };
      if (msg.method === "initialize") {
        receivedInitCaps = msg.params?.capabilities;
        accepted.channel.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: RPC_PROTOCOL_VERSION,
              nocturneVersion: "0.55.0-legacy",
            },
          }),
        );
      } else if (msg.method === "runtime.listSessions") {
        accepted.channel.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: [] }));
      }
    });

    const client = createRpcClient(phoneChannel, {
      clientName: "secure-phone",
      interactive: true,
      compression: ["deflate-raw"],
    });
    const initResult = await client.initialize();
    expect(receivedInitCaps).toEqual({ interactive: true, compression: ["deflate-raw"] });
    expect(initResult.compression).toBeUndefined();
    expect(enableRecvSpy).not.toHaveBeenCalled();
    expect(await client.runtime.listSessions()).toEqual([]);

    client.close();
    accepted.channel.close();
  });

  it("新电脑端 + 旧手机端：未声明 capabilities.compression 时结果无 compression，双方不压缩", async () => {
    const h = await connectMany();
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

    const enableSendSpy = vi.spyOn(accepted.channel, "enableSendCompression");
    const enableRecvSpy = vi.spyOn(phoneChannel, "enableReceiveCompression");
    const served = h.server.serve(accepted.channel, { origin: "remote" });

    // 旧手机端不传 compression 能力
    const client = createRpcClient(phoneChannel, {
      clientName: "legacy-phone",
      interactive: true,
    });
    const initResult = await client.initialize();
    expect(initResult.compression).toBeUndefined();
    expect(enableSendSpy).not.toHaveBeenCalled();
    expect(enableRecvSpy).not.toHaveBeenCalled();
    expect(await client.runtime.listSessions()).toEqual([]);

    await h.client.shutdown();
    await Promise.all([h.served, served]);
  });

  it("两边都新但 WebView 不支持 deflate-raw：能力检测为假不声明，双方不压缩", async () => {
    const origDecompressionStream = globalThis.DecompressionStream;
    globalThis.DecompressionStream = function UnsupportedDecompressionStream() {
      throw new TypeError("deflate-raw unsupported");
    } as unknown as typeof DecompressionStream;

    try {
      const h = await connectMany();
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

      const enableSendSpy = vi.spyOn(accepted.channel, "enableSendCompression");
      const enableRecvSpy = vi.spyOn(phoneChannel, "enableReceiveCompression");
      const served = h.server.serve(accepted.channel, { origin: "remote" });

      const compression: CompressionAlgorithm[] | undefined = supportsDeflateRawDecompression()
        ? ["deflate-raw"]
        : undefined;
      expect(compression).toBeUndefined();

      const client = createRpcClient(phoneChannel, {
        clientName: "old-webview-phone",
        interactive: true,
        ...(compression !== undefined ? { compression } : {}),
      });
      const initResult = await client.initialize();
      expect(initResult.compression).toBeUndefined();
      expect(enableSendSpy).not.toHaveBeenCalled();
      expect(enableRecvSpy).not.toHaveBeenCalled();
      expect(await client.runtime.listSessions()).toEqual([]);

      await h.client.shutdown();
      await Promise.all([h.served, served]);
    } finally {
      globalThis.DecompressionStream = origDecompressionStream;
    }
  });

  it("本机 RPC 连接即使声明 compression 也不开启压缩", async () => {
    const h = await connectMany();
    const runtime = h.runtimes[0];
    if (!runtime) throw new Error("expected runtime");
    const [p, s] = createMemoryFramePair();
    const host = await generateIdentity({ extractable: true });
    const phone = await generateIdentity({ extractable: false });
    const [localClientChannel, localServerChannel] = await Promise.all([
      connectChannel(p, { identity: phone, hostPublicKey: host.publicKey }),
      acceptChannel(s, {
        identity: host,
        lookupDevice: async (id) => (id === phone.id ? phone.publicKey : undefined),
      }),
    ]);

    const localServer = createRpcServer({
      nocturneVersion: "0.0.0-test",
      createRuntime: async () => ({ runtime, dispose: async () => undefined }),
    });
    const enableSendSpy = vi.spyOn(localServerChannel.channel, "enableSendCompression");
    const servedLocal = localServer.serve(localServerChannel.channel, { origin: "local" });
    const localClient = createRpcClient(localClientChannel, {
      clientName: "local-desktop",
      interactive: true,
      compression: ["deflate-raw"],
    });
    const initResult = await localClient.initialize();
    expect(initResult.compression).toBeUndefined();
    expect(enableSendSpy).not.toHaveBeenCalled();

    await localClient.shutdown();
    await servedLocal;
    await h.client.shutdown();
    await h.served;
  });
});
