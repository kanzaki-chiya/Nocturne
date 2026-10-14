import { fail } from "./errors.js";

export type Bytes = Uint8Array<ArrayBuffer>;
export const MAX_FRAME = 1_048_576;
export const MAX_MESSAGE = 16 * 1024 * 1024;
export const FRAME_TYPES = {
  init: 0x01,
  response: 0x02,
  finish: 0x03,
  pairingHello: 0x08,
  pairingAccept: 0x09,
  data: 0x10,
  error: 0x7f,
} as const;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64u(bytes: Uint8Array): string {
  let result = "";
  let bits = 0,
    value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += alphabet.charAt((value >>> bits) & 63);
    }
  }
  if (bits > 0) result += alphabet.charAt((value << (6 - bits)) & 63);
  return result;
}

export function unb64u(text: unknown, length?: number): Bytes {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) fail();
  const result = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0,
    value = 0,
    index = 0;
  for (const char of text) {
    value = (value << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[index++] = (value >>> bits) & 255;
    }
  }
  if (b64u(result) !== text || (length !== undefined && result.length !== length)) fail();
  return result;
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text.normalize("NFC"));
}

export function concat(...parts: Uint8Array[]): Bytes {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function transcript(label: string, ...fields: (string | Uint8Array)[]): Bytes {
  return concat(
    utf8(label),
    ...fields.flatMap((field) => {
      const bytes = typeof field === "string" ? utf8(field) : field;
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.length);
      return [length, bytes];
    }),
  );
}

export function publicPoint(value: Uint8Array): Bytes {
  if (value.length !== 65 || value[0] !== 4) fail();
  return new Uint8Array(value);
}

export function jsonFrame(type: number, body: object): Bytes {
  const frame = concat(new Uint8Array([type]), new TextEncoder().encode(JSON.stringify(body)));
  if (frame.length > 4096) fail();
  return frame;
}

export function parseFrame(
  frame: Uint8Array,
  type: number,
  keys: string[],
): Record<string, unknown> {
  if (frame.length > 4096 || frame[0] !== type) fail();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(1)));
  } catch {
    fail();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail();
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key)))
    fail();
  return body as Record<string, unknown>;
}

export function version(body: Record<string, unknown>): void {
  if (body.v !== 1) fail("version_mismatch");
}
