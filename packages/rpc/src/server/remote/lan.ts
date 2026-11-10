import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as connectTcp, isIPv6, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { FRAME_TYPES, MAX_FRAME, type FrameTransport } from "@nocturne/remote";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HANDSHAKE_FRAME_LIMIT = 4096;
const MAX_SLOW_BUFFER = 8 * 1024 * 1024;
const MAX_POST_FIN_QUEUE = 4;

export const DEFAULT_MAX_HANDSHAKING = 16;

function parseIPv4Octets(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function isAllowedIPv4Octets(
  [a, b]: [number, number, number, number],
  allowSpecial: boolean,
): boolean {
  // RFC 1918 私有网段：10/8、172.16/12、192.168/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (!allowSpecial) return false;
  // 链路本地 169.254/16 与回环 127/8
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

/** 是否为可向手机通告的本机私有网段 IPv4 地址（10/8、172.16/12、192.168/16） */
export function isPrivateLanIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  return octets !== undefined && isAllowedIPv4Octets(octets, false);
}

function expandIPv6Words(ip: string): number[] | undefined {
  if (!isIPv6(ip)) return undefined;
  let normalized = ip.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  if (normalized.includes(".") && lastColon !== -1) {
    const octets = parseIPv4Octets(normalized.slice(lastColon + 1));
    if (!octets) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const full = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (full.length !== 8) return undefined;
  const words: number[] = [];
  for (const group of full) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    words.push(Number.parseInt(group, 16));
  }
  return words;
}

/**
 * 入站来源地址检查（ADR-0087）：
 * 仅允许 10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10 与回环（127/8、::1），
 * 含 ::ffff:a.b.c.d 形式的 IPv4-mapped IPv6。
 */
export function isPrivateRemoteAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const zoneIndex = raw.indexOf("%");
  const clean = (zoneIndex === -1 ? raw : raw.slice(0, zoneIndex)).trim();
  if (!clean) return false;
  const v4 = parseIPv4Octets(clean);
  if (v4) return isAllowedIPv4Octets(v4, true);
  const words = expandIPv6Words(clean);
  if (words?.length !== 8) return false;
  // ::1 回环
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // ::ffff:a.b.c.d IPv4-mapped IPv6
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const w6 = words[6] ?? 0;
    const w7 = words[7] ?? 0;
    return isAllowedIPv4Octets([(w6 >>> 8) & 0xff, w6 & 0xff, (w7 >>> 8) & 0xff, w7 & 0xff], true);
  }
  const first = words[0] ?? 0;
  // fc00::/7 唯一本地地址
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 链路本地地址
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

/** 枚举本机所有非回环私有网段 IPv4 地址（稳定去重排序） */
export function listPrivateIPv4Addresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (isPrivateLanIPv4(entry.address)) found.add(entry.address);
    }
  }
  return [...found].sort();
}

export function formatLanEndpoints(addresses: readonly string[], port: number): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const addr of addresses) {
    if (!isPrivateLanIPv4(addr) || seen.has(addr)) continue;
    seen.add(addr);
    endpoints.push(`ws://${addr}:${port}`);
  }
  return endpoints;
}

function encodeWsFrame(opcode: number, payload: Uint8Array, mask: boolean): Buffer {
  const len = payload.byteLength;
  const maskBit = mask ? 0x80 : 0;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  const maskKey = mask ? randomBytes(4) : undefined;
  const out = Buffer.allocUnsafe(headerLen + (maskKey ? 4 : 0) + len);
  out[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len <= 0xffff) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (maskKey) {
    maskKey.copy(out, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      out[offset + i] = (payload[i] ?? 0) ^ (maskKey[i & 3] ?? 0);
    }
  } else {
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, offset);
  }
  return out;
}

interface WsSessionCallbacks {
  expectMasked: boolean;
  maxPayload: number;
  onBinaryMessage: (frame: Uint8Array) => void;
  onClose: () => void;
}

class WsSocketDriver {
  private buffer = Buffer.alloc(0) as Buffer;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;
  private closeNotified = false;

  constructor(
    private readonly socket: Duplex,
    private readonly callbacks: WsSessionCallbacks,
    initialBuffer?: Buffer,
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.feed(chunk);
    });
    socket.on("error", () => {
      this.destroy();
    });
    socket.on("close", () => {
      this.closed = true;
      this.fragments = [];
      this.buffer = Buffer.alloc(0);
      this.notifyClose();
    });
    socket.on("end", () => {
      this.destroy();
    });
    if (initialBuffer && initialBuffer.byteLength > 0) {
      queueMicrotask(() => {
        if (!this.closed) this.feed(initialBuffer);
      });
    }
  }

  sendBinary(frame: Uint8Array): void {
    if (this.closed) return;
    if (frame.byteLength > this.callbacks.maxPayload) {
      this.closeWithCode(1009);
      return;
    }
    if (this.socket.writableLength > MAX_SLOW_BUFFER) {
      this.destroy();
      return;
    }
    try {
      this.socket.write(encodeWsFrame(0x2, frame, this.callbacks.expectMasked ? false : true));
    } catch {
      this.destroy();
    }
  }

  close(code = 1000): void {
    this.closeWithCode(code);
  }

  destroy(): void {
    if (!this.closed) {
      this.closed = true;
      this.fragments = [];
      this.buffer = Buffer.alloc(0);
      try {
        this.socket.destroy();
      } catch {
        /* 套接字已销毁 */
      }
    }
    this.notifyClose();
  }

  private closeWithCode(code: number): void {
    if (this.closed) {
      this.notifyClose();
      return;
    }
    this.closed = true;
    this.fragments = [];
    this.buffer = Buffer.alloc(0);
    const body = Buffer.allocUnsafe(2);
    body.writeUInt16BE(code, 0);
    try {
      const masked = !this.callbacks.expectMasked;
      this.socket.end(encodeWsFrame(0x8, body, masked));
      setTimeout(() => {
        try {
          this.socket.destroy();
        } catch {
          /* 已销毁 */
        }
      }, 250).unref();
    } catch {
      try {
        this.socket.destroy();
      } catch {
        /* 已销毁 */
      }
    }
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.callbacks.onClose();
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private feed(chunk: Buffer): void {
    if (this.isClosed()) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.isClosed() && this.buffer.length >= 2) {
      const b0 = this.buffer[0] ?? 0;
      const b1 = this.buffer[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (rsv !== 0 || masked !== this.callbacks.expectMasked) {
        this.destroy();
        return;
      }
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.callbacks.maxPayload)) {
          this.closeWithCode(1009);
          this.destroy();
          return;
        }
        payloadLen = Number(big);
        offset = 10;
      }

      const isControl = (opcode & 0x08) !== 0;
      if (isControl) {
        if (!fin || payloadLen > 125) {
          this.destroy();
          return;
        }
      } else if (
        payloadLen > this.callbacks.maxPayload ||
        this.fragmentBytes + payloadLen > this.callbacks.maxPayload
      ) {
        this.closeWithCode(1009);
        this.destroy();
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (this.buffer.length < totalFrameLen) return;

      const payload = Buffer.from(
        this.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen),
      );
      if (masked) {
        const m0 = this.buffer[offset] ?? 0;
        const m1 = this.buffer[offset + 1] ?? 0;
        const m2 = this.buffer[offset + 2] ?? 0;
        const m3 = this.buffer[offset + 3] ?? 0;
        const maskBytes = [m0, m1, m2, m3];
        for (let i = 0; i < payload.length; i++) {
          payload[i] = (payload[i] ?? 0) ^ (maskBytes[i & 3] ?? 0);
        }
      }
      this.buffer = this.buffer.subarray(totalFrameLen);

      if (opcode === 0x8) {
        this.closeWithCode(1000);
        return;
      }
      if (opcode === 0x9) {
        if (!this.isClosed()) {
          try {
            this.socket.write(encodeWsFrame(0xa, payload, !this.callbacks.expectMasked));
          } catch {
            this.destroy();
          }
        }
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x2) {
        if (this.fragments.length > 0) {
          this.destroy();
          return;
        }
        if (fin) {
          this.callbacks.onBinaryMessage(new Uint8Array(payload));
        } else {
          this.fragments.push(payload);
          this.fragmentBytes = payload.length;
        }
      } else if (opcode === 0x0) {
        if (this.fragments.length === 0) {
          this.destroy();
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (fin) {
          const joined = Buffer.concat(this.fragments, this.fragmentBytes);
          this.fragments = [];
          this.fragmentBytes = 0;
          this.callbacks.onBinaryMessage(new Uint8Array(joined));
        }
      } else {
        // 拒绝文本帧（0x1）与未知 opcode
        this.destroy();
        return;
      }
    }
  }
}

export interface LanInboundConnection {
  readonly transport: FrameTransport;
  readonly remoteAddress: string;
  /** 由上层在 acceptChannel 握手验签通过后调用，解除未认证帧限制并释放握手并发槽位 */
  markAuthenticated(): void;
  /** 立即关闭底层连接 */
  close(): void;
}

export interface ListenLanDirectOptions {
  host?: string | undefined;
  preferredPort?: number | undefined;
  maxHandshaking?: number | undefined;
  resolveRemoteAddress?:
    ((socket: Socket, req?: IncomingMessage) => string | undefined) | undefined;
  onConnection: (connection: LanInboundConnection) => void;
}

export interface LanDirectListener {
  readonly port: number;
  readonly handshakingCount: () => number;
  close(): Promise<void>;
}

function bindHttpServer(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("无法读取局域网监听端口"));
        return;
      }
      resolve(addr.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, ipv6Only: false });
  });
}

export async function listenLanDirect(options: ListenLanDirectOptions): Promise<LanDirectListener> {
  const host = options.host ?? "0.0.0.0";
  const maxHandshaking = options.maxHandshaking ?? DEFAULT_MAX_HANDSHAKING;
  const resolveAddress = options.resolveRemoteAddress ?? ((socket: Socket) => socket.remoteAddress);

  const sockets = new Set<Duplex>();
  const handshaking = new Set<Duplex>();
  let closing = false;

  const createHttp = () => {
    const httpServer = createServer((_req, res) => {
      res.socket?.destroy();
    });
    httpServer.headersTimeout = 10_000;
    httpServer.requestTimeout = 10_000;

    httpServer.on("connection", (socket: Socket) => {
      if (closing || !isPrivateRemoteAddress(resolveAddress(socket))) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      const upgradeTimer = setTimeout(() => {
        socket.destroy();
      }, 10_000);
      upgradeTimer.unref();
      (socket as Socket & { __lanUpgradeTimer?: ReturnType<typeof setTimeout> }).__lanUpgradeTimer =
        upgradeTimer;
      sockets.add(socket);
      socket.once("close", () => {
        clearTimeout(upgradeTimer);
        sockets.delete(socket);
        handshaking.delete(socket);
      });
    });

    httpServer.on("upgrade", (req, socket, head) => {
      const netSocket = socket as Socket & { __lanUpgradeTimer?: ReturnType<typeof setTimeout> };
      clearTimeout(netSocket.__lanUpgradeTimer);
      const remoteAddress = resolveAddress(netSocket, req) ?? "";
      if (closing || !isPrivateRemoteAddress(remoteAddress) || handshaking.size >= maxHandshaking) {
        socket.destroy();
        return;
      }

      const upgrade = req.headers.upgrade;
      const version = req.headers["sec-websocket-version"];
      const key = req.headers["sec-websocket-key"];
      if (
        req.method !== "GET" ||
        typeof upgrade !== "string" ||
        upgrade.toLowerCase() !== "websocket" ||
        version !== "13" ||
        typeof key !== "string"
      ) {
        socket.destroy();
        return;
      }
      const decodedKey = Buffer.from(key.trim(), "base64");
      if (decodedKey.byteLength !== 16 || decodedKey.toString("base64") !== key.trim()) {
        socket.destroy();
        return;
      }

      sockets.add(socket);
      handshaking.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        handshaking.delete(socket);
      });

      const accept = createHash("sha1")
        .update(key.trim() + WS_GUID)
        .digest("base64");
      try {
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      } catch {
        handshaking.delete(socket);
        socket.destroy();
        return;
      }

      let phase: "await_init" | "await_resp" | "await_fin" | "verifying_fin" | "ready" =
        "await_init";
      let frameHandler: ((frame: Uint8Array) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      let closeFired = false;
      const bufferedForHandler: Uint8Array[] = [];
      const postFinQueue: Uint8Array[] = [];

      const deliver = (frame: Uint8Array) => {
        if (frameHandler) frameHandler(frame);
        else bufferedForHandler.push(frame);
      };

      const driver = new WsSocketDriver(
        socket,
        {
          expectMasked: true,
          maxPayload: MAX_FRAME,
          onBinaryMessage: (frame) => {
            if (frame.byteLength === 0 || frame.byteLength > MAX_FRAME) {
              driver.destroy();
              return;
            }
            if (phase === "ready") {
              deliver(frame);
              return;
            }
            if (phase === "await_init") {
              // 握手完成前首帧只能是 hs.init，发数据帧或其它帧立即关闭
              if (frame.byteLength > HANDSHAKE_FRAME_LIMIT || frame[0] !== FRAME_TYPES.init) {
                driver.destroy();
                return;
              }
              phase = "await_resp";
              deliver(frame);
              return;
            }
            if (phase === "await_resp") {
              // 服务端尚未回 hs.resp 前不接受任何后续帧
              driver.destroy();
              return;
            }
            if (phase === "await_fin") {
              const type = frame[0];
              if (
                frame.byteLength > HANDSHAKE_FRAME_LIMIT ||
                (type !== FRAME_TYPES.finish && type !== FRAME_TYPES.error)
              ) {
                driver.destroy();
                return;
              }
              phase = "verifying_fin";
              deliver(frame);
              return;
            }
            // verifying_fin：客户端在发出 hs.fin 后可能同包背靠背发出首条加密数据帧，
            // 仅在验签落定前有限缓冲，绝不在验签完成前交给上层处理
            if (postFinQueue.length >= MAX_POST_FIN_QUEUE || frame[0] !== FRAME_TYPES.data) {
              driver.destroy();
              return;
            }
            postFinQueue.push(frame);
          },
          onClose: () => {
            handshaking.delete(socket);
            postFinQueue.length = 0;
            if (!closeFired) {
              closeFired = true;
              closeHandler?.();
            }
          },
        },
        head.byteLength > 0 ? Buffer.from(head) : undefined,
      );

      const transport: FrameTransport = {
        send(frame) {
          if (phase === "await_resp" && frame[0] === FRAME_TYPES.response) {
            phase = "await_fin";
          }
          driver.sendBinary(frame);
        },
        onFrame(handler) {
          frameHandler = handler;
          while (bufferedForHandler.length > 0) {
            const next = bufferedForHandler.shift();
            if (next) handler(next);
          }
        },
        onClose(handler) {
          closeHandler = handler;
          if (closeFired) queueMicrotask(handler);
        },
        close() {
          handshaking.delete(socket);
          driver.close();
        },
      };

      options.onConnection({
        transport,
        remoteAddress,
        markAuthenticated() {
          handshaking.delete(socket);
          if (phase !== "ready") {
            phase = "ready";
            while (postFinQueue.length > 0) {
              const queued = postFinQueue.shift();
              if (queued) deliver(queued);
            }
          }
        },
        close() {
          handshaking.delete(socket);
          driver.destroy();
        },
      });
    });

    return httpServer;
  };

  let server = createHttp();
  let boundPort: number;
  const preferred = options.preferredPort;
  if (preferred !== undefined && preferred > 0) {
    try {
      boundPort = await bindHttpServer(server, host, preferred);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
      server = createHttp();
      boundPort = await bindHttpServer(server, host, 0);
    }
  } else {
    boundPort = await bindHttpServer(server, host, 0);
  }

  return {
    port: boundPort,
    handshakingCount: () => handshaking.size,
    async close() {
      if (closing) return;
      closing = true;
      handshaking.clear();
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* 已关闭 */
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * 标准 RFC 6455 二进制帧客户端（供 Node 侧测试及直连回环验证使用）。
 */
export function connectLanWebSocket(
  endpoint: string,
  options: { timeoutMs?: number; maxPayload?: number } = {},
): Promise<FrameTransport> {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:") {
    return Promise.reject(new Error(`仅支持 ws:// 直连地址：${endpoint}`));
  }
  const port = url.port ? Number(url.port) : 80;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const path = `${url.pathname || "/"}${url.search}`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxPayload = options.maxPayload ?? MAX_FRAME;

  return new Promise<FrameTransport>((resolve, reject) => {
    let settled = false;
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");

    const socket = connectTcp({ host, port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("WebSocket 连接超时"));
      }
    }, timeoutMs);

    const failConnect = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    socket.once("error", failConnect);
    socket.once("close", () => {
      failConnect(new Error("WebSocket 升级前连接已关闭"));
    });

    let headerBuf = Buffer.alloc(0) as Buffer;
    const onUpgradeData = (chunk: Buffer) => {
      headerBuf = headerBuf.length === 0 ? chunk : Buffer.concat([headerBuf, chunk]);
      if (headerBuf.length > 16_384) {
        failConnect(new Error("WebSocket 响应头过大"));
        return;
      }
      const boundary = headerBuf.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      socket.off("data", onUpgradeData);
      clearTimeout(timer);

      const headerText = headerBuf.subarray(0, boundary).toString("latin1");
      const rest = headerBuf.subarray(boundary + 4);
      const lines = headerText.split("\r\n");
      const statusLine = lines[0] ?? "";
      if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
        failConnect(new Error(`WebSocket 升级被拒绝：${statusLine}`));
        return;
      }
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx !== -1) {
          headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
        }
      }
      if (
        headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        headers.get("sec-websocket-accept") !== expectedAccept
      ) {
        failConnect(new Error("WebSocket 升级校验失败"));
        return;
      }

      settled = true;
      let frameHandler: ((frame: Uint8Array) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      let closed = false;
      const buffered: Uint8Array[] = [];

      const driver = new WsSocketDriver(
        socket,
        {
          expectMasked: false,
          maxPayload,
          onBinaryMessage: (frame) => {
            if (frameHandler) frameHandler(frame);
            else buffered.push(frame);
          },
          onClose: () => {
            if (!closed) {
              closed = true;
              closeHandler?.();
            }
          },
        },
        rest.byteLength > 0 ? Buffer.from(rest) : undefined,
      );

      resolve({
        send(frame) {
          driver.sendBinary(frame);
        },
        onFrame(handler) {
          frameHandler = handler;
          while (buffered.length > 0) {
            const next = buffered.shift();
            if (next) handler(next);
          }
        },
        onClose(handler) {
          closeHandler = handler;
          if (closed) queueMicrotask(handler);
        },
        close() {
          driver.close();
        },
      });
    };

    socket.on("data", onUpgradeData);
    socket.once("connect", () => {
      const hostHeader = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });
}
