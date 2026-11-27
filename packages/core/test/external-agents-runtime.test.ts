import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type ExternalAgentConfig,
  type ExternalAgentConnector,
  type McpServerConfig,
  type RuntimeSession,
  type SubmitInput,
} from "../src/index.js";
import {
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createOpenAIResponsesProvider,
  createGeminiProvider,
  type FakeScript,
  type Provider,
} from "../src/provider/index.js";
import {
  createSessionView,
  decodeDurableEvent,
  encodeDurableEvent,
  reduceSessionView,
  replaySessionView,
  type ModelProtocol,
} from "../src/protocol/index.js";

const roots: string[] = [];
const sessions: RuntimeSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  // Windows CI 上 rmdir 偶发 ENOTEMPTY，与 titles.test.ts 等同样重试
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const done = (): FakeScript => [
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "stop" },
];
const callTask = (): FakeScript => [
  {
    type: "tool_call",
    toolCallId: "delegate",
    name: "task",
    input: { agent: "offline", task: "原文" },
  },
  { type: "finish", reason: "tool_calls" },
];
const entry: Omit<ExternalAgentConfig, "name"> = {
  command: "old-command",
  args: ["old-arg"],
  env: { LITERAL: "old", REFERENCE: "${OFFLINE_ENV}" },
  configOptions: { model: "old-model" },
  description: "old-description",
  enabled: true,
};
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function setup(
  provider = new FakeProvider({ handler: () => done() }),
  builtin = false,
  mcpServers: McpServerConfig[] = [],
) {
  const root = await mkdtemp(path.join(tmpdir(), "nct-agent-runtime-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      modelsDev: false,
      skills: { sources: { agents: false, claude: false } },
      externalAgents: [{ name: "handwritten", command: "user-command", args: [], enabled: false }],
    }),
  );
  const platform = {
    ...createPlatform(),
    homeDir: () => root,
    nocturneHome: () => home,
    env: () => undefined,
  };
  const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
  const run = vi.fn<ExternalAgentConnector["run"]>(async (_config, request) => ({
    status: "ok",
    modelContent: "外部结果",
    output: {
      agent: request.agent,
      transcriptPath: request.transcriptPath,
      stopReason: "end_turn",
      permissionDecisions: { allowed: 0, denied: 0 },
    },
  }));
  const probe = vi.fn<ExternalAgentConnector["probe"]>(async () => ({
    ok: true,
    durationMs: 7,
    agentInfo: { name: "offline-agent", version: "1.0" },
    configOptions: [
      { id: "model", name: "Model", currentValue: "a", options: [{ value: "a", name: "A" }] },
    ],
  }));
  const runtime = await createRuntime({
    cwd: workspace,
    sessionsDir: path.join(home, "sessions"),
    config,
    providers: [provider],
    permissions: { autoApproveAsk: true },
    subagent: { enabled: builtin },
    externalAgents: { run, probe },
    mcpServers,
  });
  await runtime.saveExternalAgent({ mode: "create", name: "offline", config: entry });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  sessions.push(session);
  return { runtime, session, provider, run, probe, home, config };
}

describe("外部 agent：Runtime 管理与 Turn 快照", () => {
  it("管理 API 复用配置来源，启停/删除热更新 task，探测保存条目或草稿而不运行任务", async () => {
    const f = await setup();
    expect(await f.runtime.describeExternalAgents()).toMatchObject({
      agents: [
        { name: "offline", origin: "app", editable: true, enabled: true },
        { name: "handwritten", origin: "user", editable: false, enabled: false },
      ],
    });
    expect(await f.session.describeExternalAgents()).toEqual(
      await f.runtime.describeExternalAgents(),
    );
    expect(
      f.session.describeContext().request.tools.find((tool) => tool.name === "task")?.description,
    ).toContain("old-description");
    await expect(
      f.runtime.saveExternalAgent({ mode: "replace", name: "handwritten", config: entry }),
    ).rejects.toMatchObject({ field: "name" });
    await expect(
      f.runtime.saveExternalAgent({ mode: "create", name: "OFFLINE", config: entry }),
    ).rejects.toMatchObject({ field: "name" });
    await f.runtime.setExternalAgentEnabled({ name: "offline", enabled: false });
    expect(f.session.describeContext().request.tools.some((tool) => tool.name === "task")).toBe(
      false,
    );
    expect(await f.runtime.probeExternalAgent({ name: "OFFLINE" })).toMatchObject({
      ok: true,
      durationMs: 7,
    });
    expect(f.probe).toHaveBeenLastCalledWith(
      { ...entry, name: "offline", enabled: false },
      { nocturneHome: f.home },
    );
    const draft = { ...entry, name: "draft", command: "draft-command" };
    await f.runtime.probeExternalAgent({ config: draft });
    expect(f.probe).toHaveBeenLastCalledWith(draft, { nocturneHome: f.home });
    expect(f.run).not.toHaveBeenCalled();
    await expect(f.runtime.probeExternalAgent({ name: "missing" })).rejects.toMatchObject({
      field: "name",
    });
    await expect(
      f.runtime.probeExternalAgent({
        config: { ...draft, configOptions: { bad: 3 } },
      } as unknown as Parameters<typeof f.runtime.probeExternalAgent>[0]),
    ).rejects.toMatchObject({ field: "configOptions" });
    await f.runtime.setExternalAgentEnabled({ name: "offline", enabled: true });
    expect(
      f.session.describeContext().request.tools.find((tool) => tool.name === "task")?.inputSchema
        .required,
    ).toEqual(["task"]);
    await f.runtime.deleteExternalAgent({ name: "offline" });
    expect(f.session.describeContext().request.tools.some((tool) => tool.name === "task")).toBe(
      false,
    );
  });

  it("配置替换期间同一 Turn 的描述、schema 与 connector 参数冻结，下一 Turn 使用新配置", async () => {
    const entered = latch();
    const hold = latch();
    const provider = new FakeProvider({
      handler: async (_request, index) => {
        if (index === 0) {
          entered.release();
          await hold.promise;
        }
        return index % 2 === 0 ? callTask() : done();
      },
    });
    const f = await setup(provider);
    const turn = f.session.submit({ text: "first" });
    await entered.promise;
    const replacement = {
      ...entry,
      command: "new-command",
      args: ["new-arg"],
      env: { LITERAL: "new" },
      configOptions: { model: "new-model" },
      description: "new-description",
    };
    try {
      await f.runtime.saveExternalAgent({ mode: "replace", name: "offline", config: replacement });
      expect(
        f.session.describeContext().request.tools.find((tool) => tool.name === "task")?.description,
      ).toContain("old-description");
    } finally {
      hold.release();
    }
    expect(await turn).toBe("done");
    expect(f.run.mock.calls[0]?.[0]).toEqual({ ...entry, name: "offline" });
    for (const request of provider.requests.slice(0, 2)) {
      expect(request.tools.find((tool) => tool.name === "task")?.description).toContain(
        "old-description",
      );
      expect(request.tools.find((tool) => tool.name === "task")?.inputSchema).toMatchObject({
        properties: { agent: { description: expect.stringContaining("offline") } },
      });
    }
    await f.session.submit({ text: "second" });
    expect(f.run.mock.calls[1]?.[0]).toEqual({ ...replacement, name: "offline" });
    expect(provider.requests[2]?.tools.find((tool) => tool.name === "task")?.description).toContain(
      "new-description",
    );
    await f.runtime.setExternalAgentEnabled({ name: "offline", enabled: false });
    expect(f.session.describeContext().request.tools.some((tool) => tool.name === "task")).toBe(
      false,
    );
  });

  it("禁用不会中止在途 connector，结束后才移除外部 task", async () => {
    const entered = latch();
    const hold = latch();
    const provider = new FakeProvider({
      handler: (_request, index) => (index === 0 ? callTask() : done()),
    });
    const f = await setup(provider);
    const execute = f.run.getMockImplementation();
    if (execute === undefined) throw new Error("缺少离线执行器");
    f.run.mockImplementation(async (config, request, ctx) => {
      entered.release();
      await hold.promise;
      expect(ctx.signal.aborted).toBe(false);
      return execute(config, request, ctx);
    });
    const turn = f.session.submit({ text: "first" });
    await entered.promise;
    try {
      await f.runtime.setExternalAgentEnabled({ name: "offline", enabled: false });
      expect(f.session.describeContext().request.tools.some((tool) => tool.name === "task")).toBe(
        true,
      );
    } finally {
      hold.release();
    }
    expect(await turn).toBe("done");
    expect(f.run.mock.calls[0]?.[0]).toEqual({ ...entry, name: "offline" });
    expect(f.session.describeContext().request.tools.some((tool) => tool.name === "task")).toBe(
      false,
    );
  });

  it("内置 task 保留，全部外部禁用后 schema 与说明移除 agent", async () => {
    const f = await setup(undefined, true);
    await f.runtime.setExternalAgentEnabled({ name: "offline", enabled: false });
    const task = f.session.describeContext().request.tools.find((tool) => tool.name === "task");
    expect(task).toBeDefined();
    expect(task?.inputSchema.properties).not.toHaveProperty("agent");
    expect(task?.description).not.toContain("外部 agent");
  });
});

describe("外部 agent：submit.delegate 持久快照", () => {
  it("skill 互斥、空白/未知/停用 agent 在任何 Turn 事件前拒绝", async () => {
    const f = await setup();
    const invalid: unknown[] = [
      { delegate: { agent: "offline", task: "task" }, skill: { name: "skill" } },
      { delegate: { agent: "offline", task: " \n " } },
      { delegate: { agent: " ", task: "task" } },
      { delegate: { agent: "missing", task: "task" } },
      { delegate: { agent: "handwritten", task: "task" } },
      { delegate: null },
      { delegate: { agent: "offline", task: 3 } },
    ];
    for (const input of invalid) {
      await expect(f.session.submit(input as SubmitInput)).rejects.toMatchObject({
        code: "invalid_command",
      });
    }
    expect(f.session.durableEvents().some((event) => event.type === "turn.started")).toBe(false);
    expect(f.provider.requests).toHaveLength(0);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each<ModelProtocol>(["openai-compatible", "anthropic", "openai-responses", "gemini"])(
    "%s 投影保留指令和任务原文，在线/序列化/恢复回放一致",
    async (protocol) => {
      const base = new FakeProvider({}).models()[0];
      if (base === undefined) throw new Error("缺少离线模型");
      const provider = new FakeProvider({ models: [{ ...base, protocol }], handler: () => done() });
      const f = await setup(provider);
      const online = createSessionView();
      f.session.subscribe((event) => reduceSessionView(online, event));
      const task = '  第一行 "原文"\n第二行 </delegate>\\末尾  ';
      const delegate = { agent: "offline", task };
      await f.session.submit({
        text: "/OFFLINE 原始用户输入",
        delegate: { ...delegate, agent: "OFFLINE" },
      });
      const user = f.session.durableEvents().find((event) => event.type === "message.user");
      expect(user?.payload).toMatchObject({ delegate });
      if (user?.type !== "message.user") throw new Error("缺少用户事件");
      const instruction = user.payload.content.at(-1);
      expect(instruction?.type).toBe("text");
      if (instruction?.type !== "text") throw new Error("缺少委派指令");
      expect(instruction.text).toContain("task");
      expect(instruction.text).toContain(JSON.stringify(delegate.agent));
      expect(instruction.text.endsWith(task)).toBe(true);
      expect(f.run).not.toHaveBeenCalled();
      expect(provider.requests[0]?.protocol).toBe(protocol);
      const request = provider.requests[0];
      if (request === undefined) throw new Error("缺少投影请求");
      let wireBody: Record<string, unknown> | undefined;
      const streamEvents: Record<ModelProtocol, object[]> = {
        gemini: [{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }],
        "openai-compatible": [
          {
            id: "offline",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "ok" } }],
          },
          {
            id: "offline",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ],
        anthropic: [
          {
            type: "message_start",
            message: {
              id: "offline",
              type: "message",
              role: "assistant",
              model: "fake-1",
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ],
        "openai-responses": [
          {
            type: "response.completed",
            response: {
              id: "offline",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              incomplete_details: null,
            },
          },
        ],
      };
      const captureFetch: typeof fetch = async (_input, init) => {
        wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = streamEvents[protocol]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      };
      const adapterConfig = {
        id: "projection",
        baseURL: "https://api.test/v1",
        apiKeyEnv: "OFFLINE_KEY",
        models: { "fake-1": {} },
      };
      const adapters: Record<ModelProtocol, () => Provider> = {
        gemini: () => createGeminiProvider(adapterConfig, () => "offline-key", captureFetch),
        "openai-compatible": () =>
          createOpenAICompatibleProvider(adapterConfig, () => "offline-key", captureFetch),
        anthropic: () =>
          createAnthropicProvider(
            { ...adapterConfig, type: "anthropic" },
            () => "offline-key",
            captureFetch,
          ),
        "openai-responses": () =>
          createOpenAIResponsesProvider(adapterConfig, () => "offline-key", captureFetch),
      };
      for await (const _event of adapters[protocol]().stream(
        request,
        new AbortController().signal,
      )) {
        // 消费完整流，使适配器发送请求；下方断言线上请求中的委派指令。
      }
      expect(wireBody).toBeDefined();
      expect(JSON.stringify(wireBody)).toContain(JSON.stringify(instruction.text).slice(1, -1));
      expect(provider.requests[0]?.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: user.payload.content }),
      );
      expect(f.session.state().history.find((item) => item.kind === "user")).toMatchObject({
        delegate,
      });
      expect(online.entries.find((item) => item.kind === "user")).toMatchObject({ delegate });
      const events = f.session
        .durableEvents()
        .map((event) => decodeDurableEvent(encodeDurableEvent(event)));
      expect(replaySessionView(events).entries).toEqual(online.entries);
      const id = f.session.id;
      await f.session.close();
      sessions.splice(sessions.indexOf(f.session), 1);
      await f.runtime.deleteExternalAgent({ name: "offline" });
      const resumed = await f.runtime.resumeSession(id);
      sessions.push(resumed);
      expect(resumed.state().history.find((item) => item.kind === "user")).toMatchObject({
        delegate,
        content: user.payload.content,
      });
      expect(
        replaySessionView(resumed.durableEvents()).entries.find((item) => item.kind === "user"),
      ).toMatchObject({ delegate });
      expect(resumed.describeContext().request.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: user.payload.content }),
      );
    },
  );
});

describe("ADR-0127 第五阶段：task(worker=…) 续派", () => {
  /** 用指定 task input 构造一个提交 task 工具调用的 provider */
  const workerTaskProvider = (input: Record<string, unknown>): FakeProvider =>
    new FakeProvider({
      handler: (_req, callIndex) => {
        if (callIndex === 0) {
          return [
            {
              type: "tool_call",
              toolCallId: "x",
              name: "task",
              input,
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        // 工具结算后轮次直接 done，不再触发新的 task 调用
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
  /** 在 NOCTURNE_HOME 写一份 loadSessionCapable 的 worker 记录 */
  const writeWorker = async (
    home: string,
    workerId: string,
    overrides: { agentName?: string; cwd?: string; loadSessionCapable?: boolean } = {},
  ): Promise<string> => {
    const workerDir = path.join(home, "external-workers");
    await mkdir(workerDir, { recursive: true });
    const workerCwd = overrides.cwd ?? path.join(home, "worker-tree");
    await mkdir(workerCwd, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      path.join(workerDir, `${workerId}.json`),
      JSON.stringify({
        formatVersion: 1,
        workerId,
        agentName: overrides.agentName ?? "offline",
        externalSessionId: "ext-session-1",
        cwd: workerCwd,
        providerSnapshot: { command: "x", args: [], envKeys: [] },
        loadSessionCapable: overrides.loadSessionCapable ?? true,
        createdAt: now,
        lastUsedAt: now,
      }),
    );
    return workerCwd;
  };

  it("worker 与 agent/profile/preset/tools/outputSchema/model/effort/background 互斥", async () => {
    const f = await setup(
      workerTaskProvider({ worker: "ew-0000000000000000", agent: "offline", task: "x" }),
      true,
    );
    await f.session.submit({ text: "go" });
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("worker id 形状非法：schema 校验拒绝（invalid_input）", async () => {
    const f = await setup(workerTaskProvider({ worker: "not-a-worker-id", task: "x" }), true);
    await f.session.submit({ text: "go" });
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("worker 不存在：worker_not_found 错误（connector 不被调用——Core 装配层提前拦截）", async () => {
    const f = await setup(workerTaskProvider({ worker: "ew-0000000000000000", task: "x" }), true);
    await f.session.submit({ text: "go" });
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "worker_not_found" },
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("worker 续派：按 worker 记录解析 agent 名，cwd 沿 worker 原工作树，workerId 传给 connector", async () => {
    const workerId = "ew-abcd1234abcd1234";
    const f = await setup(workerTaskProvider({ worker: workerId, task: "请继续修改" }), true);
    const workerCwd = await writeWorker(f.home, workerId);
    await f.session.submit({ text: "go" });
    expect(f.run).toHaveBeenCalledTimes(1);
    const callArgs = f.run.mock.calls[0];
    expect(callArgs?.[0].name).toBe("offline");
    expect(callArgs?.[1]).toMatchObject({
      agent: "offline",
      workerId,
      cwd: workerCwd,
      task: "请继续修改",
    });
  });

  it("worker 记录的 agent 已停用：按未启用拒绝", async () => {
    const workerId = "ew-abcd1234abcd1234";
    const f = await setup(workerTaskProvider({ worker: workerId, task: "x" }), true);
    await writeWorker(f.home, workerId);
    await f.runtime.setExternalAgentEnabled({ name: "offline", enabled: false });
    await f.session.submit({ text: "go" });
    expect(f.run).not.toHaveBeenCalled();
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
  });

  it("mcpServers 仅外部派工可用：内置档位给出时报 invalid_input", async () => {
    // 不给 agent/worker 时按内置 default 档位处理——mcpServers 无意义，invalid_input
    const f = await setup(workerTaskProvider({ task: "x", mcpServers: ["team-tool"] }), true);
    await f.session.submit({ text: "go" });
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("按任务注入：明文 env 物化进 sessionMcpServers 随请求发给 connector", async () => {
    const teamServer = {
      name: "team-tool",
      origin: "project" as const,
      type: "stdio" as const,
      command: "team-cmd",
      args: ["serve"],
      env: { TEAM_MARK: "plaintext-value" },
    };
    const f = await setup(
      workerTaskProvider({ agent: "offline", task: "x", mcpServers: ["team-tool"] }),
      true,
      [teamServer],
    );
    await f.session.submit({ text: "go" });
    expect(f.run).toHaveBeenCalledTimes(1);
    const requestArg = f.run.mock.calls[0]?.[1];
    expect(requestArg?.sessionMcpServers).toHaveLength(1);
    const injected = requestArg?.sessionMcpServers?.[0];
    expect(injected?.name).toBe("team-tool");
    expect(injected?.env).toEqual({ TEAM_MARK: "plaintext-value" });
  });

  it("注入名字未知：invalid_input 并列出可用服务器，不调用 connector", async () => {
    const teamServer = {
      name: "team-tool",
      origin: "project" as const,
      type: "stdio" as const,
      command: "team-cmd",
    };
    const f = await setup(
      workerTaskProvider({ agent: "offline", task: "x", mcpServers: ["no-such"] }),
      true,
      [teamServer],
    );
    await f.session.submit({ text: "go" });
    expect(f.run).not.toHaveBeenCalled();
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(JSON.stringify(toolCompleted?.payload)).toContain("team-tool");
  });

  it("stored 凭据缺失：拒绝整个注入（不注入残缺工具）", async () => {
    const teamServer = {
      name: "team-tool",
      origin: "project" as const,
      type: "stdio" as const,
      command: "team-cmd",
      env: { TEAM_TOKEN: { stored: true } as const },
    };
    const f = await setup(
      workerTaskProvider({ agent: "offline", task: "x", mcpServers: ["team-tool"] }),
      true,
      [teamServer],
    );
    await f.session.submit({ text: "go" });
    expect(f.run).not.toHaveBeenCalled();
    const events = f.session.durableEvents();
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(JSON.stringify(toolCompleted?.payload)).toContain("缺少凭据");
  });

  it("worker 续派携带 mcpServers：每次任务独立绑定，未列出的服务器不注入", async () => {
    const workerId = "ew-abcd1234abcd1234";
    const teamA = {
      name: "team-a",
      origin: "project" as const,
      type: "stdio" as const,
      command: "cmd-a",
    };
    const teamB = {
      name: "team-b",
      origin: "project" as const,
      type: "stdio" as const,
      command: "cmd-b",
    };
    const f = await setup(
      workerTaskProvider({ worker: workerId, task: "继续", mcpServers: ["team-a"] }),
      true,
      [teamA, teamB],
    );
    await writeWorker(f.home, workerId);
    await f.session.submit({ text: "go" });
    expect(f.run).toHaveBeenCalledTimes(1);
    const requestArg = f.run.mock.calls[0]?.[1];
    // 只物化 team-a——team-b 虽在会话池中但本任务未列出，不进入外部进程
    expect(requestArg?.sessionMcpServers?.map((server) => server.name)).toEqual(["team-a"]);
  });
});
