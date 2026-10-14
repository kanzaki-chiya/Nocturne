import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateIdentity } from "../src/crypto.js";
import { b64u } from "../src/encoding.js";
import {
  parseInvite,
  parseRelayMessage,
  registerTranscript,
  hostAuthTranscript,
  deviceAuthTranscript,
  verifySignature,
} from "../src/relay/protocol.js";

const code = "AAAAAAAAAAAAAAAAAAAAAAAA";
describe("relay protocol", () => {
  it("解析邀请并规范化主机与端口", () => {
    expect(parseInvite(`  nocturne-invite:RELAY.Example:8443/${code}\n`)).toEqual({
      origin: "https://relay.example:8443",
      code,
    });
    expect(parseInvite(`nocturne-invite:relay.example/${code}`).origin).toBe(
      "https://relay.example",
    );
  });
  it.each([
    `nocturne-invite:http://example/${code}`,
    `nocturne-invite:user@example/${code}`,
    `nocturne-invite:example/path/${code}`,
    `nocturne-invite:example/${code}?q=1`,
    `nocturne-invite:example/${code}#x`,
    `nocturne-invite:example\\evil/${code}`,
    "nocturne-invite:example/short",
    `https://example/${code}`,
  ])("拒绝非法邀请 %s", (input) => {
    expect(() => parseInvite(input)).toThrow(expect.objectContaining({ code: "protocol_error" }));
  });
  it("三种转录固定向量由 Node 独立交叉校验", () => {
    const pub = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i)]);
    const origin = "https://relay.example";
    const n = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const independent = (label: string, ...fields: (string | Uint8Array)[]) =>
      Buffer.concat([
        Buffer.from(label),
        ...fields.flatMap((f) => {
          const bytes = typeof f === "string" ? Buffer.from(f.normalize("NFC")) : Buffer.from(f);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(bytes.length);
          return [length, bytes];
        }),
      ]);
    const vectors = [
      [
        registerTranscript(origin, code, pub),
        independent("nocturne/relay/v1/register", origin, code, pub),
      ],
      [hostAuthTranscript(origin, n, id), independent("nocturne/relay/v1/host", origin, n, id)],
      [
        deviceAuthTranscript(origin, n, id, id),
        independent("nocturne/relay/v1/device", origin, n, id, id),
      ],
    ] as const;
    for (const [actual, expected] of vectors) {
      expect(Buffer.from(actual)).toEqual(expected);
      expect(createHash("sha256").update(actual).digest()).toEqual(
        createHash("sha256").update(expected).digest(),
      );
    }
  });
  it("签名与 Node 验签互通，篡改返回 false", async () => {
    const identity = await generateIdentity({ extractable: true });
    const data = registerTranscript("https://relay.example", code, identity.publicKey);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, data),
    );
    expect(await verifySignature(identity.publicKey, sig, data)).toBe(true);
    const jwk = await crypto.subtle.exportKey(
      "jwk",
      await crypto.subtle.importKey(
        "raw",
        new Uint8Array(identity.publicKey),
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      ),
    );
    expect(
      verify(
        "sha256",
        data,
        { key: createPublicKey({ key: { ...jwk }, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        sig,
      ),
    ).toBe(true);
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(await verifySignature(identity.publicKey, sig, data)).toBe(false);
  });
  it("解析所有控制消息变体", () => {
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const pub = b64u(Uint8Array.from([4, ...new Uint8Array(64)]));
    const messages = [
      { t: "challenge", n: b64u(new Uint8Array(32)) },
      { t: "auth", id, sig: b64u(new Uint8Array(64)) },
      { t: "auth", id, host: id, sig: b64u(new Uint8Array(64)) },
      { t: "ok" },
      { t: "ok", online: false },
      { t: "pair.open" },
      { t: "pair.slot", slot: id, expiresAt: 1 },
      { t: "device.allow", id, pub, name: "手机" },
      ...["device.allowed", "device.remove", "device.removed"].map((t) => ({ t, id })),
      { t: "devices" },
      {
        t: "devices",
        list: [{ id, name: "手机", createdAt: 1, lastSeenAt: null, online: false, push: false }],
      },
      { t: "push" },
      { t: "push.sent", count: 1 },
      { t: "conn.open", conn: 1, kind: "device", device: id },
      { t: "conn.open", conn: 2, kind: "pair", slot: id },
      { t: "conn.close", conn: 2 },
      { t: "unregister" },
      { t: "unregistered" },
      { t: "host", online: true },
      {
        t: "push.subscribe",
        endpoint: "https://push.example",
        p256dh: pub,
        auth: b64u(new Uint8Array(16)),
      },
      { t: "push.subscribed" },
      { t: "push.unsubscribe" },
      { t: "push.unsubscribed" },
      ...["limit", "revoked", "protocol_error", "push_endpoint"].map((code) => ({
        t: "error",
        code,
      })),
    ];
    for (const message of messages)
      expect(parseRelayMessage(JSON.stringify(message))).toEqual(message);
  });
  it.each([
    '{"t":"push","extra":0}',
    '{"t":"challenge"}',
    '{"t":"unknown"}',
    "[]",
    '{"t":"ok","online":0}',
    '{"t":"conn.close","conn":4294967296}',
    '{"t":"error","code":"other"}',
  ])("拒绝字段或类型错误 %s", (json) => {
    expect(() => parseRelayMessage(json)).toThrow(
      expect.objectContaining({ code: "protocol_error" }),
    );
  });
  it("拒绝超过 16 KiB 的控制消息（按 UTF-8 字节）", () => {
    expect(() =>
      parseRelayMessage(
        JSON.stringify({ t: "push.subscribe", endpoint: "中".repeat(6000), p256dh: "", auth: "" }),
      ),
    ).toThrow();
  });
});
