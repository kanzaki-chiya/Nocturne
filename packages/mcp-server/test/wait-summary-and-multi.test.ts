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
  formatReadSessionOutput,
  MAX_WAIT_PROCESS_TEXT_CHARS,
  MAX_WAIT_TOOL_TARGET_CHARS,
  MAX_WAIT_TOOLS_PER_CALL,
  MAX_WAIT_USER_TEXT_CHARS,
  NOCTURNE_MCP_TOOLS,
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
    };
    expect(turn2.omittedPreviousTools).toBe(2);
    expect(turn2.tools).toHaveLength(2);
    expect(turn2.tools[0]).toContain("c.txt");
    expect(turn2.tools[1]).toContain("d.txt");
    expect("assistantText" in turn2).toBe(false);

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

  it("wait: false 的 nocturne_start_session 与 nocturne_send 只返回排队状态，不含 lastTurn / reply / 工具列表", async () => {
    let releaseTurn1!: () => void;
    const turn1Gate = new Promise<void>((resolve) => {
      releaseTurn1 = resolve;
    });
    let turn1Started!: () => void;
    const turn1Ready = new Promise<void>((resolve) => {
      turn1Started = resolve;
    });
    cleanups.push(() => {
      releaseTurn1();
      return Promise.resolve();
    });

    let reqCount = 0;
    const harness = await createHarness({
      handler: async () => {
        reqCount++;
        if (reqCount === 1) {
          turn1Started();
          await turn1Gate;
          return [
            { type: "text_delta", text: "第一轮长回复" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          { type: "text_delta", text: "第二轮回复" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    cleanups.push(() => harness.close());

    const conn = await harness.connectAgent("agent-wait-false", "Wait False Agent");

    const startRes = await conn.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: harness.workspace,
        title: "精简排队测试",
        prompt: "第一轮任务",
        wait: false,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const startData = parseToolJson(startRes);
    expect(typeof startData.sessionId).toBe("string");
    expect(startData.title).toBe("精简排队测试");
    expect(startData.status).toBe("running");
    expect(startData.queuedInputs).toBe(0);
    expect(typeof startData.message).toBe("string");
    expect(Object.keys(startData).sort()).toEqual([
      "message",
      "queuedInputs",
      "sessionId",
      "status",
      "title",
    ]);
    expect("lastTurn" in startData).toBe(false);
    expect("reply" in startData).toBe(false);
    expect("tools" in startData).toBe(false);

    await turn1Ready;

    const sendRes = await conn.mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId: startData.sessionId as string,
        prompt: "第二轮排队任务",
        wait: false,
      },
    });
    expect(sendRes.isError).toBeFalsy();
    const sendData = parseToolJson(sendRes);
    expect(sendData.sessionId).toBe(startData.sessionId);
    expect(sendData.title).toBe("精简排队测试");
    expect(sendData.status).toBe("running");
    expect(sendData.queuedInputs).toBe(1);
    expect(typeof sendData.message).toBe("string");
    expect(Object.keys(sendData).sort()).toEqual([
      "message",
      "queuedInputs",
      "sessionId",
      "status",
      "title",
    ]);
    expect("lastTurn" in sendData).toBe(false);
    expect("reply" in sendData).toBe(false);
    expect("tools" in sendData).toBe(false);

    releaseTurn1();
    const waitRes = parseToolJson(
      await conn.mcpClient.callTool({
        name: "nocturne_wait",
        arguments: { sessionId: startData.sessionId as string, timeoutSeconds: 10 },
      }),
    );
    expect(waitRes.status).toBe("idle");
    expect(waitRes.reply).toBe("第二轮回复");
  });

  it("extractIncrementalWaitTurn：首条 userText 截断至 300 字符、额外用户输入只计 extraInputs、回复去重且保留最后一段完整回复", () => {
    const view = createSessionView();
    const longPrompt = `首条用户消息：${"甲".repeat(360)}`;
    const shellLog1 = `<shell-result id="bg-1" status="exited" exit="0">\n${"pnpm install log line\n".repeat(40)}</shell-result>`;
    const shellLog2 = `<shell-result id="bg-2" status="exited" exit="0">\n${"cargo build log line\n".repeat(40)}</shell-result>`;
    const longProcess = `过程说明：${"乙".repeat(420)}`;
    const longFinalReply = `最终完整回复：${"丙".repeat(520)}`;

    view.entries.push(
      {
        kind: "user",
        key: "u-1",
        seq: 1,
        turnId: "t-1",
        content: [{ type: "text", text: longPrompt }],
      },
      {
        kind: "assistant",
        key: "a-1",
        seq: 2,
        turnId: "t-1",
        messageId: "m-1",
        time: "2026-11-23T00:00:00.000Z",
        text: longProcess,
        reasoning: "",
        toolCalls: [],
        model: { provider: "fake", model: "fake-model" },
        usage: undefined,
        finishReason: "tool_calls",
      },
      makeToolEntry("c-1", "t-1", "shell", { seq: 3, command: "pnpm install" }),
      {
        kind: "user",
        key: "u-2",
        seq: 4,
        turnId: "t-1",
        content: [{ type: "text", text: shellLog1 }],
        steer: true,
      },
      makeToolEntry("c-2", "t-1", "read", { seq: 5, filePath: "package.json" }),
      {
        kind: "user",
        key: "u-3",
        seq: 6,
        turnId: "t-1",
        content: [{ type: "text", text: shellLog2 }],
        steer: true,
      },
      {
        kind: "assistant",
        key: "a-2",
        seq: 7,
        turnId: "t-1",
        messageId: "m-2",
        time: "2026-11-23T00:00:05.000Z",
        text: longFinalReply,
        reasoning: "",
        toolCalls: [],
        model: { provider: "fake", model: "fake-model" },
        usage: undefined,
        finishReason: "stop",
      },
    );

    const { turn, reply } = extractIncrementalWaitTurn(view, undefined);
    expect(turn).toBeDefined();
    if (!turn) throw new Error("expected turn to be defined");
    expect(Array.from(turn.userText).length).toBe(MAX_WAIT_USER_TEXT_CHARS);
    expect(turn.userText.startsWith("首条用户消息：")).toBe(true);
    expect(turn.userText.endsWith("…")).toBe(true);
    expect(turn.userText).not.toContain("<shell-result");
    expect(turn.extraInputs).toBe(2);
    expect(turn.tools).toEqual(["[shell] ok — pnpm install", "[read] ok — package.json"]);
    expect("assistantText" in turn).toBe(false);

    const [processPart, finalPart] = reply.split("\n\n");
    expect(Array.from(processPart ?? "").length).toBe(MAX_WAIT_PROCESS_TEXT_CHARS);
    expect(processPart?.endsWith("…")).toBe(true);
    expect(finalPart).toBe(longFinalReply);

    // nocturne_read_session（formatReadSessionOutput）不受影响，仍保留完整用户条目与 assistantText
    const readJson = JSON.parse(formatReadSessionOutput(view, { sessionId: "s-1" })) as {
      turns: { userText: string; assistantText: string }[];
    };
    expect(readJson.turns[0]?.userText).toContain("<shell-result");
    expect(readJson.turns[0]?.assistantText).toContain(longFinalReply);
  });

  it("单会话与多会话 nocturne_wait：含两条 <shell-result>、工具与助手回复的轮次仅保留截断首条 userText、extraInputs=2 且回复只出现一次", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-compact-wait-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const platform = createPlatform();
    const { store: credentials } = await createCredentialStore(platform, home, {
      backend: "memory",
    });

    const longPrompt = `主任务描述：${"A".repeat(340)}`;
    const uniqueReply = "FINAL_UNIQUE_REPLY_MARKER_R1123J：构建与单测全部通过。";
    const shellOut1 = `<shell-result id="bg-1" status="exited" exit="0">\n${"pnpm-install-output-line\n".repeat(30)}</shell-result>`;
    const shellOut2 = `<shell-result id="bg-2" status="exited" exit="0">\n${"cargo-compile-output-line\n".repeat(30)}</shell-result>`;

    const makeStubSession = (sessionId: string, withShellResults: boolean) => {
      const events = [
        {
          type: "session.created",
          sessionId,
          seq: 1,
          ts: "2026-11-23T00:00:00.000Z",
          payload: {
            cwd: home,
            workspaceRoot: home,
            formatVersion: 1,
            nocturneVersion: "0.62.0-test",
            model: { provider: "fake", model: "fake-model" },
            permissionPreset: "bypass",
          },
        },
        {
          type: "turn.started",
          sessionId,
          seq: 2,
          ts: "2026-11-23T00:00:01.000Z",
          turnId: "t-1",
          payload: {},
        },
        {
          type: "message.user",
          sessionId,
          seq: 3,
          ts: "2026-11-23T00:00:01.000Z",
          turnId: "t-1",
          payload: {
            messageId: "u-1",
            content: [{ type: "text", text: withShellResults ? longPrompt : "简短任务 B" }],
          },
        },
        {
          type: "tool.started",
          sessionId,
          seq: 4,
          ts: "2026-11-23T00:00:02.000Z",
          turnId: "t-1",
          payload: {
            callId: "c-1",
            name: "shell",
            input: { command: "pnpm install" },
            subjects: [{ kind: "shell", target: "pnpm install" }],
          },
        },
        {
          type: "tool.completed",
          sessionId,
          seq: 5,
          ts: "2026-11-23T00:00:03.000Z",
          turnId: "t-1",
          payload: {
            callId: "c-1",
            name: "shell",
            status: "ok",
            modelContent: "started",
            truncated: false,
            durationMs: 12,
          },
        },
        ...(withShellResults
          ? [
              {
                type: "message.user",
                sessionId,
                seq: 6,
                ts: "2026-11-23T00:00:04.000Z",
                turnId: "t-1",
                payload: {
                  messageId: "u-2",
                  content: [{ type: "text", text: shellOut1 }],
                  steer: true,
                },
              },
              {
                type: "tool.started",
                sessionId,
                seq: 7,
                ts: "2026-11-23T00:00:05.000Z",
                turnId: "t-1",
                payload: {
                  callId: "c-2",
                  name: "read",
                  input: { path: "Cargo.toml" },
                  subjects: [{ kind: "read", target: "Cargo.toml" }],
                },
              },
              {
                type: "tool.completed",
                sessionId,
                seq: 8,
                ts: "2026-11-23T00:00:06.000Z",
                turnId: "t-1",
                payload: {
                  callId: "c-2",
                  name: "read",
                  status: "ok",
                  modelContent: "[package]",
                  truncated: false,
                  durationMs: 5,
                },
              },
              {
                type: "message.user",
                sessionId,
                seq: 9,
                ts: "2026-11-23T00:00:07.000Z",
                turnId: "t-1",
                payload: {
                  messageId: "u-3",
                  content: [{ type: "text", text: shellOut2 }],
                  steer: true,
                },
              },
            ]
          : []),
        {
          type: "message.assistant",
          sessionId,
          seq: withShellResults ? 10 : 6,
          ts: "2026-11-23T00:00:08.000Z",
          turnId: "t-1",
          payload: {
            messageId: "a-1",
            content: [
              {
                type: "text",
                text: withShellResults ? uniqueReply : "SESSION_B_UNIQUE_REPLY：完成。",
              },
            ],
            toolCalls: [],
            model: { provider: "fake", model: "fake-model" },
            finishReason: "stop",
          },
        },
        {
          type: "turn.completed",
          sessionId,
          seq: withShellResults ? 11 : 7,
          ts: "2026-11-23T00:00:09.000Z",
          turnId: "t-1",
          payload: { reason: "done" },
        },
      ];
      return {
        id: sessionId,
        durableEvents: () => events,
        subscribe: () => () => undefined,
        isIdle: () => true,
        onIdle: () => () => undefined,
        warnings: [],
        pendingInputs: () => ({ items: [], paused: false }),
        interrupt: () => undefined,
        close: async () => undefined,
        state: () => ({
          meta: {
            id: sessionId,
            cwd: home,
            workspaceRoot: home,
            createdAt: "2026-11-23T00:00:00.000Z",
            formatVersion: 1,
            nocturneVersion: "0.62.0-test",
          },
          config: {
            model: { provider: "fake", model: "fake-model" },
            permissionPreset: "bypass",
          },
          history: [],
          todos: [],
          notes: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          lastSeq: withShellResults ? 11 : 7,
          openTurn: undefined,
          unsettledCalls: new Map(),
        }),
      };
    };

    const sessA = makeStubSession("sess-compact-a", true);
    const sessB = makeStubSession("sess-compact-b", false);
    const stubRuntime = createRuntimeStub({
      resumeSession: async (id) => {
        if (id === sessA.id) return sessA as never;
        if (id === sessB.id) return sessB as never;
        throw new Error(`unknown session ${id}`);
      },
      listSessions: async () => [
        {
          id: sessA.id,
          createdAt: "2026-11-23T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          model: { provider: "fake", model: "fake-model" },
          mtimeMs: Date.now(),
        },
        {
          id: sessB.id,
          createdAt: "2026-11-23T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          model: { provider: "fake", model: "fake-model" },
          mtimeMs: Date.now(),
        },
      ],
      close: async () => undefined,
    });

    const rpcServer = createRpcServer({
      nocturneVersion: "0.62.0-test",
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
      name: "Compact Wait Agent",
      connectTransport: async () => {
        const [cEnd, sEnd] = createMemoryTransportPair();
        void rpcServer.serve(sEnd, {
          origin: "agent",
          agent: { id: "agent-compact-wait", name: "Compact Wait Agent" },
        });
        return cEnd;
      },
    });
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "Compact Wait Agent", version: "1.0.0" });
    await mcpServer.server.connect(sT);
    await mcpClient.connect(cT);
    cleanups.push(async () => {
      await mcpClient.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    });
    await mcpClient.callTool({ name: "nocturne_list_sessions", arguments: {} });
    await desktopClient.call("agent.respondPairing", {
      agentId: "agent-compact-wait",
      approved: true,
      scope: "run",
      maxPermissionPreset: "bypass",
    });

    // 1. 单会话 nocturne_wait
    const singleRes = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionId: sessA.id, timeoutSeconds: 5 },
    });
    expect(singleRes.isError).toBeFalsy();
    const singleRaw = getToolText(singleRes);
    const singleData = parseToolJson(singleRes);
    const singleTurn = singleData.lastTurn as {
      userText: string;
      extraInputs?: number;
      tools: string[];
    };
    expect(Array.from(singleTurn.userText).length).toBe(MAX_WAIT_USER_TEXT_CHARS);
    expect(singleTurn.userText.startsWith("主任务描述：")).toBe(true);
    expect(singleTurn.userText.endsWith("…")).toBe(true);
    expect(singleRaw).not.toContain("<shell-result");
    expect(singleRaw).not.toContain("pnpm-install-output-line");
    expect(singleRaw).not.toContain("cargo-compile-output-line");
    expect(singleTurn.extraInputs).toBe(2);
    expect(singleTurn.tools).toEqual(["[shell] ok — pnpm install", "[read] ok — Cargo.toml"]);
    expect(singleData.reply).toBe(uniqueReply);
    expect("assistantText" in singleTurn).toBe(false);
    expect(singleRaw.split(uniqueReply).length - 1).toBe(1);

    // 2. 多会话 nocturne_wait 同样适用
    const multiRes = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionIds: [sessA.id, sessB.id], timeoutSeconds: 5 },
    });
    expect(multiRes.isError).toBeFalsy();
    const multiRaw = getToolText(multiRes);
    const multiData = parseToolJson(multiRes);
    const multiSessions = multiData.sessions as {
      sessionId: string;
      reply: string;
      lastTurn: { userText: string; extraInputs?: number };
    }[];
    expect(multiSessions).toHaveLength(2);
    const [multiA, multiB] = multiSessions;
    if (!multiA || !multiB) throw new Error("expected two sessions in multi wait result");
    expect(multiRaw).not.toContain("<shell-result");
    expect(multiRaw.split(uniqueReply).length - 1).toBe(1);
    expect(multiRaw.split("SESSION_B_UNIQUE_REPLY：完成。").length - 1).toBe(1);
    expect(Array.from(multiA.lastTurn.userText).length).toBe(MAX_WAIT_USER_TEXT_CHARS);
    expect(multiA.lastTurn.extraInputs).toBe(2);
    expect("assistantText" in multiA.lastTurn).toBe(false);
    expect(multiB.lastTurn.userText).toBe("简短任务 B");
    expect(multiB.lastTurn.extraInputs).toBeUndefined();
    expect("assistantText" in multiB.lastTurn).toBe(false);

    // 3. nocturne_read_session 仍返回原文
    const readRes = await mcpClient.callTool({
      name: "nocturne_read_session",
      arguments: { sessionId: sessA.id, turns: 3 },
    });
    const readRaw = getToolText(readRes);
    expect(readRaw).toContain("<shell-result");
    expect(readRaw).toContain("pnpm-install-output-line");
    expect(readRaw).toContain("cargo-compile-output-line");
  });

  it("工具 description 写明 wait: false 仅返回排队状态且查看过程/原文调用 nocturne_read_session", () => {
    const byName = new Map(NOCTURNE_MCP_TOOLS.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("nocturne_start_session")).toContain("wait: false");
    expect(byName.get("nocturne_start_session")).toContain("nocturne_read_session");
    expect(byName.get("nocturne_send")).toContain("wait: false");
    expect(byName.get("nocturne_send")).toContain("nocturne_read_session");
    expect(byName.get("nocturne_wait")).toContain("nocturne_read_session");
  });
});
