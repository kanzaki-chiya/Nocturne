import { sign, type Identity } from "../crypto.js";
import { b64u, concat } from "../encoding.js";
import { RemoteChannelError } from "../errors.js";
import type { FrameTransport } from "../transport.js";
import {
  parseRelayMessage,
  registerTranscript,
  hostAuthTranscript,
  deviceAuthTranscript,
  type RelayMessage,
  type RelayDevice,
} from "./protocol.js";

export class RelayError extends Error {
  constructor(
    readonly code:
      | "invalid_invite"
      | "already_registered"
      | "rate_limited"
      | "limit"
      | "revoked"
      | "protocol_error"
      | "push_endpoint"
      | "closed",
  ) {
    super(`中继请求失败：${code}`);
    this.name = "RelayError";
  }
}
function originUrl(origin: string): URL {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new RemoteChannelError("protocol_error");
  return url;
}
export async function registerHost(options: {
  origin: string;
  code: string;
  identity: Identity;
  fetch?: typeof fetch;
}): Promise<{ hostId: string }> {
  originUrl(options.origin);
  const sig = await sign(
    options.identity.privateKey,
    registerTranscript(options.origin, options.code, options.identity.publicKey),
  );
  const response = await (options.fetch ?? fetch)(`${options.origin}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: options.code,
      pub: b64u(options.identity.publicKey),
      sig: b64u(sig),
    }),
  });
  if (response.status === 403) throw new RelayError("invalid_invite");
  if (response.status === 409) throw new RelayError("already_registered");
  if (response.status === 429) throw new RelayError("rate_limited");
  const result: unknown = await response.json();
  if (
    !response.ok ||
    typeof result !== "object" ||
    result === null ||
    !("hostId" in result) ||
    result.hostId !== options.identity.id ||
    Object.keys(result).length !== 1
  )
    throw new RelayError("protocol_error");
  return { hostId: options.identity.id };
}
function frameTransport(
  send: (frame: Uint8Array) => void,
  close: () => void,
): { transport: FrameTransport; receive: (frame: Uint8Array) => void; stop: () => void } {
  let handler: ((frame: Uint8Array) => void) | undefined, closer: (() => void) | undefined;
  let stopped = false,
    notified = false;
  const pending: Uint8Array[] = [];
  const deliver = (): void => {
    while (handler && pending.length) {
      const frame = pending.shift();
      if (frame) handler(frame);
    }
    if (stopped && !pending.length && closer && !notified) {
      notified = true;
      closer();
    }
  };
  return {
    transport: {
      send(frame) {
        if (!stopped) send(frame);
      },
      close,
      onFrame(fn) {
        handler = fn;
        queueMicrotask(deliver);
      },
      onClose(fn) {
        closer = fn;
        queueMicrotask(deliver);
      },
    },
    receive(frame) {
      if (!stopped) {
        pending.push(new Uint8Array(frame));
        deliver();
      }
    },
    stop() {
      stopped = true;
      deliver();
    },
  };
}
type FrameEnd = ReturnType<typeof frameTransport>;
interface SocketState {
  socket: WebSocket;
  request: (message: RelayMessage, expected: RelayMessage["t"]) => Promise<RelayMessage>;
  onControl: (handler: (message: RelayMessage) => void) => void;
  onBinary: (handler: (frame: Uint8Array) => void) => void;
  onClose: (handler: (code: number) => void) => void;
  initial: RelayMessage;
}
async function socketConnection(
  origin: string,
  path: string,
  auth?: (nonce: string) => Promise<RelayMessage>,
): Promise<SocketState> {
  const url = originUrl(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${url.origin}${path}`);
  socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    let ready = false,
      closed: number | undefined;
    let control: ((msg: RelayMessage) => void) | undefined,
      binary: ((frame: Uint8Array) => void) | undefined;
    const controls: RelayMessage[] = [],
      frames: Uint8Array[] = [],
      closers: ((code: number) => void)[] = [];
    let waiter:
      | { expected: string; resolve: (msg: RelayMessage) => void; reject: (error: Error) => void }
      | undefined;
    let outgoing = Promise.resolve(),
      incoming = Promise.resolve();
    const timer = setTimeout(() => {
      reject(new RelayError("closed"));
      socket.close();
    }, 10000);
    const state = (initial: RelayMessage): SocketState => ({
      socket,
      initial,
      request(message, expected) {
        const task = outgoing.then(
          () =>
            new Promise<RelayMessage>((done, fail) => {
              if (closed !== undefined) {
                fail(new RelayError("closed"));
                return;
              }
              waiter = { expected, resolve: done, reject: fail };
              socket.send(JSON.stringify(message));
            }),
        );
        outgoing = task.then(
          () => {
            /* 队列继续。 */
          },
          () => {
            /* 失败不阻断后续请求。 */
          },
        );
        return task;
      },
      onControl(handler) {
        control = handler;
        for (const msg of controls.splice(0)) handler(msg);
      },
      onBinary(handler) {
        binary = handler;
        for (const frame of frames.splice(0)) handler(frame);
      },
      onClose(handler) {
        if (closed !== undefined)
          queueMicrotask(() => {
            handler(closed ?? 1000);
          });
        else closers.push(handler);
      },
    });
    const complete = (initial: RelayMessage): void => {
      ready = true;
      clearTimeout(timer);
      resolve(state(initial));
    };
    socket.addEventListener("open", () => {
      if (!auth) complete({ t: "ok" });
    });
    socket.addEventListener("message", (event) => {
      incoming = incoming
        .then(async () => {
          if (typeof event.data !== "string") {
            if (!ready || !(event.data instanceof ArrayBuffer))
              throw new RelayError("protocol_error");
            const frame = new Uint8Array(event.data);
            if (binary) binary(frame);
            else frames.push(frame);
            return;
          }
          const msg = parseRelayMessage(event.data);
          if (!ready) {
            if (msg.t === "challenge" && auth) socket.send(JSON.stringify(await auth(msg.n)));
            else if (msg.t === "ok") complete(msg);
            else throw new RelayError("protocol_error");
          } else if (waiter && (msg.t === waiter.expected || msg.t === "error")) {
            const active = waiter;
            waiter = undefined;
            if (msg.t === "error") active.reject(new RelayError(msg.code));
            else active.resolve(msg);
          } else if (control) control(msg);
          else controls.push(msg);
        })
        .catch(() => {
          socket.close(4000, "protocol_error");
        });
    });
    socket.addEventListener("close", (event) => {
      closed = event.code;
      clearTimeout(timer);
      if (!ready) reject(new RelayError("closed"));
      waiter?.reject(new RelayError("closed"));
      waiter = undefined;
      for (const handler of closers) handler(event.code);
    });
    socket.addEventListener("error", () => {
      if (!ready) {
        clearTimeout(timer);
        reject(new RelayError("closed"));
      }
    });
  });
}
export interface RelayConnection {
  conn: number;
  kind: "device" | "pair";
  device?: string;
  slot?: string;
  transport: FrameTransport;
}
export interface HostRelay {
  onConnection(handler: (connection: RelayConnection) => void): void;
  openPairingSlot(): Promise<{ slot: string; expiresAt: number }>;
  allowDevice(device: { id: string; publicKey: Uint8Array; name: string }): Promise<void>;
  removeDevice(id: string): Promise<void>;
  listDevices(): Promise<RelayDevice[]>;
  push(): Promise<number>;
  unregister(): Promise<void>;
  close(): void;
  onClose(handler: (code: number) => void): void;
}
export async function connectHostRelay(options: {
  origin: string;
  identity: Identity;
  hostId: string;
}): Promise<HostRelay> {
  const state = await socketConnection(options.origin, "/v1/host", async (n) => ({
    t: "auth",
    id: options.hostId,
    sig: b64u(
      await sign(
        options.identity.privateKey,
        hostAuthTranscript(options.origin, n, options.hostId),
      ),
    ),
  }));
  const routes = new Map<number, FrameEnd>(),
    pending: RelayConnection[] = [];
  let handler: ((connection: RelayConnection) => void) | undefined;
  state.onControl((msg) => {
    if (msg.t === "conn.open") {
      const end = frameTransport(
        (frame) => {
          const header = new Uint8Array(4);
          new DataView(header.buffer).setUint32(0, msg.conn);
          state.socket.send(concat(header, frame));
        },
        () => {
          state.socket.send(JSON.stringify({ t: "conn.close", conn: msg.conn }));
        },
      );
      routes.set(msg.conn, end);
      const connection: RelayConnection = {
        conn: msg.conn,
        kind: msg.kind,
        transport: end.transport,
        ...(msg.kind === "device" ? { device: msg.device } : { slot: msg.slot }),
      };
      if (handler) handler(connection);
      else pending.push(connection);
    } else if (msg.t === "conn.close") {
      routes.get(msg.conn)?.stop();
      routes.delete(msg.conn);
    } else state.socket.close(4000, "protocol_error");
  });
  state.onBinary((frame) => {
    if (frame.length < 4) {
      state.socket.close(4000, "protocol_error");
      return;
    }
    const conn = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
    routes.get(conn)?.receive(frame.subarray(4));
  });
  state.onClose(() => {
    for (const end of routes.values()) end.stop();
    routes.clear();
  });
  return {
    onConnection(fn) {
      handler = fn;
      for (const conn of pending.splice(0)) fn(conn);
    },
    async openPairingSlot() {
      const msg = await state.request({ t: "pair.open" }, "pair.slot");
      if (msg.t !== "pair.slot") throw new RelayError("protocol_error");
      return { slot: msg.slot, expiresAt: msg.expiresAt };
    },
    async allowDevice(device) {
      await state.request(
        { t: "device.allow", id: device.id, pub: b64u(device.publicKey), name: device.name },
        "device.allowed",
      );
    },
    async removeDevice(id) {
      await state.request({ t: "device.remove", id }, "device.removed");
    },
    async listDevices() {
      const msg = await state.request({ t: "devices" }, "devices");
      if (msg.t !== "devices" || !msg.list) throw new RelayError("protocol_error");
      return msg.list;
    },
    async push() {
      const msg = await state.request({ t: "push" }, "push.sent");
      if (msg.t !== "push.sent") throw new RelayError("protocol_error");
      return msg.count;
    },
    async unregister() {
      await state.request({ t: "unregister" }, "unregistered");
    },
    close() {
      state.socket.close();
    },
    onClose: state.onClose,
  };
}
export interface DeviceRelay {
  online: boolean;
  transport: FrameTransport;
  onHostOnline(handler: () => void): void;
  subscribePush(sub: { endpoint: string; p256dh: string; auth: string }): Promise<void>;
  unsubscribePush(): Promise<void>;
  onClose(handler: (code: number) => void): void;
}
export async function connectDeviceRelay(options: {
  origin: string;
  identity: Identity;
  hostId: string;
}): Promise<DeviceRelay> {
  const state = await socketConnection(options.origin, "/v1/device", async (n) => ({
    t: "auth",
    id: options.identity.id,
    host: options.hostId,
    sig: b64u(
      await sign(
        options.identity.privateKey,
        deviceAuthTranscript(options.origin, n, options.identity.id, options.hostId),
      ),
    ),
  }));
  if (state.initial.t !== "ok" || state.initial.online === undefined) {
    state.socket.close();
    throw new RelayError("protocol_error");
  }
  const end = frameTransport(
    (frame) => {
      state.socket.send(new Uint8Array(frame));
    },
    () => {
      state.socket.close();
    },
  );
  let online = state.initial.online,
    notified = false,
    handler: (() => void) | undefined;
  state.onBinary(end.receive);
  state.onClose(end.stop);
  state.onControl((msg) => {
    if (msg.t === "host" && msg.online) {
      online = true;
      if (handler) {
        notified = true;
        handler();
      }
    } else state.socket.close(4000, "protocol_error");
  });
  return {
    get online() {
      return online;
    },
    transport: end.transport,
    onHostOnline(fn) {
      handler = fn;
      if (online && !notified) {
        notified = true;
        queueMicrotask(fn);
      }
    },
    async subscribePush(sub) {
      await state.request({ t: "push.subscribe", ...sub }, "push.subscribed");
    },
    async unsubscribePush() {
      await state.request({ t: "push.unsubscribe" }, "push.unsubscribed");
    },
    onClose: state.onClose,
  };
}
export async function connectPairRelay(options: {
  origin: string;
  slot: string;
}): Promise<FrameTransport> {
  const state = await socketConnection(
    options.origin,
    `/v1/pair?slot=${encodeURIComponent(options.slot)}`,
  );
  const end = frameTransport(
    (frame) => {
      state.socket.send(new Uint8Array(frame));
    },
    () => {
      state.socket.close();
    },
  );
  state.onBinary(end.receive);
  state.onClose(end.stop);
  state.onControl(() => {
    state.socket.close(4000, "protocol_error");
  });
  return end.transport;
}
