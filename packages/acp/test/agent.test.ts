import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionConfigSelectOption,
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
  type ModelInfo,
  type ModelRef,
  type Platform,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function requireConfigOption(
  options: readonly SessionConfigOption[],
  id: string,
): SessionConfigOption & { type: "select" } {
  const opt = options.find((o) => o.id === id);
  if (opt === undefined || opt.type === "boolean") {
    throw new Error(`config option ${id} missing or not a select`);
  }
  return opt as SessionConfigOption & { type: "select" };
}

function selectValues(opt: SessionConfigOption & { type: "select" }): string[] {
  return (opt.options as readonly (SessionConfigSelectOption | { group: string })[])
    .filter((o): o is SessionConfigSelectOption => "value" in o)
    .map((o) => o.value);
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
  models?: ModelInfo[] | undefined;
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
    ...(options?.models !== undefined ? { models: options.models } : {}),
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
      loadSession: true,
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

describe("session/new configOptions 与 session/set_config_option（ADR-0127 第一阶段）", () => {
  function modelEntry(
    model: string,
    reasoningEffort?: ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")[],
    extra?: Partial<ModelInfo>,
  ): ModelInfo {
    return {
      ref: { provider: "fake", model },
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: reasoningEffort !== undefined && reasoningEffort.length > 0 ? "visible" : "none",
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        imageInput: false,
        promptCache: false,
        editTool: "edit",
        historyPrune: true,
      },
      ...extra,
    };
  }

  async function newSession(h: Awaited<ReturnType<typeof startHarness>>, cwd: string) {
    return await h.conn.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
  }

  it("session/new 返回真实 configOptions：当前模型、完整 provider/model ID 与该模型实际档位", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [
        modelEntry("fake-1", ["minimal", "low", "high"]),
        modelEntry("org/deep-model", ["low", "medium", "high", "max"], {
          displayName: "Deep Model",
        }),
        modelEntry("broken-model", undefined, {
          unavailable: { reason: "协议不支持" },
        }),
      ],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const res = await newSession(h, workspaceA);

    expect(res.configOptions).toBeDefined();
    const modelOpt = requireConfigOption(res.configOptions ?? [], "model");
    expect(modelOpt).toMatchObject({
      type: "select",
      category: "model",
      currentValue: "fake/fake-1",
    });
    const values = selectValues(modelOpt);
    // 完整 provider/model ID，含多段斜杠保留；不可用模型不列出
    expect(values).toContain("fake/fake-1");
    expect(values).toContain("fake/org/deep-model");
    expect(values).not.toContain("fake/broken-model");
    const deep = (modelOpt.options as readonly SessionConfigSelectOption[]).find(
      (o) => o.value === "fake/org/deep-model",
    );
    expect(deep?.name).toBe("fake/Deep Model");

    const effortOpt = requireConfigOption(res.configOptions ?? [], "thought_level");
    expect(effortOpt).toMatchObject({
      type: "select",
      category: "thought_level",
      currentValue: "off",
    });
    expect(selectValues(effortOpt)).toEqual(["off", "minimal", "low", "high"]);
  });

  it("无可调档位的模型不出 thought_level 配置项，但 model 选择器仍在", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [modelEntry("fake-1", [])],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const res = await newSession(h, workspaceA);
    expect(res.configOptions?.some((o: { id: string }) => o.id === "thought_level")).toBe(false);
    expect(res.configOptions?.some((o: { id: string }) => o.id === "model")).toBe(true);
  });

  it("当前模型不在工作区目录（如经 --model 指定清单外）时追加一项保证 currentValue 命中", async () => {
    const h = await startHarness({
      model: "fake/outside-model",
      models: [modelEntry("fake-1", ["low", "high"])],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const res = await newSession(h, workspaceA);
    const modelOpt = requireConfigOption(res.configOptions ?? [], "model");
    expect(modelOpt.currentValue).toBe("fake/outside-model");
    expect(selectValues(modelOpt)).toContain("fake/outside-model");
  });

  it("set_config_option 切换模型后刷新档位并回报完整配置；prompt 用新模型", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [
        modelEntry("fake-1", ["minimal", "low"]),
        modelEntry("fake-2", ["high", "xhigh", "max"]),
      ],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await newSession(h, workspaceA);

    const res = await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "fake/fake-2",
    });
    expect(requireConfigOption(res.configOptions, "model").currentValue).toBe("fake/fake-2");
    expect(selectValues(requireConfigOption(res.configOptions, "thought_level"))).toEqual([
      "off",
      "high",
      "xhigh",
      "max",
    ]);

    // 切档后立即生效于下一轮
    const eff = await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "thought_level",
      value: "xhigh",
    });
    expect(requireConfigOption(eff.configOptions, "thought_level").currentValue).toBe("xhigh");

    // config_option_update 通知随每次变更发出
    await flushMicrotasks();
    const configUpdates = h.updates.filter(
      (u) => u.sessionId === sessionId && u.update.sessionUpdate === "config_option_update",
    );
    expect(configUpdates.length).toBeGreaterThanOrEqual(2);
  });

  it("未知配置项、非法模型引用与未知档位都拒绝且保留原配置", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [modelEntry("fake-1", ["low", "high"]), modelEntry("fake-2", ["high", "max"])],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await newSession(h, workspaceA);

    // 未知配置项
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "permission_mode",
        value: "bypass",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 非法模型引用（无斜杠）
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: "no-slash",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 未知 provider/model
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: "ghost/missing",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 清单外模型（FakeProvider strictModels）
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: "fake/not-declared",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 模型未声明的档位
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "thought_level",
        value: "max",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 未知档位名
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "thought_level",
        value: "ultra",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 布尔型请求一律拒绝（当前无布尔配置项）
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        type: "boolean",
        value: true,
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 原配置不变：再读一次完整配置核对
    const verify = await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "thought_level",
      value: "low",
    });
    expect(requireConfigOption(verify.configOptions, "model").currentValue).toBe("fake/fake-1");
    expect(requireConfigOption(verify.configOptions, "thought_level").currentValue).toBe("low");
  });

  it("忙时切换模型失败且保留原配置；空闲时切档位成功", async () => {
    const release = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    const h = await startHarness({
      model: "fake/fake-1",
      models: [modelEntry("fake-1", ["low", "high"]), modelEntry("fake-2", ["high", "max"])],
      handler: async (_req, callIndex) => {
        if (callIndex === 0) {
          started.resolve(undefined);
          await release.promise;
          return textScript("first");
        }
        return textScript("later");
      },
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await newSession(h, workspaceA);

    const turn = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    turn.catch(() => undefined);
    await started.promise;

    // 忙时切模型：Core session_busy —— 映射为 invalidRequest 且原配置保留
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: "fake/fake-2",
      }),
    ).rejects.toMatchObject({ code: -32600 });

    // 忙时切档位允许（下一个 Turn 生效）——ADR-0018 §3：本 Turn 沿用快照
    const effRes = await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "thought_level",
      value: "high",
    });
    // current 已更新为下一轮意图；effective（本 Turn 快照）不暴露在选择器上
    expect(requireConfigOption(effRes.configOptions, "thought_level").currentValue).toBe("high");

    release.resolve(undefined);
    await turn;

    // Turn 结束后模型仍未切换（忙时那次被拒绝），档位意图保留
    const post = await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "fake/fake-2",
    });
    expect(requireConfigOption(post.configOptions, "model").currentValue).toBe("fake/fake-2");
    // 换模型后档位集合刷新为 fake-2 的档位；原 "high" 意图在新模型可用集合内得以保留
    const effort = requireConfigOption(post.configOptions, "thought_level");
    expect(selectValues(effort)).toEqual(["off", "high", "max"]);
    expect(effort.currentValue).toBe("high");
  });

  it("同一连接上的不同会话互不影响：A 切模型不影响 B 的默认值", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [modelEntry("fake-1", ["low", "high"]), modelEntry("fake-2", ["high", "max"])],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const sA = await newSession(h, workspaceA);
    const sB = await newSession(h, workspaceB);
    expect(sA.sessionId).not.toBe(sB.sessionId);

    await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId: sA.sessionId,
      configId: "model",
      value: "fake/fake-2",
    });
    await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId: sA.sessionId,
      configId: "thought_level",
      value: "max",
    });

    // B 的配置仍是初始默认；A 的 config_option_update 不会出现在 B 的更新流里
    await flushMicrotasks();
    const bModelUpdates = h.updates.filter(
      (u) => u.sessionId === sB.sessionId && u.update.sessionUpdate === "config_option_update",
    );
    expect(bModelUpdates).toHaveLength(0);

    // 对 B 查询（借一次合法 set 验证其当前值）：B 仍为 fake-1/off
    const verifyB = await h.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId: sB.sessionId,
      configId: "thought_level",
      value: "low",
    });
    expect(requireConfigOption(verifyB.configOptions, "model").currentValue).toBe("fake/fake-1");

    // A 的更新全部带 A 的 sessionId
    const aModelUpdates = h.updates.filter(
      (u) => u.update.sessionUpdate === "config_option_update" && u.sessionId === sA.sessionId,
    );
    expect(aModelUpdates.length).toBeGreaterThanOrEqual(2);
  });

  it("旧宿主不使用 configOptions 直接 prompt 仍按默认模型正常对话", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [modelEntry("fake-1", ["low", "high"])],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await newSession(h, workspaceA);
    // 忽略 configOptions、不发任何 set_config_option，直接对话
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "legacy hello" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
  });

  it("已关闭会话的 set_config_option 报 resourceNotFound", async () => {
    const h = await startHarness({
      model: "fake/fake-1",
      models: [modelEntry("fake-1", ["low"])],
    });
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await newSession(h, workspaceA);
    await h.conn.agent.request(methods.agent.session.close, { sessionId });
    await expect(
      h.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: "fake/fake-1",
      }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});

describe("session/load 跨进程恢复（ADR-0127 第二阶段）", () => {
  async function initAndCreate(
    h: Awaited<ReturnType<typeof startHarness>>,
    cwd: string,
    promptText?: string,
  ) {
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const created = await h.conn.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    const sessionId = (created as { sessionId: string }).sessionId;
    if (promptText !== undefined) {
      await h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
    }
    return sessionId;
  }

  it("initialize 广告 loadSession: true", async () => {
    const h = await startHarness();
    const res = await h.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });
    expect((res as { agentCapabilities: { loadSession: boolean } }).agentCapabilities.loadSession).toBe(true);
  });

  it("session/new 创建的会话带 ACP 归属标记（session.created.client.name === acp）", async () => {
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA);
    const entry = (h.runtime as unknown as { sessionsDir?: string });
    void entry;
    // 直接读日志首行验证归属事件
    const sessionsDir = path.join(tempRoot, "sessions");
    const firstLine = (await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), "utf8")).split("\n")[0] ?? "";
    const created = JSON.parse(firstLine) as { payload: { client?: { kind: string; name: string } } };
    expect(created.payload.client).toMatchObject({ kind: "agent", name: "acp" });
  });

  it("无效 ID、相对 cwd、不存在目录、additionalDirectories 在触碰锁之前拒绝", async () => {
    const h = await startHarness();
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });

    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: "../evil",
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: "202601010000-abcdef01",
        cwd: "relative/path",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: "202601010000-abcdef01",
        cwd: path.join(tempRoot, "no-such-dir"),
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: "202601010000-abcdef01",
        cwd: workspaceA,
        additionalDirectories: [workspaceB],
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("不存在的会话 ID 返回 resourceNotFound 且不创建锁文件", async () => {
    const h = await startHarness();
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: "202601010000-abcdef01",
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32002 });
    const sessionsDir = path.join(tempRoot, "sessions");
    const files = await fs.readdir(sessionsDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.includes("abcdef01"))).toEqual([]);
  });

  it("非 ACP 会话（无 client 标记）拒绝恢复——不成为任意本地会话入口", async () => {
    // 先用裸 Runtime 直接创建一个没有 ACP 标记的会话
    const provider = new FakeProvider({ id: "fake", scripts: [textScript("x")] });
    const rt = await createRuntime({
      cwd: workspaceA,
      providers: [provider],
      interactive: true,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const foreign = await rt.createSession({ model: "fake/fake-1", cwd: workspaceA, workspaceRoot: workspaceA });
    const foreignId = foreign.id;
    await foreign.close();

    const h = await startHarness();
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: foreignId,
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32002 });
    await rt.close();
  });

  it("工作区不匹配拒绝恢复（workspace_mismatch）", async () => {
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA, "first");
    // 关闭受管会话释放锁
    await h.conn.agent.request(methods.agent.session.close, { sessionId });
    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceB,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("工作区") });
  });

  it("同一连接重复 load 同一会话拒绝（session_already_loaded）", async () => {
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA, "hello");
    // 会话仍在受管状态（未 close）——直接 load 同一 ID
    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32600 });
  });

  it("并发 load 同一会话：至多一个成功，锁不泄漏", async () => {
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA, "concurrent base");
    await h.conn.agent.request(methods.agent.session.close, { sessionId });

    // 同帧发出两个 load（JSON-RPC 允许并发请求）
    const results = await Promise.allSettled([
      h.conn.agent.request(methods.agent.session.load, { sessionId, cwd: workspaceA, mcpServers: [] }),
      h.conn.agent.request(methods.agent.session.load, { sessionId, cwd: workspaceA, mcpServers: [] }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeLessThanOrEqual(1);
    // 锁文件不泄漏：管理内会话关闭后无残留锁
    await h.conn.agent.request(methods.agent.session.close, { sessionId }).catch(() => undefined);
    const sessionsDir = path.join(tempRoot, "sessions");
    const files = await fs.readdir(sessionsDir);
    expect(files.filter((f) => f === `${sessionId}.lock`)).toEqual([]);
  });

  it("恢复后历史恰一份：用户/助手/工具各按协议时序投影一次，无审批重放", async () => {
    // 第一幕：创建会话，跑一轮带工具的对话
    const h1 = await startHarness({
      scripts: [
        [
          { type: "text_delta", text: "decision is DELTA-9" },
          { type: "tool_call", toolCallId: "tc-1", name: "read", input: { path: "a.txt" } },
          { type: "finish", reason: "stop" },
        ],
        [{ type: "text_delta", text: "file content noted" }, { type: "finish", reason: "stop" }],
      ],
    });
    const sessionId = await initAndCreate(h1, workspaceA, "remember DELTA-9");
    // 等待工具轮完成（tool_call 触发第二轮模型请求）
    await vi.waitFor(
      () => {
        const done = h1.updates.filter(
          (u) => u.update.sessionUpdate === "tool_call_update" || u.update.sessionUpdate === "tool_call",
        );
        if (done.length === 0) throw new Error("tool updates not yet arrived");
      },
      { timeout: 8000 },
    );

    const liveCount = h1.updates.length;
    expect(liveCount).toBeGreaterThan(0);

    // 关闭第一幕的受管会话（模拟进程结束前的正常收尾）
    await h1.conn.agent.request(methods.agent.session.close, { sessionId });
    const liveUpdatesAfterClose = h1.updates.length;

    // 第二幕：新 server（模拟新进程）加载同一 ID
    const h2 = await startHarness({
      scripts: [textScript("restored ok")],
    });
    await h2.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const loadRes = await h2.conn.agent.request(methods.agent.session.load, {
      sessionId,
      cwd: workspaceA,
      mcpServers: [],
    });
    expect((loadRes as { configOptions?: unknown }).configOptions).toBeDefined();

    // 历史回放：h2.updates 只含回放帧
    const replayed = h2.updates;
    const userChunks = replayed.filter((u) => u.update.sessionUpdate === "user_message_chunk");
    const agentChunks = replayed.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
    const toolCalls = replayed.filter((u) => u.update.sessionUpdate === "tool_call");

    // 用户消息恰一条（"remember DELTA-9"）
    expect(userChunks.length).toBe(1);
    const userText = ((userChunks[0]?.update ?? {}) as { content?: { text: string } }).content?.text ?? "";
    expect(userText).toContain("remember DELTA-9");

    // 助手消息含决定文本
    const agentText = agentChunks
      .map((u) => (u.update as { content: { text: string } }).content.text)
      .join("");
    expect(agentText).toContain("DELTA-9");

    // 工具调用投影为终态 tool_call（completed/failed），无 pending/in_progress 复活
    for (const tc of toolCalls) {
      const status = (tc.update as { status?: string }).status;
      expect(["completed", "failed"]).toContain(status);
    }
    // 无权限请求转发给新宿主（不重放旧审批）
    expect(h2.permissions.length).toBe(0);
    void liveUpdatesAfterClose;
  });

  it("恢复后新轮正常：模型上下文含历史决定（恰一份）", async () => {
    const marker = "ZEBRA-UNIQUE-77";
    const h1 = await startHarness({
      scripts: [
        [{ type: "text_delta", text: `the code is ${marker}` }, { type: "finish", reason: "stop" }],
      ],
    });
    const sessionId = await initAndCreate(h1, workspaceA, `remember the code`);
    await h1.conn.agent.request(methods.agent.session.close, { sessionId });

    // 新进程：handler 捕获发给模型的请求
    const captured: string[] = [];
    const h2 = await startHarness({
      handler: (req) => {
        captured.push(JSON.stringify(req.messages));
        return textScript("next turn done");
      },
    });
    await h2.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    await h2.conn.agent.request(methods.agent.session.load, {
      sessionId,
      cwd: workspaceA,
      mcpServers: [],
    });
    const res = await h2.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "what was the code?" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });

    // 模型请求中标记恰出现一次（历史不重复计入）
    const joined = captured.join("\n");
    const occurrences = joined.split(marker).length - 1;
    expect(occurrences).toBe(1);
  });

  it("加载占用中会话（别的进程持锁）拒绝 session_locked 且不force", async () => {
    const h1 = await startHarness();
    const sessionId = await initAndCreate(h1, workspaceA, "locked base");
    // h1 仍持有锁（会话受管未关）
    const h2 = await startHarness();
    await h2.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    await expect(
      h2.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32600 });
  });

  it("session/new 流程不受 loadSession 影响（旧宿主兼容）", async () => {
    const h = await startHarness({
      handler: async () => textScript("ok"),
    });
    const sessionId = await initAndCreate(h, workspaceA, "compat check");
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "second turn" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
  });
});
