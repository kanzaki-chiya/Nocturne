import { fingerprint, identityId, hkdf, random, sign, verify, type Identity } from "./crypto.js";
import {
  b64u,
  unb64u,
  utf8,
  transcript,
  jsonFrame,
  parseFrame,
  publicPoint,
  version,
  FRAME_TYPES,
  type Bytes,
} from "./encoding.js";
import { asChannelError, fail } from "./errors.js";

export interface ParsedOffer {
  slot: string;
  key: Uint8Array;
  hostFingerprint: Uint8Array;
}
export interface PairingSecret {
  readonly slot: string;
}
interface SecretData {
  key: Bytes;
  used: boolean;
}
const secrets = new WeakMap<PairingSecret, SecretData>();
export interface PairingState {
  readonly slot: string;
}
interface StateData {
  offer: ParsedOffer;
  publicKey: Bytes;
  name: string;
  nonce: Bytes;
}
const states = new WeakMap<PairingState, StateData>();

function slotId(slot: string): void {
  unb64u(slot, 16);
}
function deviceName(value: unknown): string {
  if (typeof value !== "string") fail();
  const name = value.trim().normalize("NFC");
  let length = 0;
  for (const _char of name) length++;
  if (length < 1 || length > 64) fail();
  return name;
}
async function macKey(key: Uint8Array, slot: string): Promise<CryptoKey> {
  if (key.length !== 32) fail();
  const raw = await hkdf(new Uint8Array(key), utf8("nocturne/pair/v1"), utf8(`mac:${slot}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
async function mac(key: CryptoKey, data: Bytes): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}
async function verifyMac(key: CryptoKey, value: unknown, data: Bytes): Promise<void> {
  if (!(await crypto.subtle.verify("HMAC", key, unb64u(value, 32), data))) fail("bad_mac");
}

export async function createPairingOffer(
  host: Identity,
  slot: string,
): Promise<{ fragment: string; secret: PairingSecret }> {
  slotId(slot);
  const key = random(32),
    secret = Object.freeze({ slot });
  secrets.set(secret, { key, used: false });
  return {
    fragment: `pair=${slot}.${b64u(key)}.${b64u(await fingerprint(host.publicKey))}`,
    secret,
  };
}

export function parsePairingFragment(fragment: string): ParsedOffer {
  const match = /^#?pair=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(fragment);
  if (match === null) fail();
  const slot = match[1] ?? "";
  slotId(slot);
  return { slot, key: unb64u(match[2], 32), hostFingerprint: unb64u(match[3], 32) };
}

export async function createPairingHello(
  phone: Identity,
  offer: ParsedOffer,
  name: string,
): Promise<{ message: Uint8Array; state: PairingState }> {
  try {
    slotId(offer.slot);
    if (offer.hostFingerprint.length !== 32) fail();
    const normalized = deviceName(name),
      nonce = random(32),
      pub = publicPoint(phone.publicKey);
    const key = await macKey(offer.key, offer.slot);
    const data = transcript("nocturne/pair/v1/hello", offer.slot, pub, normalized, nonce);
    const state = Object.freeze({ slot: offer.slot });
    states.set(state, {
      offer: {
        ...offer,
        key: new Uint8Array(offer.key),
        hostFingerprint: new Uint8Array(offer.hostFingerprint),
      },
      publicKey: pub,
      name: normalized,
      nonce,
    });
    return {
      message: jsonFrame(FRAME_TYPES.pairingHello, {
        v: 1,
        pub: b64u(pub),
        name: normalized,
        n: b64u(nonce),
        sig: b64u(await sign(phone.privateKey, data)),
        mac: await mac(key, data),
      }),
      state,
    };
  } catch (error) {
    throw asChannelError(error);
  }
}

export async function acceptPairingHello(
  host: Identity,
  secret: PairingSecret,
  message: Uint8Array,
): Promise<{ reply: Uint8Array; device: { id: string; publicKey: Uint8Array; name: string } }> {
  const stored = secrets.get(secret);
  if (stored === undefined || stored.used) fail();
  stored.used = true;
  const keyBytes = stored.key.slice();
  stored.key.fill(0);
  try {
    const body = parseFrame(message, FRAME_TYPES.pairingHello, [
      "v",
      "pub",
      "name",
      "n",
      "sig",
      "mac",
    ]);
    version(body);
    const pub = publicPoint(unb64u(body.pub)),
      name = deviceName(body.name),
      nonce = unb64u(body.n, 32);
    const key = await macKey(keyBytes, secret.slot);
    const hello = transcript("nocturne/pair/v1/hello", secret.slot, pub, name, nonce);
    await verifyMac(key, body.mac, hello);
    await verify(pub, unb64u(body.sig, 64), hello);
    const hostNonce = random(32);
    const accept = transcript(
      "nocturne/pair/v1/accept",
      secret.slot,
      pub,
      name,
      nonce,
      host.publicKey,
      hostNonce,
    );
    return {
      reply: jsonFrame(FRAME_TYPES.pairingAccept, {
        v: 1,
        pub: b64u(host.publicKey),
        n: b64u(hostNonce),
        sig: b64u(await sign(host.privateKey, accept)),
        mac: await mac(key, accept),
      }),
      device: { id: await identityId(pub), publicKey: pub, name },
    };
  } catch (error) {
    throw asChannelError(error);
  } finally {
    keyBytes.fill(0);
  }
}

export async function finishPairing(
  state: PairingState,
  reply: Uint8Array,
): Promise<{ hostId: string; hostPublicKey: Uint8Array }> {
  try {
    const stored = states.get(state);
    if (stored === undefined) fail();
    states.delete(state);
    const body = parseFrame(reply, FRAME_TYPES.pairingAccept, ["v", "pub", "n", "sig", "mac"]);
    version(body);
    const pub = publicPoint(unb64u(body.pub));
    if (b64u(await fingerprint(pub)) !== b64u(stored.offer.hostFingerprint))
      fail("fingerprint_mismatch");
    const data = transcript(
      "nocturne/pair/v1/accept",
      state.slot,
      stored.publicKey,
      stored.name,
      stored.nonce,
      pub,
      unb64u(body.n, 32),
    );
    await verifyMac(await macKey(stored.offer.key, state.slot), body.mac, data);
    await verify(pub, unb64u(body.sig, 64), data);
    return { hostId: await identityId(pub), hostPublicKey: pub };
  } catch (error) {
    throw asChannelError(error);
  }
}
