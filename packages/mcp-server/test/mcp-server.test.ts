import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type FakeScript,
  type ModelInfo,
  type Runtime,
} from "@nocturne/core";
import { createSessionView } from "@nocturne/core/protocol";
import { createMemoryTransportPair, createRpcClient, type RpcClient } from "@nocturne/rpc/client";
import { createRpcServer, type RpcServer } from "@nocturne/rpc/server";
import {
  createNocturneMcpServer,
  DESKTOP_NOT_RUNNING_MESSAGE,
  formatReadSessionOutput,
  loadOrCreateBridgeIdentity,
  MAX_MCP_OUTPUT_BYTES,
  NOCTURNE_MCP_TOOLS,
  PAIRING_PENDING_MESSAGE,
  truncateMcpOutput,
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

interface TestBackend {
  home: string;
  workspace: string;
  provider: FakeProvider;
  runtime: Runtime;
  rpcServer: RpcServer;
  desktopClient: RpcClient;
  close(): Promise<void>;
}

async function createTestBackend(options?: {
  scripts?: FakeScript[];
  agentPipe?: boolean;
}): Promise<TestBackend> {
  const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "nct-mcp-ws-"));
  await writeFile(path.join(workspace, "hello.txt"), "hello world\n", "utf8");
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
    scripts: options?.scripts ?? [],
    models: TEST_MODELS,
  });
  let runtime!: Runtime;
  const rpcServer = createRpcServer({
    nocturneVersion: "0.23.0-test",
    agentPipe: options?.agentPipe ?? true,
    remote: {
      home,
      credentials,
    },
    createRuntime: async (init) => {
      runtime = await createRuntime({
        cwd: workspace,
        config,
        providers: [provider],
        interactive: init.interactive,
      });
      return {
        runtime,
        sessionsDir: config.sessionsDir,
        providerConfig: {
          config,
          reload: () =>
            loadConfig(platform, {
              nocturneHome: home,
              env: () => undefined,
              credentials,
              modelsDevFetch: () => Promise.reject(new Error("offline")),
              upstreamFetch: () => Promise.resolve([]),
            }),
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

  return {
    home,
    workspace,
    provider,
    runtime,
    rpcServer,
    desktopClient,
    async close() {
      desktopClient.close();
      await served.catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function parseToolJson(result: Record<string, unknown>): Record<string, unknown> {
  const arr = result.content as { type: string; text: string }[];
  return JSON.parse(arr[0]?.text ?? "{}") as Record<string, unknown>;
}

function getToolText(result: Record<string, unknown>): string {
  const arr = result.content as { type: string; text: string }[];
  return arr[0]?.text ?? "";
}

describe("packages/mcp-server 单元与集成测试", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("桌面端未运行时：MCP initialize 和 tools/list 正常返回，每次工具调用返回 isError 提示文案", async () => {
    const emptyHome = await mkdtemp(path.join(tmpdir(), "nct-mcp-norun-"));
    cleanups.push(() => rm(emptyHome, { recursive: true, force: true }));

    const mcpServer = createNocturneMcpServer({
      home: emptyHome,
      pipePath:
        process.platform === "win32"
          ? `\\\\.\\pipe\\nocturne-nonexistent-${Date.now()}`
          : path.join(emptyHome, "nonexistent.sock"),
    });
    cleanups.push(() => mcpServer.close());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "Claude Code", version: "1.0.0" });
    await mcpServer.server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    cleanups.push(() => mcpClient.close());

    const toolsRes = await mcpClient.listTools();
    expect(toolsRes.tools.map((t) => t.name)).toEqual(NOCTURNE_MCP_TOOLS.map((t) => t.name));

    const callRes = await mcpClient.callTool({
      name: "nocturne_list_sessions",
      arguments: {},
    });
    expect(callRes.isError).toBe(true);
    expect(getToolText(callRes)).toBe(DESKTOP_NOT_RUNNING_MESSAGE);
  });

  it("桥身份文件持久化：默认保存 identity.json，指定 --name 保存独立槽 <label>.json", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-id-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));

    const id1 = await loadOrCreateBridgeIdentity({ home });
    const id2 = await loadOrCreateBridgeIdentity({ home });
    expect(id1.filePath).toBe(path.join(home, "mcp-bridge", "identity.json"));
    expect(id1.identity.id).toBe(id2.identity.id);
    expect(id1.fingerprint).toBe(id2.fingerprint);

    const named = await loadOrCreateBridgeIdentity({ home, name: "claude-code" });
    expect(named.filePath).toBe(path.join(home, "mcp-bridge", "claude-code.json"));
    expect(named.identity.id).not.toBe(id1.identity.id);

    if (process.platform !== "win32") {
      const st = await stat(id1.filePath);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it("工具全流程：等待配对 → start_session (wait) → send 忙时排队不打断 → wait (完成/超时/权限/提问/progressToken) → read_session 折叠 → 子代理拒绝 → 连接关闭释放引用", async () => {
    const backend = await createTestBackend({
      scripts: [
        // Turn 1: 调用 read 工具并输出回复
        [
          {
            type: "tool_call",
            toolCallId: "tc-read-1",
            name: "read",
            input: { path: "hello.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "第一轮读取完毕" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 2: 调用 write 工具触发权限确认，批准后完成
        [
          {
            type: "tool_call",
            toolCallId: "tc-write-1",
            name: "write",
            input: { path: "out.txt", content: "new content" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "第二轮写入完成" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 3: 排队的第三轮消息
        [
          { type: "text_delta", text: "第三轮排队回复完成" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 4: 调用 ask_user 触发提问，回答后完成
        [
          {
            type: "tool_call",
            toolCallId: "tc-ask-1",
            name: "ask_user",
            input: {
              questions: [{ question: "请选择部署环境？" }],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "收到回答后完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(() => backend.close());

    const mcpServer = createNocturneMcpServer({
      home: backend.home,
      name: "claude-code",
    });
    cleanups.push(() => mcpServer.close());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "Claude Code", version: "1.0.0" });
    await mcpServer.server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    cleanups.push(() => mcpClient.close());

    // 1. 尚未批准配对时调用工具，返回等待确认提示
    const pendingRes = await mcpClient.callTool({
      name: "nocturne_status",
      arguments: {},
    });
    expect(pendingRes.isError).toBe(true);
    expect(getToolText(pendingRes)).toBe(PAIRING_PENDING_MESSAGE);

    // 桌面端批准为可运行（上限 default）
    const idInfo = await mcpServer.bridge.getIdentity();
    await backend.desktopClient.call("agent.respondPairing", {
      agentId: idInfo.identity.id,
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    // 收集 progressToken 进度通知
    const progressNotifications: unknown[] = [];
    mcpClient.setNotificationHandler(ProgressNotificationSchema, (n) => {
      progressNotifications.push(n.params);
    });

    // 2. 启动会话 (wait: true) 并带 progressToken，等待第一轮完成
    const startRes = await mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: backend.workspace,
        prompt: "请读取 hello.txt",
        wait: true,
      },
      _meta: { progressToken: "tok-start" },
    });
    if (startRes.isError) throw new Error(`startRes failed: ${getToolText(startRes)}`);
    const startedData = parseToolJson(startRes);
    const sessionId = startedData.sessionId as string;
    expect(startedData.status).toBe("idle");
    expect(progressNotifications.length).toBeGreaterThan(0);

    // 3. 桌面端同时打开该会话（使其具有交互式审批端）
    const { session: desktopSess } = await backend.desktopClient.runtime.resumeSession(sessionId);

    // 4. 测试停在权限确认上时立即返回 waiting_for_permission，且在会话忙时 send 排队不打断
    const permRes = await mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "请写入 out.txt",
        wait: true,
        timeoutSeconds: 10,
      },
    });
    const permData = parseToolJson(permRes);
    expect(permData.status).toBe("waiting_for_permission");
    const pendingPerms = permData.pendingPermissions as { requestId: string }[];
    expect(pendingPerms).toHaveLength(1);

    // 此时第二轮正停在权限请求上（会话忙），调用 nocturne_send (wait: false) 排入队列，绝不打断第二轮
    const queuedSendRes = await mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "排队的第三轮消息",
        wait: false,
      },
    });
    expect(queuedSendRes.isError).toBeFalsy();
    const queuedSendData = parseToolJson(queuedSendRes);
    expect(queuedSendData.queuedInputs).toBe(1);
    // 验证第二轮的权限请求仍在挂起，未被中断
    expect(queuedSendData.status).toBe("waiting_for_permission");

    // 桌面端批准权限请求 -> 第二轮完成并自动接着跑完排队的第三轮
    await desktopSess.respondPermission(pendingPerms[0]?.requestId ?? "", {
      decision: "allow",
    });
    const waitAfterPerm = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionId, timeoutSeconds: 10 },
    });
    expect(parseToolJson(waitAfterPerm).status).toBe("idle");

    // 5. 测试 nocturne_read_session 折叠结果（包含用户消息、最终回复与单行工具摘要，不展开 hello world 全文）
    const readRes = await mcpClient.callTool({
      name: "nocturne_read_session",
      arguments: { sessionId, lastTurns: 5 },
    });
    const readText = getToolText(readRes);
    const readData = JSON.parse(readText) as {
      turns: { userText: string; tools: string[]; assistantText: string }[];
    };
    expect(readData.turns.length).toBeGreaterThanOrEqual(3);
    expect(readData.turns[0]?.userText).toBe("请读取 hello.txt");
    expect(readData.turns[0]?.tools).toHaveLength(1);
    expect(readData.turns[0]?.tools[0]).toContain("[read] ok");
    expect(readData.turns[0]?.assistantText).toBe("第一轮读取完毕");
    expect(readData.turns[1]?.userText).toBe("请写入 out.txt");
    expect(readData.turns[1]?.assistantText).toBe("第二轮写入完成");
    expect(readData.turns[2]?.userText).toBe("排队的第三轮消息");
    expect(readData.turns[2]?.assistantText).toBe("第三轮排队回复完成");

    // 6. 测试停在 ask_user 提问上时立即返回 waiting_for_answer
    const askRes = await mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "请问我一个问题",
        wait: true,
        timeoutSeconds: 10,
      },
    });
    const askData = parseToolJson(askRes);
    expect(askData.status).toBe("waiting_for_answer");
    const pendingQ = askData.pendingQuestion as { requestId: string };
    expect(pendingQ.requestId).toBeDefined();

    await desktopSess.respondQuestion(pendingQ.requestId, {
      answers: [{ selected: [], text: "staging" }],
    });
    const afterAskWait = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionId, timeoutSeconds: 10 },
    });
    expect(parseToolJson(afterAskWait).status).toBe("idle");

    // 7. 测试子代理会话被拒
    const subSession = await backend.runtime.createSession({
      cwd: backend.workspace,
      model: "fake/fake-model",
      parent: { sessionId, callId: "sub-call-1" },
    });
    const subId = subSession.id;
    await subSession.close();

    const subReadRes = await mcpClient.callTool({
      name: "nocturne_read_session",
      arguments: { sessionId: subId },
    });
    expect(subReadRes.isError).toBe(true);
    expect(getToolText(subReadRes)).toContain("子代理会话");

    // 8. 测试连接关闭后释放桥打开的会话引用，不影响桌面端已打开的同一会话
    await mcpServer.close();
    const snap = await desktopSess.state();
    expect(snap.meta.id).toBe(sessionId);
  });

  it("wait 超时时返回 running 状态，不中断正在运行的会话", async () => {
    const backend = await createTestBackend({
      scripts: [
        [
          { type: "text_delta", text: "慢响应最终完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(() => backend.close());

    // 让 provider 的流挂起 350ms，而 wait timeoutSeconds 设为 0.06s
    const origStream = backend.provider.stream.bind(backend.provider);
    backend.provider.stream = async function* (req, signal) {
      await new Promise((r) => setTimeout(r, 350));
      yield* origStream(req, signal);
    };

    const mcpServer = createNocturneMcpServer({ home: backend.home });
    cleanups.push(() => mcpServer.close());

    const pairingPromise = new Promise<{ requestId: string }>((resolve) => {
      backend.desktopClient.onNotification("agent.pairingRequested", (req) => {
        resolve(req);
      });
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "Codex", version: "1.0.0" });
    await mcpServer.server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    cleanups.push(() => mcpClient.close());

    const pairReq = await pairingPromise;
    await backend.desktopClient.call("agent.respondPairing", {
      requestId: pairReq.requestId,
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    // start_session 设极短超时 0.06s -> 超时返回 running，不中断会话
    const startRes = await mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: backend.workspace,
        prompt: "慢任务",
        wait: true,
        timeoutSeconds: 0.06,
      },
    });
    const startData = parseToolJson(startRes);
    const sessionId = startData.sessionId as string;
    expect(startData.status).toBe("running");

    // 继续调用 nocturne_wait 等到完成 -> 状态变为 idle，且回复完整
    const waitRes = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: {
        sessionId,
        timeoutSeconds: 5,
      },
    });
    const waitData = parseToolJson(waitRes);
    expect(waitData.status).toBe("idle");
    expect((waitData.lastTurn as { assistantText: string }).assistantText).toBe("慢响应最终完成");
  });

  it("超过 64 KB 时截断并附加说明", () => {
    const huge = "あ".repeat(30_000);
    const truncated = truncateMcpOutput(huge, MAX_MCP_OUTPUT_BYTES);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(MAX_MCP_OUTPUT_BYTES);
    expect(truncated).toContain("64 KB");

    const fakeView = createSessionView();
    fakeView.entries.push(
      {
        kind: "user",
        key: "u-1",
        seq: 1,
        turnId: "t-1",
        content: [{ type: "text", text: "第一轮" }],
      },
      {
        kind: "assistant",
        key: "a-1",
        turnId: "t-1",
        messageId: "m-1",
        seq: 2,
        time: new Date().toISOString(),
        text: "A".repeat(40_000),
        reasoning: "",
        toolCalls: [],
        model: { provider: "fake", model: "m" },
        usage: undefined,
        finishReason: "stop",
      },
      {
        kind: "user",
        key: "u-2",
        seq: 3,
        turnId: "t-2",
        content: [{ type: "text", text: "第二轮" }],
      },
      {
        kind: "assistant",
        key: "a-2",
        turnId: "t-2",
        messageId: "m-2",
        seq: 4,
        time: new Date().toISOString(),
        text: "B".repeat(40_000),
        reasoning: "",
        toolCalls: [],
        model: { provider: "fake", model: "m" },
        usage: undefined,
        finishReason: "stop",
      },
    );
    const formatted = formatReadSessionOutput(fakeView, { sessionId: "s-huge", lastTurns: 5 });
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(MAX_MCP_OUTPUT_BYTES);
    expect(formatted).toContain("64 KB");
  });
});
