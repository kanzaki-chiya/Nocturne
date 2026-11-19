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
  type FakeHandler,
  type FakeScript,
  type ModelInfo,
  type PermissionPresetName,
  type Runtime,
  type RuntimeEvent,
  type RuntimeSession,
} from "@nocturne/core";
import { createRuntimeStub } from "@nocturne/core/testing";
import {
  createMemoryTransportPair,
  createRpcClient,
  trackSessionView,
  type RpcClient,
} from "@nocturne/rpc/client";
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

describe("MCP 外部 agent 处理审批（nocturne_respond_permission）", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn().catch(() => undefined);
    }
  });

  it("较低上限下等待提示只写可拒绝或请用户在 Nocturne 处理，allow 被拒、deny 成功；升为 bypass 后提示含批准且 allow 成功、持久授权仍被拒", async () => {
    const harness = await createRespondHarness({
      scripts: [
        // Turn 1: write -> 触发审批（在 default 上限下 allow 被拒，deny 成功继续完成）
        [
          {
            type: "tool_call",
            toolCallId: "tc-p-1",
            name: "write",
            input: { path: "blocked.txt", content: "nope" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "写入已被拒绝，已取消操作" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 2: write -> 触发审批（升为 bypass 后 project/always 被拒，allow 成功完成）
        [
          {
            type: "tool_call",
            toolCallId: "tc-p-2",
            name: "write",
            input: { path: "approved.txt", content: "yes" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "文件 approved.txt 已写入" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(() => harness.close());

    const agent = await harness.connectAgent("agent-mcp-perm", "Perm MCP Agent", {
      scope: "run",
      maxPermissionPreset: "default",
    });

    // Turn 1：在 default 上限下启动会话并触发 write 审批
    const startRes = await agent.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: harness.workspace,
        prompt: "请写入 blocked.txt",
        permissionPreset: "default",
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(startRes.isError).toBeFalsy();
    const wait1 = parseToolJson(startRes);
    expect(wait1.status).toBe("waiting_for_permission");
    const msg1 = String(wait1.message);
    expect(msg1).toContain("nocturne_respond_permission");
    expect(msg1).toContain("deny");
    expect(msg1).toContain("cannot approve");
    const perms1 = wait1.pendingPermissions as { requestId: string; toolName: string }[];
    expect(perms1).toHaveLength(1);
    const sessionId = String(wait1.sessionId);
    const req1 = perms1[0]?.requestId ?? "";

    // 较低上限下 allow 与 allow+session 被服务端拒绝
    const lowAllow = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req1,
        reply: { decision: "allow" },
        wait: false,
      },
    });
    expect(lowAllow.isError).toBe(true);
    expect(getToolText(lowAllow)).toContain("bypass");

    const lowAllowSession = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req1,
        reply: { decision: "allow", remember: "session" },
        wait: false,
      },
    });
    expect(lowAllowSession.isError).toBe(true);
    expect(getToolText(lowAllowSession)).toContain("bypass");

    // 较低上限下 deny 成功并继续完成
    const denyRes = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req1,
        reply: { decision: "deny", feedback: "不要创建 blocked.txt" },
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(denyRes.isError).toBeFalsy();
    const denyData = parseToolJson(denyRes);
    expect(denyData.status).toBe("idle");
    expect(denyData.turnOutcome).toBe("done");
    expect(denyData.reply).toBe("写入已被拒绝，已取消操作");

    // 升级 agent 上限为 bypass（经 agent.selfChanged 实时同步到桥）
    await harness.desktopClient.call("agent.setScope", {
      id: "agent-mcp-perm",
      scope: "run",
      maxPermissionPreset: "bypass",
    });

    // Turn 2：再发一次 write（该会话自身预设仍为 default，会再次弹出审批）
    const send2 = await agent.mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "请写入 approved.txt",
        wait: true,
        timeoutSeconds: 15,
      },
    });
    const wait2 = parseToolJson(send2);
    expect(wait2.status).toBe("waiting_for_permission");
    const msg2 = String(wait2.message);
    expect(msg2).toContain("nocturne_respond_permission");
    expect(msg2).toContain("allow");
    expect(msg2).not.toContain("cannot approve");
    const req2 = (wait2.pendingPermissions as { requestId: string }[])[0]?.requestId ?? "";

    // 即使在 bypass 上限下，持久授权变体 project / always 也一律被服务端拒绝
    const projRes = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req2,
        reply: { decision: "allow", remember: "project" },
        wait: false,
      },
    });
    expect(projRes.isError).toBe(true);
    expect(getToolText(projRes)).toContain("持久授权");

    const alwaysRes = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req2,
        reply: { decision: "allow", remember: "always" },
        wait: false,
      },
    });
    expect(alwaysRes.isError).toBe(true);
    expect(getToolText(alwaysRes)).toContain("持久授权");

    // 非持久 allow（本次允许）在 bypass 上限下成功完成
    const allowRes = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req2,
        reply: { decision: "allow" },
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(allowRes.isError).toBeFalsy();
    const allowData = parseToolJson(allowRes);
    expect(allowData.status).toBe("idle");
    expect(allowData.turnOutcome).toBe("done");
    expect(allowData.reply).toBe("文件 approved.txt 已写入");
  });

  it("桌面端与 MCP agent 同时面对同一审批：一方先回复生效后，另一方界面状态随事件更新且再回复报错", async () => {
    const harness = await createRespondHarness({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "tc-sync-1",
            name: "write",
            input: { path: "sync-1.txt", content: "v1" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "桌面批准完成" },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "tc-sync-2",
            name: "write",
            input: { path: "sync-2.txt", content: "v2" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "agent 批准完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(() => harness.close());

    const agent = await harness.connectAgent("agent-mcp-sync", "Sync Agent", {
      scope: "run",
      maxPermissionPreset: "bypass",
    });

    // Turn 1: 停在审批上，桌面端先批准
    const start1 = await agent.mcpClient.callTool({
      name: "nocturne_start_session",
      arguments: {
        cwd: harness.workspace,
        prompt: "写 sync-1.txt",
        permissionPreset: "default",
        wait: true,
        timeoutSeconds: 15,
      },
    });
    const d1 = parseToolJson(start1);
    const sessionId = String(d1.sessionId);
    const req1 = (d1.pendingPermissions as { requestId: string }[])[0]?.requestId ?? "";

    const { session: desktopSess } = await harness.desktopClient.runtime.resumeSession(sessionId);
    const desktopTracker = await trackSessionView(desktopSess);
    cleanups.push(() => desktopTracker.stop().catch(() => undefined));

    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission?.requestId).toBe(req1);
    });
    // 桌面端先回复 -> MCP agent 再回复得到已处理错误，之后 wait 返回 idle
    await desktopSess.respondPermission(req1, { decision: "allow" });
    const lateAgent = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req1,
        reply: { decision: "deny" },
        wait: false,
      },
    });
    expect(lateAgent.isError).toBe(true);

    const wait1Done = await agent.mcpClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionId, timeoutSeconds: 15 },
    });
    expect(parseToolJson(wait1Done).status).toBe("idle");
    expect(parseToolJson(wait1Done).reply).toBe("桌面批准完成");

    // Turn 2: 停在审批上，MCP agent 先批准 -> 桌面端视图清除 pendingPermission 且桌面端再回复报 unknown_request
    const send2 = await agent.mcpClient.callTool({
      name: "nocturne_send",
      arguments: {
        sessionId,
        prompt: "写 sync-2.txt",
        wait: true,
        timeoutSeconds: 15,
      },
    });
    const d2 = parseToolJson(send2);
    const req2 = (d2.pendingPermissions as { requestId: string }[])[0]?.requestId ?? "";
    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission?.requestId).toBe(req2);
    });

    const agentOk = await agent.mcpClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId,
        requestId: req2,
        reply: { decision: "allow" },
        wait: true,
        timeoutSeconds: 15,
      },
    });
    expect(agentOk.isError).toBeFalsy();
    expect(parseToolJson(agentOk).reply).toBe("agent 批准完成");

    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission).toBeUndefined();
      expect(desktopTracker.view.status).toBe("idle");
    });
    await expect(desktopSess.respondPermission(req2, { decision: "deny" })).rejects.toMatchObject({
      code: "unknown_request",
    });
  });

  it("使用 createRuntimeStub：nocturne_respond_permission 传 childSessionId 走 session.respondSubagentPermission 且等待返回携带 childSessionId；只读档位被拒", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nct-mcp-subperm-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const platform = createPlatform();
    const { store: credentials } = await createCredentialStore(platform, home, {
      backend: "memory",
    });

    const listeners = new Set<(event: RuntimeEvent) => void>();
    const emit = (event: RuntimeEvent) => {
      for (const fn of [...listeners]) fn(event);
    };
    const subPermSpy = vi.fn(async () => {
      // 模拟审批结算后广播空转发池 + turn 结束
      emit({
        type: "subagent.permissions",
        sessionId: "sess-parent-own",
        ts: new Date().toISOString(),
        payload: { pending: [] },
      } as unknown as RuntimeEvent);
      emit({
        type: "turn.completed",
        sessionId: "sess-parent-own",
        seq: 3,
        ts: new Date().toISOString(),
        turnId: "t1",
        payload: { reason: "done" },
      } as unknown as RuntimeEvent);
      emit({
        type: "runtime.status",
        sessionId: "sess-parent-own",
        ts: new Date().toISOString(),
        payload: { status: "idle" },
      } as unknown as RuntimeEvent);
    });

    let pendingInputsCalls = 0;
    const stubParentSession = {
      id: "sess-parent-own",
      durableEvents: () => [
        {
          type: "session.created",
          sessionId: "sess-parent-own",
          seq: 1,
          ts: "2026-11-20T00:00:00.000Z",
          payload: {
            cwd: home,
            workspaceRoot: home,
            formatVersion: 1,
            nocturneVersion: "0.54.0-test",
            model: { provider: "fake", model: "fake-model" },
            permissionPreset: "default",
            client: {
              kind: "agent",
              name: "SubPerm MCP Agent",
              deviceId: "agent-sub-mcp",
              id: "agent-sub-mcp",
            },
          },
        },
        {
          type: "turn.started",
          sessionId: "sess-parent-own",
          seq: 2,
          ts: "2026-11-20T00:00:01.000Z",
          turnId: "t1",
          payload: {},
        },
      ],
      subscribe: (listener: (event: RuntimeEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isIdle: () => false,
      onIdle: () => () => undefined,
      warnings: [],
      pendingInputs: () => {
        pendingInputsCalls++;
        return { items: [], paused: false };
      },
      interrupt: () => undefined,
      respondSubagentPermission: subPermSpy,
      close: async () => undefined,
      state: () => ({
        meta: {
          id: "sess-parent-own",
          cwd: home,
          workspaceRoot: home,
          createdAt: "2026-11-20T00:00:00.000Z",
          formatVersion: 1,
          nocturneVersion: "0.54.0-test",
          client: {
            kind: "agent",
            name: "SubPerm MCP Agent",
            deviceId: "agent-sub-mcp",
            id: "agent-sub-mcp",
          },
        },
        config: {
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
        },
        history: [],
        todos: [],
        notes: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        lastSeq: 2,
        openTurn: { turnId: "t1", startedAt: "2026-11-20T00:00:01.000Z" },
        unsettledCalls: new Map(),
      }),
    } as unknown as RuntimeSession;

    const stubRuntime = createRuntimeStub({
      resumeSession: async () => stubParentSession,
      listSessions: async () => [
        {
          id: "sess-parent-own",
          createdAt: "2026-11-20T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          model: { provider: "fake", model: "fake-model" },
          mtimeMs: Date.now(),
          client: {
            kind: "agent",
            name: "SubPerm MCP Agent",
            deviceId: "agent-sub-mcp",
            id: "agent-sub-mcp",
          },
        },
      ],
      close: async () => undefined,
    });

    const server = createRpcServer({
      nocturneVersion: "0.54.0-test",
      agentPipe: false,
      remote: { home, credentials },
      createRuntime: async () => ({ runtime: stubRuntime }),
    });
    const [desktopCT, desktopST] = createMemoryTransportPair();
    const served = server.serve(desktopST, { origin: "local" });
    const desktopClient = createRpcClient(desktopCT, {
      clientName: "Nocturne Desktop",
      interactive: true,
    });
    cleanups.push(async () => {
      desktopClient.close();
      await served.catch(() => undefined);
    });
    await desktopClient.initialize();

    const connectMcp = async (agentId: string, scope: "run" | "read-only") => {
      const mcpServer = createNocturneMcpServer({
        home,
        name: agentId,
        connectTransport: async () => {
          const [cT, sT] = createMemoryTransportPair();
          void server.serve(sT, { origin: "agent", agent: { id: agentId, name: agentId } });
          return cT;
        },
      });
      const [cT, sT] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: agentId, version: "1.0.0" });
      await mcpServer.server.connect(sT);
      await mcpClient.connect(cT);
      cleanups.push(async () => {
        await mcpClient.close().catch(() => undefined);
        await mcpServer.close().catch(() => undefined);
      });
      await mcpClient.callTool({ name: "nocturne_list_sessions", arguments: {} });
      await desktopClient.call("agent.respondPairing", {
        agentId,
        approved: true,
        scope,
        maxPermissionPreset: "bypass",
      });
      return mcpClient;
    };

    const runClient = await connectMcp("agent-sub-mcp", "run");
    const roClient = await connectMcp("agent-sub-ro", "read-only");

    // 启动等待，待桥完成 session.subscribe 并拉取 pendingInputs 后推送子代理转发权限事件
    const waitPromise = runClient.callTool({
      name: "nocturne_wait",
      arguments: { sessionId: "sess-parent-own", timeoutSeconds: 10 },
    });
    await vi.waitFor(() => {
      expect(pendingInputsCalls).toBeGreaterThanOrEqual(2);
    });
    emit({
      type: "subagent.permissions",
      sessionId: "sess-parent-own",
      ts: new Date().toISOString(),
      payload: {
        pending: [
          {
            childSessionId: "sess-child-42",
            parentCallId: "task-1",
            profile: "deep",
            taskSummary: "写入子代理结果",
            afterSeq: 2,
            order: 1,
            requestId: "sub-req-1",
            callId: "c-write-1",
            toolName: "write",
            subjects: [{ kind: "write", target: "sub.txt" }],
            reason: "需要确认写入",
            options: ["allow_once", "allow_session", "deny", "deny_stop"],
          },
        ],
      },
    } as unknown as RuntimeEvent);

    const waitRes = await waitPromise;
    expect(waitRes.isError).toBeFalsy();
    const waitData = parseToolJson(waitRes);
    expect(waitData.status).toBe("waiting_for_permission");
    expect(waitData.pendingPermissions).toEqual([
      {
        requestId: "sub-req-1",
        childSessionId: "sess-child-42",
        toolName: "write",
        reason: "需要确认写入",
        subjects: [{ kind: "write", target: "sub.txt" }],
      },
    ]);

    // 只读档位调用 nocturne_respond_permission 被拒
    const roRes = await roClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId: "sess-parent-own",
        childSessionId: "sess-child-42",
        requestId: "sub-req-1",
        reply: { decision: "deny" },
      },
    });
    expect(roRes.isError).toBe(true);
    expect(getToolText(roRes)).toContain("无权调用");
    expect(subPermSpy).not.toHaveBeenCalled();

    // 所属 agent 传 childSessionId 批准子代理审批 -> 走 session.respondSubagentPermission 并收束
    const respRes = await runClient.callTool({
      name: "nocturne_respond_permission",
      arguments: {
        sessionId: "sess-parent-own",
        childSessionId: "sess-child-42",
        requestId: "sub-req-1",
        reply: { decision: "allow", remember: "session" },
        wait: true,
        timeoutSeconds: 10,
      },
    });
    expect(respRes.isError).toBeFalsy();
    expect(subPermSpy).toHaveBeenCalledWith("sess-child-42", "sub-req-1", {
      decision: "allow",
      remember: "session",
    });
    expect(parseToolJson(respRes).status).toBe("idle");
  });
});
