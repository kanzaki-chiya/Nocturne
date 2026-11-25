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
import { listenFetchSafe } from "../../../scripts/test/ports.mjs";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";
import { createMcpConnector } from "../src/index.js";
import { mapContent } from "../src/connector.js";

const fakeServer = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
const processes = createProcessCleanup();
const platform = processes.platform(createPlatform());
const closers = new Set<() => Promise<void>>();

afterEach(async () => {
  await processes.cleanup();
  for (const close of closers) await close();
  closers.clear();
});

function dummyCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
    paths: platform.paths,
    sessionId: "host-mcp-test",
    turnId: "turn-1",
    callId: "call-1",
    signal: new AbortController().signal,
    subjects: [],
    permissions: { check: () => "allow" },
    fs: platform.fs,
    process: platform.process,
    readState: { record: () => undefined, get: () => undefined },
    progress: () => undefined,
  };
}

async function createHttpFixture(options?: { echoHeader?: string }) {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const server = new Server({ name: "host-http", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "ping",
        description: "returns last seen header",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => {
    const last = seenHeaders.at(-1);
    const key = options?.echoHeader?.toLowerCase();
    const val = key ? String(last?.[key] ?? "") : "pong";
    return { content: [{ type: "text", text: `seen=${val}` }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  const httpServer = createServer((req, res) => {
    seenHeaders.push(req.headers);
    void transport.handleRequest(req, res);
  });
  const port = await listenFetchSafe(httpServer);
  closers.add(
    () =>
      new Promise<void>((resolve) => {
        void server.close().finally(() => httpServer.close(() => resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${port}/mcp`, seenHeaders };
}

describe("宿主注入 MCP（ADR-0120 §3）", () => {
  it("hostCredentials 与用户凭据库严格隔离，不回退读取用户凭据", async () => {
    const connector = createMcpConnector();
    const scope: McpOpenScope = {
      servers: [
        {
          name: "host_srv",
          origin: "host",
          type: "stdio",
          command: process.execPath,
          args: [fakeServer],
          env: { HOST_TOKEN: { stored: true } },
          startupTimeoutMs: 5000,
        },
      ],
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      sessionId: "sess-iso",
      platform,
      // 用户凭据库里有同名键，但宿主服务器严禁读取
      credentials: {
        get: (id) =>
          Promise.resolve(
            id === "mcp/host_srv/HOST_TOKEN" ? "user-db-secret-must-not-use" : undefined,
          ),
      },
      hostCredentials: {
        get: () => Promise.resolve(undefined),
      },
      emitServer: () => undefined,
      warn: () => undefined,
    };

    const session = await connector.open(scope);
    closers.add(() => session.close());
    await session.startupHost?.();

    const status = session.status().find((s) => s.name === "host_srv");
    expect(status?.state).toBe("failed");
    expect(status?.error).toContain("缺少凭据");
  });

  it("stdio 与 HTTP 宿主凭据仅交给目标服务器且从工具输出脱敏，非敏感标签不被误脱敏", async () => {
    const httpFixture = await createHttpFixture({ echoHeader: "authorization" });
    const connector = createMcpConnector();
    const hostCreds = new Map<string, string>([
      ["mcp/host_stdio/HOST_SECRET_TOKEN", "stdio-secret-xyz-999"],
      ["mcp/host_stdio/SESSION_TAG", "alpha-session-tag"],
      ["mcp/host_http/authorization", "Bearer http-secret-abc-777"],
    ]);

    const scope: McpOpenScope = {
      servers: [
        {
          name: "host_stdio",
          origin: "host",
          type: "stdio",
          command: process.execPath,
          args: [fakeServer],
          env: {
            HOST_SECRET_TOKEN: { stored: true },
            SESSION_TAG: { stored: true },
          },
          startupTimeoutMs: 5000,
        },
        {
          name: "host_http",
          origin: "host",
          type: "http",
          url: httpFixture.url,
          headers: { authorization: { stored: true } },
          startupTimeoutMs: 5000,
        },
      ],
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      sessionId: "sess-redact",
      platform,
      hostCredentials: {
        get: (id) => Promise.resolve(hostCreds.get(id)),
      },
      emitServer: () => undefined,
      warn: () => undefined,
    };

    const session = await connector.open(scope);
    closers.add(() => session.close());
    await session.startupHost?.();
    session.applyPendingTools();

    const tools = new Map(session.tools().map((t) => [t.name, t]));
    const envReport = tools.get("mcp__host_stdio__env_report");
    if (envReport === undefined) throw new Error("missing mcp__host_stdio__env_report");
    const envRes = await envReport.execute(
      { keys: ["HOST_SECRET_TOKEN", "SESSION_TAG"] },
      dummyCtx(),
    );
    expect(envRes.status).toBe("ok");
    expect(JSON.parse(envRes.modelContent)).toEqual({
      HOST_SECRET_TOKEN: true,
      SESSION_TAG: true,
    });

    const echoTool = tools.get("mcp__host_stdio__echo");
    if (echoTool === undefined) throw new Error("missing mcp__host_stdio__echo");
    const echoRes = await echoTool.execute(
      { text: "leak=stdio-secret-xyz-999 tag=alpha-session-tag" },
      dummyCtx(),
    );
    expect(echoRes.status).toBe("ok");
    // 敏感 token 被脱敏，非敏感会话标签保留
    expect(echoRes.modelContent).not.toContain("stdio-secret-xyz-999");
    expect(echoRes.modelContent).toContain("***");
    expect(echoRes.modelContent).toContain("alpha-session-tag");

    const httpPing = tools.get("mcp__host_http__ping");
    if (httpPing === undefined) throw new Error("missing mcp__host_http__ping");
    const httpRes = await httpPing.execute({}, dummyCtx());
    expect(httpRes.status).toBe("ok");
    // HTTP 服务器真实收到了 Bearer 凭据，但返回输出中完整值和裸 token 均被脱敏
    expect(
      httpFixture.seenHeaders.some((h) => h.authorization === "Bearer http-secret-abc-777"),
    ).toBe(true);
    expect(httpRes.modelContent).not.toContain("http-secret-abc-777");
  });

  it("strictHostMcp 拒绝不区分大小写的同名冲突，且 reconcile 保留宿主条目", async () => {
    const connector = createMcpConnector();
    const baseCfg = (name: string, origin: McpServerConfig["origin"]): McpServerConfig => ({
      name,
      origin,
      type: "stdio",
      command: process.execPath,
      args: [fakeServer],
      startupTimeoutMs: 5000,
    });

    await expect(
      connector.open({
        servers: [baseCfg("Shared", "user"), baseCfg("shared", "host")],
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        sessionId: "sess-conflict",
        platform,
        strictHostMcp: true,
        emitServer: () => undefined,
        warn: () => undefined,
      }),
    ).rejects.toThrow("冲突");

    const warnings: string[] = [];
    const session = await connector.open({
      servers: [baseCfg("host_only", "host")],
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      sessionId: "sess-reconcile",
      platform,
      strictHostMcp: true,
      emitServer: () => undefined,
      warn: (_code, msg) => warnings.push(msg),
    });
    closers.add(() => session.close());
    await session.startupHost?.();
    session.applyPendingTools();

    // 用户配置重载为空列表或尝试添加同名服务器：宿主服务器保留且冲突用户条目被跳过
    await session.reconcile([baseCfg("HOST_ONLY", "user")]);
    expect(session.status().find((s) => s.name === "host_only")?.state).toBe("ready");
    expect(warnings.some((w) => w.includes("HOST_ONLY"))).toBe(true);
  });

  it("当 MCP 工具仅返回 structuredContent 且 content 为空时序列化进 modelContent，不重复已有文本", () => {
    const onlyStructured = mapContent({
      content: [],
      structuredContent: { agentId: "ag_123", status: "running" },
    });
    expect(JSON.parse(onlyStructured.text)).toEqual({ agentId: "ag_123", status: "running" });
    expect(onlyStructured.output).toEqual({
      content: [],
      structured: { agentId: "ag_123", status: "running" },
    });

    const withText = mapContent({
      content: [{ type: "text", text: "plain summary" }],
      structuredContent: { agentId: "ag_123" },
    });
    expect(withText.text).toBe("plain summary");
    expect(withText.output).toEqual({
      content: [{ type: "text" }],
      structured: { agentId: "ag_123" },
    });
  });
});
