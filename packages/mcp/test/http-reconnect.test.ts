import { createServer } from "node:http";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPlatform, type McpSession, type ToolContext } from "@nocturne/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpConnector, httpFailureReason, shouldRetryHttpCall } from "../src/connector.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});

async function fixture() {
  let sessionId = "";
  let generation = 0;
  let executions = 0;
  let initializations = 0;
  let requests = 0;
  let mode: "ok" | "500" | "reset" | "hang" = "ok";
  let initializeGate: Promise<void> | undefined;
  const initializeHeaders: (string | string[] | undefined)[] = [];
  const http = createServer((req, res) => {
    requests++;
    // 停服用例验证新连接被拒绝，而不是复用 keep-alive socket 后被 reset。
    res.setHeader("connection", "close");
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    void (async () => {
      let text = "";
      for await (const chunk of req) text += String(chunk);
      const body = JSON.parse(text) as { id?: number; method: string };
      if (body.method === "initialize") {
        initializations++;
        initializeHeaders.push(req.headers["mcp-session-id"]);
        await initializeGate;
        sessionId = `session-${++generation}`;
      } else if (req.headers["mcp-session-id"] !== sessionId || !sessionId) {
        res.writeHead(404).end("Not Found: Session not found");
        return;
      }
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        };
      } else if (body.method === "tools/list") {
        result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
      } else {
        executions++;
        if (mode === "500") {
          res.writeHead(500).end("Authorization: test-credential");
          return;
        }
        if (mode === "reset") {
          res.destroy();
          return;
        }
        if (mode === "hang") return;
        result = { content: [{ type: "text", text: "ok" }] };
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionId });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    })().catch(() => res.destroy());
  });
  let port = 0;
  const start = async () => {
    await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    port = address.port;
  };
  const stop = async () => {
    http.closeAllConnections();
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  await start();
  closers.push(stop);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    start,
    stop,
    expire: () => {
      sessionId = "";
    },
    setMode: (value: typeof mode) => {
      mode = value;
    },
    gate: (value: Promise<void>) => {
      initializeGate = value;
    },
    get executions() {
      return executions;
    },
    get initializations() {
      return initializations;
    },
    get requests() {
      return requests;
    },
    initializeHeaders,
  };
}

async function open(url: string, callTimeoutMs = 1000) {
  const events: { state: string }[] = [];
  const warnings: string[] = [];
  const records: { kind: string; payload: Record<string, unknown> }[] = [];
  let onReady: (() => void) | undefined;
  const session = await createMcpConnector().open({
    servers: [
      {
        name: "http",
        origin: "app",
        type: "http",
        url,
        startupTimeoutMs: 10_000,
        callTimeoutMs,
        headers: { Authorization: "test-credential" },
      },
    ],
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    sessionId: "test",
    platform: createPlatform(),
    emitServer: (event) => {
      events.push(event);
      if (event.state === "ready") onReady?.();
    },
    warn: (code) => {
      warnings.push(code);
    },
    diagnostics: {
      record: (kind, payload) => {
        records.push({ kind, payload: payload ?? {} });
      },
    },
  });
  closers.push(() => session.close());
  await session.startup();
  session.applyPendingTools();
  return {
    session,
    events,
    warnings,
    records,
    ready: () =>
      new Promise<void>((resolve) => {
        onReady = resolve;
      }),
  };
}

const call = (session: McpSession) => {
  const tool = session.tools()[0];
  if (!tool) throw new Error("missing tool");
  return tool.execute({}, {
    signal: new AbortController().signal,
    callId: "test",
  } as ToolContext);
};

describe("HTTP 自动重连", () => {
  it("旧会话 404 后静默重连，只执行一次，新 initialize 不带 session id；多次成功不受上限限制", async () => {
    const f = await fixture();
    const { session, events, warnings, records } = await open(f.url);
    for (let i = 0; i < 5; i++) {
      f.expire();
      events.splice(0);
      const before = session.tools()[0];
      expect((await call(session)).status).toBe("ok");
      expect(session.tools()[0]).toBe(before);
      expect(events.map((event) => event.state)).toEqual(["starting", "ready"]);
      expect(session.status()[0]?.restarts).toBe(0);
      session.applyPendingTools();
    }
    expect(f.executions).toBe(5);
    expect(f.initializations).toBe(6);
    expect(f.initializeHeaders.every((header) => header === undefined)).toBe(true);
    expect(warnings).toEqual([]);
    expect(
      records.some(
        (record) =>
          record.kind === "mcp.call" &&
          record.payload.httpStatus === 404 &&
          String(record.payload.error).includes("Session not found"),
      ),
    ).toBe(true);
  });

  it("并发失效调用共用一次重连", async () => {
    const f = await fixture();
    const { session, warnings } = await open(f.url);
    f.expire();
    const results = await Promise.all([call(session), call(session)]);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(f.initializations).toBe(2);
    expect(f.executions).toBe(2);
    expect(warnings).toEqual([]);
  });

  it("并发旧调用在重连时被关闭，不发起第二次连接，后续调用遵守冷却", async () => {
    const f = await fixture();
    const { session, warnings } = await open(f.url);
    await f.stop();
    const fetch = globalThis.fetch;
    let calls = 0;
    let reconnects = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"method":"tools/call"')) {
        if (++calls === 2) await held;
        return new Response("Not Found: Session not found", { status: 404 });
      }
      if (body.includes('"method":"initialize"')) reconnects++;
      return fetch(input, init);
    });
    const first = call(session);
    const second = call(session);
    expect((await first).status).toBe("error");
    release();
    // SDK 关闭旧 Client 时，其他在途调用直接以 Connection closed 结算。
    expect((await second).status).toBe("error");
    expect((await call(session)).modelContent).toContain("冷却");
    expect(reconnects).toBe(1);
    expect(warnings).toEqual(["mcp_server_failed"]);
  });

  it("停服重连失败冷却 30 秒，冷却调用不连接不重复警告，恢复后成功", async () => {
    const f = await fixture();
    const { session, warnings } = await open(f.url);
    await f.stop();
    expect(await call(session)).toMatchObject({ error: { code: "mcp_unavailable" } });
    expect(session.status()[0]).toMatchObject({ state: "failed", restarts: 1 });
    expect(warnings).toEqual(["mcp_server_failed"]);
    await f.start();
    const before = f.requests;
    expect((await call(session)).modelContent).toContain("30 秒");
    expect(f.requests).toBe(before);
    expect(warnings).toEqual(["mcp_server_failed"]);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    expect((await call(session)).status).toBe("ok");
    expect(session.status()[0]).toMatchObject({ state: "ready", restarts: 0 });
  });

  it.each(["500", "reset", "hang"] as const)(
    "执行后 %s 本次不重试，下一次调用重连",
    async (mode) => {
      const f = await fixture();
      const { session, warnings, records } = await open(f.url, 100);
      f.setMode(mode);
      expect((await call(session)).status).toBe("error");
      expect(f.executions).toBe(1);
      expect(f.initializations).toBe(1);
      expect(session.status()[0]?.state).toBe("failed");
      expect(warnings).toEqual(["mcp_server_failed"]);
      expect(JSON.stringify(records)).not.toContain("test-credential");
      f.setMode("ok");
      expect((await call(session)).status).toBe("ok");
      expect(f.initializations).toBe(2);
      expect(f.executions).toBe(2);
    },
  );

  it("启动失败后，过冷却的下一 Turn 恢复并应用工具", async () => {
    const f = await fixture();
    await f.stop();
    const { session } = await open(f.url);
    expect(session.tools()).toEqual([]);
    await f.start();
    await session.prepareTurn?.();
    expect(f.initializations).toBe(0);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    await session.prepareTurn?.();
    expect(session.tools()).toEqual([]);
    expect(session.applyPendingTools().add).toHaveLength(1);
    expect((await call(session)).status).toBe("ok");
  });

  it("Turn 恢复最多等待 3 秒，后台成功后下一边界工具才生效", async () => {
    const f = await fixture();
    await f.stop();
    const { session, ready } = await open(f.url);
    await f.start();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const started = performance.now();
    await session.prepareTurn?.();
    expect(performance.now() - started).toBeGreaterThanOrEqual(2900);
    expect(performance.now() - started).toBeLessThan(4500);
    expect(session.applyPendingTools().add).toEqual([]);
    const completed = ready();
    release();
    await completed;
    expect(session.tools()).toEqual([]);
    expect(session.applyPendingTools().add).toHaveLength(1);
  }, 10_000);

  it("关闭在途 Turn 重连不会复活连接", async () => {
    const f = await fixture();
    await f.stop();
    const { session } = await open(f.url);
    await f.start();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const controller = new AbortController();
    const preparing = session.prepareTurn?.(controller.signal);
    controller.abort();
    await preparing;
    await session.close();
    release();
    expect(session.status()[0]?.state).toBe("stopped");
    expect(session.applyPendingTools().add).toEqual([]);
  });
});

describe("HTTP 安全重试分类", () => {
  it("404 必须是带 session id 的调用，其他 HTTP 状态不重试", () => {
    expect(shouldRetryHttpCall(new StreamableHTTPError(404, "missing"), "old")).toBe(true);
    expect(shouldRetryHttpCall(new StreamableHTTPError(404, "missing"), undefined)).toBe(false);
    for (const status of [401, 403, 500, 502])
      expect(shouldRetryHttpCall(new StreamableHTTPError(status, "error"), "old")).toBe(false);
  });
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"])(
    "Node fetch cause %s 可以重试",
    (code) => {
      const cause = Object.assign(new Error("connect failed"), { code });
      expect(shouldRetryHttpCall(new TypeError("fetch failed", { cause }), "old")).toBe(true);
      expect(
        shouldRetryHttpCall(
          new TypeError("fetch failed", { cause: new AggregateError([cause, cause]) }),
          "old",
        ),
      ).toBe(true);
    },
  );
  it.each([
    "ECONNRESET",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UNKNOWN",
  ])("%s 与未知原因不重试", (code) => {
    const cause = Object.assign(new Error("failed"), { code });
    expect(shouldRetryHttpCall(new TypeError("fetch failed", { cause }), "old")).toBe(false);
    expect(
      shouldRetryHttpCall(
        new AggregateError([Object.assign(new Error(), { code: "ECONNREFUSED" }), cause]),
        "old",
      ),
    ).toBe(false);
  });
  it("超时、取消、普通错误不重试，分类不使用历史成功状态码", () => {
    for (const error of [
      new DOMException("timeout", "TimeoutError"),
      new DOMException("abort", "AbortError"),
      new Error("unknown"),
      null,
    ])
      expect(shouldRetryHttpCall(error, "old")).toBe(false);
    expect(httpFailureReason(new StreamableHTTPError(404, "missing"), 404, "old")).toBe(
      "会话已失效（HTTP 404）",
    );
    expect(httpFailureReason(new StreamableHTTPError(502, "bad gateway"), 502)).toBe("HTTP 502");
    expect(httpFailureReason(new DOMException("timeout", "TimeoutError"), 200)).toBe("请求超时");
    expect(httpFailureReason(new Error("unknown"), 200)).toContain("unknown");
  });
});
