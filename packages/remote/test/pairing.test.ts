import { describe, expect, it } from "vitest";
import {
  createPairingOffer,
  parsePairingFragment,
  createPairingHello,
  acceptPairingHello,
  finishPairing,
  generateIdentity,
} from "../src/index.js";
import { b64u, jsonFrame, transcript, utf8, unb64u } from "../src/encoding.js";
import { hkdf, sign } from "../src/crypto.js";
import { body, edit, identities } from "./helpers.js";

const slot = b64u(new Uint8Array(16).fill(4));
async function setup() {
  const ids = await identities();
  const offer = await createPairingOffer(ids.host, slot);
  const parsed = parsePairingFragment(`#${offer.fragment}`);
  const hello = await createPairingHello(ids.phone, parsed, "  手机 e\u0301 🌙  ");
  return { ...ids, offer, parsed, hello };
}

describe("扫码配对", () => {
  it("正常流程，设备名 trim/NFC，双方身份一致，secret 成功后作废", async () => {
    const s = await setup();
    expect(parsePairingFragment(s.offer.fragment)).toEqual(s.parsed);
    const accepted = await acceptPairingHello(s.host, s.offer.secret, s.hello.message);
    expect(accepted.device).toEqual({
      id: s.phone.id,
      publicKey: s.phone.publicKey,
      name: "手机 é 🌙",
    });
    expect(await finishPairing(s.hello.state, accepted.reply)).toEqual({
      hostId: s.host.id,
      hostPublicKey: s.host.publicKey,
    });
    await expect(acceptPairingHello(s.host, s.offer.secret, s.hello.message)).rejects.toMatchObject(
      { code: "protocol_error" },
    );
  });

  it("K 错误为 bad_mac，secret 失败后也作废", async () => {
    const s = await setup();
    const hello = await createPairingHello(
      s.phone,
      { ...s.parsed, key: new Uint8Array(32) },
      "手机",
    );
    await expect(acceptPairingHello(s.host, s.offer.secret, hello.message)).rejects.toMatchObject({
      code: "bad_mac",
    });
    await expect(acceptPairingHello(s.host, s.offer.secret, s.hello.message)).rejects.toMatchObject(
      { code: "protocol_error" },
    );
  });

  it.each(["name", "pub", "n"])("中途篡改 %s 不能通过 MAC", async (field) => {
    const s = await setup();
    const attacker = await generateIdentity({ extractable: true });
    const value =
      field === "name"
        ? "另一手机"
        : field === "pub"
          ? b64u(attacker.publicKey)
          : b64u(new Uint8Array(32));
    await expect(
      acceptPairingHello(s.host, s.offer.secret, edit(s.hello.message, { [field]: value })),
    ).rejects.toMatchObject({ code: "bad_mac" });
  });

  it("正确 MAC 但手机签名被改为 bad_signature", async () => {
    const s = await setup();
    await expect(
      acceptPairingHello(
        s.host,
        s.offer.secret,
        edit(s.hello.message, { sig: b64u(new Uint8Array(64)) }),
      ),
    ).rejects.toMatchObject({ code: "bad_signature" });
  });

  it.each([false, true])(
    "中继换公钥并重签，掌握 K=%s 仍 fingerprint_mismatch",
    async (knowsKey) => {
      const s = await setup();
      const attacker = await generateIdentity({ extractable: true });
      const n = new Uint8Array(32).fill(7),
        h = body(s.hello.message);
      const data = transcript(
        "nocturne/pair/v1/accept",
        slot,
        s.phone.publicKey,
        h.name as string,
        unb64u(h.n),
        attacker.publicKey,
        n,
      );
      const raw = await hkdf(
        knowsKey ? new Uint8Array(s.parsed.key) : new Uint8Array(32),
        utf8("nocturne/pair/v1"),
        utf8(`mac:${slot}`),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const reply = jsonFrame(9, {
        v: 1,
        pub: b64u(attacker.publicKey),
        n: b64u(n),
        sig: b64u(await sign(attacker.privateKey, data)),
        mac: b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, data))),
      });
      await expect(finishPairing(s.hello.state, reply)).rejects.toMatchObject({
        code: "fingerprint_mismatch",
      });
    },
  );

  it("电脑指纹正确但回复 MAC 错误为 bad_mac；签名错误为 bad_signature", async () => {
    for (const [field, code, length] of [
      ["mac", "bad_mac", 32],
      ["sig", "bad_signature", 64],
    ] as const) {
      const s = await setup();
      const accepted = await acceptPairingHello(s.host, s.offer.secret, s.hello.message);
      await expect(
        finishPairing(
          s.hello.state,
          edit(accepted.reply, { [field]: b64u(new Uint8Array(length)) }),
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it("片段与 slot 格式错误，空名、超过 64 字符被拒，64 个 Unicode 码点通过", async () => {
    const s = await setup();
    for (const fragment of [
      "",
      "pair=abc",
      `${s.offer.fragment}=`,
      `pair=${slot}.AA.AA`,
      `pair=a.${b64u(s.parsed.key)}.${b64u(s.parsed.hostFingerprint)}`,
    ])
      expect(() => parsePairingFragment(fragment)).toThrow();
    for (const badSlot of ["", "abc", `${slot}=`, slot.slice(1)])
      await expect(createPairingOffer(s.host, badSlot)).rejects.toMatchObject({
        code: "protocol_error",
      });
    for (const name of ["", "  ", "🌙".repeat(65)])
      await expect(createPairingHello(s.phone, s.parsed, name)).rejects.toMatchObject({
        code: "protocol_error",
      });
    await createPairingHello(s.phone, s.parsed, "🌙".repeat(64));
  });

  it.each([
    [{ extra: 1 }, "protocol_error"],
    [{ v: 2 }, "version_mismatch"],
  ] as const)("hello 多余字段/版本：%j", async (patch, code) => {
    const s = await setup();
    await expect(
      acceptPairingHello(s.host, s.offer.secret, edit(s.hello.message, patch)),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    [{ extra: 1 }, "protocol_error"],
    [{ v: 2 }, "version_mismatch"],
  ] as const)("accept 多余字段/版本：%j", async (patch, code) => {
    const s = await setup();
    const accepted = await acceptPairingHello(s.host, s.offer.secret, s.hello.message);
    await expect(finishPairing(s.hello.state, edit(accepted.reply, patch))).rejects.toMatchObject({
      code,
    });
  });

  it("配对帧大于 4 KiB 或非法 UTF-8 被拒", async () => {
    for (const message of [new Uint8Array(4097).fill(8), new Uint8Array([8, 0xff])]) {
      const s = await setup();
      await expect(acceptPairingHello(s.host, s.offer.secret, message)).rejects.toMatchObject({
        code: "protocol_error",
      });
    }
  });
});
