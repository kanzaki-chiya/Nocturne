import { expect } from "vitest";
import {
  acceptChannel,
  connectChannel,
  createMemoryFramePair,
  generateIdentity,
  type FrameTransport,
  type Identity,
} from "../src/index.js";
import { jsonFrame } from "../src/encoding.js";

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("缺少预期测试值");
  return value;
}

export function body(frame: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(frame.subarray(1))) as Record<string, unknown>;
}
export function edit(frame: Uint8Array, patch: Record<string, unknown>): Uint8Array {
  return jsonFrame(frame[0] ?? 0, { ...body(frame), ...patch });
}
export function wire(
  transport: FrameTransport,
  transform: (frame: Uint8Array) => Uint8Array[] = (f) => [f],
): FrameTransport {
  return {
    ...transport,
    send: (frame) => {
      for (const f of transform(new Uint8Array(frame))) transport.send(f);
    },
  };
}
export async function identities(): Promise<{ host: Identity; phone: Identity }> {
  return {
    host: await generateIdentity({ extractable: true }),
    phone: await generateIdentity({ extractable: false }),
  };
}
export async function connected(
  options: {
    ids?: { host: Identity; phone: Identity };
    p2h?: (frame: Uint8Array) => Uint8Array[];
    h2p?: (frame: Uint8Array) => Uint8Array[];
  } = {},
) {
  const ids = options.ids ?? (await identities());
  const [p, h] = createMemoryFramePair();
  const phoneWire = wire(p, options.p2h),
    hostWire = wire(h, options.h2p);
  const [phone, accepted] = await Promise.all([
    connectChannel(phoneWire, { identity: ids.phone, hostPublicKey: ids.host.publicKey }),
    acceptChannel(hostWire, {
      identity: ids.host,
      lookupDevice: async (id) => (id === ids.phone.id ? ids.phone.publicKey : undefined),
    }),
  ]);
  expect(accepted.deviceId).toBe(ids.phone.id);
  return { phone, host: accepted.channel, phoneWire, hostWire, ids };
}
export async function until(test: () => boolean): Promise<void> {
  await expect.poll(test, { timeout: 5000 }).toBe(true);
}
