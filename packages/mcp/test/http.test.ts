import { createServer, type IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createPlatform,
  type McpOpenScope,
  type McpServerConfig,
  type ToolContext,
} from "@nocturne/core";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";
import { createMcpConnector } from "../src/index.js";

const processes = createProcessCleanup();
const platform = processes.platform(createPlatform());
const closers = new Set<() => Promise<void>>();
afterEach(async () => {
  await processes.cleanup();
  for (const close of closers) await close();
  closers.clear();
});
const cfg = (url: string): McpServerConfig => ({
  name: "http",
  origin: "app",
  type: "http",
  url,
  startupTimeoutMs: 1000,
});
const scope = (server: McpServerConfig): McpOpenScope => ({
  servers: [server],
  cwd: process.cwd(),
  workspaceRoot: process.cwd(),
  sessionId: "test",
  platform,
  emitServer: () => undefined,
  warn: () => undefined,
});
async function httpFixture(reflectSecret = false, failList = false) {
  const requests: { method: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const server = new Server({ name: "fake-http", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: reflectSecret ? "test-token-123" : "echo",
        description: reflectSecret ? "test-token-123" : "echo",
        inputSchema: {
          type: "object",
          ...(reflectSecret ? { description: "test-token-123" } : {}),
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => ({
    content: [{ type: "text", text: String(request.params.arguments?.text ?? "ok") }],
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  const http = createServer((req, res) => {
    requests.push({ method: req.method, headers: req.headers });
    if (req.url === "/401" || req.url === "/403" || req.url === "/500") {
      res.writeHead(Number(req.url.slice(1)));
      res.end("test-token-123");
      return;
    }
    if (req.url === "/cross") {
      res.writeHead(307, { location: "http://127.0.0.1:1/other" });
      res.end();
      return;
    }
    if (req.url === "/same") {
      res.writeHead(307, { location: "/mcp" });
      res.end();
      return;
    }
    if (req.url === "/hang") return;
    void (async () => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      if (failList && body.includes('"method":"tools/list"')) {
        res.writeHead(500);
        res.end();
        return;
      }
      await transport.handleRequest(req, res, body ? (JSON.parse(body) as unknown) : undefined);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const close = async () => {
    closers.delete(close);
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  closers.add(close);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("port unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close,
  };
}

describe("Streamable HTTP 和探测", () => {
  it("初始化后 tools/list 的 HTTP 错误保留状态码，清理仍发送 DELETE", async () => {
    const fixture = await httpFixture(false, true);
    try {
      expect(await createMcpConnector().probe(scope(cfg(`${fixture.url}/mcp`)))).toMatchObject({
        ok: false,
        error: { code: "http_status" },
        httpStatus: 500,
      });
      expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(true);
    } finally {
      await fixture.close();
    }
  });
  it("服务器在元数据和结果中回显凭据时，工具、诊断和结果均脱敏", async () => {
    const fixture = await httpFixture(true);
    const records: unknown[] = [];
    const session = await createMcpConnector().open({
      ...scope({ ...cfg(`${fixture.url}/mcp`), headers: { Authorization: { stored: true } } }),
      credentials: { get: async () => "test-token-123" },
      emitServer: (event) => {
        records.push(event);
      },
      warn: (code, message) => {
        records.push({ code, message });
      },
      diagnostics: {
        record: (kind, payload) => {
          records.push({ kind, payload });
        },
      },
    });
    try {
      const tool = session.tools()[0];
      expect(tool).toBeDefined();
      expect(
        JSON.stringify({
          name: tool?.name,
          description: tool?.description,
          schema: tool?.inputSchema,
          subjects: tool?.permissionSubjects(
            {},
            {
              cwd: process.cwd(),
              workspaceRoot: process.cwd(),
              paths: platform.paths,
            },
          ),
        }),
      ).not.toContain("test-token-123");
      const result = await tool?.execute({ text: "test-token-123" }, {
        signal: new AbortController().signal,
        callId: "redaction",
      } as ToolContext);
      expect(result?.status).toBe("ok");
      expect(JSON.stringify({ result, records })).not.toContain("test-token-123");
    } finally {
      await session.close();
      await fixture.close();
    }
  });
  it("请求头送达、探测列原始工具名，结束会话发 DELETE", async () => {
    const fixture = await httpFixture();
    try {
      const result = await createMcpConnector().probe({
        ...scope({
          ...cfg(`${fixture.url}/mcp`),
          headers: { Authorization: { stored: true }, "X-Trace": "test-trace" },
        }),
        credentials: {
          get: async (key) =>
            key === "mcp/http/authorization" ? "Bearer test-token-123" : undefined,
        },
      });
      expect(result).toMatchObject({
        ok: true,
        serverInfo: { name: "fake-http", version: "1" },
        tools: [{ name: "echo" }],
      });
      expect(result.stderrTail).toBeUndefined();
      expect(
        fixture.requests.every(
          (r) =>
            r.headers.authorization === "Bearer test-token-123" &&
            r.headers["x-trace"] === "test-trace",
        ),
      ).toBe(true);
      expect(fixture.requests.some((r) => r.method === "DELETE")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("test-token-123");
    } finally {
      await fixture.close();
    }
  });
  it.each([
    ["401", "auth_required"],
    ["403", "auth_required"],
    ["500", "http_status"],
    ["cross", "http_redirect"],
    ["hang", "startup_timeout"],
  ])("%s 返回 %s", async (path, code) => {
    const fixture = await httpFixture();
    try {
      const result = await createMcpConnector().probe(
        scope({ ...cfg(`${fixture.url}/${path}`), startupTimeoutMs: 150 }),
      );
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(result)).not.toContain("test-token-123");
    } finally {
      await fixture.close();
    }
  });
  it("同源重定向跟随，网络断开不自动重连", async () => {
    const fixture = await httpFixture();
    const session = await createMcpConnector().open(scope(cfg(`${fixture.url}/same`)));
    try {
      expect(session.status()[0]?.state).toBe("ready");
      const tool = session.tools()[0];
      expect(tool).toBeDefined();
      await fixture.close();
      const ctx = { signal: new AbortController().signal, callId: "test" } as ToolContext;
      const result = await tool?.execute({}, ctx);
      expect(result?.status).toBe("error");
      expect(session.status()[0]?.state).toBe("failed");
      const before = fixture.requests.length;
      await tool?.execute({}, ctx);
      expect(fixture.requests).toHaveLength(before);
    } finally {
      await session.close();
    }
  });
  it("连接拒绝返回 connect_failed；缺失 stored 不发请求", async () => {
    const fixture = await httpFixture();
    const url = fixture.url;
    await fixture.close();
    const connector = createMcpConnector();
    expect(await connector.probe(scope(cfg(`${url}/mcp`)))).toMatchObject({
      ok: false,
      error: { code: "connect_failed" },
    });
    expect(
      await connector.probe(
        scope({ ...cfg(`${url}/mcp`), headers: { Authorization: { stored: true } } }),
      ),
    ).toMatchObject({ ok: false, error: { code: "mcp_secret_missing" } });
  });
  it("stdio 探测成功、spawn 失败、initialize 失败与超时", async () => {
    const connector = createMcpConnector();
    const base: McpServerConfig = {
      name: "stdio",
      origin: "app",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fake-server.mjs", import.meta.url))],
    };
    expect(await connector.probe(scope(base))).toMatchObject({
      ok: true,
      serverInfo: { name: "fake-mcp" },
      stderrTail: [],
    });
    expect(
      await connector.probe(scope({ ...base, command: "nocturne-nonexistent-test-command" })),
    ).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
    expect(
      await connector.probe(scope({ ...base, args: ["-e", "process.exit(1)"] })),
    ).toMatchObject({ ok: false, error: { code: "initialize_failed" } });
    expect(
      await connector.probe(
        scope({ ...base, args: ["-e", "setInterval(()=>{},1000)"], startupTimeoutMs: 150 }),
      ),
    ).toMatchObject({ ok: false, error: { code: "startup_timeout" } });
  });
  it("reconcile 增加、删除、停用、变化重启、无变化不动、轮换密钥重启", async () => {
    const fixture = await httpFixture();
    const connector = createMcpConnector();
    const base = cfg(`${fixture.url}/mcp`);
    let key = "test-token-123";
    const server = { ...base, headers: { Authorization: { stored: true as const } } };
    const session = await connector.open({
      ...scope(server),
      credentials: { get: async () => key },
    });
    try {
      const count = fixture.requests.length;
      await session.reconcile([server]);
      expect(fixture.requests).toHaveLength(count);
      await session.reconcile([{ ...server, enabled: false }]);
      expect(session.applyPendingTools().remove).toContain("mcp__http__echo");
      expect(session.status()).toEqual([]);
      // A stateful SDK fixture accepts one initialized connection; use stdio for subsequent restarts.
      const stdio: McpServerConfig = {
        name: "stdio",
        origin: "app",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fake-server.mjs", import.meta.url))],
        env: { TEST_TOKEN: { stored: true } },
      };
      await session.reconcile([stdio]);
      session.applyPendingTools();
      expect(session.status()[0]?.state).toBe("ready");
      await session.reconcile([{ ...stdio, callTimeoutMs: 1234 }]);
      expect(session.applyPendingTools().add.length).toBeGreaterThan(0);
      key = "test-token-456";
      await session.reconcile([{ ...stdio, callTimeoutMs: 1234 }]);
      expect(session.applyPendingTools().add.length).toBeGreaterThan(0);
      await session.reconcile([]);
      expect(session.applyPendingTools().remove.length).toBeGreaterThan(0);
    } finally {
      await session.close();
      await fixture.close();
    }
  });
});
