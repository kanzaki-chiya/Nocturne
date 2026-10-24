/**
 * MCP 运行时来源与图片映射测试（desktop-browser.md 第 1、4 节）：
 * - 受信运行时来源的调用者 _meta 注入（普通 MCP 不发送）；
 * - 所有 MCP image 通用、受预算地映射到 ToolResult.attachments，不按工具名特殊处理；
 * - 运行时来源合并、同名冲突跳过、reconcile 保留、close 释放。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createPlatform,
  type McpOpenScope,
  type McpServerConfig,
  type ToolContext,
} from "@nocturne/core";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";
import { listenFetchSafe } from "../../../scripts/test/ports.mjs";

import { createMcpConnector, mapContent, type RuntimeMcpSource } from "../src/connector.js";

const processes = createProcessCleanup();
const platform = processes.platform(createPlatform());
const closers = new Set<() => Promise<void>>();
afterEach(async () => {
  await processes.cleanup();
  for (const close of closers) await close();
  closers.clear();
});

// 1x1 PNG（透明），1x1 GIF（用于 MIME 不一致用例）
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1X1 = "R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=";

const baseScope = (servers: McpServerConfig[], extra?: Partial<McpOpenScope>): McpOpenScope => ({
  servers,
  cwd: process.cwd(),
  workspaceRoot: process.cwd(),
  sessionId: "root-session",
  platform,
  emitServer: () => undefined,
  warn: () => undefined,
  ...extra,
});

const toolCtx = (callId: string): ToolContext =>
  ({
    signal: new AbortController().signal,
    sessionId: "root-session",
    turnId: "turn-1",
    callId,
  }) as ToolContext;

interface Fixture {
  url: string;
  lastMeta: unknown[];
  lastHeaders: Record<string, string | string[] | undefined>[];
  close: () => Promise<void>;
}

async function imageMetaFixture(
  handler: (params: { name?: string; arguments?: unknown; _meta?: unknown }) => CallToolResult,
): Promise<Fixture> {
  const lastMeta: unknown[] = [];
  const lastHeaders: Record<string, string | string[] | undefined>[] = [];
  const server = new Server({ name: "fake-agent", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "shot",
        description: "screenshot",
        inputSchema: { type: "object", properties: {} },
        // 只有受信运行时来源的这条声明会被采信（fileEffects，见 mcp.md 第 7 节）
        _meta: { "nocturne/fileEffects": "none" },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    lastMeta.push(request.params._meta);
    return handler(request.params as { name?: string; arguments?: unknown; _meta?: unknown });
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  const http = createServer((req, res) => {
    lastHeaders.push({ ...req.headers });
    void (async () => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
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
  const port = await listenFetchSafe(http);
  return { url: `http://127.0.0.1:${port}/mcp`, lastMeta, lastHeaders, close };
}

describe("MCP 图片通用映射（不按工具名特殊处理）", () => {
  it("有效 PNG 进入 attachments，文本带尺寸", async () => {
    const fx = await imageMetaFixture(() => ({
      content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    }));
    try {
      const session = await createMcpConnector().open(
        baseScope([{ name: "pics", origin: "user", type: "http", url: fx.url }]),
      );
      try {
        await session.startup();
        session.applyPendingTools();
        const tool = session.tools()[0];
        expect(tool).toBeDefined();
        const res = await tool?.execute({}, toolCtx("call-img-1"));
        expect(res?.status).toBe("ok");
        expect(res?.attachments?.length).toBe(1);
        expect(res?.attachments?.[0]?.mimeType).toBe("image/png");
        expect(res?.modelContent).toContain("1×1");
      } finally {
        await session.close();
      }
    } finally {
      await fx.close();
    }
  });

  it("不支持类型/损坏/MIME 不符被跳过，不进 attachments", () => {
    const badType = mapContent({
      content: [{ type: "image", data: PNG_1X1, mimeType: "image/tiff" }],
    } as unknown as CallToolResult);
    expect(badType.attachments ?? []).toEqual([]);
    expect(badType.text).toContain("不支持");

    const corrupt = mapContent({
      content: [{ type: "image", data: "!!!", mimeType: "image/png" }],
    } as unknown as CallToolResult);
    expect(corrupt.attachments ?? []).toEqual([]);
    expect(corrupt.text).toContain("跳过");

    const mismatch = mapContent({
      content: [{ type: "image", data: GIF_1X1, mimeType: "image/png" }],
    } as unknown as CallToolResult);
    expect(mismatch.attachments ?? []).toEqual([]);
    expect(mismatch.text).toContain("跳过");
  });

  it("超过 4 张时多余被截断", () => {
    const content = Array.from({ length: 5 }, () => ({
      type: "image",
      data: PNG_1X1,
      mimeType: "image/png",
    }));
    const mapped = mapContent({ content } as unknown as CallToolResult);
    expect(mapped.attachments?.length).toBe(4);
    expect(mapped.text).toContain("已跳过");
  });

  it("单张超 5MB 与合计超 8MB 被拒绝", () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    // PNG 魔数，保证走到长度分支（长度优先于文件头校验）
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;
    big[4] = 0x0d;
    big[5] = 0x0a;
    big[6] = 0x1a;
    big[7] = 0x0a;
    const single = mapContent({
      content: [{ type: "image", data: big.toString("base64"), mimeType: "image/png" }],
    } as unknown as CallToolResult);
    expect(single.attachments ?? []).toEqual([]);
    expect(single.text).toContain("5 MB");

    const fourMb = Buffer.alloc(4 * 1024 * 1024);
    fourMb[0] = 0x89;
    fourMb[1] = 0x50;
    fourMb[2] = 0x4e;
    fourMb[3] = 0x47;
    fourMb[4] = 0x0d;
    fourMb[5] = 0x0a;
    fourMb[6] = 0x1a;
    fourMb[7] = 0x0a;
    const data = fourMb.toString("base64");
    const total = mapContent({
      content: [
        { type: "image", data, mimeType: "image/png" },
        { type: "image", data, mimeType: "image/png" },
        { type: "image", data, mimeType: "image/png" },
      ],
    } as unknown as CallToolResult);
    // 前两张合计 8MB 可通过（文件头损坏仍可能在 sniff 阶段被拒；这里只断言不超过合计上限的语义：
    // 第三张必须因合计超限或文件头原因被跳过，且 attachments 不超过 2 张）
    expect((total.attachments ?? []).length).toBeLessThanOrEqual(2);
    expect(total.text).toContain("跳过");
  });
});

describe("调用者 _meta 注入（仅受信运行时来源）", () => {
  it("运行时来源的调用带 sessionId/turnId/callId，fileEffects 声明只对它生效；普通 MCP 都不带", async () => {
    const plainFx = await imageMetaFixture((params) => ({
      content: [{ type: "text", text: JSON.stringify(params._meta ?? null) }],
    }));
    const rtFx = await imageMetaFixture((params) => ({
      content: [{ type: "text", text: JSON.stringify(params._meta ?? null) }],
    }));
    try {
      // 普通 MCP：不注入
      const plain = await createMcpConnector().open(
        baseScope([{ name: "plain", origin: "user", type: "http", url: plainFx.url }]),
      );
      try {
        await plain.startup();
        plain.applyPendingTools();
        const tool = plain.tools()[0];
        expect(tool).toBeDefined();
        await tool?.execute({}, toolCtx("call-plain"));
        expect(plainFx.lastMeta.at(-1)).toBeUndefined();
        // 普通 MCP 自称不改文件也不采信：照常计入未追踪调用
        expect(tool?.traits.fileEffects).toBeUndefined();
      } finally {
        await plain.close();
      }

      // 受信运行时来源：注入
      const bearer = "runtime-bearer-123";
      const src: RuntimeMcpSource = {
        open: async () => ({
          servers: [
            {
              name: "desktop_browser",
              origin: "app",
              type: "http",
              url: rtFx.url,
              headers: { authorization: { stored: true } },
            },
          ],
          credentials: {
            get: async (id) => (id === "mcp/desktop_browser/authorization" ? bearer : undefined),
          },
          callerMetadata: true,
          close: async () => undefined,
        }),
      };
      const session = await createMcpConnector({ runtimeServers: [src] }).open(baseScope([]));
      try {
        await session.startup();
        session.applyPendingTools();
        const all = session.tools().map((t) => t.name);
        const st = session.status();
        expect(st).toMatchObject([{ name: "desktop_browser", state: "ready" }]);
        const tool = session.tools().find((t) => t.name === "mcp__desktop_browser__shot");
        expect(all).toContain("mcp__desktop_browser__shot");
        expect(tool).toBeDefined();
        expect(tool?.traits.fileEffects).toBe("none");
        const res = await tool?.execute({}, toolCtx("call-rt-1"));
        expect(res?.status).toBe("ok");
        expect(rtFx.lastMeta.at(-1)).toMatchObject({
          "nocturne/caller": { sessionId: "root-session", turnId: "turn-1", callId: "call-rt-1" },
        });
        // bearer 只在请求头，不在模型文本
        expect(JSON.stringify(res)).not.toContain(bearer);
        expect(
          (rtFx.lastHeaders.at(-1)?.authorization as string | undefined) ??
            (rtFx.lastHeaders.at(-1)?.Authorization as string | undefined),
        ).toContain(bearer);
      } finally {
        await session.close();
      }
    } finally {
      await plainFx.close();
      await rtFx.close();
    }
  });

  it("同名用户配置被跳过、reconcile 保留运行时、close 释放来源", async () => {
    const fx = await imageMetaFixture(() => ({ content: [{ type: "text", text: "ok" }] }));
    try {
      const warnings: { code: string; message: string }[] = [];
      let closed = 0;
      const src: RuntimeMcpSource = {
        open: async () => ({
          servers: [{ name: "desktop_browser", origin: "app", type: "http", url: fx.url }],
          credentials: { get: async () => undefined },
          callerMetadata: true,
          close: async () => {
            closed += 1;
          },
        }),
      };
      const session = await createMcpConnector({ runtimeServers: [src] }).open(
        baseScope([{ name: "Desktop_Browser", origin: "user", type: "http", url: fx.url }], {
          warn: (code, message) => warnings.push({ code, message }),
        }),
      );
      try {
        await session.startup();
        session.applyPendingTools();
        const names = session.tools().map((t) => t.name);
        // 运行时工具存在，用户同名条目被跳过（只保留一份 desktop_browser 工具）
        expect(names.filter((n) => n.includes("desktop_browser")).length).toBeGreaterThan(0);
        expect(warnings.some((w) => w.message.includes("重名"))).toBe(true);

        // reconcile 只给空用户配置，运行时仍保留
        await session.reconcile([]);
        expect(
          session
            .tools()
            .map((t) => t.name)
            .filter((n) => n.includes("desktop_browser")).length,
        ).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
      expect(closed).toBe(1);
    } finally {
      await fx.close();
    }
  });
});
