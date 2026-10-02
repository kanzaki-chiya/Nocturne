import { createServer, type Server } from "node:http";
import { ProviderLoginError } from "./errors.js";

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

  try {
    const ipv4 = makeServer();
    await listen(ipv4, "127.0.0.1", 0);
    const address = ipv4.address();
    if (!address || typeof address === "string") throw new ProviderLoginError("callback");
    if (options.dualStack) await listen(makeServer(), "::1", address.port);
    return {
      callbackUrl: `http://${options.dualStack ? "localhost" : "127.0.0.1"}:${address.port}${options.path}`,
      close,
    };
  } catch {
    close();
    throw new ProviderLoginError("callback");
  }
}
