import { createECDH, createHash, createCipheriv, createHmac, hkdfSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import vectors from "./vectors.json" with { type: "json" };
import { required } from "./helpers.js";
import { b64u, unb64u, transcript, utf8 } from "../src/encoding.js";
import {
  fingerprint,
  generateIdentity,
  identityId,
  importIdentity,
  exportIdentity,
} from "../src/index.js";
import { hkdf, sign, verify } from "../src/crypto.js";
import { deriveKeys, encryptFrame } from "../src/channel.js";

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const independentT = (label: string, ...fields: (string | Uint8Array)[]) =>
  Buffer.concat([
    Buffer.from(label),
    ...fields.flatMap((field) => {
      const value =
        typeof field === "string" ? Buffer.from(field.normalize("NFC")) : Buffer.from(field);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(value.length);
      return [length, value];
    }),
  ]);

describe("固定向量与同构", () => {
  it("转录 NFC 与 u32be 字段长度：node 独立交叉校验", () => {
    const v = vectors.transcript;
    const fields = [required(v.fields[0]), required(v.fields[1]), bytes(required(v.fields[2]))];
    expect(hex(transcript(v.label, ...fields))).toBe(v.hex);
    expect(independentT(v.label, ...fields).toString("hex")).toBe(v.hex);
  });

  it("固定 ECDH、salt、双向 HKDF、counter 0/1 完整 AES-GCM 帧：node 独立交叉校验", async () => {
    const v = vectors.handshake;
    const p = createECDH("prime256v1"),
      h = createECDH("prime256v1");
    p.setPrivateKey(Buffer.from(v.dP, "base64url"));
    h.setPrivateKey(Buffer.from(v.dH, "base64url"));
    expect(p.getPublicKey().toString("hex")).toBe(v.eP);
    expect(h.getPublicKey().toString("hex")).toBe(v.eH);
    const shared = p.computeSecret(h.getPublicKey());
    expect(shared.toString("hex")).toBe(v.shared);
    expect(h.computeSecret(p.getPublicKey())).toEqual(shared);
    const fields = [v.pubH, v.pubP, v.eP, v.eH, v.nP, v.nH].map(bytes);
    const salt = createHash("sha256")
      .update(independentT("nocturne/hs/v1/salt", ...fields))
      .digest();
    expect(salt.toString("hex")).toBe(v.salt);
    const jwk = {
      kty: "EC",
      crv: "P-256",
      d: v.dP,
      x: b64u(bytes(v.eP).slice(1, 33)),
      y: b64u(bytes(v.eP).slice(33)),
    };
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const publicKey = await crypto.subtle.importKey(
      "raw",
      bytes(v.eH),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    expect(
      hex(
        new Uint8Array(
          await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256),
        ),
      ),
    ).toBe(v.shared);
    const keys = await deriveKeys(privateKey, bytes(v.eH), fields);
    expect(keys.p2h.extractable).toBe(false);
    expect(keys.h2p.extractable).toBe(false);
    for (const [direction, expected] of [
      ["p2h", v.kP2H],
      ["h2p", v.kH2P],
    ]) {
      const info = Buffer.from(`nocturne/hs/v1/${direction}`);
      expect(Buffer.from(hkdfSync("sha256", shared, salt, info, 32)).toString("hex")).toBe(
        expected,
      );
      expect(hex(await hkdf(bytes(v.shared), bytes(v.salt), new Uint8Array(info)))).toBe(expected);
    }
    for (const [counter, message] of vectors.messages.entries()) {
      const head = Buffer.alloc(9);
      head[0] = 16;
      head.writeBigUInt64BE(BigInt(counter), 1);
      const iv = Buffer.concat([Buffer.alloc(4), head.subarray(1)]);
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(v.kP2H, "hex"), iv);
      cipher.setAAD(head);
      const frame = Buffer.concat([
        head,
        cipher.update(Buffer.concat([Buffer.from([0]), Buffer.from(message)])),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      expect(frame.toString("hex")).toBe(vectors.frames[counter]);
      expect(hex(await encryptFrame(keys.p2h, counter, 0, utf8(message)))).toBe(
        vectors.frames[counter],
      );
    }
    const reverse = await encryptFrame(keys.h2p, 0, 0, utf8("reverse"));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(12), additionalData: reverse.slice(0, 9) },
      await crypto.subtle.importKey("raw", bytes(v.kH2P), "AES-GCM", false, ["decrypt"]),
      reverse.slice(9),
    );
    expect(new TextDecoder().decode(new Uint8Array(plain).slice(1))).toBe("reverse");
  });

  it("固定配对 K、slot、macKey 与 Th HMAC：node 独立交叉校验", async () => {
    const v = vectors.pairing;
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(v.K, "hex"),
        Buffer.from("nocturne/pair/v1"),
        Buffer.from(`mac:${v.slot}`),
        32,
      ),
    );
    expect(key.toString("hex")).toBe(v.macKey);
    const data = independentT("nocturne/pair/v1/hello", v.slot, bytes(v.pubP), v.name, bytes(v.nP));
    expect(createHmac("sha256", key).update(data).digest("hex")).toBe(v.hmac);
    const raw = await hkdf(bytes(v.K), utf8("nocturne/pair/v1"), utf8(`mac:${v.slot}`));
    expect(hex(raw)).toBe(v.macKey);
    const macKey = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expect(
      hex(
        new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            macKey,
            transcript("nocturne/pair/v1/hello", v.slot, bytes(v.pubP), v.name, bytes(v.nP)),
          ),
        ),
      ),
    ).toBe(v.hmac);
  });

  it("ECDSA 签名能验，改一个字节验不过；身份导入导出与不可导出手机", async () => {
    const identity = await generateIdentity({ extractable: true });
    const restored = await importIdentity(await exportIdentity(identity), { extractable: false });
    expect(restored.id).toBe(identity.id);
    expect(restored.publicKey).toEqual(identity.publicKey);
    expect(restored.id).toBe(await identityId(restored.publicKey));
    expect(await fingerprint(restored.publicKey)).toHaveLength(32);
    const data = utf8("签名"),
      signature = await sign(restored.privateKey, data);
    expect(signature).toHaveLength(64);
    await verify(identity.publicKey, signature, data);
    signature[0] = required(signature[0]) ^ 1;
    await expect(verify(identity.publicKey, signature, data)).rejects.toMatchObject({
      code: "bad_signature",
    });
    await expect(exportIdentity(restored)).rejects.toMatchObject({ code: "protocol_error" });
    await expect(
      exportIdentity(await generateIdentity({ extractable: false })),
    ).rejects.toMatchObject({ code: "protocol_error" });
    await expect(importIdentity("{}", { extractable: true })).rejects.toMatchObject({
      code: "protocol_error",
    });
  });

  it("base64url 拒绝填充、非法字符、非规范尾位；raw 公钥格式校验", async () => {
    for (const text of ["a=", "a+", "a/", "a", "AB", "@@"]) expect(() => unb64u(text)).toThrow();
    for (let size = 0; size < 100; size++) {
      const data = crypto.getRandomValues(new Uint8Array(size));
      expect(b64u(data)).toBe(Buffer.from(data).toString("base64url"));
      expect(unb64u(b64u(data))).toEqual(data);
    }
    await expect(fingerprint(new Uint8Array(64))).rejects.toMatchObject({ code: "protocol_error" });
    await expect(fingerprint(new Uint8Array(65))).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("src 源码不含 Node 全局或内置模块", () => {
    const root = new URL("../src/", import.meta.url);
    for (const file of readdirSync(root).filter((name) => name.endsWith(".ts"))) {
      expect(readFileSync(new URL(file, root), "utf8"), file).not.toMatch(
        /\bBuffer\b|\bprocess\b|node:/,
      );
    }
  });
});
