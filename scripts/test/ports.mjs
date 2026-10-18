import { createServer } from "node:net";

/**
 * 测试用随机端口（各包测试共用，见 docs/development/workflow.md 第 4 节）。
 *
 * fetch 规范的禁用端口（WHATWG Fetch「bad port」）：Node 的 fetch 连这些端口直接报
 * `bad port`。随机端口由系统分配，范围取决于本机（可能是 1024–65535），所以测试不能
 * 指望分不到它们。
 */
const FETCH_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export function isFetchBlockedPort(port) {
  return FETCH_BLOCKED_PORTS.has(port);
}

function listenOnce(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("监听失败"));
      else resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 在随机端口上监听；分到 fetch 禁用的端口就关掉重分。返回实际端口 */
export async function listenFetchSafe(server, host = "127.0.0.1") {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await listenOnce(server, host);
    if (!isFetchBlockedPort(port)) return port;
    await closeServer(server);
  }
  throw new Error("连续分到 fetch 禁用端口");
}

/** 一个 fetch 可用、当前没有监听的端口：先占一个再放掉 */
export async function unusedFetchSafePort(host = "127.0.0.1") {
  const probe = createServer();
  const port = await listenFetchSafe(probe, host);
  await closeServer(probe);
  return port;
}

/**
 * 给 RelayServer 的 `listen` 配置：先占一个 fetch 可用的随机端口再放掉。
 * `start()` 同时打开存储与推送服务，不适合分到坏端口后关掉重来。
 */
export async function fetchSafeListen(host = "127.0.0.1") {
  return `${host}:${await unusedFetchSafePort(host)}`;
}
