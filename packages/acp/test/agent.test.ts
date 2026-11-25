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
  type CreateSessionOptions,
  type FakeHandler,
  type FakeScript,
  type ModelRef,
  type Platform,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
import {
  createAcpAgentServer,
  createAcpStdioStream,
  type AcpAgentDiagnostic,
} from "../src/agent.js";

const MODEL = "fake/fake-1";

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    promise.then(
      () => "fulfilled",
      () => "rejected",
    ),
    Promise.resolve(pending),
  ]);
  return winner !== pending;
}

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
  resolveModel?: (workspaceRoot: string) => Promise<string | ModelRef | undefined>;
  wrapPlatform?: (platform: Platform) => Platform;
  createSession?: (
    opts: CreateSessionOptions,
    realCreate: (opts: CreateSessionOptions) => Promise<RuntimeSession>,
  ) => Promise<RuntimeSession>;
  diagnostics?: (record: AcpAgentDiagnostic) => void;
  onPermission?: (
    req: RequestPermissionRequest,
  ) => Promise<"allow_once" | "reject_once" | "cancel">;
}) {
  const basePlatform = createPlatform();
  const platform = options?.wrapPlatform ? options.wrapPlatform(basePlatform) : basePlatform;
  const provider = new FakeProvider({
    id: "fake",
    ...(options?.handler !== undefined
      ? { handler: options.handler }
      : { scripts: options?.scripts ?? [textScript("ok")] }),
  });
  const realRuntime: Runtime = await createRuntime({
    cwd: workspaceA,
    providers: [provider],
    interactive: true,
    permissions: { autoApproveAsk: false },
    sessionsDir: path.join(tempRoot, "sessions"),
  });
  const customCreateSession = options?.createSession;
  const runtime: Runtime =
    customCreateSession !== undefined
      ? createRuntimeStub({
          createSession: (opts) =>
            customCreateSession(opts, (inner) => realRuntime.createSession(inner)),
          defaultModel: (input) => realRuntime.defaultModel(input),
          listModels: (input) => realRuntime.listModels(input),
          close: () => realRuntime.close(),
        })
      : realRuntime;

  const server = createAcpAgentServer({
    runtime,
    platform,
    version: "0.67.0-test",
    ...(options?.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
    resolveModel:
      options?.resolveModel ??
      (async () => {
        if (options?.resolveModelError !== undefined) throw options.resolveModelError;
        return options?.noModel ? undefined : (options?.model ?? MODEL);
      }),
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
    await realRuntime.close();
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

  it("stat / resolveReal / resolveModel 暂停时遇 EOF 或 close 不会启动 Runtime 会话或宿主 MCP", async () => {
    // 1) stat 暂停时遇 EOF
    {
      const statEntered = Promise.withResolvers<undefined>();
      const statGate = Promise.withResolvers<undefined>();
      let resolveRealCalls = 0;
      let resolveModelCalls = 0;
      let createSessionCalls = 0;

      const h = await startHarness({
        wrapPlatform: (base) => ({
          ...base,
          fs: {
            ...base.fs,
            stat: async (p) => {
              statEntered.resolve(undefined);
              await statGate.promise;
              return base.fs.stat(p);
            },
          },
          resolveReal: async (p) => {
            resolveRealCalls += 1;
            return base.resolveReal(p);
          },
        }),
        resolveModel: async () => {
          resolveModelCalls += 1;
          return MODEL;
        },
        createSession: async (opts, realCreate) => {
          createSessionCalls += 1;
          return realCreate(opts);
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

      const pendingNew = h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });
      pendingNew.catch(() => undefined);

      await statEntered.promise;
      h.pair.closeClientInput();
      await h.served;

      statGate.resolve(undefined);
      await flushMicrotasks();
      h.conn.close();
      await expect(pendingNew).rejects.toThrow();
      expect(resolveRealCalls).toBe(0);
      expect(resolveModelCalls).toBe(0);
      expect(createSessionCalls).toBe(0);
    }

    // 2) resolveReal 暂停时遇 EOF
    {
      const realEntered = Promise.withResolvers<undefined>();
      const realGate = Promise.withResolvers<undefined>();
      let resolveModelCalls = 0;
      let createSessionCalls = 0;

      const h = await startHarness({
        wrapPlatform: (base) => ({
          ...base,
          resolveReal: async (p) => {
            realEntered.resolve(undefined);
            await realGate.promise;
            return base.resolveReal(p);
          },
        }),
        resolveModel: async () => {
          resolveModelCalls += 1;
          return MODEL;
        },
        createSession: async (opts, realCreate) => {
          createSessionCalls += 1;
          return realCreate(opts);
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

      const pendingNew = h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });
      pendingNew.catch(() => undefined);

      await realEntered.promise;
      h.pair.closeClientInput();
      await h.served;

      realGate.resolve(undefined);
      await flushMicrotasks();
      h.conn.close();
      await expect(pendingNew).rejects.toThrow();
      expect(resolveModelCalls).toBe(0);
      expect(createSessionCalls).toBe(0);
    }

    // 3) resolveModel 暂停时遇 EOF / server.close()（带宿主 MCP 与凭据）：不启动会话、不启动宿主 MCP
    for (const trigger of ["eof", "close"] as const) {
      const modelEntered = Promise.withResolvers<undefined>();
      const modelGate = Promise.withResolvers<string>();
      let createSessionCalls = 0;

      const h = await startHarness({
        resolveModel: async () => {
          modelEntered.resolve(undefined);
          return await modelGate.promise;
        },
        createSession: async (opts, realCreate) => {
          createSessionCalls += 1;
          return realCreate(opts);
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

      const pendingNew = h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [
          {
            name: "orch",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            env: [{ name: "ORCH_TOKEN", value: "secret-should-not-start" }],
          },
        ],
      });
      pendingNew.catch(() => undefined);

      await modelEntered.promise;
      if (trigger === "eof") {
        h.pair.closeClientInput();
        await h.served;
      } else {
        await h.server.close();
        await h.served;
      }

      modelGate.resolve(MODEL);
      await flushMicrotasks();
      h.conn.close();
      await expect(pendingNew).rejects.toThrow();
      expect(createSessionCalls).toBe(0);
    }
  });

  it("runtime.createSession 已开始时遇 EOF，closeAll 等待建会话与回滚 close 全部释放完毕", async () => {
    const createEntered = Promise.withResolvers<undefined>();
    const createGate = Promise.withResolvers<undefined>();
    const sessionCloseEntered = Promise.withResolvers<undefined>();
    const sessionCloseGate = Promise.withResolvers<undefined>();
    let sessionCloseCalls = 0;
    const diagEvents: string[] = [];

    const h = await startHarness({
      diagnostics: (rec) => {
        diagEvents.push(rec.event);
      },
      createSession: async (opts, realCreate) => {
        createEntered.resolve(undefined);
        await createGate.promise;
        const realSession = await realCreate(opts);
        const origClose = realSession.close.bind(realSession);
        return {
          ...realSession,
          close: async () => {
            sessionCloseCalls += 1;
            sessionCloseEntered.resolve(undefined);
            await sessionCloseGate.promise;
            await origClose();
          },
        };
      },
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

    const pendingNew = h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    pendingNew.catch(() => undefined);

    await createEntered.promise;
    h.pair.closeClientInput();
    const closePromise = h.server.close();

    // 建会话仍在途：served 与 server.close 都不得提前结束
    await flushMicrotasks();
    expect(await isSettled(h.served)).toBe(false);
    expect(await isSettled(closePromise)).toBe(false);

    // 放行 createSession：随后进入回滚 session.close()，仍不得提前结束
    createGate.resolve(undefined);
    await sessionCloseEntered.promise;
    await flushMicrotasks();
    expect(sessionCloseCalls).toBe(1);
    expect(await isSettled(h.served)).toBe(false);
    expect(await isSettled(closePromise)).toBe(false);

    // 放行 session.close()：资源真正释放后，closeAll 与 served 才结束，且不会登记 session_new
    sessionCloseGate.resolve(undefined);
    await Promise.all([closePromise, h.served]);
    h.conn.close();
    await expect(pendingNew).rejects.toThrow();
    expect(sessionCloseCalls).toBe(1);
    expect(diagEvents).not.toContain("session_new");
  });

  it("手动 session/close 与 EOF 重叠时，连接关闭等待同一异步回收且只 close 一次", async () => {
    // 1) 空闲会话：session/close 暂停在 session.close() 期间遇到 EOF
    {
      const sessionCloseEntered = Promise.withResolvers<undefined>();
      const sessionCloseGate = Promise.withResolvers<undefined>();
      let sessionCloseCalls = 0;

      const h = await startHarness({
        createSession: async (opts, realCreate) => {
          const realSession = await realCreate(opts);
          const origClose = realSession.close.bind(realSession);
          return {
            ...realSession,
            close: async () => {
              sessionCloseCalls += 1;
              sessionCloseEntered.resolve(undefined);
              await sessionCloseGate.promise;
              await origClose();
            },
          };
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
      const { sessionId } = await h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });

      const manualClose = h.conn.agent.request(methods.agent.session.close, { sessionId });
      manualClose.catch(() => undefined);
      await sessionCloseEntered.promise;

      // 此时 entry 已从 sessions 删除，但异步回收尚未完成；立即触发 EOF
      h.pair.closeClientInput();
      const serverClose = h.server.close();
      await flushMicrotasks();
      expect(await isSettled(h.served)).toBe(false);
      expect(await isSettled(serverClose)).toBe(false);
      expect(sessionCloseCalls).toBe(1);

      sessionCloseGate.resolve(undefined);
      await Promise.all([serverClose, h.served]);
      expect(sessionCloseCalls).toBe(1);
    }

    // 2) 运行中会话：session/close 等待 turn 中止 + session.close() 期间遇到 EOF
    {
      const turnStarted = Promise.withResolvers<undefined>();
      const turnGate = Promise.withResolvers<undefined>();
      const manualCloseEntered = Promise.withResolvers<undefined>();
      const sessionCloseEntered = Promise.withResolvers<undefined>();
      const sessionCloseGate = Promise.withResolvers<undefined>();
      let sessionCloseCalls = 0;

      const h = await startHarness({
        diagnostics: (rec) => {
          if (rec.event === "session_close") manualCloseEntered.resolve(undefined);
        },
        handler: async () => {
          turnStarted.resolve(undefined);
          await turnGate.promise;
          return textScript("late");
        },
        createSession: async (opts, realCreate) => {
          const realSession = await realCreate(opts);
          const origClose = realSession.close.bind(realSession);
          return {
            ...realSession,
            close: async () => {
              sessionCloseCalls += 1;
              sessionCloseEntered.resolve(undefined);
              await sessionCloseGate.promise;
              await origClose();
            },
          };
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
      const { sessionId } = await h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });

      const turn = h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "running" }],
      });
      turn.catch(() => undefined);
      await turnStarted.promise;

      const manualClose = h.conn.agent.request(methods.agent.session.close, { sessionId });
      manualClose.catch(() => undefined);
      await manualCloseEntered.promise;

      // EOF 到达时 turn 尚未结束，closeAll 必须等待同一 closeEntry 完成 turn 与 session.close()
      h.pair.closeClientInput();
      await flushMicrotasks();
      expect(await isSettled(h.served)).toBe(false);

      turnGate.resolve(undefined);
      await sessionCloseEntered.promise;
      await flushMicrotasks();
      expect(await isSettled(h.served)).toBe(false);
      expect(sessionCloseCalls).toBe(1);

      sessionCloseGate.resolve(undefined);
      await h.served;
      expect(sessionCloseCalls).toBe(1);
    }
  });

  it("初始化失败与重复 session/close、重复 server.close 保持既有语义且不泄漏状态", async () => {
    // 1) createSession 失败（常规 + 并发 EOF）
    {
      let attempt = 0;
      const h = await startHarness({
        createSession: async (opts, realCreate) => {
          attempt += 1;
          if (attempt === 1) {
            throw new RuntimeCommandError("invalid_command", "宿主 MCP 启动失败");
          }
          return realCreate(opts);
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

      await expect(
        h.conn.agent.request(methods.agent.session.new, {
          cwd: workspaceA,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining("宿主 MCP 启动失败"),
      });

      // 初始化失败后连接仍正常，后续可新建并关闭会话
      const created = await h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });
      expect(created.sessionId).toBeTruthy();
      await h.conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId });
    }

    // 2) createSession 失败与 EOF 重叠：closeAll 等待失败收尾并正常 resolve，不抛错
    {
      const createEntered = Promise.withResolvers<undefined>();
      const createGate = Promise.withResolvers<undefined>();

      const h = await startHarness({
        createSession: async () => {
          createEntered.resolve(undefined);
          await createGate.promise;
          throw new RuntimeCommandError("invalid_command", "部分启动失败");
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

      const pendingNew = h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });
      pendingNew.catch(() => undefined);
      await createEntered.promise;

      h.pair.closeClientInput();
      await flushMicrotasks();
      expect(await isSettled(h.served)).toBe(false);

      createGate.resolve(undefined);
      await h.served;
      h.conn.close();
      await expect(pendingNew).rejects.toThrow();
    }

    // 3) 重复 session/close（并发与顺序）及重复 server.close（并发、事后与 serve 之前）
    {
      const sessionCloseEntered = Promise.withResolvers<undefined>();
      const sessionCloseGate = Promise.withResolvers<undefined>();
      let sessionCloseCalls = 0;

      const h = await startHarness({
        createSession: async (opts, realCreate) => {
          const realSession = await realCreate(opts);
          const origClose = realSession.close.bind(realSession);
          return {
            ...realSession,
            close: async () => {
              sessionCloseCalls += 1;
              sessionCloseEntered.resolve(undefined);
              await sessionCloseGate.promise;
              await origClose();
            },
          };
        },
      });
      await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
      const { sessionId: s1 } = await h.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });

      const firstClose = h.conn.agent.request(methods.agent.session.close, { sessionId: s1 });
      await sessionCloseEntered.promise;
      // 并发重复 session/close：第二次明确报 resourceNotFound，不重复关闭
      await expect(
        h.conn.agent.request(methods.agent.session.close, { sessionId: s1 }),
      ).rejects.toMatchObject({ code: -32002 });

      sessionCloseGate.resolve(undefined);
      await expect(firstClose).resolves.toEqual({});
      expect(sessionCloseCalls).toBe(1);

      // 顺序重复 session/close：仍报 resourceNotFound
      await expect(
        h.conn.agent.request(methods.agent.session.close, { sessionId: s1 }),
      ).rejects.toMatchObject({ code: -32002 });
      expect(sessionCloseCalls).toBe(1);

      // 并发重复 server.close() 返回同一 Promise 且只关一次会话
      const close2Entered = Promise.withResolvers<undefined>();
      const close2Gate = Promise.withResolvers<undefined>();
      let s2CloseCalls = 0;
      const h2 = await startHarness({
        createSession: async (opts, realCreate) => {
          const realSession = await realCreate(opts);
          const origClose = realSession.close.bind(realSession);
          return {
            ...realSession,
            close: async () => {
              s2CloseCalls += 1;
              close2Entered.resolve(undefined);
              await close2Gate.promise;
              await origClose();
            },
          };
        },
      });
      await h2.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
      await h2.conn.agent.request(methods.agent.session.new, {
        cwd: workspaceA,
        mcpServers: [],
      });

      const c1 = h2.server.close();
      const c2 = h2.server.close();
      expect(c1).toBe(c2);
      await close2Entered.promise;
      await flushMicrotasks();
      expect(await isSettled(c1)).toBe(false);

      close2Gate.resolve(undefined);
      await Promise.all([c1, c2, h2.served]);
      expect(s2CloseCalls).toBe(1);

      // 事后重复 close 幂等返回
      await h2.server.close();
      expect(s2CloseCalls).toBe(1);

      // serve 前先 close：serve 立即返回
      const preClosed = createAcpAgentServer({
        runtime: createRuntimeStub({}),
        platform: createPlatform(),
        version: "0.67.0-test",
      });
      await preClosed.close();
      await preClosed.close();
      const pair = createPairStreams();
      await preClosed.serve(pair.agentStream);
      pair.closeClientInput();
    }
  });
});
