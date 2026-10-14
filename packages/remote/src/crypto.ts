import { concat, publicPoint, unb64u, b64u, type Bytes } from "./encoding.js";
import { asChannelError, fail } from "./errors.js";

export interface Identity {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  id: string;
}

export async function fingerprint(pub: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", publicPoint(pub)));
}

export async function identityId(pub: Uint8Array): Promise<string> {
  return b64u((await fingerprint(pub)).subarray(0, 16));
}

export async function generateIdentity({
  extractable,
}: {
  extractable: boolean;
}): Promise<Identity> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["sign", "verify"],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  return { privateKey: keys.privateKey, publicKey, id: await identityId(publicKey) };
}

export async function exportIdentity(identity: Identity): Promise<string> {
  try {
    return JSON.stringify(await crypto.subtle.exportKey("jwk", identity.privateKey));
  } catch {
    fail();
  }
}

export async function importIdentity(
  json: string,
  { extractable }: { extractable: boolean },
): Promise<Identity> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) fail();
    const jwk = value as JsonWebKey;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") fail();
    unb64u(jwk.d, 32);
    const publicKey = concat(new Uint8Array([4]), unb64u(jwk.x, 32), unb64u(jwk.y, 32));
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      extractable,
      ["sign"],
    );
    await verify(publicKey, new Uint8Array(await sign(privateKey, publicKey)), publicKey);
    return { privateKey, publicKey, id: await identityId(publicKey) };
  } catch (error) {
    throw asChannelError(error);
  }
}

export function random(size: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(size));
}

export async function sign(key: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
}

export async function verify(pub: Uint8Array, signature: Bytes, data: Bytes): Promise<void> {
  const key = await crypto.subtle.importKey(
    "raw",
    publicPoint(pub),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data)))
    fail("bad_signature");
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, 256),
  );
}
