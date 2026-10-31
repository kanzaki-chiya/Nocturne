import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_FRAME, type FrameTransport } from "@nocturne/remote";

export class WindowsSidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsSidError";
  }
}

function resolveSystemRoot(): string {
  const raw = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : "C:\\Windows";
}

function resolvePowerShellCandidates(): string[] {
  const sysRoot = resolveSystemRoot();
  const fullPath = path.win32.join(
    sysRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return [fullPath, "powershell.exe"];
}

function powerShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === "PSMODULEPATH") continue;
    env[k] = v;
  }
  return env;
}

export interface CurrentUserSidOptions {
  whoamiExe?: string;
  powerShellExe?: string;
}

/**
 * 获取当前 Windows 用户的 SID；非 Windows 返回当前 username。
 * Windows 上按顺序尝试：
 * 1. `%SystemRoot%\System32\whoami.exe /user /fo csv /nh`
 * 2. PowerShell `[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`
 * 两种方法都失败时抛出明确的 `WindowsSidError`，绝不退回用户名。
 */
export function currentUserSid(options?: CurrentUserSidOptions): string {
  if (process.platform !== "win32") {
    return os.userInfo().username;
  }

  const sysRoot = resolveSystemRoot();
  const whoamiPath = options?.whoamiExe ?? path.win32.join(sysRoot, "System32", "whoami.exe");
  const errors: string[] = [];

  try {
    const out = execFileSync(whoamiPath, ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const match = /S-1-\d+(?:-\d+)+/.exec(out);
    if (match?.[0] !== undefined) {
      return match[0];
    }
    errors.push(`whoami.exe 未返回有效 SID (${out.trim() || "空输出"})`);
  } catch (err) {
    errors.push(`whoami.exe 调用失败 (${err instanceof Error ? err.message : String(err)})`);
  }

  const psCandidates =
    options?.powerShellExe !== undefined ? [options.powerShellExe] : resolvePowerShellCandidates();
  let psError: string | undefined;
  for (const psExe of psCandidates) {
    try {
      const out = execFileSync(
        psExe,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        {
          encoding: "utf8",
          env: powerShellEnv(),
          timeout: 10_000,
          windowsHide: true,
        },
      );
      const match = /S-1-\d+(?:-\d+)+/.exec(out);
      if (match?.[0] !== undefined) {
        return match[0];
      }
      psError = `PowerShell 未返回有效 SID (${out.trim() || "空输出"})`;
    } catch (err) {
      psError = `PowerShell 调用失败 (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  if (psError !== undefined) {
    errors.push(psError);
  }

  throw new WindowsSidError(
    `无法获取当前 Windows 用户的 SID（whoami.exe 与 PowerShell 均失败）：${errors.join("；")}`,
  );
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
