import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type FakeHandler,
  type FakeScript,
  type ModelInfo,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import type { DurableEvent, PendingInputsSnapshot, RuntimeEvent } from "@nocturne/core/protocol";
import {
  createMemoryTransportPair,
  createRpcClient,
  trackSessionView,
  type LineTransport,
  type RpcClient,
  type RpcSession,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import { createRpcServer, type RpcServer } from "@nocturne/rpc/server";
import { createNocturneMcpServer } from "../src/index.js";

const createdRunRoots: string[] = [];

const TEST_MODELS: ModelInfo[] = [
  {
    ref: { provider: "fake", model: "fake-model" },
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none",
      imageInput: false,
      promptCache: false,
      editTool: "edit",
    },
  },
];

type McpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

async function until(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!check()) throw new Error(`等待超时：${label}`);
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function parseToolJson(result: McpCallToolResult): Record<string, unknown> {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP tool result 缺少 content 数组");
  }
  const first = result.content[0];
  if (!isTextBlock(first)) {
    throw new Error("MCP tool result 首项不是 text 块");
  }
  const parsed: unknown = JSON.parse(first.text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP tool result JSON 不是对象");
  }
  return parsed as Record<string, unknown>;
}

interface IntegrationRig {
  home: string;
  workspace: string;
  provider: FakeProvider;
  runtime: Runtime;
  rpcServer: RpcServer;
  desktopClient: RpcClient;
  mcpClient: Client;
  durableEvents(sessionId: string): readonly DurableEvent[];
  openRemoteClient(): Promise<{ client: RpcClient; close: () => Promise<void> }>;
  close(): Promise<void>;
}

async function setupRig(
  source: FakeScript[] | FakeHandler,
  options?: { wrapAgentTransport?: (transport: LineTransport) => LineTransport },
): Promise<IntegrationRig> {
  const runRoot = await mkdtemp(path.join(tmpdir(), "nct-mcp-phone-stop-"));
  createdRunRoots.push(runRoot);
  const home = path.join(runRoot, "home");
  const userHome = path.join(runRoot, "user-home");
  const workspace = path.join(runRoot, "ws");
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "readme.txt"), "hello\n", "utf8");

  // 彻底隔离 NOCTURNE_HOME / HOME / USERPROFILE 到系统临时目录，确保 createRuntime 不触及真实用户目录
  vi.stubEnv("NOCTURNE_HOME", home);
  vi.stubEnv("HOME", userHome);
  vi.stubEnv("USERPROFILE", userHome);

  const platform = createPlatform();
  const { store: credentials } = await createCredentialStore(platform, home, {
    backend: "memory",
  });
  const config = await loadConfig(platform, {
    nocturneHome: home,
    env: () => undefined,
    credentials,
    modelsDevFetch: () => Promise.reject(new Error("offline")),
    upstreamFetch: () => Promise.resolve([]),
  });

  const provider = new FakeProvider({
    ...(typeof source === "function" ? { handler: source } : { scripts: source }),
    models: TEST_MODELS,
  });

  const trackedCoreSessions = new Map<string, RuntimeSession>();
  let runtime!: Runtime;

  const rpcServer = createRpcServer({
    nocturneVersion: "0.51.0-test",
    agentPipe: false,
    remote: { home, credentials },
    createRuntime: async (init) => {
      const inner = await createRuntime({
        cwd: workspace,
        sessionsDir: config.sessionsDir,
        config,
        providers: [provider],
        interactive: init.interactive,
        turn: { retryBaseDelayMs: 1 },
      });
      const remember = (session: RuntimeSession): RuntimeSession => {
        trackedCoreSessions.set(session.id, session);
        return session;
      };
      runtime = {
        ...inner,
        createSession: async (opts) => remember(await inner.createSession(opts)),
        resumeSession: async (id, opts) => remember(await inner.resumeSession(id, opts)),
      };
      return {
        runtime,
        sessionsDir: config.sessionsDir,
        providerConfig: {
          config,
          reload: () => Promise.resolve(config),
          workspaceRoot: workspace,
        },
      };
    },
  });

  const [localServerEnd, localClientEnd] = createMemoryTransportPair();
  const localServed = rpcServer.serve(localServerEnd, { origin: "local" });
  const desktopClient = createRpcClient(localClientEnd, {
    clientName: "Nocturne Desktop",
    interactive: true,
  });
  await desktopClient.initialize();
  await desktopClient.call("runtime.setDefaultModel", {
    model: "fake/fake-model",
    reasoningEffort: null,
  });
  // 让 workspace 成为已打开过的合法工作区
  const { session: seed } = await desktopClient.runtime.createSession({
    cwd: workspace,
    model: "fake/fake-model",
  });
  await seed.close();

  const agentServedList: Promise<void>[] = [];
  const pairingPromise = new Promise<{ requestId: string }>((resolve) => {
    desktopClient.onNotification("agent.pairingRequested", (req) => {
      resolve(req);
    });
  });

  const mcpServer = createNocturneMcpServer({
    home,
    name: "claude-code-test",
    connectTransport: () => {
      const [agentServerEnd, agentClientEnd] = createMemoryTransportPair();
      agentServedList.push(
        rpcServer.serve(agentServerEnd, {
          origin: "agent",
          agent: {
            id: "agent-claude-test",
            name: "claude-code-test",
          },
        }),
      );
      return Promise.resolve(
        options?.wrapAgentTransport !== undefined
          ? options.wrapAgentTransport(agentClientEnd)
          : agentClientEnd,
      );
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "Claude Code", version: "1.0.0" });
  await mcpServer.server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const pairReq = await pairingPromise;
  await desktopClient.call("agent.respondPairing", {
    requestId: pairReq.requestId,
    approved: true,
    scope: "run",
    maxPermissionPreset: "default",
  });

  const remoteCleanups: (() => Promise<void>)[] = [];

  return {
    home,
    workspace,
    provider,
    runtime,
    rpcServer,
    desktopClient,
    mcpClient,
    durableEvents: (sessionId) => trackedCoreSessions.get(sessionId)?.durableEvents() ?? [],
    async openRemoteClient() {
      const [remoteServerEnd, remoteClientEnd] = createMemoryTransportPair();
      const remoteServed = rpcServer.serve(remoteServerEnd, { origin: "remote" });
      const remoteClient = createRpcClient(remoteClientEnd, {
        clientName: "Nocturne Phone Web",
        interactive: true,
      });
      await remoteClient.initialize();
      const close = async () => {
        remoteClient.close();
        await remoteServed.catch(() => undefined);
      };
      remoteCleanups.push(close);
      return { client: remoteClient, close };
    },
    async close() {
      for (const fn of remoteCleanups.splice(0)) {
        await fn().catch(() => undefined);
      }
      await mcpClient.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
      await desktopClient.shutdown().catch(() => desktopClient.close());
      await Promise.allSettled([localServed, ...agentServedList]);
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function summarizeTurns(events: readonly DurableEvent[]) {
  return events
    .filter(
      (e) => e.type === "turn.started" || e.type === "turn.completed" || e.type === "message.user",
    )
    .map((e) =>
      e.type === "turn.completed"
        ? { seq: e.seq, type: e.type, turnId: e.turnId, reason: e.payload.reason }
        : { seq: e.seq, type: e.type, turnId: e.turnId },
    );
}

/**
 * 按真实手机（SessionScreen.tsx / sessions.ts）或桌面（conversations.ts）顺序打开会话、
 * 订阅事件流并拉取待发输入快照，验证处于运行态后调用无 id 的 `session.interrupt` 通知。
 */
async function openViewerAndInterrupt(
  rig: IntegrationRig,
  origin: "remote" | "local",
  sessionId: string,
  inspectPendingBefore?: (snap: PendingInputsSnapshot) => void,
): Promise<{
  viewerSession: RpcSession;
  viewerTracker: SessionViewTracker;
  viewerEvents: RuntimeEvent[];
  interruptAt: number;
}> {
  let viewerClient = rig.desktopClient;
  if (origin === "remote") {
    const remote = await rig.openRemoteClient();
    viewerClient = remote.client;
    const list = await viewerClient.runtime.listSessions();
    const item = list.find((s) => s.id === sessionId);
    expect(item).toBeDefined();
    expect(item?.openHere).toBe(true);
  }

  const { session: viewerSession } = await viewerClient.runtime.resumeSession(sessionId);
  const viewerEvents: RuntimeEvent[] = [];
  const viewerTracker = await trackSessionView(viewerSession, (_v, ev) => {
    viewerEvents.push(ev);
  });
  const pendingSnap = await viewerSession.pendingInputs();
  inspectPendingBefore?.(pendingSnap);
  expect(viewerTracker.view.currentTurn).toBeDefined();

  const interruptAt = Date.now();
  viewerSession.interrupt();
  return { viewerSession, viewerTracker, viewerEvents, interruptAt };
}

/**
 * Layer A 独立观测：在任何桥层 wait 结果之外先确认持久 `turn.completed(aborted)` 落盘、
 * 静默窗口无第 2 个 Turn / 第 2 次 provider 请求，并返回采集到的摘要供日志与断言使用。
 */
async function collectLayerAAfterInterrupt(
  rig: IntegrationRig,
  viewerSession: RpcSession,
  sessionId: string,
  quietWindowMs = 200,
) {
  await until(
    () => rig.durableEvents(sessionId).some((e) => e.type === "turn.completed"),
    "durable 写入 turn.completed",
  );
  // eslint-disable-next-line no-restricted-syntax -- 反向断言：中断后需真实经过静默窗口（quietWindowMs），确认没有迟到的后续 Turn 或队列接续
  await new Promise((r) => setTimeout(r, quietWindowMs));

  const durable = rig.durableEvents(sessionId);
  const started = durable.filter((e) => e.type === "turn.started");
  const completed = durable.filter((e) => e.type === "turn.completed");
  const userMsgs = durable.filter((e) => e.type === "message.user");
  const finalPending = await viewerSession.pendingInputs();

  return {
    turnSummary: summarizeTurns(durable),
    started,
    completed,
    userMsgs,
    finalPending,
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 包装下游 LineTransport：当检测到第 targetTurnIndex 轮的 `turn.started` 事件帧时，
 * 拦截该帧及其后到达的所有下游帧（严格保序 FIFO 排队），直到 release() 后按原序放行。
 */
function createOrderedTurnStartedGate(
  inner: LineTransport,
  targetTurnIndex: number,
): {
  transport: LineTransport;
  intercepted: Promise<void>;
  release: () => void;
} {
  let holding = false;
  let closedWhileHolding = false;
  const buffered: string[] = [];
  let lineHandler: ((line: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const interceptedDef = createDeferred();

  const deliver = (): void => {
    if (holding) return;
    while (lineHandler !== undefined && buffered.length > 0) {
      const next = buffered.shift();
      if (next !== undefined) lineHandler(next);
    }
    if (closedWhileHolding && buffered.length === 0 && closeHandler !== undefined) {
      closeHandler();
    }
  };

  inner.onLine((line) => {
    if (!holding) {
      try {
        const msg = JSON.parse(line) as {
          method?: unknown;
          params?: { event?: { type?: unknown; payload?: { turnIndex?: unknown } } };
        };
        if (
          msg.method === "event" &&
          msg.params?.event?.type === "turn.started" &&
          msg.params.event.payload?.turnIndex === targetTurnIndex
        ) {
          holding = true;
          interceptedDef.resolve();
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
    if (holding || lineHandler === undefined) {
      buffered.push(line);
      return;
    }
    lineHandler(line);
  });

  inner.onClose(() => {
    if (holding || lineHandler === undefined) {
      closedWhileHolding = true;
      return;
    }
    closeHandler?.();
  });

  return {
    transport: {
      send: (line) => inner.send(line),
      onLine: (handler) => {
        lineHandler = handler;
        deliver();
      },
      onClose: (handler) => {
        closeHandler = handler;
        deliver();
      },
      ...(inner.flush !== undefined ? { flush: () => inner.flush?.() ?? Promise.resolve() } : {}),
      close: () => inner.close(),
    },
    intercepted: interceptedDef.promise,
    release: () => {
      holding = false;
      deliver();
    },
  };
}

async function raceWithinWindow<T>(promise: Promise<T>, windowMs = 1_000) {
  const raced = await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) =>
      setTimeout(() => resolve({ settled: false }), windowMs),
    ),
  ]);
  const final = raced.settled ? raced.value : await promise;
  return { settled: raced.settled, final };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

afterAll(async () => {
  await Promise.all(
    createdRunRoots
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe("agent 桥创建慢 Turn，remote 手机 / local 桌面按实际顺序中断", () => {
  describe.each(["remote", "local"] as const)("连接来源: %s", (origin) => {
    it("常规长 Turn：按实际打开/订阅/pendingInputs 后发送 session.interrupt 通知，aborted 且无后续 Turn", async () => {
      const rig = await setupRig([[{ type: "wait", ms: 60_000 }]]);
      cleanups.push(() => rig.close());

      const startRes = await rig.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: {
          cwd: rig.workspace,
          prompt: "执行一个长耗时任务（常规）",
          wait: false,
        },
      });
      expect(startRes.isError).toBeFalsy();
      const sessionId = parseToolJson(startRes).sessionId as string;
      expect(typeof sessionId).toBe("string");

      await until(
        () => rig.provider.requests.length === 1 && rig.provider.waitState.waiting === 1,
        "首个 provider 请求确实挂起",
      );

      const { viewerSession, viewerTracker, viewerEvents } = await openViewerAndInterrupt(
        rig,
        origin,
        sessionId,
        (snap) => {
          expect(snap.items).toEqual([]);
        },
      );

      const layerA = await collectLayerAAfterInterrupt(rig, viewerSession, sessionId);

      const t0 = Date.now();
      const waitRes = await rig.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 2 },
      });
      const waitElapsedMs = Date.now() - t0;
      const waitData = parseToolJson(waitRes);

      console.info(
        `[diag][${origin}][normal]`,
        JSON.stringify({
          turnSummary: layerA.turnSummary,
          providerRequests: rig.provider.requests.length,
          providerWaitState: rig.provider.waitState,
          finalPending: layerA.finalPending,
          viewerReceivedCompleted: viewerEvents.some((e) => e.type === "turn.completed"),
          waitElapsedMs,
          waitData,
        }),
      );

      expect(layerA.started).toHaveLength(1);
      expect(layerA.completed).toHaveLength(1);
      expect(
        layerA.completed[0]?.type === "turn.completed" && layerA.completed[0].payload.reason,
      ).toBe("aborted");
      expect(layerA.userMsgs).toHaveLength(1);
      expect(rig.provider.requests).toHaveLength(1);
      expect(rig.provider.waitState.aborts).toBe(1);
      expect(layerA.finalPending.items).toEqual([]);
      expect(viewerEvents.some((e) => e.type === "turn.completed")).toBe(true);

      expect(waitRes.isError).toBeFalsy();
      expect(waitElapsedMs).toBeLessThan(1_000);
      expect(waitData.status).toBe("idle");
      expect(waitData.turnOutcome).toBe("aborted");

      await viewerTracker.stop();
      await viewerSession.close();
    });

    it("nocturne_wait 正在等待中：按实际顺序中断后 wait 及时结束且返回 aborted，无后续 Turn", async () => {
      const rig = await setupRig([[{ type: "wait", ms: 60_000 }]]);
      cleanups.push(() => rig.close());

      const startRes = await rig.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: {
          cwd: rig.workspace,
          prompt: "执行一个长耗时任务（wait 中）",
          wait: false,
        },
      });
      expect(startRes.isError).toBeFalsy();
      const sessionId = parseToolJson(startRes).sessionId as string;

      await until(
        () => rig.provider.requests.length === 1 && rig.provider.waitState.waiting === 1,
        "首个 provider 请求确实挂起",
      );

      let waitSettled = false;
      const waitStartedAt = Date.now();
      const waitPromise = rig.mcpClient
        .callTool({
          name: "nocturne_wait",
          arguments: { sessionId, timeoutSeconds: 3 },
        })
        .then((res) => {
          waitSettled = true;
          return { res, elapsedMs: Date.now() - waitStartedAt };
        });

      // eslint-disable-next-line no-restricted-syntax -- 反向断言：长 Turn 仍在运行，nocturne_wait(3s) 在真实 30ms 窗口内不得提前返回
      await new Promise((r) => setTimeout(r, 30));
      expect(waitSettled).toBe(false);

      const { viewerSession, viewerTracker, viewerEvents, interruptAt } =
        await openViewerAndInterrupt(rig, origin, sessionId);

      const layerA = await collectLayerAAfterInterrupt(rig, viewerSession, sessionId);

      const waitRace = await Promise.race([
        waitPromise.then((v) => ({ settled: true as const, ...v })),
        new Promise<{ settled: false }>((resolve) =>
          setTimeout(() => resolve({ settled: false }), 1_200),
        ),
      ]);
      const finalWait = waitRace.settled ? waitRace : await waitPromise;
      const afterInterruptMs =
        (waitRace.settled ? waitRace.elapsedMs : finalWait.elapsedMs) -
        (interruptAt - waitStartedAt);
      const waitData = parseToolJson(finalWait.res);

      console.info(
        `[diag][${origin}][wait]`,
        JSON.stringify({
          turnSummary: layerA.turnSummary,
          providerRequests: rig.provider.requests.length,
          providerWaitState: rig.provider.waitState,
          finalPending: layerA.finalPending,
          viewerReceivedCompleted: viewerEvents.some((e) => e.type === "turn.completed"),
          waitSettledWithinWindow: waitRace.settled,
          afterInterruptMs,
          waitData,
        }),
      );

      expect(layerA.started).toHaveLength(1);
      expect(layerA.completed).toHaveLength(1);
      expect(
        layerA.completed[0]?.type === "turn.completed" && layerA.completed[0].payload.reason,
      ).toBe("aborted");
      expect(rig.provider.requests).toHaveLength(1);
      expect(rig.provider.waitState.aborts).toBe(1);
      expect(layerA.finalPending.items).toEqual([]);

      expect(waitRace.settled).toBe(true);
      expect(finalWait.res.isError).toBeFalsy();
      expect(waitData.status).toBe("idle");
      expect(waitData.turnOutcome).toBe("aborted");

      await viewerTracker.stop();
      await viewerSession.close();
    });

    it("Turn 内 nocturne_send 队列输入：中断后 aborted、队列保持 paused 不接续、wait 及时返回 aborted", async () => {
      const rig = await setupRig([
        [{ type: "wait", ms: 60_000 }],
        [
          { type: "text_delta", text: "不应执行的第二轮" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      cleanups.push(() => rig.close());

      const startRes = await rig.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: {
          cwd: rig.workspace,
          prompt: "执行一个长耗时任务（带 queued send）",
          wait: false,
        },
      });
      expect(startRes.isError).toBeFalsy();
      const sessionId = parseToolJson(startRes).sessionId as string;

      await until(
        () => rig.provider.requests.length === 1 && rig.provider.waitState.waiting === 1,
        "首个 provider 请求确实挂起",
      );

      const sendRes = await rig.mcpClient.callTool({
        name: "nocturne_send",
        arguments: {
          sessionId,
          prompt: "队列里的后续输入",
          wait: false,
        },
      });
      expect(sendRes.isError).toBeFalsy();
      const sendData = parseToolJson(sendRes);
      expect(sendData.status).toBe("running");
      expect(sendData.queuedInputs).toBe(1);

      let waitSettled = false;
      const waitStartedAt = Date.now();
      const waitPromise = rig.mcpClient
        .callTool({
          name: "nocturne_wait",
          arguments: { sessionId, timeoutSeconds: 2 },
        })
        .then((res) => {
          waitSettled = true;
          return { res, elapsedMs: Date.now() - waitStartedAt };
        });

      // eslint-disable-next-line no-restricted-syntax -- 反向断言：长 Turn 仍在运行，nocturne_wait(2s) 在真实 30ms 窗口内不得提前返回
      await new Promise((r) => setTimeout(r, 30));
      expect(waitSettled).toBe(false);

      let pendingBeforeInterrupt: PendingInputsSnapshot | undefined;
      const { viewerSession, viewerTracker, viewerEvents, interruptAt } =
        await openViewerAndInterrupt(rig, origin, sessionId, (snap) => {
          pendingBeforeInterrupt = snap;
          expect(snap.paused).toBe(false);
          expect(snap.items).toHaveLength(1);
          expect(snap.items[0]).toMatchObject({
            mode: "queue",
            text: "队列里的后续输入",
            paused: false,
          });
        });

      const layerA = await collectLayerAAfterInterrupt(rig, viewerSession, sessionId, 250);

      const waitRace = await Promise.race([
        waitPromise.then((v) => ({ settled: true as const, ...v })),
        new Promise<{ settled: false }>((resolve) =>
          setTimeout(() => resolve({ settled: false }), 1_000),
        ),
      ]);
      const finalWait = waitRace.settled ? waitRace : await waitPromise;
      const afterInterruptMs =
        (waitRace.settled ? waitRace.elapsedMs : finalWait.elapsedMs) -
        (interruptAt - waitStartedAt);
      const waitData = parseToolJson(finalWait.res);

      console.info(
        `[diag][${origin}][queued_send]`,
        JSON.stringify({
          turnSummary: layerA.turnSummary,
          providerRequests: rig.provider.requests.length,
          providerWaitState: rig.provider.waitState,
          sendData,
          pendingBeforeInterrupt,
          finalPending: layerA.finalPending,
          viewerReceivedCompleted: viewerEvents.some((e) => e.type === "turn.completed"),
          waitSettledWithinWindow: waitRace.settled,
          afterInterruptMs,
          waitData,
        }),
      );

      expect(layerA.started).toHaveLength(1);
      expect(layerA.completed).toHaveLength(1);
      expect(
        layerA.completed[0]?.type === "turn.completed" && layerA.completed[0].payload.reason,
      ).toBe("aborted");
      expect(layerA.userMsgs).toHaveLength(1);
      expect(JSON.stringify(layerA.userMsgs)).not.toContain("队列里的后续输入");
      expect(rig.provider.requests).toHaveLength(1);
      expect(rig.provider.waitState.aborts).toBe(1);
      expect(layerA.finalPending.paused).toBe(true);
      expect(layerA.finalPending.items).toHaveLength(1);
      expect(layerA.finalPending.items[0]).toMatchObject({
        mode: "queue",
        text: "队列里的后续输入",
        paused: true,
      });

      expect(waitRace.settled).toBe(true);
      expect(finalWait.res.isError).toBeFalsy();
      expect(waitData.status).toBe("paused");
      expect(waitData.turnOutcome).toBe("aborted");

      await viewerTracker.stop();
      await viewerSession.close();
    });
  });
});

async function assertWaitPausedAborted(
  rig: IntegrationRig,
  sessionId: string,
  pendingCall: Promise<McpCallToolResult>,
  viewerSession: RpcSession,
  viewerTracker: SessionViewTracker,
) {
  const layerA = await collectLayerAAfterInterrupt(rig, viewerSession, sessionId, 250);
  const { settled, final } = await raceWithinWindow(pendingCall, 1_000);
  const data = parseToolJson(final);

  expect(settled).toBe(true);
  expect(final.isError).toBeFalsy();
  expect(data.sessionId).toBe(sessionId);
  expect(data.status).toBe("paused");
  expect(data.turnOutcome).toBe("aborted");
  expect(data.queuedInputs).toBe(1);

  expect(layerA.started).toHaveLength(1);
  expect(layerA.completed).toHaveLength(1);
  expect(layerA.completed[0]?.type === "turn.completed" && layerA.completed[0].payload.reason).toBe(
    "aborted",
  );
  expect(rig.provider.requests).toHaveLength(1);
  expect(rig.provider.waitState.aborts).toBe(1);
  expect(layerA.finalPending.paused).toBe(true);

  await viewerTracker.stop();
  await viewerSession.close();
}

describe("桥接等待边界回归（start/send wait:true 与正常 done 队列接续）", () => {
  it("nocturne_start_session(wait: true) 带排队输入被 remote 中断时，立即返回 paused / aborted 且无后续 Turn", async () => {
    const rig = await setupRig([[{ type: "wait", ms: 60_000 }]]);
    cleanups.push(() => rig.close());

    let startSettled = false;
    const startPromise = rig.mcpClient
      .callTool({
        name: "nocturne_start_session",
        arguments: {
          cwd: rig.workspace,
          prompt: "start wait 长任务",
          wait: true,
          timeoutSeconds: 5,
        },
      })
      .then((res) => {
        startSettled = true;
        return res;
      });

    await until(
      () => rig.provider.requests.length === 1 && rig.provider.waitState.waiting === 1,
      "首个 provider 请求挂起",
    );
    const sessions = await rig.desktopClient.runtime.listSessions();
    const sessionId = sessions.find((s) => s.openHere)?.id;
    expect(typeof sessionId).toBe("string");
    if (!sessionId) throw new Error("未找到 openHere 会话");
    expect(startSettled).toBe(false);

    const sendRes = await rig.mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "start wait 期间排队的输入",
        wait: false,
      },
    });
    expect(sendRes.isError).toBeFalsy();
    expect(parseToolJson(sendRes).queuedInputs).toBe(1);

    const { viewerSession, viewerTracker } = await openViewerAndInterrupt(rig, "remote", sessionId);
    await assertWaitPausedAborted(rig, sessionId, startPromise, viewerSession, viewerTracker);
  });

  it("nocturne_send(wait: true) 在 Turn 运行中排队并在中断后立即返回 paused / aborted", async () => {
    const rig = await setupRig([[{ type: "wait", ms: 60_000 }]]);
    cleanups.push(() => rig.close());

    const startRes = await rig.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: rig.workspace,
        prompt: "先跑第一轮长任务",
        wait: false,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const sessionId = parseToolJson(startRes).sessionId as string;

    await until(
      () => rig.provider.requests.length === 1 && rig.provider.waitState.waiting === 1,
      "首个 provider 请求挂起",
    );

    let sendSettled = false;
    const sendPromise = rig.mcpClient
      .callTool({
        name: "nocturne_send",
        arguments: {
          sessionId,
          prompt: "send wait 排队输入",
          wait: true,
          timeoutSeconds: 5,
        },
      })
      .then((res) => {
        sendSettled = true;
        return res;
      });

    // eslint-disable-next-line no-restricted-syntax -- 反向断言：Turn 仍在运行，nocturne_send(wait:true) 在真实 40ms 窗口内不得提前返回
    await new Promise((r) => setTimeout(r, 40));
    expect(sendSettled).toBe(false);

    const { viewerSession, viewerTracker } = await openViewerAndInterrupt(
      rig,
      "remote",
      sessionId,
      (snap) => {
        expect(snap.paused).toBe(false);
        expect(snap.items).toHaveLength(1);
      },
    );
    await assertWaitPausedAborted(rig, sessionId, sendPromise, viewerSession, viewerTracker);
  });

  it("已处于 paused 时调用 nocturne_send(wait: true)：不误早退，等恢复后的排队轮次全部 done 后返回", async () => {
    const turn2Gate = createDeferred();
    const turn3Gate = createDeferred();
    const rig = await setupRig(async (_req, callIndex) => {
      if (callIndex === 0) return [{ type: "wait", ms: 60_000 }];
      if (callIndex === 1) {
        await turn2Gate.promise;
        return [
          { type: "text_delta", text: "第一条恢复完成" },
          { type: "finish", reason: "stop" },
        ];
      }
      await turn3Gate.promise;
      return [
        { type: "text_delta", text: "第二条新消息完成" },
        { type: "finish", reason: "stop" },
      ];
    });
    cleanups.push(() => rig.close());

    const startRes = await rig.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: rig.workspace,
        prompt: "先跑一轮再中断",
        wait: false,
      },
    });
    const sessionId = parseToolJson(startRes).sessionId as string;

    await until(
      () => rig.provider.requests.length === 1 && rig.provider.waitState.waiting === 1,
      "首轮挂起",
    );

    await rig.mcpClient.callTool({
      name: "nocturne_send",
      arguments: { sessionId, prompt: "已暂停的排队任务", wait: false },
    });

    const { viewerSession, viewerTracker } = await openViewerAndInterrupt(rig, "remote", sessionId);
    const layerA = await collectLayerAAfterInterrupt(rig, viewerSession, sessionId, 150);
    expect(layerA.finalPending.paused).toBe(true);

    let sendSettled = false;
    const resumeSendPromise = rig.mcpClient
      .callTool({
        name: "nocturne_send",
        arguments: {
          sessionId,
          prompt: "新追加任务",
          wait: true,
          timeoutSeconds: 5,
        },
      })
      .then((res) => {
        sendSettled = true;
        return res;
      });

    await until(() => rig.provider.requests.length === 2, "恢复后第 2 轮已发往 provider");
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：第 2 轮仍在 provider 中运行，send(wait:true) 在真实 120ms 窗口内不得提前收束
    await new Promise((r) => setTimeout(r, 120));
    expect(sendSettled).toBe(false);

    turn2Gate.resolve();
    await until(() => rig.provider.requests.length === 3, "第 2 轮 done 后接续第 3 轮");
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：第 3 轮运行中，send(wait:true) 在真实 120ms 窗口内不得提前收束
    await new Promise((r) => setTimeout(r, 120));
    expect(sendSettled).toBe(false);

    turn3Gate.resolve();
    const { settled, final } = await raceWithinWindow(resumeSendPromise, 1_000);
    const sendData = parseToolJson(final);

    expect(settled).toBe(true);
    expect(final.isError).toBeFalsy();
    expect(sendData.status).toBe("idle");
    expect(sendData.turnOutcome).toBe("done");
    expect(sendData.turnCount).toBe(3);
    expect(sendData.reply).toBe("第二条新消息完成");

    await viewerTracker.stop();
    await viewerSession.close();
  });

  it("正常 done 队列接续回归：第一轮 done 后第 2 轮 turn.started 延迟 >60ms 不提前返回，第二轮 done 后才收束", async () => {
    const turn1Gate = createDeferred();
    const turn2Gate = createDeferred();
    let releaseSecondTurnStarted: (() => void) | undefined;
    let secondTurnStartedIntercepted: Promise<void> | undefined;

    const rig = await setupRig(
      async (_req, callIndex) => {
        if (callIndex === 0) {
          await turn1Gate.promise;
          return [
            { type: "text_delta", text: "第一轮正常结束" },
            { type: "finish", reason: "stop" },
          ];
        }
        await turn2Gate.promise;
        return [
          { type: "text_delta", text: "第二轮队列任务完成" },
          { type: "finish", reason: "stop" },
        ];
      },
      {
        wrapAgentTransport: (inner) => {
          const gated = createOrderedTurnStartedGate(inner, 2);
          secondTurnStartedIntercepted = gated.intercepted;
          releaseSecondTurnStarted = gated.release;
          return gated.transport;
        },
      },
    );
    cleanups.push(() => rig.close());
    cleanups.push(() => {
      releaseSecondTurnStarted?.();
      turn1Gate.resolve();
      turn2Gate.resolve();
      return Promise.resolve();
    });

    const startRes = await rig.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: rig.workspace,
        prompt: "第一轮正常任务",
        wait: false,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const sessionId = parseToolJson(startRes).sessionId as string;

    await until(() => rig.provider.requests.length === 1, "第 1 轮已进入 provider");

    const queuedSendRes = await rig.mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "第二轮排队任务",
        wait: false,
      },
    });
    expect(queuedSendRes.isError).toBeFalsy();
    expect(parseToolJson(queuedSendRes).queuedInputs).toBe(1);

    let waitSettled = false;
    const waitPromise = rig.mcpClient
      .callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 5 },
      })
      .then((res) => {
        waitSettled = true;
        return res;
      });

    // eslint-disable-next-line no-restricted-syntax -- 反向断言：第 1 轮未 done，nocturne_wait(5s) 在真实 30ms 窗口内不得提前返回
    await new Promise((r) => setTimeout(r, 30));
    expect(waitSettled).toBe(false);

    // 放行第 1 轮正常 done；transport gate 拦截第 2 个 turn.started 及全部后续帧，明确保持 >60ms 间隙
    turn1Gate.resolve();
    await secondTurnStartedIntercepted;
    // eslint-disable-next-line no-restricted-syntax -- 边界回归：turn.started 之间保持真实 >60ms 间隙，覆盖 shortTimer 判定窗口
    await new Promise((r) => setTimeout(r, 120));
    expect(waitSettled).toBe(false);

    // 按严格 FIFO 放行第 2 个 turn.started 及后续帧，再放行第 2 轮完成
    releaseSecondTurnStarted?.();
    await until(() => rig.provider.requests.length === 2, "第 2 轮已发往 provider");
    turn2Gate.resolve();
    const { settled, final } = await raceWithinWindow(waitPromise, 1_000);
    const waitData = parseToolJson(final);

    expect(settled).toBe(true);
    expect(final.isError).toBeFalsy();
    expect(waitData.status).toBe("idle");
    expect(waitData.turnOutcome).toBe("done");
    expect(waitData.turnCount).toBe(2);
    expect(waitData.reply).toBe("第二轮队列任务完成");
  });

  it("Turn 出错结束且带 queued send：wait 及时返回 paused / error，队列暂停不接续", async () => {
    const turn1Gate = createDeferred();
    const rig = await setupRig(async (_req, callIndex) => {
      if (callIndex === 0) {
        await turn1Gate.promise;
        return [{ type: "throw", error: new Error("provider down") }];
      }
      return [{ type: "finish", reason: "stop" }];
    });
    cleanups.push(() => rig.close());
    cleanups.push(() => {
      turn1Gate.resolve();
      return Promise.resolve();
    });

    const startRes = await rig.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: rig.workspace,
        prompt: "执行会出错的首轮任务",
        wait: false,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const sessionId = parseToolJson(startRes).sessionId as string;

    await until(() => rig.provider.requests.length === 1, "第 1 轮已进入 provider");

    const queuedSendRes = await rig.mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "出错后应保持暂停的排队输入",
        wait: false,
      },
    });
    expect(queuedSendRes.isError).toBeFalsy();
    expect(parseToolJson(queuedSendRes).queuedInputs).toBe(1);

    let waitSettled = false;
    const waitPromise = rig.mcpClient
      .callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 5 },
      })
      .then((res) => {
        waitSettled = true;
        return res;
      });

    // eslint-disable-next-line no-restricted-syntax -- 反向断言：首轮未抛错结束，nocturne_wait(5s) 在真实 30ms 窗口内不得提前返回
    await new Promise((r) => setTimeout(r, 30));
    expect(waitSettled).toBe(false);

    // 放行首轮抛错；non-retryable Error 直接以 reason:"error" 结束 Turn 并暂停排队输入
    turn1Gate.resolve();
    const { settled, final } = await raceWithinWindow(waitPromise, 1_000);
    const waitData = parseToolJson(final);

    expect(settled).toBe(true);
    expect(final.isError).toBeFalsy();
    expect(waitData.status).toBe("paused");
    expect(waitData.turnOutcome).toBe("error");
    expect(waitData.queuedInputs).toBe(1);

    // 静默窗口确认无第二轮发起，且 durable 与 pendingInputs 状态一致
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：错误结束后需真实经过 200ms 静默窗口，确认没有自动发起第二轮
    await new Promise((r) => setTimeout(r, 200));
    const durable = rig.durableEvents(sessionId);
    const started = durable.filter((e) => e.type === "turn.started");
    const completed = durable.filter((e) => e.type === "turn.completed");
    const userMsgs = durable.filter((e) => e.type === "message.user");
    const { session: checkSession } = await rig.desktopClient.runtime.resumeSession(sessionId);
    const finalPending = await checkSession.pendingInputs();
    await checkSession.close();

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.type === "turn.completed" && completed[0].payload.reason).toBe("error");
    expect(userMsgs).toHaveLength(1);
    expect(rig.provider.requests).toHaveLength(1);
    expect(finalPending.paused).toBe(true);
    expect(finalPending.items).toHaveLength(1);
    expect(finalPending.items[0]).toMatchObject({
      mode: "queue",
      text: "出错后应保持暂停的排队输入",
      paused: true,
    });
  });

  it("前序 submit RPC 响应迟到且下一轮 turn.started 超过 40ms 时，不误清启动令牌导致提前返回上一轮 idle", async () => {
    const enqueueSentDef = createDeferred();
    const submitRespInterceptedDef = createDeferred();
    let heldSubmitRespLine: string | undefined;
    let submitRespDelivered = false;
    let outerHandler: ((line: string) => void) | undefined;
    let releaseTurn2Started: (() => void) | undefined;
    let turn2StartedIntercepted: Promise<void> | undefined;

    const releaseSubmitResponse = (): void => {
      if (submitRespDelivered) return;
      submitRespDelivered = true;
      if (heldSubmitRespLine !== undefined && outerHandler !== undefined) {
        const line = heldSubmitRespLine;
        heldSubmitRespLine = undefined;
        outerHandler(line);
      }
    };

    const rig = await setupRig(
      (_req, callIndex) => {
        if (callIndex === 0) {
          return Promise.resolve([
            { type: "text_delta", text: "第一轮完成" },
            { type: "finish", reason: "stop" },
          ]);
        }
        return Promise.resolve([
          { type: "text_delta", text: "第二轮正常完成" },
          { type: "finish", reason: "stop" },
        ]);
      },
      {
        wrapAgentTransport: (inner) => {
          let submitReqId: string | number | undefined;
          const submitGate: LineTransport = {
            send: (line) => {
              try {
                const msg = JSON.parse(line) as { id?: string | number; method?: unknown };
                if (msg.method === "session.submit" && msg.id !== undefined) {
                  submitReqId = msg.id;
                } else if (msg.method === "session.enqueueInput") {
                  enqueueSentDef.resolve();
                }
              } catch {
                /* 非 JSON 行忽略 */
              }
              inner.send(line);
            },
            onLine: (handler) => {
              outerHandler = handler;
              inner.onLine((line) => {
                if (!submitRespDelivered && submitReqId !== undefined) {
                  try {
                    const msg = JSON.parse(line) as { id?: unknown };
                    if (msg.id === submitReqId) {
                      heldSubmitRespLine = line;
                      submitRespInterceptedDef.resolve();
                      return;
                    }
                  } catch {
                    /* 非 JSON 行忽略 */
                  }
                }
                handler(line);
              });
            },
            onClose: (handler) => inner.onClose(handler),
            ...(inner.flush !== undefined
              ? { flush: () => inner.flush?.() ?? Promise.resolve() }
              : {}),
            close: () => inner.close(),
          };
          const turn2Gate = createOrderedTurnStartedGate(submitGate, 2);
          turn2StartedIntercepted = turn2Gate.intercepted;
          releaseTurn2Started = turn2Gate.release;
          return turn2Gate.transport;
        },
      },
    );
    cleanups.push(() => rig.close());
    cleanups.push(() => {
      releaseSubmitResponse();
      releaseTurn2Started?.();
      return Promise.resolve();
    });

    const startRes = await rig.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: rig.workspace,
        prompt: "第一轮任务",
        wait: true,
        timeoutSeconds: 5,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const startData = parseToolJson(startRes);
    const sessionId = startData.sessionId as string;
    expect(startData.status).toBe("idle");
    expect(startData.turnCount).toBe(1);

    await submitRespInterceptedDef.promise;

    let sendSettled = false;
    const sendPromise = rig.mcpClient
      .callTool({
        name: "nocturne_send",
        arguments: {
          sessionId,
          prompt: "紧接着的第二轮任务",
          wait: true,
          timeoutSeconds: 5,
        },
      })
      .then((res) => {
        sendSettled = true;
        return res;
      });

    await enqueueSentDef.promise;
    // 在第二轮已进入 triggerEnqueueOnTracked 后才放行第一轮迟到的 session.submit RPC 响应
    releaseSubmitResponse();

    await turn2StartedIntercepted;
    // 越过 triggerEnqueueOnTracked 的 40ms shortTimer 窗口，确认不会误判为上一轮 idle 提前返回
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：必须真实越过 40ms shortTimer 窗口，确认 send(wait:true) 不会提前返回上一轮 idle
    await new Promise((r) => setTimeout(r, 80));
    expect(sendSettled).toBe(false);

    releaseTurn2Started?.();
    const { settled, final } = await raceWithinWindow(sendPromise, 2_000);
    const sendData = parseToolJson(final);

    expect(settled).toBe(true);
    expect(final.isError).toBeFalsy();
    expect(sendData.status).toBe("idle");
    expect(sendData.turnOutcome).toBe("done");
    expect(sendData.turnCount).toBe(2);
    expect(sendData.reply).toBe("第二轮正常完成");
  });
});
