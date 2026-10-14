import { hkdf, identityId, random, sign, verify, type Identity } from "./crypto.js";
import {
  b64u,
  unb64u,
  concat,
  transcript,
  utf8,
  publicPoint,
  jsonFrame,
  parseFrame,
  version,
  MAX_FRAME,
  MAX_MESSAGE,
  FRAME_TYPES,
  type Bytes,
} from "./encoding.js";
import { asChannelError, ERROR_CODES, fail, RemoteChannelError } from "./errors.js";
import type { FrameTransport } from "./transport.js";

export interface SecureLineTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  flush(): Promise<void>;
  close(): void;
  readonly closeReason: RemoteChannelError | undefined;
}
export interface ConnectChannelOptions {
  identity: Identity;
  hostPublicKey: Uint8Array;
  timeoutMs?: number;
}
export interface AcceptChannelOptions {
  identity: Identity;
  lookupDevice: (id: string) => Promise<Uint8Array | undefined>;
  timeoutMs?: number;
}

async function ephemeral(): Promise<{ privateKey: CryptoKey; publicKey: Bytes }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export async function deriveKeys(
  privateKey: CryptoKey,
  peer: Bytes,
  fields: Bytes[],
): Promise<{ p2h: CryptoKey; h2p: CryptoKey }> {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicPoint(peer),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256),
  );
  const salt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", transcript("nocturne/hs/v1/salt", ...fields)),
  );
  const key = async (direction: string): Promise<CryptoKey> =>
    crypto.subtle.importKey(
      "raw",
      await hkdf(shared, salt, utf8(`nocturne/hs/v1/${direction}`)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  try {
    return { p2h: await key("p2h"), h2p: await key("h2p") };
  } finally {
    shared.fill(0);
  }
}

function header(counter: number): Bytes {
  const result = new Uint8Array(9);
  result[0] = FRAME_TYPES.data;
  new DataView(result.buffer).setBigUint64(1, BigInt(counter));
  return result;
}
function nonce(head: Bytes): Bytes {
  return concat(new Uint8Array(4), head.subarray(1));
}

export async function encryptFrame(
  key: CryptoKey,
  counter: number,
  flag: number,
  chunk: Bytes,
): Promise<Bytes> {
  const head = header(counter);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce(head), additionalData: head, tagLength: 128 },
      key,
      concat(new Uint8Array([flag]), chunk),
    ),
  );
  return concat(head, encrypted);
}

function channel(
  transport: FrameTransport,
  options: ConnectChannelOptions | AcceptChannelOptions,
  phone: boolean,
): Promise<{ deviceId: string; channel: SecureLineTransport }> {
  return new Promise((resolve, reject) => {
    let ready = false,
      stopped = false,
      closing = false,
      notified = false,
      inputClosed = false;
    const unavailable = (): boolean => stopped || inputClosed;
    let reason: RemoteChannelError | undefined;
    let lineHandler: ((line: string) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    const pending: string[] = [];
    let outgoing = Promise.resolve(),
      incoming = Promise.resolve();
    let sendCounter = 0,
      receiveCounter = 0;
    let chunks: Bytes[] = [],
      size = 0;
    let sendKey: CryptoKey | undefined, receiveKey: CryptoKey | undefined;
    let temporary: Awaited<ReturnType<typeof ephemeral>> | undefined;
    let fields: Bytes[] | undefined;
    let deviceId = "";
    let phase: "init" | "response" | "finish" | "ready" = phone ? "response" : "init";
    const timeout = options.timeoutMs ?? 10_000;
    const timer = setTimeout(() => {
      stop(new RemoteChannelError("timeout"), true);
    }, timeout);

    const notify = (): void => {
      if (lineHandler !== undefined)
        while (pending.length > 0) {
          const line = pending.shift();
          if (line !== undefined) lineHandler(line);
        }
      if (inputClosed && pending.length === 0 && !notified && closeHandler !== undefined) {
        notified = true;
        closeHandler();
      }
    };
    const stop = (error: RemoteChannelError, report = false): void => {
      if (stopped) return;
      stopped = true;
      closing = true;
      reason = error;
      clearTimeout(timer);
      temporary = undefined;
      fields = undefined;
      chunks = [];
      size = 0;
      if (!ready) {
        if (report) {
          try {
            transport.send(jsonFrame(FRAME_TYPES.error, { code: error.code }));
          } catch {
            /* 关闭仍必须执行 */
          }
        }
        reject(error);
      }
      transport.close();
    };
    const api: SecureLineTransport = {
      get closeReason() {
        return reason;
      },
      send(line) {
        if (closing || stopped || inputClosed) return;
        // 消息是原始 UTF-8，不做 NFC；只有转录里的字符串规范化。
        const message = new TextEncoder().encode(line);
        if (message.length > MAX_MESSAGE) {
          stop(new RemoteChannelError("frame_too_large"));
          return;
        }
        outgoing = outgoing
          .then(async () => {
            if (stopped || inputClosed || sendKey === undefined) return;
            const capacity = MAX_FRAME - 9 - 16 - 1;
            let offset = 0;
            do {
              if (sendCounter >= Number.MAX_SAFE_INTEGER) fail("closed");
              const end = Math.min(offset + capacity, message.length);
              const frame = await encryptFrame(
                sendKey,
                sendCounter++,
                end < message.length ? 1 : 0,
                message.subarray(offset, end),
              );
              if (unavailable()) return;
              transport.send(frame);
              offset = end;
            } while (offset < message.length);
          })
          .catch((error: unknown) => {
            stop(asChannelError(error));
          });
      },
      onLine(handler) {
        lineHandler = handler;
        queueMicrotask(notify);
      },
      onClose(handler) {
        closeHandler = handler;
        queueMicrotask(notify);
      },
      flush() {
        return outgoing;
      },
      close() {
        if (closing || inputClosed) return;
        closing = true;
        void outgoing.then(() => {
          transport.close();
        });
      },
    };
    const complete = (): void => {
      if (stopped || inputClosed) return;
      ready = true;
      phase = "ready";
      temporary = undefined;
      fields = undefined;
      clearTimeout(timer);
      resolve({ deviceId, channel: api });
    };
    const receiveData = async (frame: Bytes): Promise<void> => {
      if (frame.length > MAX_FRAME) fail("frame_too_large");
      if (frame.length < 26 || receiveKey === undefined) fail();
      const count = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(1);
      if (count !== BigInt(receiveCounter)) fail("replay");
      if (receiveCounter >= Number.MAX_SAFE_INTEGER) fail("closed");
      const head = frame.slice(0, 9);
      let plain: Bytes;
      try {
        plain = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce(head), additionalData: head, tagLength: 128 },
            receiveKey,
            frame.subarray(9),
          ),
        );
      } catch {
        fail("decrypt_failed");
      }
      if (unavailable()) return;
      receiveCounter++;
      if (plain[0] !== 0 && plain[0] !== 1) fail();
      const chunk = plain.subarray(1);
      size += chunk.length;
      if (size > MAX_MESSAGE) fail("frame_too_large");
      chunks.push(chunk);
      if (plain[0] === 0) {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(concat(...chunks));
        chunks = [];
        size = 0;
        pending.push(line);
        notify();
      }
    };
    const receive = async (frame: Bytes): Promise<void> => {
      if (stopped) return;
      if (phase === "ready") {
        if (frame[0] !== FRAME_TYPES.data) fail();
        await receiveData(frame);
        return;
      }
      if (frame[0] === FRAME_TYPES.error) {
        const body = parseFrame(frame, FRAME_TYPES.error, ["code"]);
        const code = ERROR_CODES.find((item) => item === body.code);
        if (code === undefined) fail();
        stop(new RemoteChannelError(code));
        return;
      }
      if (phase === "init" && "lookupDevice" in options) {
        const body = parseFrame(frame, FRAME_TYPES.init, ["v", "id", "e", "n"]);
        version(body);
        unb64u(body.id, 16);
        if (typeof body.id !== "string") fail();
        deviceId = body.id;
        const pub = await options.lookupDevice(deviceId);
        if (unavailable()) return;
        if (pub === undefined) fail("unknown_device");
        if ((await identityId(pub)) !== deviceId) fail();
        const peer = publicPoint(unb64u(body.e)),
          nP = unb64u(body.n, 32);
        temporary = await ephemeral();
        if (unavailable()) {
          temporary = undefined;
          return;
        }
        fields = [
          publicPoint(options.identity.publicKey),
          publicPoint(pub),
          peer,
          temporary.publicKey,
          nP,
          random(32),
        ];
        const keys = await deriveKeys(temporary.privateKey, peer, fields);
        temporary = undefined;
        if (unavailable()) return;
        sendKey = keys.h2p;
        receiveKey = keys.p2h;
        const sig = await sign(
          options.identity.privateKey,
          transcript("nocturne/hs/v1/resp", ...fields),
        );
        if (unavailable()) return;
        phase = "finish";
        transport.send(
          jsonFrame(FRAME_TYPES.response, {
            v: 1,
            e: b64u(fields[3] ?? fail()),
            n: b64u(fields[5] ?? fail()),
            sig: b64u(sig),
          }),
        );
      } else if (phase === "response" && "hostPublicKey" in options) {
        const body = parseFrame(frame, FRAME_TYPES.response, ["v", "e", "n", "sig"]);
        version(body);
        if (temporary === undefined || fields === undefined) fail();
        const peer = publicPoint(unb64u(body.e));
        fields[3] = peer;
        fields[5] = unb64u(body.n, 32);
        await verify(
          options.hostPublicKey,
          unb64u(body.sig, 64),
          transcript("nocturne/hs/v1/resp", ...fields),
        );
        if (unavailable()) return;
        const keys = await deriveKeys(temporary.privateKey, peer, fields);
        temporary = undefined;
        if (unavailable()) return;
        sendKey = keys.p2h;
        receiveKey = keys.h2p;
        const sig = await sign(
          options.identity.privateKey,
          transcript("nocturne/hs/v1/fin", ...fields),
        );
        if (unavailable()) return;
        transport.send(jsonFrame(FRAME_TYPES.finish, { sig: b64u(sig) }));
        complete();
      } else if (phase === "finish") {
        const body = parseFrame(frame, FRAME_TYPES.finish, ["sig"]);
        if (fields === undefined) fail();
        await verify(
          fields[1] ?? fail(),
          unb64u(body.sig, 64),
          transcript("nocturne/hs/v1/fin", ...fields),
        );
        complete();
      } else fail();
    };
    transport.onFrame((frame) => {
      const copy = new Uint8Array(frame);
      incoming = incoming
        .then(() => receive(copy))
        .catch((error: unknown) => {
          stop(asChannelError(error), !ready);
        });
    });
    transport.onClose(() => {
      void incoming.then(() => {
        clearTimeout(timer);
        inputClosed = true;
        chunks = [];
        size = 0;
        temporary = undefined;
        fields = undefined;
        sendKey = receiveKey = undefined;
        if (!ready) reject(reason ?? new RemoteChannelError("closed"));
        notify();
      });
    });
    if (phone && "hostPublicKey" in options) {
      incoming = incoming
        .then(async () => {
          temporary = await ephemeral();
          if (unavailable()) {
            temporary = undefined;
            return;
          }
          fields = [
            publicPoint(options.hostPublicKey),
            publicPoint(options.identity.publicKey),
            temporary.publicKey,
            new Uint8Array(),
            random(32),
            new Uint8Array(),
          ];
          deviceId = await identityId(options.identity.publicKey);
          if (stopped) return;
          transport.send(
            jsonFrame(FRAME_TYPES.init, {
              v: 1,
              id: deviceId,
              e: b64u(temporary.publicKey),
              n: b64u(fields[4] ?? fail()),
            }),
          );
        })
        .catch((error: unknown) => {
          stop(asChannelError(error), true);
        });
    }
  });
}

export async function connectChannel(
  transport: FrameTransport,
  options: ConnectChannelOptions,
): Promise<SecureLineTransport> {
  return (await channel(transport, options, true)).channel;
}

export function acceptChannel(
  transport: FrameTransport,
  options: AcceptChannelOptions,
): Promise<{ deviceId: string; channel: SecureLineTransport }> {
  return channel(transport, options, false);
}
