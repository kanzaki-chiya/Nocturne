import { createServer, isIPv6, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { FRAME_TYPES, MAX_FRAME, type FrameTransport } from "@nocturne/remote";

const HANDSHAKE_FRAME_LIMIT = 4096;
const MAX_SLOW_BUFFER = 8 * 1024 * 1024;
const MAX_POST_FIN_BYTES = 2 * MAX_FRAME;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

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
    endpoints.push(`tcp://${addr}:${port}`);
  }
  return endpoints;
}

/** 编码带 4 字节大端无符号长度前缀的传输报文（1..MAX_FRAME） */
export function encodeLengthPrefixedFrame(frame: Uint8Array): Buffer {
  const len = frame.byteLength;
  if (len === 0 || len > MAX_FRAME) {
    throw new Error(`局域网直连帧长度越界：${len}`);
  }
  const out = Buffer.allocUnsafe(4 + len);
  out.writeUInt32BE(len, 0);
  out.set(frame, 4);
  return out;
}

class LengthPrefixedDriver {
  private buffer = Buffer.alloc(0) as Buffer;
  private closed = false;
  private closeNotified = false;

  constructor(
    private readonly socket: Socket,
    private readonly callbacks: {
      onFrame: (frame: Uint8Array) => void;
      onClose: () => void;
    },
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.feed(chunk);
    });
    socket.on("error", () => {
      this.destroy();
    });
    socket.on("end", () => {
      this.close();
    });
    socket.on("close", () => {
      this.closed = true;
      this.buffer = Buffer.alloc(0);
      this.notifyClose();
    });
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    if (frame.byteLength === 0 || frame.byteLength > MAX_FRAME) {
      this.destroy();
      return;
    }
    if (this.socket.writableLength > MAX_SLOW_BUFFER) {
      this.destroy();
      return;
    }
    try {
      this.socket.write(encodeLengthPrefixedFrame(frame));
    } catch {
      this.destroy();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
      setTimeout(() => {
        try {
          this.socket.destroy();
        } catch {
          /* 已销毁 */
        }
      }, 250).unref();
    } catch {
      this.destroy();
    }
    this.notifyClose();
  }

  destroy(): void {
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    try {
      this.socket.destroy();
    } catch {
      /* 已销毁 */
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
    if (this.isClosed() || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.isClosed() && this.buffer.length >= 4) {
      const frameLen = this.buffer.readUInt32BE(0);
      // 读到 4 字节长度头立即判定，长度为 0 或超过 MAX_FRAME 当场断开，不等负载、不分配超限内存
      if (frameLen === 0 || frameLen > MAX_FRAME) {
        this.destroy();
        return;
      }
      const totalLen = 4 + frameLen;
      if (this.buffer.length < totalLen) return;
      const frame = new Uint8Array(this.buffer.subarray(4, totalLen));
      this.buffer = this.buffer.subarray(totalLen);
      this.callbacks.onFrame(frame);
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
  handshakeTimeoutMs?: number | undefined;
  resolveRemoteAddress?: ((socket: Socket) => string | undefined) | undefined;
  onConnection: (connection: LanInboundConnection) => void;
}

export interface LanDirectListener {
  readonly port: number;
  readonly handshakingCount: () => number;
  close(): Promise<void>;
}

function bindTcpServer(server: Server, host: string, port: number): Promise<number> {
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
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const resolveAddress = options.resolveRemoteAddress ?? ((socket: Socket) => socket.remoteAddress);

  const sockets = new Set<Socket>();
  const handshaking = new Set<Socket>();
  let closing = false;

  const createTcp = () => {
    const tcpServer = createServer((socket: Socket) => {
      const remoteAddress = resolveAddress(socket) ?? "";
      // 从 TCP 接入起计入未完成加密握手并发上限，非私有网段或超出上限直接销毁
      if (closing || !isPrivateRemoteAddress(remoteAddress) || handshaking.size >= maxHandshaking) {
        socket.destroy();
        return;
      }

      socket.setNoDelay(true);
      sockets.add(socket);
      handshaking.add(socket);

      const authTimer = setTimeout(() => {
        handshaking.delete(socket);
        socket.destroy();
      }, handshakeTimeoutMs);
      authTimer.unref();

      let phase: "await_init" | "await_resp" | "await_fin" | "verifying_fin" | "ready" =
        "await_init";
      let frameHandler: ((frame: Uint8Array) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      let closeFired = false;
      const bufferedForHandler: Uint8Array[] = [];
      const postFinQueue: Uint8Array[] = [];
      let postFinBytes = 0;

      const deliver = (frame: Uint8Array) => {
        if (frameHandler) frameHandler(frame);
        else bufferedForHandler.push(frame);
      };

      const cleanupHandshakeState = () => {
        clearTimeout(authTimer);
        handshaking.delete(socket);
      };

      socket.once("close", () => {
        cleanupHandshakeState();
        sockets.delete(socket);
      });

      const driver = new LengthPrefixedDriver(socket, {
        onFrame: (frame) => {
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
          // verifying_fin：客户端发出 hs.fin 后可能紧跟多条加密数据帧，
          // 按字节总量限制（不超过 2 * MAX_FRAME），只收 data 帧，验签通过前不交给上层
          if (
            frame[0] !== FRAME_TYPES.data ||
            postFinBytes + frame.byteLength > MAX_POST_FIN_BYTES
          ) {
            driver.destroy();
            return;
          }
          postFinBytes += frame.byteLength;
          postFinQueue.push(frame);
        },
        onClose: () => {
          cleanupHandshakeState();
          postFinQueue.length = 0;
          postFinBytes = 0;
          if (!closeFired) {
            closeFired = true;
            closeHandler?.();
          }
        },
      });

      const transport: FrameTransport = {
        send(frame) {
          if (phase === "await_resp" && frame[0] === FRAME_TYPES.response) {
            phase = "await_fin";
          }
          driver.send(frame);
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
          cleanupHandshakeState();
          driver.close();
        },
      };

      options.onConnection({
        transport,
        remoteAddress,
        markAuthenticated() {
          cleanupHandshakeState();
          if (phase !== "ready") {
            phase = "ready";
            postFinBytes = 0;
            while (postFinQueue.length > 0) {
              const queued = postFinQueue.shift();
              if (queued) deliver(queued);
            }
          }
        },
        close() {
          cleanupHandshakeState();
          driver.destroy();
        },
      });
    });

    return tcpServer;
  };

  let server = createTcp();
  let boundPort: number;
  const preferred = options.preferredPort;
  if (preferred !== undefined && preferred > 0) {
    try {
      boundPort = await bindTcpServer(server, host, preferred);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
      server = createTcp();
      boundPort = await bindTcpServer(server, host, 0);
    }
  } else {
    boundPort = await bindTcpServer(server, host, 0);
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
