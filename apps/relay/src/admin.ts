import { createServer, connect, type Server } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hash } from "./store.js";
import type { RelayServer } from "./server.js";

export function adminAddress(dataDir: string): string {
  const dir = resolve(dataDir);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nocturne-relay-${hash(dir).slice(0, 16)}`
    : join(dir, "admin.sock");
}
export interface AdminRequest {
  command: string;
  id?: string;
  host?: string;
  note?: string;
  expires?: string;
}
export interface AdminResponse {
  ok: boolean;
  output: string;
}
function duration(input: string): number {
  const match = /^(\d+)(h|d)$/.exec(input);
  if (!match) throw new Error("有效期必须使用 h 或 d 单位");
  const value = Number(match[1]) * (match[2] === "h" ? 3600000 : 86400000);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("有效期必须为正数");
  return value;
}
const time = (value: number): string => new Date(value).toLocaleString();
export async function executeAdmin(relay: RelayServer, req: AdminRequest): Promise<AdminResponse> {
  try {
    let output: string;
    switch (req.command) {
      case "invite create":
        output = await relay.store.invite(
          relay.config.publicOrigin,
          duration(req.expires ?? "7d"),
          req.note,
        );
        break;
      case "invite list":
        output =
          relay.store.data.invites
            .filter((i) => !i.usedAt && i.expiresAt > Date.now())
            .map((i) => `${i.hash.slice(0, 8)}\t${i.note ?? ""}\t${time(i.expiresAt)}`)
            .join("\n") || "暂无有效邀请";
        break;
      case "host list":
        output =
          relay.store.data.hosts
            .map(
              (h) =>
                `${h.id}\t${h.note ?? ""}\t${time(h.createdAt)}\t${h.revokedAt ? "已吊销" : "有效"}`,
            )
            .join("\n") || "暂无电脑";
        break;
      case "device list":
        output =
          relay.store.data.devices
            .filter((d) => !req.host || d.hostId === req.host)
            .map(
              (d) =>
                `${d.id}\t${d.hostId}\t${d.name}\t${time(d.createdAt)}\t${d.revokedAt ? "已吊销" : "有效"}`,
            )
            .join("\n") || "暂无设备";
        break;
      case "host revoke":
      case "device revoke":
        if (!req.id) throw new Error("缺少 id");
        await relay.revoke(req.command === "host revoke" ? "host" : "device", req.id);
        output = "已吊销";
        break;
      default:
        throw new Error("未知管理命令");
    }
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : "管理命令失败" };
  }
}
export async function startAdmin(relay: RelayServer): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "",
      size = 0;
    socket.setTimeout(10000, () => {
      socket.destroy();
    });
    socket.on("error", () => {
      /* 无效管理连接不影响服务。 */
    });
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16384) {
        socket.destroy();
        return;
      }
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      socket.pause();
      void (async () => {
        let result: AdminResponse;
        try {
          result = await executeAdmin(relay, JSON.parse(buffer.slice(0, index)) as AdminRequest);
        } catch {
          result = { ok: false, output: "管理请求格式错误" };
        }
        socket.end(`${JSON.stringify(result)}\n`);
      })();
    });
  });
  const address = adminAddress(relay.config.dataDir);
  // 不移除已有 socket：避免第二个服务抢占正在运行的管理通道。
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      done();
    });
  });
  if (process.platform !== "win32") await chmod(address, 0o600);
  server.on("close", () => {
    if (process.platform !== "win32")
      void unlink(address).catch(() => {
        /* socket 已移除。 */
      });
  });
  return server;
}
export function requestAdmin(dataDir: string, request: AdminRequest): Promise<AdminResponse> {
  return new Promise((done, reject) => {
    const socket = connect(adminAddress(dataDir));
    let buffer = "";
    const fail = (): void => {
      socket.destroy();
      reject(new Error("中继未运行"));
    };
    socket.on("error", fail);
    socket.setTimeout(10000, fail);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) {
        fail();
        return;
      }
      if (buffer.includes("\n")) {
        try {
          done(JSON.parse(buffer.split("\n")[0] ?? "") as AdminResponse);
          socket.end();
        } catch {
          fail();
        }
      }
    });
    socket.on("end", () => {
      if (!buffer.includes("\n")) fail();
    });
  });
}
