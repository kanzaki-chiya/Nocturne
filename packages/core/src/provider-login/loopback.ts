import { createServer, type Server } from "node:http";
import { ProviderLoginError } from "./errors.js";

/** fetch 规范（也即浏览器）拒绝连接的危险端口（WHATWG bad port 列表）。 */
const BLOCKED_WEB_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export function isBlockedWebPort(port: number): boolean {
  return BLOCKED_WEB_PORTS.has(port);
}

interface LoopbackOptions {
  state: string;
  path: string;
  dualStack: boolean;
  /** 返回 true 才消费回调；SIWC 可在这里校验额外参数。 */
  accept(url: URL): boolean;
}

export async function openLoginLoopback(options: LoopbackOptions) {
  const servers: Server[] = [];
  let consumed = false;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  }

  function makeServer() {
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'");
      response.setHeader("Connection", "close");
      let accepted = false;
      try {
        const url = new URL(request.url ?? "", "http://127.0.0.1");
        const states = url.searchParams.getAll("state");
        if (
          request.method === "GET" &&
          url.origin === "http://127.0.0.1" &&
          url.pathname === options.path &&
          !consumed &&
          !closed &&
          states.length === 1 &&
          states[0] === options.state
        ) {
          accepted = options.accept(url);
        }
      } catch {
        // 固定响应，不回显请求或解析异常。
      }
      if (accepted) {
        consumed = true;
        response.once("finish", close);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><meta charset=utf-8><p>可以关闭此页面。</p>");
      } else {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("无效的登录回调。");
      }
    });
    servers.push(server);
    return server;
  }

  async function listen(server: Server, host: string, port: number) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, ipv6Only: host === "::1", exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async function listenSafePort(server: Server): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await listen(server, "127.0.0.1", 0);
      const address = server.address();
      if (!address || typeof address === "string") throw new ProviderLoginError("callback");
      if (!isBlockedWebPort(address.port)) return address.port;
      // 禁用端口无法在浏览器（或 fetch）中打开；释放后由系统分配下一个端口。
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    throw new ProviderLoginError("callback");
  }

  try {
    const ipv4 = makeServer();
    const port = await listenSafePort(ipv4);
    if (options.dualStack) await listen(makeServer(), "::1", port);
    return {
      callbackUrl: `http://${options.dualStack ? "localhost" : "127.0.0.1"}:${port}${options.path}`,
      close,
    };
  } catch {
    close();
    throw new ProviderLoginError("callback");
  }
}
