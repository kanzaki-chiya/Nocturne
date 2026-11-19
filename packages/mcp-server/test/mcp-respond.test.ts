import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  type PermissionPresetName,
  type Runtime,
} from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import { createMemoryTransportPair, createRpcClient, type RpcClient } from "@nocturne/rpc/client";
import { createRpcServer, type RpcServer } from "@nocturne/rpc/server";
import { createNocturneMcpServer } from "../src/index.js";

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

interface RespondHarness {
  home: string;
  workspace: string;
  desktopClient: RpcClient;
  server: RpcServer;
  runtime: Runtime;
  connectAgent: (
    agentId: string,
    name: string,
    opts?: { scope?: "run" | "read-only"; maxPermissionPreset?: PermissionPresetName },
  ) => Promise<{ mcpClient: Client; close: () => Promise<void> }>;
  close: () => Promise<void>;
}

async function createRespondHarness(options: {
  scripts?: FakeScript[];
  handler?: FakeHandler;
  wrapRuntime?: (real: Runtime) => Runtime;
}): Promise<RespondHarness> {
  const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-respond-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "nct-mcp-respond-ws-"));
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
    ...(options.handler !== undefined
      ? { handler: options.handler }
      : { scripts: options.scripts ?? [] }),
    models: TEST_MODELS,
  });

  let runtime!: Runtime;
  const server = createRpcServer({
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
      runtime = options.wrapRuntime !== undefined ? options.wrapRuntime(real) : real;
      return {
        runtime,
        sessionsDir: config.sessionsDir,
        providerConfig: {
          config,
          reload: () => Promise.resolve(config),
          credentials,
        },
      };
    },
  });

  const [desktopClientT, desktopServerT] = createMemoryTransportPair();
  const served = server.serve(desktopServerT, { origin: "local" });
  const desktopClient = createRpcClient(desktopClientT, {
    clientName: "Nocturne Desktop",
    interactive: true,
  });
  await desktopClient.initialize();
  // 先建一个桌面会话，确保 workspace 成为已有会话使用过的工作区
  const initDesktop = await desktopClient.runtime.createSession({
    cwd: workspace,
    model: "fake/fake-model",
  });
  await initDesktop.session.close();

  const agentClosers: (() => Promise<void>)[] = [];
  const connectAgent: RespondHarness["connectAgent"] = async (agentId, name, opts) => {
    const scope = opts?.scope ?? "run";
    const maxPermissionPreset = opts?.maxPermissionPreset ?? "default";
    const mcpServer = createNocturneMcpServer({
      home,
      name,
      connectTransport: async () => {
        const [agentClientT, agentServerT] = createMemoryTransportPair();
        void server.serve(agentServerT, {
          origin: "agent",
          agent: { id: agentId, name },
        });
        return agentClientT;
      },
    });
    const [mcpClientT, mcpServerT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name, version: "1.0.0" });
    await mcpServer.server.connect(mcpServerT);
    await mcpClient.connect(mcpClientT);

    // 触发配对并由桌面端批准
    await mcpClient.callTool({ name: "nocturne_list_sessions", arguments: {} });
    await desktopClient.call("agent.respondPairing", {
      agentId,
      approved: true,
      scope,
      maxPermissionPreset,
    });

    const close = async () => {
      await mcpClient.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    };
    agentClosers.push(close);
    return { mcpClient, close };
  };

  return {
    home,
    workspace,
    desktopClient,
    server,
    runtime,
    connectAgent,
    close: async () => {
      for (const fn of agentClosers.splice(0)) {
        await fn();
      }
      desktopClient.close();
      await served.catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

describe("MCP 外部 agent 回答提问（nocturne_answer）", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn().catch(() => undefined);
    }
  });

  it("nocturne_answer 回答自己创建会话的提问并继续完成，waiting_for_answer 提示说明可调用工具并保留 pendingQuestion", async () => {
    const harness = await createRespondHarness({
      scripts: [
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
          {
            type: "tool_call",
            toolCallId: "tc-ask-1",
            name: "ask_user",
            input: {
              questions: [
                {
                  question: "目标环境？",
                  options: [{ label: "staging" }, { label: "prod" }],
                },
                {
                  question: "是否附带说明？",
                },
              ],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "收到答案 staging，任务已完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(() => harness.close());

    const agent = await harness.connectAgent("agent-ans-owner", "Reviewer Agent");
    const startRes = await agent.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: harness.workspace,
        prompt: "先读文件再向我确认环境",
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const waitData = parseToolJson(startRes);
    expect(waitData.status).toBe("waiting_for_answer");
    expect(String(waitData.message)).toContain("nocturne_answer");
    const pendingQ = waitData.pendingQuestion as {
      requestId: string;
      questions: { question: string }[];
    };
    expect(pendingQ.requestId).toBeTruthy();
    expect(pendingQ.questions).toHaveLength(2);
    const sessionId = String(waitData.sessionId);

    // 调用 nocturne_answer 作答（第一题选 staging 附文字，第二题放弃作答），wait: true 等待完成
    const ansRes = await agent.mcpClient.callTool({
      name: "nocturne_answer",
      arguments: {
        sessionId,
        requestId: pendingQ.requestId,
        answers: [{ selected: ["staging"], text: "先发灰度" }, { declined: true }],
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(ansRes.isError).toBeFalsy();
    const ansData = parseToolJson(ansRes);
    expect(ansData.status).toBe("idle");
    expect(ansData.turnOutcome).toBe("done");
    expect(ansData.reply).toBe("收到答案 staging，任务已完成");
    // 沿用 r1119t 增量摘要：前一次 wait 已汇报的 read 不重复出现，记录在 omittedPreviousTools
    const lastTurn = ansData.lastTurn as {
      omittedPreviousTools: number;
      tools: string[];
    };
    expect(lastTurn.omittedPreviousTools).toBeGreaterThanOrEqual(1);

    // 过期 requestId 再次作答报错
    const staleRes = await agent.mcpClient.callTool({
      name: "nocturne_answer",
      arguments: {
        sessionId,
        requestId: pendingQ.requestId,
        answers: [{ selected: ["staging"] }, { declined: true }],
        wait: false,
      },
    });
    expect(staleRes.isError).toBe(true);
    expect(getToolText(staleRes)).toBeTruthy();
  });

  it("nocturne_answer 对用户会话、其他 agent 会话或只读档位均返回拒绝错误", async () => {
    const harness = await createRespondHarness({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "tc-ask-b",
            name: "ask_user",
            input: {
              questions: [{ question: "请确认方案？", options: [{ label: "A" }, { label: "B" }] }],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "方案 A 已完成" },
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
          close: real.close.bind(real),
        }),
    });
    cleanups.push(() => harness.close());

    // 用户会话
    const { opened: userOpened, session: userSess } =
      await harness.desktopClient.runtime.createSession({
        cwd: harness.workspace,
        model: "fake/fake-model",
      });
    cleanups.push(() => userSess.close().catch(() => undefined));

    const agentA = await harness.connectAgent("agent-a-ans", "Agent A", { scope: "run" });
    const agentB = await harness.connectAgent("agent-b-ans", "Agent B", { scope: "run" });
    const agentRo = await harness.connectAgent("agent-ro-ans", "Agent RO", { scope: "read-only" });

    // Agent B 创建会话并停在提问上
    const bStart = await agentB.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: harness.workspace,
        prompt: "问我选 A 还是 B",
        wait: true,
        timeoutSeconds: 15,
      },
    });
    const bData = parseToolJson(bStart);
    expect(bData.status).toBe("waiting_for_answer");
    const bSessionId = String(bData.sessionId);
    const bReqId = (bData.pendingQuestion as { requestId: string }).requestId;

    // 1. Agent A 尝试回答 Agent B 的会话 -> 报错
    const crossRes = await agentA.mcpClient.callTool({
      name: "nocturne_answer",
      arguments: {
        sessionId: bSessionId,
        requestId: bReqId,
        answers: [{ selected: ["A"] }],
      },
    });
    expect(crossRes.isError).toBe(true);
    expect(getToolText(crossRes)).toContain("自己创建的会话");

    // 2. Agent A 尝试回答用户会话 -> 报错
    const userRes = await agentA.mcpClient.callTool({
      name: "nocturne_answer",
      arguments: {
        sessionId: userOpened.sessionId,
        requestId: "q-nonexistent",
        answers: [{ selected: ["A"] }],
      },
    });
    expect(userRes.isError).toBe(true);
    expect(getToolText(userRes)).toContain("自己创建的会话");

    // 3. 只读档位尝试调用 nocturne_answer -> 报错
    const roRes = await agentRo.mcpClient.callTool({
      name: "nocturne_answer",
      arguments: {
        sessionId: bSessionId,
        requestId: bReqId,
        answers: [{ selected: ["A"] }],
      },
    });
    expect(roRes.isError).toBe(true);
    expect(getToolText(roRes)).toContain("无权调用");

    // 4. 最终由会话创建者 Agent B 正常作答并完成
    const okRes = await agentB.mcpClient.callTool({
      name: "nocturne_answer",
      arguments: {
        sessionId: bSessionId,
        requestId: bReqId,
        answers: [{ selected: ["A"] }],
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(okRes.isError).toBeFalsy();
    expect(parseToolJson(okRes).status).toBe("idle");
    expect(parseToolJson(okRes).reply).toBe("方案 A 已完成");
  });
});
