import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchSafeListen, isFetchBlockedPort, listenFetchSafe } from "./ports.js";

describe("测试端口", () => {
  it("识别 fetch 禁用端口", () => {
    for (const port of [6000, 6665, 6669, 10080, 5060, 4045])
      expect(isFetchBlockedPort(port)).toBe(true);
    for (const port of [6001, 8787, 31420, 49152]) expect(isFetchBlockedPort(port)).toBe(false);
  });

  it("分到禁用端口就关掉重分", async () => {
    const ports = [6666, 10080, 40001];
    const calls: string[] = [];
    let current = 0;
    // 只模拟 listen/close/address：按顺序「分到」上面的端口
    const fake = {
      once() {
        return fake;
      },
      removeListener() {
        return fake;
      },
      listen(_port: number, _host: string, done: () => void) {
        current = ports[calls.filter((c) => c === "listen").length] ?? 0;
        calls.push("listen");
        done();
        return fake;
      },
      address: () => ({ port: current, address: "127.0.0.1", family: "IPv4" }),
      close(done: () => void) {
        calls.push("close");
        done();
        return fake;
      },
    } as unknown as Server;
    expect(await listenFetchSafe(fake)).toBe(40001);
    expect(calls).toEqual(["listen", "close", "listen", "close", "listen"]);
  });

  it("真实监听得到可用端口", async () => {
    const server = createServer();
    const port = await listenFetchSafe(server);
    expect(isFetchBlockedPort(port)).toBe(false);
    await new Promise<void>((done) => server.close(() => done()));
    const listen = await fetchSafeListen();
    expect(listen).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(isFetchBlockedPort(Number(listen.split(":")[1]))).toBe(false);
  });
});
