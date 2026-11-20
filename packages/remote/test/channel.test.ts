import { randomBytes } from "node:crypto";
import { constants as zlibConstants, createDeflateRaw } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  acceptChannel,
  connectChannel,
  createMemoryFramePair,
  DATA_FLAGS,
  MAX_FRAME,
  MAX_MESSAGE,
  MESSAGE_TERMINATOR,
  supportsDeflateRawDecompression,
  type Identity,
  type StreamCompressor,
} from "../src/index.js";
import { b64u, jsonFrame, transcript, utf8, unb64u } from "../src/encoding.js";
import { sign, hkdf } from "../src/crypto.js";
import { encryptFrame } from "../src/channel.js";
import { body, connected, edit, identities, until, wire, required } from "./helpers.js";

describe("签名握手", () => {
  it("正常握手，双向密钥一致，手机 hs.fin 后立即发数据，电脑验证后交付", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const accepted = acceptChannel(h, {
      identity: ids.host,
      lookupDevice: async () => ids.phone.publicKey,
    });
    const phone = await connectChannel(p, {
      identity: ids.phone,
      hostPublicKey: ids.host.publicKey,
    });
    phone.send("手机");
    const host = (await accepted).channel;
    const receivedPhone: string[] = [],
      receivedHost: string[] = [];
    phone.onLine((line) => receivedPhone.push(line));
    host.onLine((line) => receivedHost.push(line));
    host.send("电脑");
    await Promise.all([phone.flush(), host.flush()]);
    await until(() => receivedHost.length === 1 && receivedPhone.length === 1);
    expect(receivedHost).toEqual(["手机"]);
    expect(receivedPhone).toEqual(["电脑"]);
    phone.close();
  });

  it("未知或吊销设备回 unknown_device 并关闭底层", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const sent: Uint8Array[] = [];
    let closed = false;
    const observed = {
      ...p,
      onClose: (handler: () => void) =>
        p.onClose(() => {
          closed = true;
          handler();
        }),
    };
    const result = await Promise.allSettled([
      connectChannel(observed, { identity: ids.phone, hostPublicKey: ids.host.publicKey }),
      acceptChannel(
        wire(h, (f) => {
          sent.push(f);
          return [f];
        }),
        { identity: ids.host, lookupDevice: async () => undefined },
      ),
    ]);
    expect(result).toMatchObject([
      { status: "rejected", reason: { code: "unknown_device" } },
      { status: "rejected", reason: { code: "unknown_device" } },
    ]);
    expect(body(required(sent[0]))).toEqual({ code: "unknown_device" });
    await until(() => closed);
  });

  it("冒充电脑验签失败，不发 hs.fin", async () => {
    const ids = await identities(),
      attacker = (await identities()).host;
    const [p, h] = createMemoryFramePair();
    const types: number[] = [];
    const results = await Promise.allSettled([
      connectChannel(
        wire(p, (f) => {
          types.push(required(f[0]));
          return [f];
        }),
        { identity: ids.phone, hostPublicKey: ids.host.publicKey },
      ),
      acceptChannel(h, { identity: attacker, lookupDevice: async () => ids.phone.publicKey }),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "bad_signature" } });
    expect(types).not.toContain(3);
  });

  it("冒充手机沿用合法 id 换私钥，电脑拒绝 hs.fin", async () => {
    const ids = await identities(),
      attacker = (await identities()).phone;
    const forged: Identity = { ...ids.phone, privateKey: attacker.privateKey };
    const [p, h] = createMemoryFramePair();
    const accepted = acceptChannel(h, {
      identity: ids.host,
      lookupDevice: async () => ids.phone.publicKey,
    });
    const rejected = expect(accepted).rejects.toMatchObject({ code: "bad_signature" });
    const phone = await connectChannel(p, { identity: forged, hostPublicKey: ids.host.publicKey });
    await rejected;
    let closed = false;
    phone.onClose(() => {
      closed = true;
    });
    await until(() => closed);
  });

  it.each(["eH", "nP"])("篡改 %s 导致手机验签失败", async (field) => {
    const ids = await identities(),
      attacker = (await identities()).host;
    const [p, h] = createMemoryFramePair();
    const results = await Promise.allSettled([
      connectChannel(
        wire(p, (f) => [
          f[0] === 1 && field === "nP" ? edit(f, { n: b64u(new Uint8Array(32)) }) : f,
        ]),
        { identity: ids.phone, hostPublicKey: ids.host.publicKey },
      ),
      acceptChannel(
        wire(h, (f) => [
          f[0] === 2 && field === "eH" ? edit(f, { e: b64u(attacker.publicKey) }) : f,
        ]),
        { identity: ids.host, lookupDevice: async () => ids.phone.publicKey },
      ),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "bad_signature" } });
  });

  it.each([
    [{ v: 2 }, "version_mismatch"],
    [{ extra: true }, "protocol_error"],
  ] as const)("init 版本与额外字段：%j", async (patch, code) => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const results = await Promise.allSettled([
      connectChannel(
        wire(p, (f) => [f[0] === 1 ? edit(f, patch) : f]),
        { identity: ids.phone, hostPublicKey: ids.host.publicKey },
      ),
      acceptChannel(h, { identity: ids.host, lookupDevice: async () => ids.phone.publicKey }),
    ]);
    expect(results).toMatchObject([
      { status: "rejected", reason: { code } },
      { status: "rejected", reason: { code } },
    ]);
  });

  it("握手超时关闭底层，双方均拒绝", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const results = await Promise.allSettled([
      connectChannel(
        wire(p, (f) => (f[0] === 1 ? [] : [f])),
        { identity: ids.phone, hostPublicKey: ids.host.publicKey, timeoutMs: 30 },
      ),
      acceptChannel(h, {
        identity: ids.host,
        lookupDevice: async () => ids.phone.publicKey,
        timeoutMs: 30,
      }),
    ]);
    expect(results).toMatchObject([
      { status: "rejected", reason: { code: "timeout" } },
      { status: "rejected", reason: { code: "timeout" } },
    ]);
  });

  it.each([
    [2, { extra: true }, "protocol_error"],
    [2, { v: 2 }, "version_mismatch"],
    [3, { extra: true }, "protocol_error"],
  ] as const)("握手帧 %s 字段严格校验：%j", async (type, patch, code) => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const accepted = acceptChannel(
      wire(h, (f) => [f[0] === type ? edit(f, patch) : f]),
      {
        identity: ids.host,
        lookupDevice: async () => ids.phone.publicKey,
      },
    );
    const rejected = expect(accepted).rejects.toMatchObject({ code });
    const phone = connectChannel(
      wire(p, (f) => [f[0] === type ? edit(f, patch) : f]),
      {
        identity: ids.phone,
        hostPublicKey: ids.host.publicKey,
      },
    );
    if (type === 2) await expect(phone).rejects.toMatchObject({ code });
    else await phone;
    await rejected;
  });

  it("握手超过 4 KiB、错误帧额外字段或未知类型为 protocol_error", async () => {
    for (const frame of [
      new Uint8Array(4097).fill(1),
      jsonFrame(127, { code: "closed", extra: 1 }),
      new Uint8Array([4]),
    ]) {
      const ids = await identities(),
        [p, h] = createMemoryFramePair();
      const accepted = acceptChannel(h, {
        identity: ids.host,
        lookupDevice: async () => ids.phone.publicKey,
      });
      const rejected = expect(accepted).rejects.toMatchObject({ code: "protocol_error" });
      p.onFrame(() => undefined);
      p.send(frame);
      await rejected;
    }
  });

  it("握手底层正常断开为 closed", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const accepted = acceptChannel(h, {
      identity: ids.host,
      lookupDevice: async () => ids.phone.publicKey,
    });
    const rejected = expect(accepted).rejects.toMatchObject({ code: "closed" });
    p.close();
    await rejected;
  });

  it("hs.fin 前数据帧为 protocol_error", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    const accepted = acceptChannel(h, {
      identity: ids.host,
      lookupDevice: async () => ids.phone.publicKey,
    });
    const rejected = expect(accepted).rejects.toMatchObject({ code: "protocol_error" });
    await connectChannel(
      wire(p, (f) => (f[0] === 3 ? [new Uint8Array([16])] : [f])),
      { identity: ids.phone, hostPublicKey: ids.host.publicKey },
    );
    await rejected;
  });

  it("同一身份重连会话密钥不同，第一次密文在第二次 decrypt_failed", async () => {
    const ids = await identities();
    let captured: Uint8Array | undefined;
    const first = await connected({
      ids,
      p2h: (f) => {
        if (f[0] === 16) captured = f;
        return [f];
      },
    });
    first.host.onLine(() => undefined);
    first.phone.send("first");
    await first.phone.flush();
    first.phone.close();
    const second = await connected({ ids });
    second.host.onLine(() => undefined);
    second.phoneWire.send(required(captured));
    await until(() => second.host.closeReason !== undefined);
    expect(second.host.closeReason?.code).toBe("decrypt_failed");
  });
});

describe("数据帧", () => {
  it("1000 条并发 send 串行加密解密按调用顺序交付", async () => {
    const s = await connected(),
      got: string[] = [];
    s.host.onLine((line) => got.push(line));
    const expected = Array.from({ length: 1000 }, (_, i) => `消息 ${i}`);
    await Promise.all(
      expected.map(async (line) => {
        s.phone.send(line);
      }),
    );
    await s.phone.flush();
    await until(() => got.length === 1000);
    expect(got).toEqual(expected);
    s.phone.close();
  });

  it.each(["ciphertext", "counter", "replay", "drop", "swap"])(
    "%s 篡改或乱序关闭且不回错误帧",
    async (mode) => {
      let saved: Uint8Array | undefined;
      let index = 0;
      const responses: number[] = [];
      const s = await connected({
        h2p: (f) => {
          responses.push(required(f[0]));
          return [f];
        },
        p2h: (f) => {
          if (f[0] !== 16) return [f];
          index++;
          if (mode === "ciphertext") {
            f[f.length - 1] = required(f[f.length - 1]) ^ 1;
            return [f];
          }
          if (mode === "counter") {
            f[8] = 1;
            return [f];
          }
          if (mode === "replay") return [f, f];
          if (mode === "drop") return index === 1 ? [] : [f];
          if (index === 1) {
            saved = f;
            return [];
          }
          return [f, required(saved)];
        },
      });
      s.host.onLine(() => undefined);
      s.phone.send("a");
      s.phone.send("b");
      await s.phone.flush();
      await until(() => s.host.closeReason !== undefined);
      expect(s.host.closeReason?.code).toBe(mode === "ciphertext" ? "decrypt_failed" : "replay");
      expect(responses).not.toContain(127);
    },
  );

  it("P→H 密文反射回 P 为 decrypt_failed", async () => {
    let captured: Uint8Array | undefined;
    const s = await connected({
      p2h: (f) => {
        if (f[0] === 16) captured = f;
        return [f];
      },
    });
    s.host.onLine(() => undefined);
    s.phone.onLine(() => undefined);
    s.phone.send("reflection");
    await s.phone.flush();
    s.hostWire.send(required(captured));
    await until(() => s.phone.closeReason !== undefined);
    expect(s.phone.closeReason?.code).toBe("decrypt_failed");
  });

  it("3 MiB UTF-8 消息自动分片往返，单帧不超过上限", async () => {
    const frames: number[] = [];
    const s = await connected({
      p2h: (f) => {
        if (f[0] === 16) frames.push(f.length);
        return [f];
      },
    });
    const message = "夜".repeat(1024 * 1024);
    let result: string | undefined;
    s.host.onLine((line) => s.host.send(line));
    s.phone.onLine((line) => {
      result = line;
    });
    s.phone.send(message);
    await s.phone.flush();
    await until(() => result !== undefined);
    expect(result).toBe(message);
    expect(frames).toHaveLength(4);
    expect(Math.max(...frames)).toBe(MAX_FRAME);
    s.phone.close();
  });

  it("发送超过 MAX_MESSAGE 关闭并记录 frame_too_large", async () => {
    const s = await connected();
    s.host.onLine(() => undefined);
    s.phone.send("a".repeat(MAX_MESSAGE + 1));
    expect(s.phone.closeReason?.code).toBe("frame_too_large");
    let closed = false;
    s.host.onClose(() => {
      closed = true;
    });
    await until(() => closed);
  });

  it("收到超大单帧关闭", async () => {
    const s = await connected();
    s.host.onLine(() => undefined);
    const frame = new Uint8Array(MAX_FRAME + 1);
    frame[0] = 16;
    s.phoneWire.send(frame);
    await until(() => s.host.closeReason !== undefined);
    expect(s.host.closeReason?.code).toBe("frame_too_large");
  });

  it("close 前已 send 的消息全部交付后才 onClose，迟注册也缓冲且只通知一次", async () => {
    const s = await connected(),
      events: string[] = [];
    s.phone.send("一");
    s.phone.send("二");
    s.phone.close();
    s.phone.close();
    s.host.onClose(() => events.push("close"));
    await s.phone.flush();
    s.host.onLine((line) => events.push(line));
    await until(() => events.includes("close"));
    expect(events).toEqual(["一", "二", "close"]);
    s.host.close();
    s.host.onClose(() => events.push("again"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(3);
    expect(s.host.closeReason).toBeUndefined();
    expect(s.phone.closeReason).toBeUndefined();
  });
});

// 独立手机对端能生成有合法 tag 的非法 flag/超大重组帧，不暴露通道内密钥。
async function rawPhone() {
  const ids = await identities(),
    [p, h] = createMemoryFramePair();
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const eP = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    nP = new Uint8Array(32).fill(9);
  let resolveResponse!: (frame: Uint8Array) => void;
  const response = new Promise<Uint8Array>((resolve) => {
    resolveResponse = resolve;
  });
  p.onFrame((frame) => {
    if (frame[0] === 2) resolveResponse(frame);
  });
  const accepted = acceptChannel(h, {
    identity: ids.host,
    lookupDevice: async () => ids.phone.publicKey,
  });
  p.send(jsonFrame(1, { v: 1, id: ids.phone.id, e: b64u(eP), n: b64u(nP) }));
  const resp = body(await response),
    eH = unb64u(resp.e),
    nH = unb64u(resp.n);
  const fields = [ids.host.publicKey, ids.phone.publicKey, eP, eH, nP, nH];
  p.send(
    jsonFrame(3, {
      sig: b64u(await sign(ids.phone.privateKey, transcript("nocturne/hs/v1/fin", ...fields))),
    }),
  );
  const peer = await crypto.subtle.importKey(
    "raw",
    eH,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256),
  );
  const salt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", transcript("nocturne/hs/v1/salt", ...fields)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    await hkdf(shared, salt, utf8("nocturne/hs/v1/p2h")),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  return { p, key, host: (await accepted).channel };
}

describe("认证后恶意分片", () => {
  it("非法 flag 为 protocol_error", async () => {
    const s = await rawPhone();
    s.host.onLine(() => undefined);
    s.p.send(await encryptFrame(s.key, 0, 2, utf8("bad flag")));
    await until(() => s.host.closeReason !== undefined);
    expect(s.host.closeReason?.code).toBe("protocol_error");
  });
  it("重组超过 16 MiB 为 frame_too_large，不交付半条消息", async () => {
    const s = await rawPhone(),
      lines: string[] = [];
    s.host.onLine((line) => lines.push(line));
    const chunk = new Uint8Array(MAX_FRAME - 26);
    for (let i = 0; i < 17; i++) s.p.send(await encryptFrame(s.key, i, 1, chunk));
    await until(() => s.host.closeReason !== undefined);
    expect(s.host.closeReason?.code).toBe("frame_too_large");
    expect(lines).toEqual([]);
  });
  it("底层关闭丢弃未收完分片", async () => {
    const s = await rawPhone(),
      events: string[] = [];
    s.host.onLine((line) => events.push(line));
    s.host.onClose(() => events.push("close"));
    s.p.send(await encryptFrame(s.key, 0, 1, utf8("partial")));
    s.p.close();
    await until(() => events.length > 0);
    expect(events).toEqual(["close"]);
  });
});

function createNodeDeflateCompressor(): StreamCompressor {
  const deflate = createDeflateRaw({ level: 6, windowBits: 15 });
  let closed = false;
  return {
    compress(data: Uint8Array): Promise<Uint8Array> {
      if (closed) return Promise.reject(new Error("closed"));
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const cleanup = () => {
          deflate.off("data", onData);
          deflate.off("error", onError);
        };
        const onData = (chunk: Buffer) => chunks.push(chunk);
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        deflate.on("data", onData);
        deflate.on("error", onError);
        deflate.write(data);
        deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => {
          cleanup();
          resolve(new Uint8Array(Buffer.concat(chunks)));
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      deflate.on("error", () => undefined);
      deflate.destroy();
    },
  };
}

/** 独立电脑对端：能向手机侧发送合法 AES-GCM 加密的任意 flag/载荷帧，并观测手机侧是否回传帧 */
async function rawHost() {
  const ids = await identities(),
    [p, h] = createMemoryFramePair();
  const phoneSentFrames: Uint8Array[] = [];
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const eH = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    nH = new Uint8Array(32).fill(7);
  let resolveInit!: (frame: Uint8Array) => void;
  let resolveFin!: (frame: Uint8Array) => void;
  const initPromise = new Promise<Uint8Array>((resolve) => {
    resolveInit = resolve;
  });
  const finPromise = new Promise<Uint8Array>((resolve) => {
    resolveFin = resolve;
  });
  h.onFrame((frame) => {
    if (frame[0] === 1) resolveInit(frame);
    else if (frame[0] === 3) resolveFin(frame);
    else phoneSentFrames.push(frame);
  });
  const connecting = connectChannel(p, {
    identity: ids.phone,
    hostPublicKey: ids.host.publicKey,
  });
  const initBody = body(await initPromise);
  const eP = unb64u(initBody.e),
    nP = unb64u(initBody.n);
  const fields = [ids.host.publicKey, ids.phone.publicKey, eP, eH, nP, nH];
  h.send(
    jsonFrame(2, {
      v: 1,
      e: b64u(eH),
      n: b64u(nH),
      sig: b64u(await sign(ids.host.privateKey, transcript("nocturne/hs/v1/resp", ...fields))),
    }),
  );
  await finPromise;
  const peer = await crypto.subtle.importKey(
    "raw",
    eP,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256),
  );
  const salt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", transcript("nocturne/hs/v1/salt", ...fields)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    await hkdf(shared, salt, utf8("nocturne/hs/v1/h2p")),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  return { h, key, phone: await connecting, phoneSentFrames };
}

describe("共享 deflate-raw 流压缩", () => {
  it("压缩消息分片与重组（超单帧载荷按 0x03/0x02 分片并完整还原）", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    let hostFrames = 0;
    const [phone, accepted] = await Promise.all([
      connectChannel(p, { identity: ids.phone, hostPublicKey: ids.host.publicKey }),
      acceptChannel(
        wire(h, (frame) => {
          if (frame[0] === 0x10) hostFrames++;
          return [frame];
        }),
        { identity: ids.host, lookupDevice: async () => ids.phone.publicKey },
      ),
    ]);
    const host = accepted.channel;
    host.enableSendCompression(createNodeDeflateCompressor());
    phone.enableReceiveCompression("deflate-raw");

    // 用高熵随机 base64 保证压缩后载荷超过 2 * MAX_FRAME，触发至少 3 个分片帧（0x03/0x03/0x02）
    const incompressible = randomBytes(2_300_000).toString("base64");
    const received: string[] = [];
    phone.onLine((line) => received.push(line));
    host.send(incompressible);
    host.send("tail-after-fragmented");
    await host.flush();
    await until(() => received.length === 2);

    expect(hostFrames).toBeGreaterThanOrEqual(4);
    expect(received[0]).toBe(incompressible);
    expect(received[1]).toBe("tail-after-fragmented");
    phone.close();
  });

  it("开启压缩前入队的消息保持未压缩，开启后发送的消息自动压缩", async () => {
    const s = await connected();
    const received: string[] = [];
    let enabled = false;
    s.phone.onLine((line) => {
      received.push(line);
      if (!enabled) {
        enabled = true;
        s.phone.enableReceiveCompression("deflate-raw");
      }
    });
    // 第一条未压缩（模拟 initialize 响应），紧接着同步开启压缩再发第二、三条
    s.host.send('{"id":1,"result":{"compression":"deflate-raw"}}');
    s.host.enableSendCompression(createNodeDeflateCompressor());
    s.host.send('{"method":"event","params":{"seq":1,"text":"hello"}}');
    s.host.send('{"method":"event","params":{"seq":2,"text":"hello"}}');
    await s.host.flush();
    await until(() => received.length === 3);
    expect(received).toEqual([
      '{"id":1,"result":{"compression":"deflate-raw"}}',
      '{"method":"event","params":{"seq":1,"text":"hello"}}',
      '{"method":"event","params":{"seq":2,"text":"hello"}}',
    ]);
    s.phone.close();
  });

  it.each([DATA_FLAGS.compressedEnd, DATA_FLAGS.compressedMore, 0x04])(
    "未开启压缩时收到 flag 0x%s 报 protocol_error",
    async (flag) => {
      const s = await rawHost();
      s.phone.onLine(() => undefined);
      s.h.send(await encryptFrame(s.key, 0, flag, utf8("unexpected")));
      await until(() => s.phone.closeReason !== undefined);
      expect(s.phone.closeReason?.code).toBe("protocol_error");
      expect(s.phoneSentFrames).toEqual([]);
    },
  );

  it.each([DATA_FLAGS.uncompressedEnd, DATA_FLAGS.uncompressedMore, 0x04])(
    "开启压缩后收到未压缩或非法 flag 0x%s 报 protocol_error",
    async (flag) => {
      const s = await rawHost();
      s.phone.enableReceiveCompression("deflate-raw");
      s.phone.onLine(() => undefined);
      s.h.send(await encryptFrame(s.key, 0, flag, utf8("mixed")));
      await until(() => s.phone.closeReason !== undefined);
      expect(s.phone.closeReason?.code).toBe("protocol_error");
      expect(s.phoneSentFrames).toEqual([]);
    },
  );

  it("共用压缩流跨 220 条随机大小消息逐条明文一致，且线上字节明显小于明文", async () => {
    const ids = await identities(),
      [p, h] = createMemoryFramePair();
    let wireBytes = 0;
    const [phone, accepted] = await Promise.all([
      connectChannel(p, { identity: ids.phone, hostPublicKey: ids.host.publicKey }),
      acceptChannel(
        wire(h, (frame) => {
          if (frame[0] === 0x10) wireBytes += frame.byteLength;
          return [frame];
        }),
        { identity: ids.host, lookupDevice: async () => ids.phone.publicKey },
      ),
    ]);
    const host = accepted.channel;
    host.enableSendCompression(createNodeDeflateCompressor());
    phone.enableReceiveCompression("deflate-raw");

    // 确定性伪随机生成器，构造 220 条涵盖边界与随机大小的消息
    let seed = 0x1121e;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const messages: string[] = [
      "",
      "a",
      "你好，🌙",
      "包含\n换行与\0空字节",
      JSON.stringify({ jsonrpc: "2.0", method: "session.observeEvent", params: { seq: 1 } }),
    ];
    const vocabulary = [
      '"tool.completed"',
      '"modelContent":"read file packages/remote/src/channel.ts"',
      '"output":"ok"',
      "中文片段",
      "0123456789abcdef",
    ];
    while (messages.length < 220) {
      const targetLen = nextRand() % 24_000;
      let text = `{"seq":${messages.length},"body":"`;
      while (text.length < targetLen) {
        text += required(vocabulary[nextRand() % vocabulary.length]);
      }
      messages.push(`${text.slice(0, targetLen)}"}`);
    }

    const received: string[] = [];
    phone.onLine((line) => received.push(line));
    let plainBytes = 0;
    for (const msg of messages) {
      plainBytes += Buffer.byteLength(msg, "utf8");
      host.send(msg);
    }
    await host.flush();
    await until(() => received.length === messages.length);

    expect(received).toEqual(messages);
    expect(wireBytes).toBeLessThan(plainBytes * 0.25);
    phone.close();
  });

  it("高压缩比消息解压超 MAX_MESSAGE 报 frame_too_large，且中途停止未读完全部明文", async () => {
    const NativeDecompressionStream = globalThis.DecompressionStream;
    let totalReadBytes = 0;
    let readerCancelled = false;

    class SpyDecompressionStream {
      readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const inner = new NativeDecompressionStream(format);
        this.writable = inner.writable;
        const origGetReader = inner.readable.getReader.bind(inner.readable);
        this.readable = new Proxy(inner.readable, {
          get(target, prop, receiver) {
            if (prop === "getReader") {
              return (...args: Parameters<typeof origGetReader>) => {
                const reader = origGetReader(...args) as ReadableStreamDefaultReader<
                  Uint8Array<ArrayBuffer>
                >;
                const origRead = reader.read.bind(reader);
                const origCancel = reader.cancel.bind(reader);
                return new Proxy(reader, {
                  get(rTarget, rProp, rReceiver) {
                    if (rProp === "read") {
                      return async () => {
                        const res = await origRead();
                        if (!res.done && res.value) {
                          totalReadBytes += res.value.byteLength;
                        }
                        return res;
                      };
                    }
                    if (rProp === "cancel") {
                      return (reason?: unknown) => {
                        readerCancelled = true;
                        return origCancel(reason);
                      };
                    }
                    return Reflect.get(rTarget, rProp, rReceiver);
                  },
                });
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      }
    }

    globalThis.DecompressionStream =
      SpyDecompressionStream as unknown as typeof DecompressionStream;
    try {
      const s = await rawHost();
      const lines: string[] = [];
      s.phone.enableReceiveCompression("deflate-raw");
      s.phone.onLine((line) => lines.push(line));

      // 构造 64 MiB 全 'a' 明文：压缩后仅约 65 KiB，远小于单帧上限，但解压后远超 16 MiB MAX_MESSAGE
      const compressor = createNodeDeflateCompressor();
      const bombSize = 64 * 1024 * 1024;
      const bombInput = new Uint8Array(bombSize + 1);
      bombInput.fill(0x61, 0, bombSize);
      bombInput[bombSize] = MESSAGE_TERMINATOR;
      const compressedBomb = await compressor.compress(bombInput);
      compressor.close();
      expect(compressedBomb.byteLength).toBeLessThan(128 * 1024);

      s.h.send(
        await encryptFrame(s.key, 0, DATA_FLAGS.compressedEnd, new Uint8Array(compressedBomb)),
      );
      await until(() => s.phone.closeReason !== undefined);

      expect(s.phone.closeReason?.code).toBe("frame_too_large");
      expect(lines).toEqual([]);
      expect(s.phoneSentFrames).toEqual([]);
      expect(readerCancelled).toBe(true);
      // 刚越过 16 MiB 即停读，绝没有把全部 64 MiB 明文读进内存
      expect(totalReadBytes).toBeGreaterThan(MAX_MESSAGE);
      expect(totalReadBytes).toBeLessThan(MAX_MESSAGE + 1024 * 1024);
    } finally {
      globalThis.DecompressionStream = NativeDecompressionStream;
    }
  });

  it("解压数据损坏时直接关闭、报 decrypt_failed 且不回错误帧", async () => {
    const s = await rawHost();
    const lines: string[] = [];
    let closed = false;
    s.phone.enableReceiveCompression("deflate-raw");
    s.phone.onLine((line) => lines.push(line));
    s.phone.onClose(() => {
      closed = true;
    });

    const corruptDeflate = new Uint8Array([0xff, 0xff, 0x01, 0x02, 0x03, 0x04]);
    s.h.send(await encryptFrame(s.key, 0, DATA_FLAGS.compressedEnd, corruptDeflate));
    await until(() => closed && s.phone.closeReason !== undefined);

    expect(s.phone.closeReason?.code).toBe("decrypt_failed");
    expect(lines).toEqual([]);
    expect(s.phoneSentFrames).toEqual([]);
  });

  it("supportsDeflateRawDecompression 在不支持 deflate-raw 时返回 false", () => {
    expect(supportsDeflateRawDecompression()).toBe(true);
    const orig = globalThis.DecompressionStream;
    globalThis.DecompressionStream = function UnsupportedDecompressionStream() {
      throw new TypeError("unsupported format");
    } as unknown as typeof DecompressionStream;
    try {
      expect(supportsDeflateRawDecompression()).toBe(false);
    } finally {
      globalThis.DecompressionStream = orig;
    }
  });
});
