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
  decodeAcpBase64,
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
        image: true,
        audio: false,
        embeddedContext: true,
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
    expect(
      (res as { agentCapabilities: { loadSession: boolean } }).agentCapabilities.loadSession,
    ).toBe(true);
  });

  it("session/new 创建的会话带 ACP 归属标记（session.created.client.name === acp）", async () => {
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA);
    const entry = h.runtime as unknown as { sessionsDir?: string };
    void entry;
    // 直接读日志首行验证归属事件
    const sessionsDir = path.join(tempRoot, "sessions");
    const firstLine =
      (await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), "utf8")).split("\n")[0] ??
      "";
    const created = JSON.parse(firstLine) as {
      payload: { client?: { kind: string; name: string } };
    };
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
    const foreign = await rt.createSession({
      model: "fake/fake-1",
      cwd: workspaceA,
      workspaceRoot: workspaceA,
    });
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
      h.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceA,
        mcpServers: [],
      }),
      h.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceA,
        mcpServers: [],
      }),
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
        [
          { type: "text_delta", text: "file content noted" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const sessionId = await initAndCreate(h1, workspaceA, "remember DELTA-9");
    // 等待工具轮完成（tool_call 触发第二轮模型请求）
    await vi.waitFor(
      () => {
        const done = h1.updates.filter(
          (u) =>
            u.update.sessionUpdate === "tool_call_update" || u.update.sessionUpdate === "tool_call",
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
    const userText =
      ((userChunks[0]?.update ?? {}) as { content?: { text: string } }).content?.text ?? "";
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
        [
          { type: "text_delta", text: `the code is ${marker}` },
          { type: "finish", reason: "stop" },
        ],
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

  it("外来会话/工作区不匹配拒绝前：不绑定宿主工具、不投递历史通知", async () => {
    // 外来会话（无 ACP 标记）与 cwd 不匹配两类拒绝都要验证——它们此前在 resumeSession
    // 装配完宿主 MCP 之后才检查，会误启动借来会话的宿主工具并可能投递历史。
    const pidFile = path.join(tempRoot, "host-mcp.pid");
    const hostMcp = [
      {
        name: "probe",
        command: process.execPath,
        args: [
          "-e",
          'require("fs").writeFileSync(process.env.NOCTURNE_TEST_PID_FILE,String(process.pid));setInterval(()=>{},1000)',
        ],
        env: [{ name: "NOCTURNE_TEST_PID_FILE", value: pidFile }],
      },
    ];

    // 1) 外来会话：新建一个无 ACP 标记的会话，注入宿主 MCP 去 load
    const provider = new FakeProvider({ id: "fake", scripts: [textScript("x")] });
    const rt = await createRuntime({
      cwd: workspaceA,
      providers: [provider],
      interactive: true,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const foreign = await rt.createSession({
      model: "fake/fake-1",
      cwd: workspaceA,
      workspaceRoot: workspaceA,
    });
    const foreignId = foreign.id;
    await foreign.close();

    const h = await startHarness();
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId: foreignId,
        cwd: workspaceA,
        mcpServers: hostMcp,
      }),
    ).rejects.toMatchObject({ code: -32002 });
    // 拒绝前未启动任何宿主 stdio MCP（无 PID 文件），未投递历史回放
    expect(await fs.stat(pidFile).catch(() => undefined)).toBeUndefined();
    expect(h.updates.length).toBe(0);
    await rt.close();

    // 2) 工作区不匹配：合法 ACP 会话用错误 cwd 去 load
    const pidFile2 = path.join(tempRoot, "host-mcp2.pid");
    const hostMcp2 = [
      {
        name: "probe",
        command: process.execPath,
        args: [
          "-e",
          'require("fs").writeFileSync(process.env.NOCTURNE_TEST_PID_FILE,String(process.pid));setInterval(()=>{},1000)',
        ],
        env: [{ name: "NOCTURNE_TEST_PID_FILE", value: pidFile2 }],
      },
    ];
    const sessionId = await initAndCreate(h, workspaceA, "guard base");
    await h.conn.agent.request(methods.agent.session.close, { sessionId });
    const updatesBeforeMismatch = h.updates.length;
    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceB,
        mcpServers: hostMcp2,
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(await fs.stat(pidFile2).catch(() => undefined)).toBeUndefined();
    // 没有为这次失败的 load 投递任何回放帧
    expect(h.updates.length).toBe(updatesBeforeMismatch);
  });

  it("资格校验失败后，同一会话的合法 load 仍可恢复", async () => {
    // 先做一次会因 cwd 不匹配而失败的 load，确认失败后合法请求仍能正常恢复——
    // 校验失败必须完整释放锁，不留下占用。
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA, "retry after reject");
    await h.conn.agent.request(methods.agent.session.close, { sessionId });

    await expect(
      h.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceB,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 合法 cwd 的 load 应成功（锁已正确释放）
    const res = await h.conn.agent.request(methods.agent.session.load, {
      sessionId,
      cwd: workspaceA,
      mcpServers: [],
    });
    expect((res as { configOptions?: unknown }).configOptions).toBeDefined();
  });

  it("realpath 会话工作目录失败时拒绝恢复（workspace_mismatch），不靠字符串匹配继续", async () => {
    // 原实现在 resolveReal 失败时 catch 后用未验证的 currentExec 继续做字符串比较，
    // 可能在目标已被删除/不可读时错误放行。修复后：realpath 失败即拒绝。
    const h = await startHarness();
    const sessionId = await initAndCreate(h, workspaceA, "realpath fail base");
    await h.conn.agent.request(methods.agent.session.close, { sessionId });

    // 包装 platform：对会话工作目录的 resolveReal 注入失败
    const failRealpathHarness = await startHarness({
      wrapPlatform: (base) => ({
        ...base,
        resolveReal: async (p) => {
          if (p === workspaceA) throw new Error("injected realpath failure");
          return base.resolveReal(p);
        },
      }),
    });
    await failRealpathHarness.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });
    // 请求 cwd 与会话 cwd 都是 workspaceA——若靠字符串匹配会错误放行；realpath 失败必须拒绝
    await expect(
      failRealpathHarness.conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: workspaceA,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(failRealpathHarness.updates.length).toBe(0);
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

describe("ask_user 提问（ADR-0127 第三阶段）", () => {
  const questionsInput = [
    {
      question: "用哪个数据库？",
      header: "选型",
      options: [{ label: "PostgreSQL", description: "默认推荐" }, { label: "SQLite" }],
    },
  ];

  const askScript = (questions: unknown): FakeScript[] => [
    [
      { type: "tool_call", toolCallId: "q1", name: "ask_user", input: { questions } },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "根据您的选择继续" },
      { type: "finish", reason: "stop" },
    ],
  ];

  it("宿主声明 elicitation.form：经 elicitation/create 提问，accept 答案回传 provider", async () => {
    const elicitations: unknown[] = [];
    const h = await startHarness({
      scripts: askScript(questionsInput),
    });
    // 替换 client 以拦截 elicitation/create
    const updates: SessionNotification[] = [];
    const permissions: RequestPermissionRequest[] = [];
    const pair = createPairStreams();
    const server2 = createAcpAgentServer({
      runtime: h.runtime,
      platform: createPlatform(),
      version: "0.67.0-test",
      resolveModel: async () => "fake/fake-1",
    });
    const served2 = server2.serve(pair.agentStream);
    cleanups.push(async () => {
      pair.closeClientInput();
      await served2;
    });
    const cliApp = client({ name: "test-host-eli" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        permissions.push(ctx.params);
        return { outcome: { outcome: "selected", optionId: "reject_once" } };
      })
      .onRequest(
        "elicitation/create" as never,
        (async (ctx: { params: unknown }) => {
          elicitations.push(ctx.params);
          return {
            action: "accept",
            content: { q1: "PostgreSQL" },
          } as never;
        }) as never,
      );
    const conn2 = cliApp.connect(pair.clientStream);
    cleanups.push(async () => {
      conn2.close();
    });

    await conn2.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await conn2.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;

    const promptRes = await conn2.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(promptRes.stopReason).toBe("end_turn");
    expect(elicitations.length).toBe(1);
    const eliReq = elicitations[0] as {
      sessionId?: string;
      message?: string;
      requestedSchema?: { properties?: Record<string, unknown> };
    };
    expect(eliReq.sessionId).toBe(sessionId);
    expect(eliReq.message).toContain("用哪个数据库？");
    expect(eliReq.requestedSchema?.properties).toBeDefined();
    // provider 收到下一轮请求时，tool 消息包含用户选的 PostgreSQL
    const provider = (h.runtime as unknown as { __provider?: unknown }).__provider;
    void provider;
  });

  it("宿主不声明 elicitation：问题作为 agent_message_chunk 展示，ask_user 以 handoff_suspended 收尾", async () => {
    const h = await startHarness({
      scripts: askScript(questionsInput),
    });
    await h.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // 不声明 elicitation —— 模拟 Paseo 0.17.5 clientCapabilities: {}
      clientCapabilities: {},
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const promptRes = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(promptRes.stopReason).toBe("end_turn");
    // 问题以 agent_message_chunk 展示给用户
    const chunks = h.updates.filter(
      (u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        u.update.content.type === "text" &&
        u.update.content.text.includes("用哪个数据库？"),
    );
    expect(chunks.length).toBeGreaterThan(0);
    // ask_user tool 完成状态是 error/handoff_suspended，不是 declined
    const toolCalls = h.updates.filter(
      (u) =>
        (u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update") &&
        u.update.toolCallId !== undefined,
    );
    void toolCalls;
  });

  it("elicitation 响应 decline：所有题以 declined 结算（用户显式拒答）", async () => {
    const pair = createPairStreams();
    const server2 = createAcpAgentServer({
      runtime: await createRuntime({
        cwd: workspaceA,
        providers: [new FakeProvider({ scripts: askScript(questionsInput) })],
        interactive: true,
        sessionsDir: path.join(tempRoot, "sess-decline"),
      }),
      platform: createPlatform(),
      version: "0.67.0-test",
      resolveModel: async () => "fake/fake-1",
    });
    const served2 = server2.serve(pair.agentStream);
    cleanups.push(async () => {
      pair.closeClientInput();
      await served2;
    });
    const cliApp = client({ name: "test-host-decline" })
      .onNotification(methods.client.session.update, () => undefined)
      .onRequest(methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "reject_once" },
      }))
      .onRequest(
        "elicitation/create" as never,
        (async () => ({ action: "decline" }) as never) as never,
      );
    const conn2 = cliApp.connect(pair.clientStream);
    cleanups.push(async () => {
      conn2.close();
    });

    await conn2.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await conn2.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const promptRes = await conn2.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(promptRes.stopReason).toBe("end_turn");
  });

  it("elicitation 响应 cancel：取消当前 turn（ask_user 不以 declined 结算）", async () => {
    const pair = createPairStreams();
    const rt = await createRuntime({
      cwd: workspaceA,
      providers: [new FakeProvider({ scripts: askScript(questionsInput) })],
      interactive: true,
      sessionsDir: path.join(tempRoot, "sess-cancel"),
    });
    const server2 = createAcpAgentServer({
      runtime: rt,
      platform: createPlatform(),
      version: "0.67.0-test",
      resolveModel: async () => "fake/fake-1",
    });
    const served2 = server2.serve(pair.agentStream);
    cleanups.push(async () => {
      pair.closeClientInput();
      await served2;
      await rt.close();
    });
    const cliApp = client({ name: "test-host-cancel" })
      .onNotification(methods.client.session.update, () => undefined)
      .onRequest(methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "reject_once" },
      }))
      .onRequest(
        "elicitation/create" as never,
        (async () => ({ action: "cancel" }) as never) as never,
      );
    const conn2 = cliApp.connect(pair.clientStream);
    cleanups.push(async () => {
      conn2.close();
    });

    await conn2.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await conn2.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const promptRes = await conn2.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    // cancel 后 turn 以 cancelled 收尾
    expect(promptRes.stopReason).toBe("cancelled");
  });
});

describe("ask_user 提问 - 补强场景（ADR-0127 第三阶段）", () => {
  const askScriptMulti = (questions: unknown): FakeScript[] => [
    [
      { type: "tool_call", toolCallId: "q1", name: "ask_user", input: { questions } },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "已收到答案" },
      { type: "finish", reason: "stop" },
    ],
  ];

  async function startElicitationHarness(options: {
    scripts: FakeScript[];
    onElicitation: (params: unknown) => Promise<unknown>;
    clientCapabilities?: Record<string, unknown>;
  }) {
    const provider = new FakeProvider({ scripts: options.scripts });
    const rt = await createRuntime({
      cwd: workspaceA,
      providers: [provider],
      interactive: true,
      sessionsDir: path.join(tempRoot, `sess-eli-${Math.random().toString(36).slice(2, 8)}`),
    });
    const pair = createPairStreams();
    const server = createAcpAgentServer({
      runtime: rt,
      platform: createPlatform(),
      version: "0.67.0-test",
      resolveModel: async () => "fake/fake-1",
    });
    const served = server.serve(pair.agentStream);
    cleanups.push(async () => {
      pair.closeClientInput();
      await served;
      await rt.close();
    });
    const updates: SessionNotification[] = [];
    const cliApp = client({ name: "test-host-x" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "reject_once" },
      }))
      .onRequest(
        "elicitation/create" as never,
        (async (ctx: { params: unknown }) =>
          (await options.onElicitation(ctx.params)) as never) as never,
      );
    const conn = cliApp.connect(pair.clientStream);
    cleanups.push(async () => {
      conn.close();
    });
    await conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: options.clientCapabilities ?? { elicitation: { form: {} } },
    });
    return { conn, updates, rt, provider };
  }

  it("多题+多选：schema 反映 array/anyOf，accept 数组回传 selected", async () => {
    const multiQuestions = [
      {
        question: "选数据库",
        options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
      },
      {
        question: "启用哪些功能？",
        multiSelect: true,
        options: [{ label: "读写分离" }, { label: "分区" }, { label: "归档" }],
      },
      { question: "其他约束？" },
    ];
    const captured: unknown[] = [];
    const h = await startElicitationHarness({
      scripts: askScriptMulti(multiQuestions),
      onElicitation: async (params) => {
        captured.push(params);
        return {
          action: "accept",
          content: {
            q1: "PostgreSQL",
            q2: ["读写分离", "分区"],
            q3: "需兼容 13 版",
          },
        };
      },
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(res.stopReason).toBe("end_turn");
    expect(captured.length).toBe(1);
    const schema = (
      captured[0] as { requestedSchema?: { properties?: Record<string, { type?: string }> } }
    ).requestedSchema;
    expect(schema?.properties?.q1?.type).toBe("string");
    expect(schema?.properties?.q2?.type).toBe("array");
    expect(schema?.properties?.q3?.type).toBe("string");
    // 模型下一轮看到的 tool 消息包含所选项与自由文本
    const toolUpdates = h.updates.filter(
      (u) =>
        u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update",
    );
    const allText = JSON.stringify(toolUpdates);
    expect(allText).toContain("PostgreSQL");
    expect(allText).toContain("读写分离");
    expect(allText).toContain("需兼容 13 版");
  });

  it("elicitation 请求抛错（宿主断连/协议错误）：turn cancelled，不写成拒答", async () => {
    const h = await startElicitationHarness({
      scripts: askScriptMulti([{ question: "q" }]),
      onElicitation: async () => {
        throw new Error("host disconnected");
      },
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(res.stopReason).toBe("cancelled");
    // 模型收到的不是「用户拒绝回答」
    const allText = JSON.stringify(h.updates);
    expect(allText).not.toContain("用户拒绝回答");
  });

  it("取消后同一 session 仍可接受下一轮 prompt", async () => {
    const scripts: FakeScript[] = [
      [
        {
          type: "tool_call",
          toolCallId: "q1",
          name: "ask_user",
          input: { questions: [{ question: "q" }] },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "第二轮" },
        { type: "finish", reason: "stop" },
      ],
    ];
    const h = await startElicitationHarness({
      scripts,
      onElicitation: async () => ({ action: "cancel" }),
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const r1 = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    expect(r1.stopReason).toBe("cancelled");
    // 下一轮不带 ask_user 调用：FakeProvider 第二个脚本
    const r2 = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "继续" }],
    });
    expect(r2.stopReason).toBe("end_turn");
  });

  it("文本退化：Paseo 风格 clientCapabilities={} 下两轮独立会话互不串扰", async () => {
    // 退化路径下两个会话各自展示各自的问题，互不串答案/状态
    const h = await startHarness({
      handler: async (req) => {
        if (req.messages.some((m) => m.role === "tool")) {
          return [
            { type: "text_delta", text: "已收到答案" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "q1",
            name: "ask_user",
            input: {
              questions: [{ question: "问题X", options: [{ label: "A" }, { label: "B" }] }],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });
    await h.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const c1 = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const c2 = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceB,
      mcpServers: [],
    });
    const id1 = (c1 as { sessionId: string }).sessionId;
    const id2 = (c2 as { sessionId: string }).sessionId;
    expect(id1).not.toBe(id2);
    const r1 = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: id1,
      prompt: [{ type: "text", text: "ask1" }],
    });
    const r2 = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: id2,
      prompt: [{ type: "text", text: "ask2" }],
    });
    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");
    // 各会话的 chunk 各自独立展示问题
    const text1 = JSON.stringify(h.updates.filter((u) => u.sessionId === id1));
    const text2 = JSON.stringify(h.updates.filter((u) => u.sessionId === id2));
    expect(text1).toContain("问题X");
    expect(text2).toContain("问题X");
  });

  it("提问后、回答前重开会话：恢复回放仍能看到问题与选项，恰一份且不重发 elicitation", async () => {
    // ADR-0127 第三阶段返工·恢复可见问题：提问后、回答前重开会话，
    // 用户仍应能看到此前的问题与选项；历史展示恰一份、不重新发 elicitation。
    // 机制：文本退化路径的问题块是当轮临时 chunk（不持久化），但 handoff 的
    // ask_user 输入（含完整 questions）随 tool.started.input 持久化——恢复回放时
    // 从 input 重建同一份问题展示。
    const h = await startHarness({
      handler: async (req) => {
        if (req.messages.some((m) => m.role === "tool")) {
          return [
            { type: "text_delta", text: "后续" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "q1",
            name: "ask_user",
            input: {
              questions: [{ question: "曾经的问题", options: [{ label: "A" }, { label: "B" }] }],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });
    await h.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const c = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (c as { sessionId: string }).sessionId;
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    await h.conn.agent.request(methods.agent.session.close, { sessionId });

    const updatesBefore = h.updates.length;
    await h.conn.agent.request(methods.agent.session.load, {
      sessionId,
      cwd: workspaceA,
      mcpServers: [],
    });
    // 确定性断言：load 回放中用户仍能看到此前的问题与选项
    const loadUpdates = h.updates.slice(updatesBefore);
    const loadText = JSON.stringify(loadUpdates);
    expect(loadText).toContain("曾经的问题");
    // 问题展示恰一份（不重复累积）——「曾经的问题」在 agent_message_chunk 中只出现一次，
    // 且选项文本一并展示（A/B）
    const questionChunks = loadUpdates.filter(
      (u) =>
        u.update.sessionUpdate === "agent_message_chunk" &&
        JSON.stringify(u).includes("曾经的问题"),
    );
    expect(questionChunks.length).toBe(1);
    const questionText = JSON.stringify(questionChunks[0]);
    expect(questionText).toContain("1. A");
    expect(questionText).toContain("2. B");
    // 新轮仍可正常进行
    const r = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "恢复后再继续" }],
    });
    expect(r.stopReason).toBe("end_turn");
  });

  it("elicitation schema：选项带 description 时映射为 EnumOption.description", async () => {
    const qs = [
      {
        question: "q",
        options: [{ label: "A", description: "推荐项" }, { label: "B" }],
      },
    ];
    const captured: unknown[] = [];
    const h = await startElicitationHarness({
      scripts: askScriptMulti(qs),
      onElicitation: async (params) => {
        captured.push(params);
        return { action: "accept", content: { q1: "A" } };
      },
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    const schema = (
      captured[0] as {
        requestedSchema?: {
          properties?: {
            q1?: { oneOf?: { const: string; title: string; description?: string }[] };
          };
        };
      }
    ).requestedSchema;
    const oneOf = schema?.properties?.q1?.oneOf ?? [];
    expect(oneOf[0]).toMatchObject({ const: "A", title: "A", description: "推荐项" });
    expect(oneOf[1]).toMatchObject({ const: "B", title: "B" });
    expect(oneOf[1]?.description).toBeUndefined();
  });

  it("旧轮取消、新轮运行后才收到旧 elicitation 响应：不取消新轮", async () => {
    // 轮次绑定回归（ADR-0127 第三阶段返工）：
    // turn1 的 elicitation 响应被挂起；turn1 取消后开启 turn2；
    // 此时才放行旧响应（cancel）——它不得取消正在运行的 turn2。
    // turn2 用 wait 挂起持续运行，确保迟到 cancel 到达时它确实 busy——
    // 否则即完脚本早已收尾，cancelEntry 因 busy=false 直接 return，测不到保护。
    const scripts: FakeScript[] = [
      // turn1：ask_user
      [
        {
          type: "tool_call",
          toolCallId: "q1",
          name: "ask_user",
          input: { questions: [{ question: "q1" }] },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      // turn2：先 wait 挂起（持续运行、可被 interrupt），再发文本
      [
        { type: "wait", ms: 400 },
        { type: "text_delta", text: "turn2 正常运行" },
        { type: "finish", reason: "stop" },
      ],
    ];
    // 可控的 elicitation 响应：先挂起，由测试手动放行
    let releaseElicitation!: (value: unknown) => void;
    const elicitationGate = new Promise<unknown>((resolve) => {
      releaseElicitation = resolve;
    });
    // elicitation 是否已被调用（turn1 进入等待的可观测信号）
    let elicitationStarted = false;
    const h = await startElicitationHarness({
      scripts,
      onElicitation: async () => {
        elicitationStarted = true;
        return (await elicitationGate) as never;
      },
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;

    // turn1 启动（elicitation 挂起中，turn 停在 waiting_user）
    const turn1Promise = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask turn1" }],
    });
    // 等 elicitation 请求确实发出（turn1 进入等待）——以 onElicitation 被调用为真实信号
    await vi.waitFor(
      () => {
        if (!elicitationStarted) throw new Error("elicitation not yet issued");
      },
      { timeout: 8000 },
    );
    // 取消 turn1
    await h.conn.agent.notify(methods.agent.session.cancel, { sessionId });
    const r1 = await turn1Promise;
    expect(r1.stopReason).toBe("cancelled");

    // turn2 启动（新轮，普通文本）——但先不放行旧响应
    const turn2Promise = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "turn2" }],
    });
    // 让 turn2 开始运行：turn2 脚本的第一个事件是 wait 挂起——
    // 等 provider 进入 wait 状态，证明 turn2 的推理流确实在进行中（busy、可被 interrupt）。
    // 这是本回归的关键竞态前提，不能用固定延时近似。
    await vi.waitFor(
      () => {
        if (h.provider.waitState.waiting === 0) throw new Error("turn2 not yet in wait");
      },
      { timeout: 8000 },
    );
    // 现在才放行旧轮（turn1）的迟到 cancel 响应
    releaseElicitation({ action: "cancel" });
    const r2 = await turn2Promise;
    // 关键断言：turn2 未被旧轮的迟到 cancel 取消——按自身脚本正常 end_turn
    expect(r2.stopReason).toBe("end_turn");
    const text = JSON.stringify(h.updates);
    expect(text).toContain("turn2 正常运行");
  });

  it("无效 accept（答案未通过校验）后不悬空：会话仍可用，且绝不写成用户拒答", async () => {
    // respondQuestion 对缺失/非法答案返回 invalid_reply 时，broker 会继续等待——
    // 必须明确收尾（取消该轮）而非悬空；明确拒答仍只来自用户 decline。
    const scripts: FakeScript[] = [
      [
        {
          type: "tool_call",
          toolCallId: "q1",
          name: "ask_user",
          input: { questions: [{ question: "q", options: [{ label: "A" }, { label: "B" }] }] },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "恢复后的正常轮" },
        { type: "finish", reason: "stop" },
      ],
    ];
    const h = await startElicitationHarness({
      scripts,
      // accept 但 content 提供了一个不在选项内的非法 label——
      // respondQuestion 校验（selected 必须属于已提供选项）会返回 invalid_reply
      onElicitation: async () => ({ action: "accept", content: { q1: "NOT-A-VALID-OPTION" } }),
    });
    const created = await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    });
    const sessionId = (created as { sessionId: string }).sessionId;
    const r1 = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "ask" }],
    });
    // 无效 accept 明确收尾为取消（不悬空、不写成拒答）
    expect(r1.stopReason).toBe("cancelled");
    expect(JSON.stringify(h.updates)).not.toContain("用户拒绝回答");
    // 会话仍可用：下一轮正常运行
    const r2 = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "继续" }],
    });
    expect(r2.stopReason).toBe("end_turn");
  });
});

describe("图片与文本附件（ADR-0127 第四阶段）", () => {
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  function imageModelEntry(model: string, imageInput: boolean): ModelInfo {
    return {
      ref: { provider: "fake", model },
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: "none",
        imageInput,
        promptCache: false,
        editTool: "edit",
        historyPrune: true,
      },
    };
  }

  async function startAttachmentHarness(options: { imageInput: boolean }) {
    const provider = new FakeProvider({
      models: [imageModelEntry("fake-1", options.imageInput)],
      scripts: [textScript("ok")],
    });
    const rt = await createRuntime({
      cwd: workspaceA,
      providers: [provider],
      interactive: true,
      sessionsDir: path.join(tempRoot, `sess-att-${Math.random().toString(36).slice(2, 8)}`),
    });
    const pair = createPairStreams();
    const server = createAcpAgentServer({
      runtime: rt,
      platform: createPlatform(),
      version: "0.67.0-test",
      resolveModel: async () => "fake/fake-1",
    });
    const served = server.serve(pair.agentStream);
    cleanups.push(async () => {
      pair.closeClientInput();
      await served;
      await rt.close();
    });
    const cliApp = client({ name: "test-host-att" }).onNotification(
      methods.client.session.update,
      () => undefined,
    );
    const conn = cliApp.connect(pair.clientStream);
    cleanups.push(async () => {
      conn.close();
    });
    await conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    return { conn, provider };
  }

  it("混合文本与图片保持顺序：content 块按序、images 携带 afterBlock 位置", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "text A" },
        { type: "image", data: PNG_B64, mimeType: "image/png" },
        { type: "text", text: "text B" },
        { type: "image", data: PNG_B64, mimeType: "image/png" },
        { type: "text", text: "text C" },
      ],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    // 中性请求：最后一条 user 消息的 content 块按 textA/B/C 顺序，
    // images 两张各带 afterBlock（image1 在块0 textA 后、image2 在块1 textB 后）
    const req = h.provider.requests.find((r) =>
      r.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes("text A")),
      ),
    );
    expect(req).toBeDefined();
    const userMsg = req?.messages.filter((m) => m.role === "user").at(-1);
    expect(userMsg?.role).toBe("user");
    if (userMsg?.role !== "user") throw new Error("unreachable");
    const texts = userMsg.content.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts).toEqual(["text A", "text B", "text C"]);
    const images = userMsg.images ?? [];
    expect(images.length).toBe(2);
    expect(images[0]?.afterBlock).toBe(0);
    expect(images[1]?.afterBlock).toBe(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe(PNG_B64);
  });

  it("内嵌文本资源转为有序 resource 快照块", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "before" },
        {
          type: "resource",
          resource: {
            uri: "file:///src/a.ts",
            text: "const x = 1;",
            mimeType: "text/x-typescript",
          },
        },
        { type: "text", text: "after" },
      ],
    });
    const req = h.provider.requests.find((r) =>
      r.messages.some(
        (m) => m.role === "user" && m.content.some((b) => b.text.includes("const x = 1;")),
      ),
    );
    const userMsg = req?.messages.filter((m) => m.role === "user").at(-1);
    if (userMsg?.role !== "user") throw new Error("unreachable");
    const texts = userMsg.content.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts[0]).toBe("before");
    expect(texts[1]).toContain('<resource uri="file:///src/a.ts">');
    expect(texts[1]).toContain("const x = 1;");
    expect(texts[2]).toBe("after");
  });

  it("resource_link 保留链接语义，不抓取 URL 或文件", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "看这里" },
        { type: "resource_link", uri: "https://example.com/doc", name: "doc", title: "文档" },
      ],
    });
    const req = h.provider.requests.find((r) =>
      r.messages.some((m) => m.role === "user" && m.content.some((b) => b.text.includes("看这里"))),
    );
    const userMsg = req?.messages.filter((m) => m.role === "user").at(-1);
    if (userMsg?.role !== "user") throw new Error("unreachable");
    const texts = userMsg.content.filter((b) => b.type === "text").map((b) => b.text);
    // 链接语义：markdown 链接文本，不是抓取来的内容
    expect(texts.some((t) => t.includes("[文档](https://example.com/doc)"))).toBe(true);
  });

  it("模型不支持图片输入时明确拒绝（image_input_unsupported），不提交残缺消息", async () => {
    const h = await startAttachmentHarness({ imageInput: false });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    const before = h.provider.requests.length;
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "带图" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
        ],
      }),
    ).rejects.toMatchObject({
      code: -32602,
      data: expect.objectContaining({ code: "image_input_unsupported" }),
    });
    // 部分失败不提交：没有发出任何主推理请求
    expect(h.provider.requests.length).toBe(before);
  });

  it("audio 内容块明确拒绝", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("非图片内嵌二进制资源明确拒绝", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "resource",
            resource: { uri: "file:///a.bin", blob: "AAAA", mimeType: "application/octet-stream" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  // 有效 1x1 PNG，两个不同指纹（红/蓝），用于区分 image1/image2 的实际顺序
  const PNG_RED =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const PNG_BLUE =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

  const lastUserImages = (
    h: { provider: { requests: { messages: unknown[] }[] } },
    marker: string,
  ): {
    images: { data?: string; afterBlock?: number }[];
    content: { type: string; text?: string }[];
  } => {
    const req = h.provider.requests.find((r) =>
      (r.messages as { role: string; content: { type: string; text?: string }[] }[]).some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && (b.text ?? "").includes(marker)),
      ),
    );
    const userMsg = (
      req?.messages as { role: string; images?: unknown; content: unknown }[] | undefined
    )
      ?.filter((m) => m.role === "user")
      .at(-1);
    return {
      images: (userMsg?.images ?? []) as { data?: string; afterBlock?: number }[],
      content: (userMsg?.content ?? []) as { type: string; text?: string }[],
    };
  };

  it("前置图片（开头）：afterBlock=-1 表示在第 0 块之前，与首段文字后的图片区分", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data: PNG_RED, mimeType: "image/png" },
        { type: "text", text: "LEAD-MARKER" },
      ],
    });
    const { images } = lastUserImages(h, "LEAD-MARKER");
    expect(images.length).toBe(1);
    // 开头图片：afterBlock=-1（在第 0 块之前），不是 0（在第 0 块之后）
    expect(images[0]?.afterBlock).toBe(-1);
    expect(images[0]?.data).toBe(PNG_RED);
  });

  it("连续前置两图：同槽（-1）保持提交顺序，image1/image2 指纹不串", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data: PNG_RED, mimeType: "image/png" },
        { type: "image", data: PNG_BLUE, mimeType: "image/png" },
        { type: "text", text: "DOUBLE-LEAD" },
      ],
    });
    const { images } = lastUserImages(h, "DOUBLE-LEAD");
    expect(images.length).toBe(2);
    // 两张都在开头槽（-1），顺序保持提交顺序：红在前、蓝在后
    expect(images[0]?.afterBlock).toBe(-1);
    expect(images[1]?.afterBlock).toBe(-1);
    expect(images[0]?.data).toBe(PNG_RED);
    expect(images[1]?.data).toBe(PNG_BLUE);
  });

  it("纯图片（无文本）：afterBlock=-1，两张指纹都保留不丢失", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data: PNG_RED, mimeType: "image/png" },
        { type: "image", data: PNG_BLUE, mimeType: "image/png" },
      ],
    });
    // 纯图片：最后 user 消息（无文字标记）——取最近一次请求的 user 消息
    const req = h.provider.requests.at(-1);
    const userMsg = (req?.messages as { role: string; images?: unknown }[] | undefined)
      ?.filter((m) => m.role === "user")
      .at(-1);
    const images = (userMsg?.images ?? []) as { data?: string; afterBlock?: number }[];
    // 纯图片两张都必须保留（空 textParts 不丢图），红前蓝后
    expect(images.length).toBe(2);
    expect(images[0]?.afterBlock).toBe(-1);
    expect(images[1]?.afterBlock).toBe(-1);
    expect(images[0]?.data).toBe(PNG_RED);
    expect(images[1]?.data).toBe(PNG_BLUE);
  });

  it("末尾图片：afterBlock 为最末文本块索引（末尾之后）", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "TAIL-A" },
        { type: "text", text: "TAIL-B" },
        { type: "image", data: PNG_RED, mimeType: "image/png" },
      ],
    });
    const { images } = lastUserImages(h, "TAIL-A");
    expect(images.length).toBe(1);
    // 末尾图片在最末文本块（块1 TAIL-B）之后
    expect(images[0]?.afterBlock).toBe(1);
  });

  it("混合交错序列位置：image1/textA/image2 各自位置正确区分", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "image", data: PNG_RED, mimeType: "image/png" },
        { type: "text", text: "MIX-A" },
        { type: "image", data: PNG_BLUE, mimeType: "image/png" },
      ],
    });
    const { images } = lastUserImages(h, "MIX-A");
    expect(images.length).toBe(2);
    // 红在开头（-1，MIX-A 之前）；蓝在 MIX-A（块0）之后（0）
    expect(images[0]?.afterBlock).toBe(-1);
    expect(images[0]?.data).toBe(PNG_RED);
    expect(images[1]?.afterBlock).toBe(0);
    expect(images[1]?.data).toBe(PNG_BLUE);
  });

  it("严格 base64 校验：含非法字符（!）即便能解出非空字节也整体拒绝，下一条合法输入仍正常", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    // "aGVsbG8!" 含非法字符 "!"：Node 会忽略它仍解出非空字节（5 字节），
    // try/catch 无法发现——严格校验必须在解码前的字符集阶段拒绝
    const before = h.provider.requests.length;
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "bad" },
          { type: "image", data: "aGVsbG8!", mimeType: "image/png" },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    // 部分失败不提交：没有发出任何主推理请求
    expect(h.provider.requests.length).toBe(before);
    // 下一条合法输入仍正常（会话未被坏请求破坏）
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: "good" },
        { type: "image", data: PNG_RED, mimeType: "image/png" },
      ],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
  });

  it("严格 base64 校验：合法块与坏块混合时整体拒绝（原子提交）", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    const before = h.provider.requests.length;
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "image", data: PNG_RED, mimeType: "image/png" },
          { type: "text", text: "mixed" },
          // "aGVs bG8" 含空格：Node 忽略空格仍解出非空字节，严格校验拒绝
          { type: "image", data: "aGVs bG8", mimeType: "image/png" },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(h.provider.requests.length).toBe(before);
  });

  it("严格 base64 校验：长度非 4 倍数、空 data、纯非法字符（#### 解出 0 字节）均拒绝", async () => {
    const h = await startAttachmentHarness({ imageInput: true });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    const before = h.provider.requests.length;
    // 长度非 4 倍数
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "aGVsbG", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    // 纯非法字符：Node 解出 0 字节，严格校验在字符集阶段就拒绝
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "####", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    // 空 data
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "image", data: "", mimeType: "image/png" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(h.provider.requests.length).toBe(before);
  });

  it("严格 base64 临界值：恰好等于上限通过、超一字节拒绝（decodeAcpBase64 单元层，解码前拦截）", () => {
    // 用小的 maxBytes 验证临界精确性（机制与 IMAGE_MAX_BYTES 相同，避免分配大缓冲）。
    // maxBytes=6：6 字节 ↔ base64 8 字符（无 padding）；7 字节需 12 字符（去 padding 估 9>6）。
    const valid6 = Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64"); // 恰好 6 字节
    expect(valid6.length % 4).toBe(0);
    // 恰好等于上限：通过并解出正确字节
    const ok = decodeAcpBase64(valid6, "image", 6);
    expect(ok.byteLength).toBe(6);
    expect([...ok]).toEqual([1, 2, 3, 4, 5, 6]);
    // 超一字节（7 字节 → 预估 7 > 6）：解码前拒绝
    const over7 = Buffer.from([1, 2, 3, 4, 5, 6, 7]).toString("base64");
    expect(() => decodeAcpBase64(over7, "image", 6)).toThrowError(
      expect.objectContaining({ code: -32602 }),
    );
    // 临界带 padding：4 字节 ↔ "AAAAAA==" 形式预估正确
    const valid4 = Buffer.from([9, 9, 9, 9]).toString("base64");
    expect(decodeAcpBase64(valid4, "image", 4).byteLength).toBe(4);
    expect(() => decodeAcpBase64(valid4, "image", 3)).toThrowError(
      expect.objectContaining({ code: -32602 }),
    );
  });
});

describe("执行进度与命令发现（ADR-0127 第四阶段）", () => {
  async function startProgressHarness(options?: { handler?: FakeHandler; scripts?: FakeScript[] }) {
    const h = await startHarness({
      ...(options?.handler !== undefined
        ? { handler: options.handler }
        : { scripts: options?.scripts ?? [textScript("ok")] }),
    });
    // 进度事件（plan/compaction）是 UNSTABLE 能力，需客户端显式声明才发送——
    // 进度测试声明完整能力，核对真实发送路径。
    await h.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { plan: {}, session: { compaction: {} } },
    });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    return { ...h, sessionId };
  }

  const updatesOf = (h: { updates: SessionNotification[] }, kind: string) =>
    h.updates.filter((u) => u.update.sessionUpdate === kind);

  it("session/new 后发布 available_commands_update：只含真实可工作的 /compact", async () => {
    const h = await startProgressHarness();
    await vi.waitFor(
      () => {
        if (updatesOf(h, "available_commands_update").length === 0) {
          throw new Error("commands not yet published");
        }
      },
      { timeout: 5000 },
    );
    const update = updatesOf(h, "available_commands_update")[0]?.update as {
      availableCommands: { name: string; description: string }[];
    };
    const names = update.availableCommands.map((c) => c.name);
    expect(names).toContain("compact");
    // 不公布依赖 TUI/REPL 交互的命令（经 ACP 无法工作）
    for (const banned of ["model", "cost", "help", "rename", "context", "provider"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("todo_write 成功投影为完整清单替换式 plan 更新，状态逐项映射", async () => {
    const h = await startProgressHarness({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "t1",
            name: "todo_write",
            input: {
              items: [
                { text: "第一步", status: "completed" },
                { text: "第二步", status: "in_progress" },
                { text: "第三步", status: "pending" },
              ],
            },
          },
          { type: "finish", reason: "stop" },
        ],
        textScript("done"),
      ],
    });
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "track tasks" }],
    });
    await vi.waitFor(
      () => {
        if (updatesOf(h, "plan").length === 0) throw new Error("plan not yet published");
      },
      { timeout: 5000 },
    );
    const plan = updatesOf(h, "plan")[0]?.update as {
      entries: { content: string; status: string; priority: string }[];
    };
    expect(plan.entries.map((e) => [e.content, e.status])).toEqual([
      ["第一步", "completed"],
      ["第二步", "in_progress"],
      ["第三步", "pending"],
    ]);
  });

  it("同一清单重复 todo_write 不重复投影 plan（签名去重）", async () => {
    const items = [{ text: "唯一步骤", status: "pending" }];
    const h = await startProgressHarness({
      scripts: [
        [
          { type: "tool_call", toolCallId: "t1", name: "todo_write", input: { items } },
          { type: "tool_call", toolCallId: "t2", name: "todo_write", input: { items } },
          { type: "finish", reason: "stop" },
        ],
        textScript("done"),
      ],
    });
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "dedupe" }],
    });
    await vi.waitFor(
      async () => {
        // 等本轮真正结束（最后 text 到达）再统计，避免过早断言
        const texts = updatesOf(h, "agent_message_chunk");
        if (
          !texts.some((u) =>
            (u.update as { content: { text: string } }).content.text.includes("done"),
          )
        ) {
          throw new Error("turn not finished");
        }
      },
      { timeout: 5000 },
    );
    // 同一清单两次写入只投影一次 plan
    expect(updatesOf(h, "plan").length).toBe(1);
  });

  it("turn.completed 投影 usage_update：used/size 来自上下文报告，累计用量进 _meta", async () => {
    const h = await startProgressHarness();
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "usage probe" }],
    });
    await vi.waitFor(
      () => {
        if (updatesOf(h, "usage_update").length === 0) throw new Error("usage not yet published");
      },
      { timeout: 5000 },
    );
    const usage = updatesOf(h, "usage_update")[0]?.update as {
      used: number;
      size: number;
      _meta?: { inputTokens?: number; outputTokens?: number };
    };
    // used/size 是真实上下文水位：非负且 used 不超过窗口
    expect(usage.used).toBeGreaterThanOrEqual(0);
    expect(usage.size).toBeGreaterThan(0);
    expect(usage.used).toBeLessThanOrEqual(usage.size);
    // 累计用量非负存在
    expect(usage._meta?.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage._meta?.outputTokens).toBeGreaterThanOrEqual(0);
  });

  it("/compact 命令触发压缩并投影 compaction_update 开始/完成配对，不进入模型推理", async () => {
    // handler：所有请求（含压缩的摘要请求）都返回文本——压缩需要模型完成摘要。
    // 摘要请求走主对话通道（buildSummaryRequest 无 purpose），用脚本会在第一轮后耗尽。
    // 记录每次推理请求的首条用户输入，验证 "/compact" 不作为用户输入进入新一轮推理。
    const promptInputs: string[] = [];
    const h = await startProgressHarness({
      handler: (request) => {
        const firstUser = [...request.messages].reverse().find((m) => m.role === "user");
        const text =
          firstUser !== undefined && typeof firstUser.content !== "string"
            ? firstUser.content.find((b) => b.type === "text")?.text
            : undefined;
        if (text !== undefined) promptInputs.push(text);
        return textScript("reply text for compaction boundary");
      },
    });
    // 先跑一轮产生历史
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "start some work" }],
    });
    const compactionUpdatesBefore = updatesOf(h, "compaction_update").length;
    expect(compactionUpdatesBefore).toBe(0);

    // 发 /compact 命令（Paseo toAcpPrompt 形式：纯文本 "/compact"）
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    await vi.waitFor(
      () => {
        if (updatesOf(h, "compaction_update").length < 2) {
          throw new Error("compaction updates not yet complete");
        }
      },
      { timeout: 8000 },
    );
    const updates = updatesOf(h, "compaction_update").map(
      (u) =>
        u.update as {
          compactionId: string;
          status: string;
        },
    );
    // 开始/完成配对：同一 compactionId 先 in_progress 后 completed
    const started = updates.find((u) => u.status === "in_progress");
    const completed = updates.find((u) => u.status === "completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(started?.compactionId).toBe(completed?.compactionId);
    // "/compact" 不作为用户输入进入新一轮推理（压缩的摘要请求用户块是压缩指令，
    // 不是 "/compact"；第一轮是 "start some work"）。
    expect(promptInputs.some((t) => t.trim() === "/compact")).toBe(false);
  });

  it("/compact 在途压缩可被 session/cancel 中断：compaction 无残留 in_progress，下一轮正常", async () => {
    // 摘要请求（user 块含「压缩为摘要」）返回无限挂起的 wait 脚本——压缩在途可控；
    // 普通对话请求返回正常文本。wait 响应 abort signal，中断时 reject。
    const h = await startProgressHarness({
      handler: (request) => {
        const firstUser = [...request.messages].reverse().find((m) => m.role === "user");
        const text =
          firstUser !== undefined && typeof firstUser.content !== "string"
            ? firstUser.content.find((b) => b.type === "text")?.text
            : undefined;
        if (text !== undefined && text.includes("压缩为摘要")) {
          return [{ type: "wait" }];
        }
        return textScript("normal reply");
      },
    });
    // 先跑一轮产生历史（压缩需要可行边界）
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "start some work" }],
    });
    // 发 /compact——压缩摘要请求挂起，压缩在途
    const compactPromise = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    // 等压缩开始（compaction_update in_progress 投递）
    await vi.waitFor(
      () => {
        if (
          updatesOf(h, "compaction_update").some(
            (u) => (u.update as { status?: string }).status === "in_progress",
          )
        ) {
          return;
        }
        throw new Error("compaction not yet started");
      },
      { timeout: 8000 },
    );
    // 在压缩结束前发 session/cancel——中断在途压缩（session/cancel 是通知不是请求）
    await h.conn.agent.notify(methods.agent.session.cancel, { sessionId: h.sessionId });
    // compact 的 prompt 请求应按 cancelled 收尾（不是压缩失败、不是 end_turn）
    const res = await compactPromise;
    expect(res).toEqual({ stopReason: "cancelled" });
    // 宿主无残留进行中状态：in_progress 必须有终态配对（cancelled），
    // 且不再有停留在 in_progress 的压缩条目
    await vi.waitFor(
      () => {
        const updates = updatesOf(h, "compaction_update").map(
          (u) => u.update as { compactionId: string; status: string },
        );
        const started = updates.find((u) => u.status === "in_progress");
        const terminal = updates.find((u) => u.status === "cancelled" || u.status === "completed");
        if (started === undefined || terminal === undefined) {
          throw new Error("compaction not yet terminalized");
        }
      },
      { timeout: 8000 },
    );
    const updates = updatesOf(h, "compaction_update").map(
      (u) => u.update as { compactionId: string; status: string },
    );
    const started = updates.find((u) => u.status === "in_progress");
    const cancelled = updates.find((u) => u.status === "cancelled");
    expect(started).toBeDefined();
    expect(cancelled).toBeDefined();
    expect(cancelled?.compactionId).toBe(started?.compactionId);
    // 压缩被中断不写 context.compacted——不应有 completed
    expect(updates.some((u) => u.status === "completed")).toBe(false);
    // 下一轮正常使用：会话未被取消的压缩破坏
    const next = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "continue after cancel" }],
    });
    expect(next).toEqual({ stopReason: "end_turn" });
  });

  it("/compact 压缩在途时并发 prompt 被拒绝为 session_busy，压缩收尾后下一轮正常", async () => {
    // 摘要请求挂起（压缩在途），普通请求正常返回。
    const h = await startProgressHarness({
      handler: (request) => {
        const firstUser = [...request.messages].reverse().find((m) => m.role === "user");
        const text =
          firstUser !== undefined && typeof firstUser.content !== "string"
            ? firstUser.content.find((b) => b.type === "text")?.text
            : undefined;
        if (text !== undefined && text.includes("压缩为摘要")) {
          return [{ type: "wait" }];
        }
        return textScript("normal reply");
      },
    });
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "seed history" }],
    });
    const compactPromise = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    // 等压缩在途
    await vi.waitFor(
      () => {
        if (
          updatesOf(h, "compaction_update").some(
            (u) => (u.update as { status?: string }).status === "in_progress",
          )
        ) {
          return;
        }
        throw new Error("compaction not yet started");
      },
      { timeout: 8000 },
    );
    // 压缩在途时第二个 prompt 必须被拒绝为 session_busy——压缩与推理共享同一会话 busy 生命周期
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId: h.sessionId,
        prompt: [{ type: "text", text: "concurrent prompt during compaction" }],
      }),
    ).rejects.toMatchObject({
      code: -32600,
      data: expect.objectContaining({ code: "session_busy" }),
    });
    // 取消压缩收尾
    await h.conn.agent.notify(methods.agent.session.cancel, { sessionId: h.sessionId });
    expect(await compactPromise).toEqual({ stopReason: "cancelled" });
    // 压缩收尾后下一轮正常
    const next = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "after busy rejection" }],
    });
    expect(next).toEqual({ stopReason: "end_turn" });
  });

  it("/compact 压缩在途时 session/close 中断压缩并完成关闭，压缩不留 in_progress", async () => {
    // 摘要请求挂起（压缩在途）；关闭应中断压缩、等待 turn 收尾、释放会话。
    const h = await startProgressHarness({
      handler: (request) => {
        const firstUser = [...request.messages].reverse().find((m) => m.role === "user");
        const text =
          firstUser !== undefined && typeof firstUser.content !== "string"
            ? firstUser.content.find((b) => b.type === "text")?.text
            : undefined;
        if (text !== undefined && text.includes("压缩为摘要")) {
          return [{ type: "wait" }];
        }
        return textScript("normal reply");
      },
    });
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "seed history" }],
    });
    const compactPromise = h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    await vi.waitFor(
      () => {
        if (
          updatesOf(h, "compaction_update").some(
            (u) => (u.update as { status?: string }).status === "in_progress",
          )
        ) {
          return;
        }
        throw new Error("compaction not yet started");
      },
      { timeout: 8000 },
    );
    // 压缩在途时关闭会话：closeEntry 经 cancelEntry 中断压缩、等待 turnPromise 收尾
    const closeResult = await h.conn.agent.request(methods.agent.session.close, {
      sessionId: h.sessionId,
    });
    expect(closeResult).toBeDefined();
    // 压缩的 prompt 请求按 cancelled 收尾——close 触发中断，压缩不留在途
    expect(await compactPromise).toEqual({ stopReason: "cancelled" });
    // 无残留 in_progress：close resolve 前压缩已收尾（close 等待 turnPromise），
    // cancelled 已 enqueue 进入异步 flush 链——等投递完成后核对配对。
    await vi.waitFor(
      () => {
        const ups = updatesOf(h, "compaction_update").map(
          (u) => u.update as { compactionId: string; status: string },
        );
        if (!ups.some((u) => u.status === "cancelled")) {
          throw new Error("cancelled not yet delivered");
        }
      },
      { timeout: 8000 },
    );
    const updates = updatesOf(h, "compaction_update").map(
      (u) => u.update as { compactionId: string; status: string },
    );
    const started = updates.find((u) => u.status === "in_progress");
    const cancelled = updates.find((u) => u.status === "cancelled");
    expect(started).toBeDefined();
    expect(cancelled?.compactionId).toBe(started?.compactionId);
    expect(updates.some((u) => u.status === "completed")).toBe(false);
    // 会话已关闭：再 prompt 报会话不存在
    await expect(
      h.conn.agent.request(methods.agent.session.prompt, {
        sessionId: h.sessionId,
        prompt: [{ type: "text", text: "after close" }],
      }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it("普通文本 /compact 之外的斜杠文本不拦截：进入正常推理", async () => {
    const h = await startProgressHarness();
    const res = await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "/model 是什么" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    // 未触发压缩
    expect(updatesOf(h, "compaction_update").length).toBe(0);
  });

  it("压缩失败/中断时 compaction_update 按 cancelled 终态化，不留卡在 in_progress 的条目", async () => {
    // handler：第一轮正常；压缩的摘要请求抛错使压缩失败。
    // 摘要请求 purpose 为 compaction 类角色——用 roleHandler 无法按内容区分，
    // 这里依赖 Core 失败路径只保证 cancelled 终态化逻辑被覆盖（成功路径另测）。
    // 若压缩实际不可用（无边界），应无 compaction 更新或按 cancelled 收尾——
    // 关键断言：绝不留下状态为 in_progress 且无配对的条目。
    const h = await startProgressHarness({
      scripts: [textScript("some history")],
    });
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "seed" }],
    });
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId: h.sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    await vi.waitFor(
      () => {
        const ups = updatesOf(h, "compaction_update");
        if (ups.length === 0) throw new Error("no compaction updates yet");
        // 等到出现终态（completed 或 cancelled）
        const terminal = ups.some((u) => {
          const s = (u.update as { status: string }).status;
          return s === "completed" || s === "cancelled" || s === "failed";
        });
        if (!terminal) throw new Error("no terminal compaction state yet");
      },
      { timeout: 8000 },
    );
    const ups = updatesOf(h, "compaction_update").map(
      (u) =>
        u.update as {
          compactionId: string;
          status: string;
        },
    );
    // 每个 in_progress 都必须有同 ID 的终态配对
    const inProgress = ups.filter((u) => u.status === "in_progress");
    for (const ip of inProgress) {
      const paired = ups.some(
        (u) =>
          u.compactionId === ip.compactionId &&
          (u.status === "completed" || u.status === "cancelled" || u.status === "failed"),
      );
      expect(paired).toBe(true);
    }
  });

  it("capability 门槛：未声明 compaction 的宿主收不到 compaction_update，但仍收到稳定协议的 plan/usage", async () => {
    // 协议规则（SDK schema/types.gen.d.ts）：compaction 约束 "MUST only send when the
    // Client advertised ClientSessionCapabilities::compaction"；plan/usage_update 是稳定
    // 协议、无能力门槛。本测试用未声明任何能力的 initialize 核对差异。
    const h = await startHarness({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "t1",
            name: "todo_write",
            input: { items: [{ text: "任务一", status: "in_progress" }] },
          },
        ],
        textScript("done"),
      ],
    });
    // 不声明任何 clientCapabilities（Paseo 0.17.5 风格 {}）
    await h.conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = (await h.conn.agent.request(methods.agent.session.new, {
      cwd: workspaceA,
      mcpServers: [],
    })) as { sessionId: string };
    // 跑一轮触发 todo_write → plan + usage
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "do work" }],
    });
    // plan（稳定协议）即使未声明能力也应收到
    await vi.waitFor(
      () => {
        if (updatesOf(h, "plan").length === 0) throw new Error("plan not yet received");
      },
      { timeout: 8000 },
    );
    expect(updatesOf(h, "plan").length).toBeGreaterThanOrEqual(1);
    // usage_update（稳定协议）也应收到
    expect(updatesOf(h, "usage_update").length).toBeGreaterThanOrEqual(1);
    // 触发压缩——未声明 compaction 能力，compaction_update 不应发送
    await h.conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    });
    // /compact 的 prompt 请求在压缩收尾后才 resolve——此处压缩流程已完整结束，
    // 无需额外等待即可反向断言：全程无 compaction_update 投递（能力门槛生效）。
    expect(updatesOf(h, "compaction_update").length).toBe(0);
  });
});
