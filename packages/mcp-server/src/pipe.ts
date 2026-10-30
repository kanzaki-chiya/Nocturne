import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_FRAME, type FrameTransport } from "@nocturne/remote";

let cachedSid: string | undefined;

export function currentUserSid(): string {
  if (cachedSid !== undefined) return cachedSid;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const match = /S-1-\d+(?:-\d+)+/.exec(out);
      if (match?.[0] !== undefined) {
        cachedSid = match[0];
        return cachedSid;
      }
    } catch {
      /* 降级到 username */
    }
  }
  cachedSid = os.userInfo().username;
  return cachedSid;
}

export function resolveNocturneHome(nocturneHome?: string): string {
  const raw = nocturneHome ?? process.env.NOCTURNE_HOME;
  if (raw !== undefined && raw.trim() !== "") {
    return path.resolve(raw);
  }
  return path.resolve(os.homedir(), ".nocturne");
}

export function agentPipeAddress(nocturneHome?: string): string {
  const home = resolveNocturneHome(nocturneHome);
  if (process.platform === "win32") {
    const defaultHome = path.resolve(os.homedir(), ".nocturne");
    const sid = currentUserSid();
    const seed =
      home.toLowerCase() === defaultHome.toLowerCase() ? sid : `${sid}:${home.toLowerCase()}`;
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\nocturne-agent-${hash}`;
  }
  return path.join(home, "agent.sock");
}

export function createSocketFrameTransport(socket: net.Socket): FrameTransport {
  let frameHandler: ((frame: Uint8Array) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const pending: Uint8Array[] = [];
  let closed = false;
  let closeNotified = false;
  let buffer: Buffer = Buffer.alloc(0);

  const flushPending = (): void => {
    while (frameHandler !== undefined && pending.length > 0) {
      const next = pending.shift();
      if (next !== undefined) frameHandler(next);
    }
    if (closed && pending.length === 0 && !closeNotified && closeHandler !== undefined) {
      closeNotified = true;
      closeHandler();
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME) {
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + len) break;
      const frame = new Uint8Array(buffer.subarray(4, 4 + len));
      buffer = buffer.subarray(4 + len);
      pending.push(frame);
    }
    flushPending();
  });

  const handleClose = (): void => {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    flushPending();
  };

  socket.on("close", handleClose);
  socket.on("error", () => {
    socket.destroy();
  });

  return {
    send(frame: Uint8Array) {
      if (closed || socket.destroyed) return;
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(frame.byteLength, 0);
      socket.write(
        Buffer.concat([header, Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)]),
      );
    },
    onFrame(handler) {
      frameHandler = handler;
      queueMicrotask(flushPending);
    },
    onClose(handler) {
      closeHandler = handler;
      queueMicrotask(flushPending);
    },
    close() {
      if (closed) return;
      socket.end();
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, 50).unref();
    },
  };
}

export interface ConnectAgentPipeOptions {
  home?: string | undefined;
  pipePath?: string | undefined;
  timeoutMs?: number | undefined;
}

export async function connectAgentPipe(options?: ConnectAgentPipeOptions): Promise<FrameTransport> {
  const address = options?.pipePath ?? agentPipeAddress(options?.home);
  const timeoutMs = options?.timeoutMs ?? 3000;
  return new Promise<FrameTransport>((resolve, reject) => {
    const socket = net.connect({ path: address });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接本机管道超时: ${address}`));
    }, timeoutMs);
    timer.unref();

    const onError = (err: Error): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      reject(new Error(`连接本机管道失败: ${err.message}`));
    };
    const onConnect = (): void => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(createSocketFrameTransport(socket));
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}
