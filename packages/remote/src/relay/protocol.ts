import { publicPoint, transcript, unb64u, type Bytes } from "../encoding.js";
import { verify } from "../crypto.js";
import { asChannelError, fail } from "../errors.js";

export const RELAY_CLOSE_CODES = {
  normal: 1000,
  protocol_error: 4000,
  replaced: 4001,
  host_offline: 4002,
  revoked: 4003,
  auth_failed: 4004,
  rate_limited: 4005,
  limit: 4006,
  slow_consumer: 4007,
  slot_invalid: 4008,
} as const;
export const MAX_CONTROL = 16 * 1024;

export interface RelayDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
  push: boolean;
}
export type RelayMessage =
  | { t: "challenge"; n: string }
  | { t: "auth"; id: string; sig: string; host?: string }
  | { t: "ok"; online?: boolean }
  | { t: "pair.open" }
  | { t: "pair.slot"; slot: string; expiresAt: number }
  | { t: "device.allow"; id: string; pub: string; name: string }
  | { t: "device.allowed"; id: string }
  | { t: "device.remove"; id: string }
  | { t: "device.removed"; id: string }
  | { t: "devices"; list?: RelayDevice[] }
  | { t: "push" }
  | { t: "push.sent"; count: number }
  | { t: "conn.open"; conn: number; kind: "device"; device: string }
  | { t: "conn.open"; conn: number; kind: "pair"; slot: string }
  | { t: "conn.close"; conn: number }
  | { t: "unregister" }
  | { t: "unregistered" }
  | { t: "host"; online: boolean }
  | { t: "push.subscribe"; endpoint: string; p256dh: string; auth: string }
  | { t: "push.subscribed" }
  | { t: "push.unsubscribe" }
  | { t: "push.unsubscribed" }
  | { t: "error"; code: "limit" | "revoked" | "protocol_error" | "push_endpoint" };

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(body: Record<string, unknown>, names: string[]): void {
  if (Object.keys(body).length !== names.length || names.some((key) => !Object.hasOwn(body, key)))
    fail();
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string") fail();
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail();
}
function boolean(value: unknown): void {
  if (typeof value !== "boolean") fail();
}
function name(value: unknown): void {
  text(value);
  let length = 0;
  for (const _char of value) length++;
  if (length < 1 || length > 64) fail();
}

/** Validates every control variant; role/state validation belongs to the receiver. */
export function parseRelayMessage(json: string): RelayMessage {
  try {
    if (new TextEncoder().encode(json).length > MAX_CONTROL) fail();
    const body = object(JSON.parse(json));
    let fields: string[];
    switch (body.t) {
      case "challenge":
        fields = ["n"];
        unb64u(body.n, 32);
        break;
      case "auth":
        fields = Object.hasOwn(body, "host") ? ["id", "host", "sig"] : ["id", "sig"];
        unb64u(body.id, 16);
        unb64u(body.sig, 64);
        if (Object.hasOwn(body, "host")) unb64u(body.host, 16);
        break;
      case "ok":
        fields = Object.hasOwn(body, "online") ? ["online"] : [];
        if (fields.length) boolean(body.online);
        break;
      case "pair.slot":
        fields = ["slot", "expiresAt"];
        unb64u(body.slot, 16);
        integer(body.expiresAt);
        break;
      case "device.allow":
        fields = ["id", "pub", "name"];
        unb64u(body.id, 16);
        publicPoint(unb64u(body.pub, 65));
        name(body.name);
        break;
      case "device.allowed":
      case "device.remove":
      case "device.removed":
        fields = ["id"];
        unb64u(body.id, 16);
        break;
      case "devices":
        fields = Object.hasOwn(body, "list") ? ["list"] : [];
        if (fields.length) {
          if (!Array.isArray(body.list)) fail();
          for (const value of body.list) {
            const device = object(value);
            keys(device, ["id", "name", "createdAt", "lastSeenAt", "online", "push"]);
            unb64u(device.id, 16);
            name(device.name);
            integer(device.createdAt);
            if (device.lastSeenAt !== null) integer(device.lastSeenAt);
            boolean(device.online);
            boolean(device.push);
          }
        }
        break;
      case "push.sent":
        fields = ["count"];
        integer(body.count);
        break;
      case "conn.open":
        integer(body.conn, 0xffffffff);
        if (body.kind === "device") {
          fields = ["conn", "kind", "device"];
          unb64u(body.device, 16);
        } else if (body.kind === "pair") {
          fields = ["conn", "kind", "slot"];
          unb64u(body.slot, 16);
        } else fail();
        break;
      case "conn.close":
        fields = ["conn"];
        integer(body.conn, 0xffffffff);
        break;
      case "host":
        fields = ["online"];
        boolean(body.online);
        break;
      case "push.subscribe":
        fields = ["endpoint", "p256dh", "auth"];
        text(body.endpoint);
        publicPoint(unb64u(body.p256dh, 65));
        unb64u(body.auth, 16);
        break;
      case "error":
        fields = ["code"];
        if (!["limit", "revoked", "protocol_error", "push_endpoint"].includes(String(body.code)))
          fail();
        break;
      case "pair.open":
      case "push":
      case "unregister":
      case "unregistered":
      case "push.subscribed":
      case "push.unsubscribe":
      case "push.unsubscribed":
        fields = [];
        break;
      default:
        fail();
    }
    keys(body, ["t", ...fields]);
    return body as unknown as RelayMessage;
  } catch (error) {
    throw asChannelError(error);
  }
}

export function registerTranscript(origin: string, code: string, pub: Uint8Array): Bytes {
  return transcript("nocturne/relay/v1/register", origin, code, publicPoint(pub));
}
export function hostAuthTranscript(origin: string, nonce: string, hostId: string): Bytes {
  return transcript("nocturne/relay/v1/host", origin, nonce, hostId);
}
export function deviceAuthTranscript(
  origin: string,
  nonce: string,
  deviceId: string,
  hostId: string,
): Bytes {
  return transcript("nocturne/relay/v1/device", origin, nonce, deviceId, hostId);
}
export async function verifySignature(
  pub: Uint8Array,
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    if (sig.length !== 64) return false;
    await verify(pub, new Uint8Array(sig), new Uint8Array(data));
    return true;
  } catch {
    return false;
  }
}

export function parseInvite(text: string): { origin: string; code: string } {
  try {
    const match = /^nocturne-invite:([^/\s?#@]+)\/([A-Za-z0-9_-]{24})$/.exec(text.trim());
    if (match === null) fail();
    const authority = match[1] ?? fail();
    const url = new URL(`https://${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail();
    // URL parsing must not silently accept backslashes or normalize a malformed authority.
    if (authority.includes("\\") || !url.hostname || url.origin === "null") fail();
    const code = match[2] ?? fail();
    unb64u(code, 18);
    return { origin: url.origin.toLowerCase(), code };
  } catch (error) {
    throw asChannelError(error);
  }
}
