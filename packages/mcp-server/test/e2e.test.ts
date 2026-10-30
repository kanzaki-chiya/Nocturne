import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type ModelInfo,
} from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { PAIRING_PENDING_MESSAGE } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliDist = path.join(repoRoot, "apps/cli/dist/main.js");

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

beforeAll(() => {
  execSync(
    "pnpm --filter @nocturne/core --filter @nocturne/remote --filter @nocturne/rpc --filter @nocturne/mcp-server --filter @nocturne/cli build",
    {
      cwd: repoRoot,
      stdio: "pipe",
    },
  );
}, 120_000);

describe("nctrn mcp 端到端测试 (真实子进程 + 本机管道)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("启动带 --agent-pipe 的后台与真实 nctrn mcp 进程，通过 MCP SDK 客户端完成：配对 → 新建会话 → 等待 → 读取", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-e2e-home-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "nct-mcp-e2e-ws-"));
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    });

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
      models: TEST_MODELS,
      scripts: [
        [
          { type: "text_delta", text: "端到端会话执行成功！" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const rpcServer = createRpcServer({
      nocturneVersion: "0.23.0-e2e",
      agentPipe: true,
      remote: {
        home,
        credentials,
      },
      createRuntime: async (init) => {
        const runtime = await createRuntime({
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
    cleanups.push(async () => {
      desktopClient.close();
      await served.catch(() => undefined);
    });

    await desktopClient.initialize();
    await desktopClient.call("runtime.setDefaultModel", {
      model: "fake/fake-model",
      reasoningEffort: null,
    });
    const { session: seedSession } = await desktopClient.runtime.createSession({
      cwd: workspace,
      model: "fake/fake-model",
    });
    await seedSession.close();

    // 监听桌面端收到的配对请求
    let latestPairRequest: { requestId: string; agentId: string; name: string } | undefined;
    const pairingReceived = new Promise<{ requestId: string; agentId: string; name: string }>(
      (resolve) => {
        desktopClient.onNotification("agent.pairingRequested", (req) => {
          latestPairRequest = req;
          resolve(req);
        });
      },
    );

    // 启动真实的 `nctrn mcp` 进程，通过 MCP SDK StdioClientTransport 连接
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliDist, "mcp", "--name", "e2e-claude"],
      env: {
        ...process.env,
        NOCTURNE_HOME: home,
      } as Record<string, string>,
      stderr: "pipe",
    });
    const mcpClient = new Client({ name: "Claude Code E2E", version: "1.0.0" });
    await mcpClient.connect(transport);
    cleanups.push(async () => {
      await mcpClient.close().catch(() => undefined);
    });

    // 1. 配对前调用工具返回等待确认文案，且桌面端收到 agent.pairingRequested
    const preCall = await mcpClient.callTool({
      name: "nocturne_status",
      arguments: {},
    });
    expect(preCall.isError).toBe(true);
    expect((preCall.content as { text: string }[])[0]?.text).toBe(PAIRING_PENDING_MESSAGE);

    const pairReq = latestPairRequest ?? (await pairingReceived);
    expect(pairReq.name).toBe("e2e-claude");

    // 桌面端批准配对（可运行 + default 上限）
    await desktopClient.call("agent.respondPairing", {
      requestId: pairReq.requestId,
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    // 2. 新建会话 (wait: false)
    const startRes = await mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: workspace,
        prompt: "请完成端到端测试任务",
        wait: false,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const started = JSON.parse((startRes.content as { text: string }[])[0]?.text ?? "{}") as {
      sessionId: string;
    };
    expect(typeof started.sessionId).toBe("string");

    // 3. 调用 nocturne_wait 等待完成
    const waitRes = await mcpClient.callTool({
      name: "nocturne_wait",
      arguments: {
        sessionId: started.sessionId,
        timeoutSeconds: 15,
      },
    });
    expect(waitRes.isError).toBeFalsy();
    const waited = JSON.parse((waitRes.content as { text: string }[])[0]?.text ?? "{}") as {
      status: string;
    };
    expect(waited.status).toBe("idle");

    // 4. 调用 nocturne_read_session 读取折叠结果
    const readRes = await mcpClient.callTool({
      name: "nocturne_read_session",
      arguments: {
        sessionId: started.sessionId,
        lastTurns: 5,
      },
    });
    expect(readRes.isError).toBeFalsy();
    const readData = JSON.parse((readRes.content as { text: string }[])[0]?.text ?? "{}") as {
      sessionId: string;
      status: string;
      turns: { userText: string; assistantText: string }[];
    };
    expect(readData.sessionId).toBe(started.sessionId);
    expect(readData.status).toBe("idle");
    expect(readData.turns).toHaveLength(1);
    expect(readData.turns[0]?.userText).toBe("请完成端到端测试任务");
    expect(readData.turns[0]?.assistantText).toBe("端到端会话执行成功！");

    // 5. 验证桌面端列出的会话带有 client 来源标记
    const allSessions = await desktopClient.runtime.listSessions();
    const createdSummary = allSessions.find((s) => s.id === started.sessionId);
    expect(createdSummary?.client).toEqual({
      kind: "agent",
      name: "e2e-claude",
      deviceId: pairReq.agentId,
      id: pairReq.agentId,
    });
  }, 60_000);
});
