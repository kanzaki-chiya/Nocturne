import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  SessionError,
  type FakeHandler,
  type FakeScript,
  type ModelInfo,
  type Runtime,
} from "@nocturne/core";
import { createSessionView, type ToolEntry } from "@nocturne/core/protocol";
import { createRuntimeStub } from "@nocturne/core/testing";
import { createMemoryTransportPair, createRpcClient, type RpcClient } from "@nocturne/rpc/client";
import { createRpcServer, type RpcServer } from "@nocturne/rpc/server";
import {
  createNocturneMcpServer,
  extractIncrementalWaitTurn,
  MAX_WAIT_TOOL_TARGET_CHARS,
  MAX_WAIT_TOOLS_PER_CALL,
  summarizeWaitToolEntry,
  type WaitToolCursor,
} from "../src/index.js";

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

function parseToolJson(
  result: Record<string, unknown> | { content?: unknown },
): Record<string, unknown> {
  const arr = (result as { content?: { type: string; text: string }[] }).content;
  return JSON.parse(arr?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function getToolText(result: Record<string, unknown> | { content?: unknown }): string {
  const arr = (result as { content?: { type: string; text: string }[] }).content;
  return arr?.[0]?.text ?? "";
}

function makeToolEntry(
  callId: string,
  turnId: string,
  name: string,
  options: {
    seq: number;
    status?: "ok" | "error" | "running";
    command?: string;
    filePath?: string;
    error?: string;
  },
): ToolEntry {
  const status = options.status ?? "ok";
  return {
    kind: "tool",
    key: `tool-${callId}`,
    turnId,
    callId,
    name,
    seq: options.seq,
    status,
    input:
      options.command !== undefined
        ? { command: options.command }
        : options.filePath !== undefined
          ? { path: options.filePath }
          : {},
    subjects:
      options.command !== undefined
        ? [{ kind: "shell", target: options.command }]
        : options.filePath !== undefined
          ? [{ kind: "read", target: options.filePath }]
          : [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result:
      status === "running"
        ? undefined
        : {
            status,
            modelContent: "",
            output: undefined,
            error:
              options.error !== undefined
                ? { code: "tool_error", message: options.error }
                : undefined,
            truncated: false,
            spillPath: undefined,
            durationMs: 10,
          },
  };
}

interface TestHarness {
  home: string;
  workspace: string;
  provider: FakeProvider;
  runtime: Runtime;
  rpcServer: RpcServer;
  desktopClient: RpcClient;
  connectAgent(
    agentId: string,
    name: string,
  ): Promise<{
    mcpClient: Client;
    close: () => Promise<void>;
  }>;
  close(): Promise<void>;
}

async function createHarness(options?: {
  scripts?: FakeScript[];
  handler?: FakeHandler;
  roleHandler?: FakeHandler;
  wrapRuntime?: (runtime: Runtime) => Runtime;
}): Promise<TestHarness> {
  const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-wait-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "nct-mcp-wait-ws-"));
  await writeFile(path.join(workspace, "a.txt"), "alpha\n", "utf8");
  await writeFile(path.join(workspace, "b.txt"), "beta\n", "utf8");
  await writeFile(path.join(workspace, "c.txt"), "gamma\n", "utf8");
  await writeFile(path.join(workspace, "d.txt"), "delta\n", "utf8");

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
    ...(options?.handler !== undefined
      ? { handler: options.handler }
      : { scripts: options?.scripts ?? [] }),
    ...(options?.roleHandler !== undefined ? { roleHandler: options.roleHandler } : {}),
    models: TEST_MODELS,
  });

  let runtime!: Runtime;
  const rpcServer = createRpcServer({
    nocturneVersion: "0.54.0-test",
    agentPipe: false,
    remote: { home, credentials },
    createRuntime: async (init) => {
      const real = await createRuntime({
        cwd: workspace,
        config,
        providers: [provider],
        interactive: init.interactive,
      });
      runtime = options?.wrapRuntime !== undefined ? options.wrapRuntime(real) : real;
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

  const [serverEnd, clientEnd] = createMemoryTransportPair();
  const served = rpcServer.serve(serverEnd);
  const desktopClient = createRpcClient(clientEnd, {
    clientName: "Nocturne Desktop",
    interactive: true,
  });
  await desktopClient.initialize();
  await desktopClient.call("runtime.setDefaultModel", {
    model: "fake/fake-model",
    reasoningEffort: null,
  });
  const { session: initSession } = await desktopClient.runtime.createSession({
    cwd: workspace,
    model: "fake/fake-model",
  });
  await initSession.close();

  const activeCloses: (() => Promise<void>)[] = [];
  const approvedAgents = new Set<string>();

  return {
    home,
    workspace,
    provider,
    runtime,
    rpcServer,
    desktopClient,
    async connectAgent(agentId: string, name: string) {
      const mcpServer = createNocturneMcpServer({
        home,
        name,
        connectTransport: async () => {
          const [cEnd, sEnd] = createMemoryTransportPair();
          void rpcServer.serve(sEnd, {
            origin: "agent",
            agent: { id: agentId, name },
          });
          return cEnd;
        },
      });
      const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name, version: "1.0.0" });
      await mcpServer.server.connect(sTransport);
      await mcpClient.connect(cTransport);
      if (!approvedAgents.has(agentId)) {
        await mcpClient.callTool({ name: "nocturne_list_sessions", arguments: {} });
        await desktopClient.call("agent.respondPairing", {
          agentId,
          approved: true,
          scope: "run",
          maxPermissionPreset: "auto-edit",
        });
        approvedAgents.add(agentId);
      }
      const close = async () => {
        await mcpClient.close().catch(() => undefined);
        await mcpServer.close().catch(() => undefined);
      };
      activeCloses.push(close);
      return { mcpClient, close };
    },
    async close() {
      while (activeCloses.length > 0) {
        await activeCloses.pop()?.();
      }
      desktopClient.close();
      await served.catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

describe("MCP 等待返回精简、多会话等待、新建标题与子会话报错", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("多行 shell 命令压成一行、折叠多余空白，超长时截断至上限", () => {
    const multilineEntry = makeToolEntry("c-1", "t-1", "shell", {
      seq: 2,
      command:
        "\n   pnpm   --filter   @nocturne/mcp-server   test   \n" +
        "echo second line that must not appear\n" +
        "echo third line\n",
    });
    const line1 = summarizeWaitToolEntry(multilineEntry);
    expect(line1).not.toMatch(/[\r\n]/);
    expect(line1).toBe("[shell] ok — pnpm --filter @nocturne/mcp-server test…");
    expect(line1).not.toContain("second line");

    const longCommand = `node -e "${"a".repeat(260)}"`;
    const longEntry = makeToolEntry("c-2", "t-1", "shell", {
      seq: 3,
      command: longCommand,
    });
    const line2 = summarizeWaitToolEntry(longEntry);
    expect(line2).not.toMatch(/[\r\n]/);
    const prefix = "[shell] ok — ";
    expect(line2.startsWith(prefix)).toBe(true);
    const targetPart = line2.slice(prefix.length);
    expect(Array.from(targetPart).length).toBeLessThanOrEqual(MAX_WAIT_TOOL_TARGET_CHARS);
    expect(targetPart.endsWith("…")).toBe(true);
  });

  it("单次工具调用超出上限（20 条）时仅保留最近 20 条并注明省略数，下次等待累计省略", () => {
    const view = createSessionView();
    view.entries.push({
      kind: "user",
      key: "u-1",
      seq: 1,
      turnId: "t-1",
      content: [{ type: "text", text: "跑一批工具" }],
    });
    for (let i = 1; i <= 25; i++) {
      view.entries.push(
        makeToolEntry(`call-${i}`, "t-1", "read", {
          seq: i + 1,
          filePath: `src/file-${i}.ts`,
        }),
      );
    }

    const first = extractIncrementalWaitTurn(view, undefined);
    expect(first.turn?.omittedPreviousTools).toBe(0);
    expect(first.turn?.omittedExcessTools).toBe(25 - MAX_WAIT_TOOLS_PER_CALL);
    expect(first.turn?.tools).toHaveLength(MAX_WAIT_TOOLS_PER_CALL);
    expect(first.turn?.tools[0]).toBe("[read] ok — src/file-6.ts");
    expect(first.turn?.tools.at(-1)).toBe("[read] ok — src/file-25.ts");

    // 同一轮再追加 2 条工具，前 25 条（含先前超限省略的 5 条）全部计入 omittedPreviousTools
    view.entries.push(
      makeToolEntry("call-26", "t-1", "read", { seq: 27, filePath: "src/file-26.ts" }),
      makeToolEntry("call-27", "t-1", "read", { seq: 28, filePath: "src/file-27.ts" }),
    );
    const second = extractIncrementalWaitTurn(view, first.nextCursor);
    expect(second.turn?.omittedPreviousTools).toBe(25);
    expect(second.turn?.omittedExcessTools).toBeUndefined();
    expect(second.turn?.tools).toEqual([
      "[read] ok — src/file-26.ts",
      "[read] ok — src/file-27.ts",
    ]);

    // 切换到新轮次 t-2 时游标重置，从新轮次开头算
    view.entries.push(
      {
        kind: "user",
        key: "u-2",
        seq: 29,
        turnId: "t-2",
        content: [{ type: "text", text: "第二轮" }],
      },
      makeToolEntry("call-28", "t-2", "read", { seq: 30, filePath: "src/next.ts" }),
    );
    const third: {
      turn: ReturnType<typeof extractIncrementalWaitTurn>["turn"];
      nextCursor: WaitToolCursor | undefined;
    } = extractIncrementalWaitTurn(view, second.nextCursor);
    expect(third.turn?.turnId).toBe("t-2");
    expect(third.turn?.omittedPreviousTools).toBe(0);
    expect(third.turn?.tools).toEqual(["[read] ok — src/next.ts"]);
  });

  it("同一连接连续两次等待：第二次只含新工具调用并注明省略数；不同连接互不影响；断开重连从本轮开头算", async () => {
    let releasePhase2!: () => void;
    const phase2Gate = new Promise<void>((resolve) => {
      releasePhase2 = resolve;
    });
    let phase2Reached!: () => void;
    const phase2Ready = new Promise<void>((resolve) => {
      phase2Reached = resolve;
    });
    cleanups.push(() => Promise.resolve(releasePhase2()));

    let step = 0;
    const harness = await createHarness({
      handler: async () => {
        step++;
        if (step === 1) {
          return [
            { type: "tool_call", toolCallId: "tc-1", name: "read", input: { path: "a.txt" } },
            { type: "tool_call", toolCallId: "tc-2", name: "read", input: { path: "b.txt" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 2) {
          phase2Reached();
          await phase2Gate;
          return [
            { type: "tool_call", toolCallId: "tc-3", name: "read", input: { path: "c.txt" } },
            { type: "tool_call", toolCallId: "tc-4", name: "read", input: { path: "d.txt" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "全部四个文件读取完毕" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    cleanups.push(() => harness.close());

    const conn1 = await harness.connectAgent("agent-inc-1", "Agent One");
    const conn2 = await harness.connectAgent("agent-inc-2", "Agent Two");

    const startRes = await conn1.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: { cwd: harness.workspace, prompt: "读四个文件", wait: false },
    });
    const sessionId = parseToolJson(startRes).sessionId as string;

    // 等前两个工具跑完并进入第 2 次模型请求挂起
    await phase2Ready;

    // 连接 1 第一次等待（极短超时）：看到前 2 条工具，omittedPreviousTools = 0
    const wait1 = parseToolJson(
      await conn1.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 0.05 },
      }),
    );
    expect(wait1.status).toBe("running");
    const turn1 = wait1.lastTurn as { tools: string[]; omittedPreviousTools: number };
    expect(turn1.omittedPreviousTools).toBe(0);
    expect(turn1.tools).toHaveLength(2);
    expect(turn1.tools[0]).toContain("a.txt");
    expect(turn1.tools[1]).toContain("b.txt");

    // 放行阶段 2，完成剩余 2 条工具与最终回复
    releasePhase2();

    // 连接 1 第二次等待：只含后 2 条新工具，并注明省略了前 2 条，附带最终回复全文
    const wait2 = parseToolJson(
      await conn1.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 10 },
      }),
    );
    expect(wait2.status).toBe("idle");
    expect(wait2.turnOutcome).toBe("done");
    expect(wait2.reply).toBe("全部四个文件读取完毕");
    const turn2 = wait2.lastTurn as {
      tools: string[];
      omittedPreviousTools: number;
      assistantText: string;
    };
    expect(turn2.omittedPreviousTools).toBe(2);
    expect(turn2.tools).toHaveLength(2);
    expect(turn2.tools[0]).toContain("c.txt");
    expect(turn2.tools[1]).toContain("d.txt");
    expect(turn2.assistantText).toBe("全部四个文件读取完毕");

    // 连接 2 首次等待同一会话：独立游标，不受连接 1 影响，从本轮开头列出全部 4 条
    const conn2Wait = parseToolJson(
      await conn2.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 10 },
      }),
    );
    const conn2Turn = conn2Wait.lastTurn as { tools: string[]; omittedPreviousTools: number };
    expect(conn2Turn.omittedPreviousTools).toBe(0);
    expect(conn2Turn.tools).toHaveLength(4);

    // 连接 1 断开后重新建立新连接：游标重置，从本轮开头算
    await conn1.close();
    const conn1Reconnected = await harness.connectAgent("agent-inc-1", "Agent One");
    const reWait = parseToolJson(
      await conn1Reconnected.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId, timeoutSeconds: 10 },
      }),
    );
    const reTurn = reWait.lastTurn as { tools: string[]; omittedPreviousTools: number };
    expect(reTurn.omittedPreviousTools).toBe(0);
    expect(reTurn.tools).toHaveLength(4);

    // nocturne_read_session 始终返回完整工具清单，不受增量游标影响
    const readData = parseToolJson(
      await conn1Reconnected.mcpClient.callTool({
        name: "nocturne_read_session",
        arguments: { sessionId, turns: 3 },
      }),
    );
    const readTurns = readData.turns as { tools: string[] }[];
    expect(readTurns[0]?.tools).toHaveLength(4);
  });

  it("多会话等待：一个先结束立即返回并标明就绪会话；已结束会话立即返回；超时全部为 running；单 id 旧调用不变", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB1!: () => void;
    const gateB1 = new Promise<void>((resolve) => {
      releaseB1 = resolve;
    });
    let releaseB2!: () => void;
    const gateB2 = new Promise<void>((resolve) => {
      releaseB2 = resolve;
    });
    let bStep2Reached!: () => void;
    const bStep2Ready = new Promise<void>((resolve) => {
      bStep2Reached = resolve;
    });
    cleanups.push(() => {
      releaseA();
      releaseB1();
      releaseB2();
      return Promise.resolve();
    });

    let bCalls = 0;
    const harness = await createHarness({
      handler: async (req) => {
        const promptText = JSON.stringify(req.messages);
        if (promptText.includes("SESSION_A_MARKER")) {
          await gateA;
          return [
            { type: "text_delta", text: "会话 A 已完成" },
            { type: "finish", reason: "stop" },
          ];
        }
        bCalls++;
        if (bCalls === 1) {
          await gateB1;
          return [
            { type: "tool_call", toolCallId: "tc-b1", name: "read", input: { path: "a.txt" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        bStep2Reached();
        await gateB2;
        return [
          { type: "text_delta", text: "会话 B 已完成" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    cleanups.push(() => harness.close());

    const conn = await harness.connectAgent("agent-multi", "Multi Agent");

    const startA = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: { cwd: harness.workspace, prompt: "SESSION_A_MARKER 任务A", wait: false },
      }),
    );
    const startB = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: { cwd: harness.workspace, prompt: "SESSION_B_MARKER 任务B", wait: false },
      }),
    );
    const idA = startA.sessionId as string;
    const idB = startB.sessionId as string;

    // 1. 两个会话都在运行：短超时返回 timedOut: true，全部为 running 且不中断
    const timeoutRes = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionIds: [idA, idB], timeoutSeconds: 0.06 },
      }),
    );
    expect(timeoutRes.timedOut).toBe(true);
    expect(timeoutRes.readySessionIds).toEqual([]);
    const timeoutSessions = timeoutRes.sessions as {
      sessionId: string;
      ready: boolean;
      status: string;
    }[];
    expect(timeoutSessions.map((s) => [s.sessionId, s.ready, s.status])).toEqual([
      [idA, false, "running"],
      [idB, false, "running"],
    ]);

    // 放行 B 的第一步工具，等 B 跑完 tool 1 进入第二步挂起
    releaseB1();
    await bStep2Ready;

    // 2. 发起多会话等待，然后只放行 A -> A 结束立即返回，标出 readySessionIds: [idA]，且 B 包含增量工具 1
    const multiWaitPromise = conn.mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionIds: [idA, idB], timeoutSeconds: 10 },
    });
    releaseA();
    const multiRes = parseToolJson(await multiWaitPromise);
    expect(multiRes.timedOut).toBe(false);
    expect(multiRes.readySessionIds).toEqual([idA]);
    const multiSessions = multiRes.sessions as {
      sessionId: string;
      ready: boolean;
      status: string;
      reply: string;
      lastTurn: { tools: string[]; omittedPreviousTools: number };
    }[];
    expect(multiSessions[0]).toMatchObject({
      sessionId: idA,
      ready: true,
      status: "idle",
      reply: "会话 A 已完成",
    });
    expect(multiSessions[1]).toMatchObject({
      sessionId: idB,
      ready: false,
      status: "running",
    });
    expect(multiSessions[1]?.lastTurn.tools).toHaveLength(1);
    expect(multiSessions[1]?.lastTurn.tools[0]).toContain("a.txt");

    // 3. A 已经满足停止条件：再次多会话等待 [idA, idB] 立刻返回（不阻塞等待 B）
    const immediateRes = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionIds: [idA, idB], timeoutSeconds: 10 },
      }),
    );
    expect(immediateRes.timedOut).toBe(false);
    expect(immediateRes.readySessionIds).toEqual([idA]);

    // 4. 放行 B，并用单 id 的旧调用方式等待 B -> 扁平返回结构不变，且上次报告的 1 条工具已计入省略数
    releaseB2();
    const singleWaitB = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId: idB, timeoutSeconds: 10 },
      }),
    );
    expect(singleWaitB.sessionId).toBe(idB);
    expect(singleWaitB.status).toBe("idle");
    expect(singleWaitB.turnOutcome).toBe("done");
    expect(singleWaitB.reply).toBe("会话 B 已完成");
    expect(singleWaitB.sessions).toBeUndefined();
    const bTurn = singleWaitB.lastTurn as { tools: string[]; omittedPreviousTools: number };
    expect(bTurn.omittedPreviousTools).toBe(1);
    expect(bTurn.tools).toEqual([]);
  });

  it("nocturne_start_session 指定 title 后不被首条消息的自动标题覆盖，不传时照常生成自动标题", async () => {
    const harness = await createHarness({
      scripts: [
        [
          { type: "text_delta", text: "带标题会话完成" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "无标题会话完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
      roleHandler: () => [{ type: "text_delta", text: "模型自动生成的标题" }],
    });
    cleanups.push(() => harness.close());

    const conn = await harness.connectAgent("agent-title", "Title Agent");

    // 1. 显式指定 title
    const titledRes = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: {
          cwd: harness.workspace,
          prompt: "请完整阅读并执行某任务文档",
          title: "r1119t：精简 MCP 等待返回",
          wait: true,
        },
      }),
    );
    const titledId = titledRes.sessionId as string;
    expect(titledRes.title).toBe("r1119t：精简 MCP 等待返回");
    expect(titledRes.renameError).toBeUndefined();
    expect(harness.provider.roleRequests).toHaveLength(0);

    const listAfterTitled = await harness.desktopClient.runtime.listSessions();
    expect(listAfterTitled.find((s) => s.id === titledId)?.firstText).toBe(
      "r1119t：精简 MCP 等待返回",
    );

    // 2. 不传 title：照常触发自动标题
    const autoRes = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_start_session",
        arguments: {
          cwd: harness.workspace,
          prompt: "请完整阅读并执行另一任务文档",
          wait: true,
        },
      }),
    );
    const autoId = autoRes.sessionId as string;
    await vi.waitFor(async () => {
      const list = await harness.desktopClient.runtime.listSessions();
      expect(list.find((s) => s.id === autoId)?.firstText).toBe("模型自动生成的标题");
    });
  });

  it("nocturne_start_session 指定 title 但 renameSession 失败时，会话照常创建并返回 renameError", async () => {
    const harness = await createHarness({
      scripts: [
        [
          { type: "text_delta", text: "改名失败但照常运行完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
      wrapRuntime: (real) =>
        createRuntimeStub({
          createSession: real.createSession.bind(real),
          resumeSession: real.resumeSession.bind(real),
          listSessions: real.listSessions.bind(real),
          listModels: real.listModels.bind(real),
          defaultModel: real.defaultModel.bind(real),
          describeSettings: real.describeSettings.bind(real),
          setDefaultModel: real.setDefaultModel.bind(real),
          renameSession: async () => {
            throw new Error("模拟改名持久化失败");
          },
          close: real.close.bind(real),
        }),
    });
    cleanups.push(() => harness.close());

    const conn = await harness.connectAgent("agent-rename-fail", "Rename Fail Agent");
    const res = await conn.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: harness.workspace,
        prompt: "即便改名失败也要运行",
        title: "期望标题",
        wait: true,
      },
    });
    expect(res.isError).toBeFalsy();
    const data = parseToolJson(res);
    expect(typeof data.sessionId).toBe("string");
    expect(data.status).toBe("idle");
    expect(data.reply).toBe("改名失败但照常运行完成");
    expect(data.renameError).toContain("模拟改名持久化失败");
  });

  it("对子代理会话调用 nocturne_wait（锁冲突与已结束）均返回带父会话 id 的明确错误", async () => {
    const parentId = "sess-parent-001";
    const lockedChildId = "sess-child-running-002";

    const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-sub-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const platform = createPlatform();
    const { store: credentials } = await createCredentialStore(platform, home, {
      backend: "memory",
    });

    const stubRuntime = createRuntimeStub({
      resumeSession: async (id) => {
        if (id === lockedChildId) {
          throw new SessionError("session_locked", "会话被另一个进程占用");
        }
        throw new Error(`unexpected resumeSession(${id})`);
      },
      listSessions: async (filter) => {
        const base = [
          {
            id: parentId,
            createdAt: "2026-11-19T00:00:00.000Z",
            cwd: home,
            workspaceRoot: home,
            model: { provider: "fake", model: "fake-model" },
            mtimeMs: Date.now(),
          },
        ];
        if (filter?.includeSubagents) {
          return [
            ...base,
            {
              id: lockedChildId,
              createdAt: "2026-11-19T00:00:01.000Z",
              cwd: home,
              workspaceRoot: home,
              model: { provider: "fake", model: "fake-model" },
              mtimeMs: Date.now(),
              locked: true,
              parent: { sessionId: parentId, callId: "call-sub-1" },
            },
          ];
        }
        return base;
      },
      close: async () => undefined,
    });

    const rpcServer = createRpcServer({
      nocturneVersion: "0.54.0-test",
      agentPipe: false,
      remote: { home, credentials },
      createRuntime: async () => ({ runtime: stubRuntime }),
    });
    const [serverEnd, clientEnd] = createMemoryTransportPair();
    const served = rpcServer.serve(serverEnd);
    const desktopClient = createRpcClient(clientEnd, {
      clientName: "Nocturne Desktop",
      interactive: true,
    });
    cleanups.push(async () => {
      desktopClient.close();
      await served.catch(() => undefined);
    });
    await desktopClient.initialize();

    const mcpServer = createNocturneMcpServer({
      home,
      name: "Sub Check Agent",
      connectTransport: async () => {
        const [cEnd, sEnd] = createMemoryTransportPair();
        void rpcServer.serve(sEnd, {
          origin: "agent",
          agent: { id: "agent-sub-check", name: "Sub Check Agent" },
        });
        return cEnd;
      },
    });
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "Sub Check Agent", version: "1.0.0" });
    await mcpServer.server.connect(sT);
    await mcpClient.connect(cT);
    cleanups.push(async () => {
      await mcpClient.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    });
    await mcpClient.callTool({ name: "nocturne_list_sessions", arguments: {} });
    await desktopClient.call("agent.respondPairing", {
      agentId: "agent-sub-check",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    // 单会话等待子会话（模拟运行中撞锁）
    const singleErr = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionId: lockedChildId },
    });
    expect(singleErr.isError).toBe(true);
    const singleText = getToolText(singleErr);
    expect(singleText).not.toContain("另一个进程占用");
    expect(singleText).toContain("子代理会话");
    expect(singleText).toContain(lockedChildId);
    expect(singleText).toContain(parentId);

    // 多会话等待中包含子会话同样报明确带父会话 id 的错误
    const multiErr = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionIds: [lockedChildId] },
    });
    expect(multiErr.isError).toBe(true);
    expect(getToolText(multiErr)).toContain(parentId);
    expect(getToolText(multiErr)).not.toContain("另一个进程占用");
  });

  it("nocturne_wait 参数校验：同时传 sessionId 与 sessionIds、均不传或空数组返回错误", async () => {
    const mcpServer = createNocturneMcpServer({
      home: path.join(tmpdir(), "nct-mcp-param-unused"),
    });
    cleanups.push(() => mcpServer.close());

    const both = await mcpServer.bridge.callTool("nocturne_wait", {
      sessionId: "a",
      sessionIds: ["a", "b"],
    });
    expect(both.isError).toBe(true);
    expect(getToolText(both)).toContain("二选一");

    const neither = await mcpServer.bridge.callTool("nocturne_wait", {});
    expect(neither.isError).toBe(true);

    const emptyArr = await mcpServer.bridge.callTool("nocturne_wait", {
      sessionIds: [],
    });
    expect(emptyArr.isError).toBe(true);
  });
});
