import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  RuntimeCommandError,
  type FakeHandler,
  type FakeScript,
  type Runtime,
} from "@nocturne/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
import { createAcpAgentServer, createAcpStdioStream } from "../src/agent.js";

const MODEL = "fake/fake-1";

function textScript(text: string): FakeScript {
  return [
    { type: "text_delta", text },
    { type: "finish", reason: "stop" },
  ];
}

function createPairStreams() {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  return {
    agentStream: createAcpStdioStream(clientToAgent, agentToClient),
    clientStream: createAcpStdioStream(agentToClient, clientToAgent),
    closeClientInput: () => clientToAgent.end(),
  };
}

let tempRoot: string;
let workspaceA: string;
let workspaceB: string;
const cleanups: (() => Promise<void>)[] = [];

const originalEnv = {
  NOCTURNE_HOME: process.env.NOCTURNE_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-acp-agent-"));
  workspaceA = path.join(tempRoot, "ws-a");
  workspaceB = path.join(tempRoot, "ws-b");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  process.env.NOCTURNE_HOME = path.join(tempRoot, "nocturne-home");
  process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
  process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, "claude-home");
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    await fn?.().catch(() => undefined);
  }
  if (originalEnv.NOCTURNE_HOME === undefined) delete process.env.NOCTURNE_HOME;
  else process.env.NOCTURNE_HOME = originalEnv.NOCTURNE_HOME;
  if (originalEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalEnv.CODEX_HOME;
  if (originalEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalEnv.CLAUDE_CONFIG_DIR;
  await removeTempDirs([tempRoot]);
});

async function startHarness(options?: {
  handler?: FakeHandler;
  scripts?: FakeScript[];
  model?: string | undefined;
  noModel?: boolean;
  resolveModelError?: Error;
  onPermission?: (
    req: RequestPermissionRequest,
  ) => Promise<"allow_once" | "reject_once" | "cancel">;
}) {
  const platform = createPlatform();
  const provider = new FakeProvider({
    id: "fake",
    ...(options?.handler !== undefined
      ? { handler: options.handler }
      : { scripts: options?.scripts ?? [textScript("ok")] }),
  });
  const runtime: Runtime = await createRuntime({
    cwd: workspaceA,
    providers: [provider],
    interactive: true,
    permissions: { autoApproveAsk: false },
    sessionsDir: path.join(tempRoot, "sessions"),
  });

  const server = createAcpAgentServer({
    runtime,
    platform,
    version: "0.67.0-test",
    resolveModel: async () => {
      if (options?.resolveModelError !== undefined) throw options.resolveModelError;
      return options?.noModel ? undefined : (options?.model ?? MODEL);
    },
  });

  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const pair = createPairStreams();

  const served = server.serve(pair.agentStream);
  const cliApp = client({ name: "test-host" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      permissions.push(ctx.params);
      const decision = (await options?.onPermission?.(ctx.params)) ?? "reject_once";
      if (decision === "cancel") {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: decision } };
    });

  const conn = cliApp.connect(pair.clientStream);
  cleanups.push(async () => {
    conn.close();
    pair.closeClientInput();
    await served;
    await runtime.close();
  });

  return { conn, server, runtime, updates, permissions, pair, served };
}

describe("ACP Agent 协议与能力契约（ADR-0120 §1–3）", () => {
  it("initialize 协商协议版本并如实声明已实现的能力", async () => {
    const h = await startHarness();
    const res = await h.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-host", version: "1.0.0" },
    });

    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.agentInfo).toEqual({
      name: "nocturne",
      title: "Nocturne",
      version: "0.67.0-test",
    });
    expect(res.agentCapabilities).toEqual({
      loadSession: false,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: {
        http: true,
        sse: false,
        acp: false,
      },
      sessionCapabilities: {
        close: {},
      },
    });
  });

  it("未配置模型或凭据缺失时 session/new 返回引导运行 nctrn setup 的可操作错误", async () => {
    const h = await startHarness({ noModel: true });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("nctrn setup"),
    });

    const hMissingKey = await startHarness({
      resolveModelError: new RuntimeCommandError(
        "invalid_model",
        "缺少凭据：环境变量 OPENAI_API_KEY 未设置",
      ),
    });
    await hMissingKey.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });
    await expect(
      hMissingKey.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("nctrn setup"),
      data: { code: "model_not_configured" },
    });
  });

  it("session/new 校验绝对 cwd、目录存在性及不支持的 MCP 传输/URL/重名", async () => {
    const h = await startHarness();
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

    // 相对 cwd
    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: "relative/path",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 不存在的目录
    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: path.join(tempRoot, "does-not-exist"),
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 不支持的 additionalDirectories
    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        additionalDirectories: [workspaceB],
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 不支持的 SSE 传输
    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [
          { type: "sse", name: "legacy", url: "http://127.0.0.1:9999/sse", headers: [] },
        ],
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("sse"),
    });

    // 非回环明文 HTTP URL
    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [
          { type: "http", name: "remote_plain", url: "http://example.com/mcp", headers: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 宿主列表内不区分大小写重名
    await expect(
      h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [
          { name: "Orch", command: process.execPath, args: [], env: [] },
          { name: "orch", command: process.execPath, args: [], env: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("同一会话忙时拒绝重入，且仅支持文本 prompt 与合法 sessionId", async () => {
    const release = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    const h = await startHarness({
      handler: async (_req, callIndex) => {
        if (callIndex === 0) {
          started.resolve(undefined);
          await release.promise;
          return textScript("first done");
        }
        return textScript("second done");
      },
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });

    // 未知 sessionId
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId: "unknown-session-id",
        prompt: [{ type: "text", text: "hi" }],
      }),
    ).rejects.toMatchObject({ code: -32002 });

    // 不支持的 image 内容块
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 发起第一轮并等待进入模型流
    const firstTurn = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "turn 1" }],
    });
    await started.promise;

    // 同一会话忙时重入明确被拒绝
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "reentrant" }],
      }),
    ).rejects.toMatchObject({
      code: -32600,
      data: expect.objectContaining({ code: "session_busy" }),
    });

    release.resolve(undefined);
    expect(await firstTurn).toEqual({ stopReason: "end_turn" });

    // 会话结束后可接受第二轮
    const secondTurn = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "turn 2" }],
    });
    expect(secondTurn).toEqual({ stopReason: "end_turn" });

    // session/close 关闭该会话后不再可 prompt
    await h.conn.agent.request(methods.agent.session.close, { sessionId });
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "after close" }],
      }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});
