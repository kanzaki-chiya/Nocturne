import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
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

/**
 * 计算本机外部 agent 管道地址（ADR-0074 §2）：
 * - Windows：`\\.\pipe\nocturne-agent-<用户 SID 哈希>`
 * - 其他平台：`<nocturneHome>/agent.sock`
 */
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

/**
 * 在 Windows 上将命名管道的 DACL 收紧为只允许当前用户（D:P(A;;FA;;;<SID>)），
 * 移除 libuv 默认赋予 Everyone/Anonymous 的读取权限。
 */
export function restrictWindowsPipeAclToCurrentUser(pipePath: string): void {
  if (process.platform !== "win32") return;
  const escaped = pipePath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User",
    "$ps = [System.IO.Pipes.PipeSecurity]::new()",
    "$ps.SetAccessRuleProtection($true, $false)",
    "$rule = [System.IO.Pipes.PipeAccessRule]::new($sid, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)",
    "$ps.AddAccessRule($rule)",
    "$w32 = [int].Assembly.GetType('Microsoft.Win32.Win32Native')",
    "$cf = $w32.GetMethod('UnsafeCreateFile', [System.Reflection.BindingFlags]'Static,NonPublic')",
    `$h = $cf.Invoke($null, @('${escaped}', [int]0x00060000, [System.IO.FileShare]::None, $null, [System.IO.FileMode]::Open, [int]0, [IntPtr]::Zero))`,
    "try {",
    "  if ($h.IsInvalid) { throw 'Failed to open pipe handle for DACL update' }",
    "  $pm = [System.IO.Pipes.PipeSecurity].GetMethod('Persist', [System.Reflection.BindingFlags]'Instance,NonPublic', $null, [Type[]]@([System.Runtime.InteropServices.SafeHandle], [System.Security.AccessControl.AccessControlSections]), $null)",
    "  $pm.Invoke($ps, @($h, [System.Security.AccessControl.AccessControlSections]::Access)) | Out-Null",
    "} finally {",
    "  if ($null -ne $h) { $h.Dispose() }",
    "}",
  ].join("\n");
  let lastError: unknown;
  for (const psExe of resolvePowerShellCandidates()) {
    try {
      execFileSync(psExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        env: powerShellEnv(),
        timeout: 10_000,
        windowsHide: true,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface WindowsPipeAclRule {
  sid: string;
  accessType: string;
  rights: string;
}

/** 读取 Windows 命名管道的 DACL 规则列表（供测试验证 ACL 仅含当前用户） */
export function readWindowsPipeAclRules(pipePath: string): WindowsPipeAclRule[] {
  if (process.platform !== "win32") return [];
  const escaped = pipePath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$w32 = [int].Assembly.GetType('Microsoft.Win32.Win32Native')",
    "$cf = $w32.GetMethod('UnsafeCreateFile', [System.Reflection.BindingFlags]'Static,NonPublic')",
    `$h = $cf.Invoke($null, @('${escaped}', [int]0x00020000, [System.IO.FileShare]::None, $null, [System.IO.FileMode]::Open, [int]0, [IntPtr]::Zero))`,
    "try {",
    "  if ($h.IsInvalid) { throw 'Failed to open pipe handle for DACL read' }",
    "  $ctor = [System.IO.Pipes.PipeSecurity].GetConstructor([System.Reflection.BindingFlags]'Instance,NonPublic', $null, [Type[]]@([Microsoft.Win32.SafeHandles.SafePipeHandle], [System.Security.AccessControl.AccessControlSections]), $null)",
    "  $sph = [Microsoft.Win32.SafeHandles.SafePipeHandle]::new($h.DangerousGetHandle(), $false)",
    "  $ps = $ctor.Invoke(@($sph, [System.Security.AccessControl.AccessControlSections]::Access))",
    "  $rules = $ps.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
    "  foreach ($r in $rules) {",
    '    Write-Output "$($r.IdentityReference.Value)|$($r.AccessControlType)|$($r.PipeAccessRights)"',
    "  }",
    "} finally {",
    "  if ($null -ne $h) { $h.Dispose() }",
    "}",
  ].join("\n");
  let out: string | undefined;
  let lastError: unknown;
  for (const psExe of resolvePowerShellCandidates()) {
    try {
      out = execFileSync(psExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        env: powerShellEnv(),
        timeout: 10_000,
        windowsHide: true,
      });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (out === undefined) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [sid = "", accessType = "", rights = ""] = line.split("|");
      return { sid, accessType, rights };
    });
}

/** 将字节流 Socket 包装为 4 字节大端长度前缀的 FrameTransport（供 acceptChannel / connectChannel 复用） */
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

export interface ListenAgentPipeOptions {
  home?: string | undefined;
  pipePath?: string | undefined;
  onConnection: (transport: FrameTransport) => void;
}

export interface AgentPipeListener {
  readonly address: string;
  close(): Promise<void>;
}

export async function listenAgentPipe(options: ListenAgentPipeOptions): Promise<AgentPipeListener> {
  let address: string;
  try {
    address = options.pipePath ?? agentPipeAddress(options.home);
  } catch (err) {
    console.error(
      `[agent-pipe] 无法启动本机外部 agent 管道: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  if (process.platform !== "win32") {
    await mkdir(path.dirname(address), { recursive: true, mode: 0o700 });
    await unlink(address).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    options.onConnection(createSocketFrameTransport(socket));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ path: address, readableAll: false, writableAll: false });
    });
  } catch (err) {
    console.error(
      `[agent-pipe] 监听本机管道失败 (${address}): ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  if (process.platform === "win32") {
    try {
      restrictWindowsPipeAclToCurrentUser(address);
    } catch (err) {
      console.error(
        `[agent-pipe] 设置 Windows 命名管道 ACL 失败 (${address}): ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      throw err;
    }
  } else {
    await chmod(address, 0o600);
  }

  let closed = false;
  return {
    address,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      if (process.platform !== "win32") {
        await unlink(address).catch(() => undefined);
      }
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
