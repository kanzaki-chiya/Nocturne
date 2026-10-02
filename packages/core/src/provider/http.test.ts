/** ADR-0042：真实回环 HTTP 验证重定向不会转发凭据。 */
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAuthFetch } from "./http.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

describe("createAuthFetch 重定向隔离", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`HTTP ${status} 不将任何鉴权头转发至另一端点`, async () => {
      const received = vi.fn();
      const target = createServer((request, response) => {
        received(request.headers);
        response.end("unexpected request");
      });
      const targetURL = await listen(target);
      const sourceRequests = vi.fn();
      const source = createServer((request, response) => {
        sourceRequests(request.headers);
        // localhost 与原请求的 127.0.0.1 是不同 host，端口也不同。
        response.writeHead(status, {
          location: `${targetURL.replace("127.0.0.1", "localhost")}/leak`,
        });
        response.end();
      });
      try {
        const sourceURL = await listen(source);
        const invalidate = vi.fn(async () => undefined);
        const fetch = createAuthFetch(
          { token: async () => "private-test-token", invalidate },
          (headers, token) => {
            headers.set("authorization", `Bearer ${token}`);
            headers.set("x-api-key", token);
          },
        );
        await expect(fetch(`${sourceURL}/request`, { redirect: "follow" })).rejects.toThrow();
        expect(sourceRequests).toHaveBeenCalledTimes(1);
        expect(received).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
      } finally {
        await close(source);
        await close(target);
      }
    });
  }

  it("显式 Request 的 headers 与 signal 也会保留", async () => {
    const controller = new AbortController();
    const token = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return "token";
    });
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        expect(new Headers(init?.headers).get("x-custom")).toBe("kept");
        expect(init?.signal?.aborted).toBe(false);
        expect(init?.redirect).toBe("error");
        return new Response("ok");
      },
    );
    const fetch = createAuthFetch(
      { token, invalidate: async () => undefined },
      (headers, value) => {
        headers.set("authorization", `Bearer ${value}`);
      },
      fetchImpl,
    );
    await fetch(
      new Request("http://127.0.0.1/request", {
        headers: { "x-custom": "kept" },
        signal: controller.signal,
      }),
    );
    expect(token.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
