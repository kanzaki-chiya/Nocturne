import { connect as connectTcp, type Socket } from "node:net";
import { MAX_FRAME, type FrameTransport } from "@nocturne/remote";
import { encodeLengthPrefixedFrame } from "../../src/server/index.js";

/**
 * 测试专用的 TCP + 4 字节大端长度前缀客户端（不打入正式包产物）。
 */
export function connectLanTcpClient(
  endpoint: string,
  options: { timeoutMs?: number; maxPayload?: number } = {},
): Promise<FrameTransport> {
  const trimmed = endpoint.trim();
  if (!trimmed.startsWith("tcp://")) {
    return Promise.reject(new Error(`仅支持 tcp:// 直连地址：${endpoint}`));
  }
  const hostPort = trimmed.slice("tcp://".length).replace(/\/$/, "");
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon <= 0) {
    return Promise.reject(new Error(`缺少端口：${endpoint}`));
  }
  const host = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const port = Number(hostPort.slice(lastColon + 1));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxPayload = options.maxPayload ?? MAX_FRAME;

  return new Promise<FrameTransport>((resolve, reject) => {
    let settled = false;
    const socket = connectTcp({ host, port });
    socket.setNoDelay(true);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("TCP 直连超时"));
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
      failConnect(new Error("TCP 连接在建立前已关闭"));
    });

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", failConnect);

      let buffer = Buffer.alloc(0) as Buffer;
      let closed = false;
      let closeNotified = false;
      let frameHandler: ((frame: Uint8Array) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      const buffered: Uint8Array[] = [];

      const notifyClose = () => {
        if (closeNotified) return;
        closeNotified = true;
        closeHandler?.();
      };

      const isClosed = () => closed;

      const destroy = () => {
        closed = true;
        buffer = Buffer.alloc(0);
        try {
          socket.destroy();
        } catch {
          /* 已销毁 */
        }
        notifyClose();
      };

      socket.on("data", (chunk: Buffer) => {
        if (isClosed() || chunk.length === 0) return;
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        while (!isClosed() && buffer.length >= 4) {
          const len = buffer.readUInt32BE(0);
          if (len === 0 || len > maxPayload) {
            destroy();
            return;
          }
          if (buffer.length < 4 + len) return;
          const frame = new Uint8Array(buffer.subarray(4, 4 + len));
          buffer = buffer.subarray(4 + len);
          if (frameHandler) frameHandler(frame);
          else buffered.push(frame);
        }
      });
      socket.on("error", destroy);
      socket.on("end", () => {
        closed = true;
        try {
          socket.end();
        } catch {
          /* 已关闭 */
        }
        notifyClose();
      });
      socket.on("close", () => {
        closed = true;
        buffer = Buffer.alloc(0);
        notifyClose();
      });

      resolve({
        send(frame) {
          if (isClosed()) return;
          socket.write(encodeLengthPrefixedFrame(frame));
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
          if (isClosed()) queueMicrotask(handler);
        },
        close() {
          if (isClosed()) return;
          closed = true;
          socket.destroy();
          notifyClose();
        },
      });
    });
  });
}

export interface RawLanTcpHandle {
  readonly socket: Socket;
  writeBytes(bytes: Uint8Array): void;
  writeFrame(frame: Uint8Array): void;
  waitClosed(): Promise<void>;
  close(): void;
}

export function openRawLanTcp(port: number, host = "127.0.0.1"): Promise<RawLanTcpHandle> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    socket.setNoDelay(true);
    let closedFlag = false;
    const closedPromise = new Promise<void>((r) => {
      socket.once("close", () => {
        closedFlag = true;
        r();
      });
    });
    const onConnectError = (err: Error) => {
      reject(err);
    };
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      socket.off("error", onConnectError);
      socket.on("error", () => undefined);
      // 必须挂 data 监听让 Node Socket 进入 flowing 模式，才能感知对端 FIN/RST 触发 close
      socket.on("data", () => undefined);
      resolve({
        socket,
        writeBytes(bytes) {
          if (!closedFlag) socket.write(Buffer.from(bytes));
        },
        writeFrame(frame) {
          if (!closedFlag) socket.write(encodeLengthPrefixedFrame(frame));
        },
        waitClosed: () => closedPromise,
        close() {
          socket.destroy();
        },
      });
    });
  });
}
