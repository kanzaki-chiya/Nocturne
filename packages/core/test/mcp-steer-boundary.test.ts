/**
 * ADR-0086：用户插话写入后、下一次请求前复用主 Turn 的 MCP 边界。
 * 时钟是替身里的可注入毫秒计数，不真实 sleep。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntime,
  estimateMcpToolsTokens,
  FakeProvider,
  MCP_TOOL_SEARCH_AUTO_THRESHOLD,
  type FakeScript,
  type McpConnector,
  type McpServerStatus,
  type McpToolSearchMode,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimeSession,
  type ToolDefinition,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const COOLDOWN_MS = 30_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function toolOf(description: string): ToolDefinition {
  return {
    name: "mcp__browseros__echo",
    description,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
    permissionSubjects: () => [{ kind: "mcp", target: "browseros/echo" }],
    execute: async () => ({ status: "ok", modelContent: "ok" }),
  };
}

const ask = (id: string): FakeScript => [
  {
    type: "tool_call",
    toolCallId: id,
    name: "ask_user",
    input: { questions: [{ question: "继续？" }] },
  },
  { type: "finish", reason: "tool_calls" },
];

const textDone: FakeScript = [
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "stop" },
];

interface Harness {
  provider: FakeProvider;
  session: RuntimeSession;
  events: RuntimeEvent[];
  prepareCalls: () => number;
  /** 替身时钟。prepareTurn 只在 serverUp 且 clock >= retryAt 时把工具暂存为 ready。 */
  clock: { now: number };
  serverUp: { value: boolean };
  /** 第二次及以后的 prepareTurn 停在这里，直到 Turn 信号中止。 */
  entered: ReturnType<typeof deferred>;
  tool: ToolDefinition;
}

async function harness(options: {
  description?: string;
  initial?: "failed" | "ready";
  toolSearch?: McpToolSearchMode;
  /** 按父会话请求序号给脚本；缺省为一次提问后结束。 */
  parent?: (index: number) => FakeScript;
  holdRecover?: boolean;
  subagent?: boolean;
}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-steer-"));
  roots.push(root);
  const tool = toolOf(options.description ?? "echo");
  const clock = { now: 0 };
  const serverUp = { value: options.initial === "ready" };
  const retryAt = COOLDOWN_MS;
  let state: McpServerStatus["state"] = options.initial === "ready" ? "ready" : "failed";
  let staged = false;
  let applied = options.initial === "ready";
  let prepareCalls = 0;
  const entered = deferred();
  let parentCalls = 0;
  const provider = new FakeProvider({
    handler: (request) => {
      if (request.tools.some((item) => item.name === "finish")) {
        return [
          {
            type: "tool_call",
            toolCallId: "finish",
            name: "finish",
            input: { result: "child result" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      const index = parentCalls++;
      return options.parent?.(index) ?? (index === 0 ? ask("q0") : textDone);
    },
  });
  const connector: McpConnector = {
    probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
    open: async () => ({
      startup: async () => undefined,
      prepareTurn: async (signal) => {
        prepareCalls += 1;
        if (options.holdRecover === true && prepareCalls > 1) {
          entered.resolve();
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        if (signal?.aborted || !serverUp.value || clock.now < retryAt) return;
        state = "ready";
        staged = true;
      },
      tools: () => (applied ? [tool] : []),
      status: () => [
        {
          name: "browseros",
          state,
          toolCount: applied || staged ? 1 : 0,
          restarts: 0,
          ...(state === "failed" ? { error: "connection refused", autoRetry: true } : {}),
        },
      ],
      reconcile: async () => undefined,
      applyPendingTools: () => {
        const add = staged && !applied ? [tool] : [];
        applied ||= staged;
        staged = false;
        return { add, remove: [] };
      },
      close: async () => undefined,
    }),
  };
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    mcp: connector,
    interactive: true,
    ...(options.toolSearch !== undefined ? { mcpToolSearch: options.toolSearch } : {}),
    ...(options.subagent === true
      ? { subagent: { background: true }, permissions: { autoApproveAsk: true } }
      : {}),
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  return {
    provider,
    session,
    events,
    prepareCalls: () => prepareCalls,
    clock,
    serverUp,
    entered,
    tool,
  };
}

function onQuestions(session: RuntimeSession, actions: (() => Promise<void>)[]): void {
  session.subscribe((event) => {
    if (event.type !== "question.requested") return;
    const action = actions.shift();
    void (async () => {
      if (action !== undefined) await action();
      await session.respondQuestion(event.payload.requestId, {
        answers: [{ selected: [], text: "继续" }],
      });
    })();
  });
}

const mcpNotes = (events: RuntimeEvent[]) =>
  events.filter(
    (event): event is Extract<RuntimeEvent, { type: "session.config_changed" }> =>
      event.type === "session.config_changed" && event.payload.mcp !== undefined,
  );

const parentRequests = (requests: readonly ModelRequest[]) =>
  requests.filter((request) => !request.tools.some((tool) => tool.name === "finish"));

/** 工具定义、system 与已有消息前缀的 JSON 文本。键序不同也会判失败。 */
function prefixText(request: ModelRequest, messageCount = request.messages.length): string {
  return JSON.stringify({
    tools: request.tools,
    system: request.system,
    messages: request.messages.slice(0, messageCount),
  });
}

describe("ADR-0086 用户插话后的 MCP 边界", () => {
  it("全量模式：冷却中插话不加载，过冷却后插话带上工具并写可用性说明", async () => {
    const f = await harness({
      parent: (index) => (index < 2 ? ask(`q${index}`) : textDone),
    });
    onQuestions(f.session, [
      async () => {
        f.serverUp.value = true;
        f.clock.now = 1_000;
        await f.session.enqueueInput("steer", { text: "冷却中再试" });
      },
      async () => {
        f.clock.now = COOLDOWN_MS + 1;
        await f.session.enqueueInput("steer", { text: "现在连上了" });
      },
    ]);
    try {
      expect(await f.session.submit({ text: "打开网页" })).toBe("done");
      const requests = parentRequests(f.provider.requests);
      expect(requests).toHaveLength(3);
      expect(requests[0]?.tools.some((tool) => tool.name === f.tool.name)).toBe(false);
      expect(requests[1]?.tools.some((tool) => tool.name === f.tool.name)).toBe(false);
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("available again");
      expect(requests[2]?.tools.some((tool) => tool.name === f.tool.name)).toBe(true);
      expect(requests[2]?.tools.some((tool) => tool.name === "mcp_search")).toBe(false);
      expect(JSON.stringify(requests[2]?.messages)).toContain("[Environment change] MCP server");
      expect(JSON.stringify(requests[2]?.messages)).toContain("available again");
      expect(mcpNotes(f.events)).toHaveLength(2);
      expect(mcpNotes(f.events)[1]).toMatchObject({
        payload: { mcp: [{ server: "browseros", available: true }] },
      });
      expect(f.prepareCalls()).toBe(3);
    } finally {
      await f.session.close();
    }
  });

  it("全部服务器失败的会话：插话后工具超过阈值则切到按需模式", async () => {
    const description = "x".repeat(40_004);
    const f = await harness({ description });
    expect(estimateMcpToolsTokens([f.tool])).toBeGreaterThan(MCP_TOOL_SEARCH_AUTO_THRESHOLD);
    onQuestions(f.session, [
      async () => {
        f.serverUp.value = true;
        f.clock.now = COOLDOWN_MS + 1;
        await f.session.enqueueInput("steer", { text: "浏览器开了" });
      },
    ]);
    try {
      expect(await f.session.submit({ text: "打开网页" })).toBe("done");
      const requests = parentRequests(f.provider.requests);
      expect(requests).toHaveLength(2);
      const before = requests[0]?.tools.map((tool) => tool.name) ?? [];
      expect(before).not.toContain("mcp_search");
      expect(before).not.toContain(f.tool.name);
      const after = requests[1]?.tools.map((tool) => tool.name) ?? [];
      expect(after).toContain("mcp_search");
      expect(after).toContain("mcp_call");
      expect(after).not.toContain(f.tool.name);
      expect(JSON.stringify(requests[1]?.messages)).toContain("available again");
      expect(mcpNotes(f.events).map((event) => event.payload.mcp?.[0]?.available)).toEqual([
        false,
        true,
      ]);
    } finally {
      await f.session.close();
    }
  });

  it.each([
    ["全量", "never"],
    ["按需", "always"],
  ] as const)("%s模式插话时 MCP 无变化：工具定义与消息前缀逐字节相同", async (_label, mode) => {
    const f = await harness({ initial: "ready", toolSearch: mode });
    f.clock.now = COOLDOWN_MS + 1;
    onQuestions(f.session, [
      async () => {
        await f.session.enqueueInput("steer", { text: "补充一句" });
      },
    ]);
    try {
      expect(await f.session.submit({ text: "先做这个" })).toBe("done");
      const requests = parentRequests(f.provider.requests);
      expect(requests).toHaveLength(2);
      const first = requests[0];
      const second = requests[1];
      if (first === undefined || second === undefined) throw new Error("missing request");
      expect(prefixText(second, first.messages.length)).toBe(prefixText(first));
      const tail = JSON.stringify(second.messages.slice(first.messages.length));
      expect(tail).toContain("补充一句");
      expect(tail).not.toContain("[Environment change]");
      expect(mcpNotes(f.events)).toEqual([]);
      expect(f.prepareCalls()).toBe(2);
    } finally {
      await f.session.close();
    }
  });

  it("后台子代理结果与 continueTurn 不触发 MCP 边界", async () => {
    const goal = await harness({
      parent: (index) => {
        if (index === 0)
          return [
            { type: "text_delta", text: "先到这里" },
            { type: "finish", reason: "stop" },
          ];
        if (index === 1)
          return [
            {
              type: "tool_call",
              toolCallId: "g1",
              name: "update_goal",
              input: {
                status: "met",
                checklist: [{ item: "测试通过", evidence: "pnpm test 0 failed" }],
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        return textDone;
      },
    });
    try {
      expect(await goal.session.submit({ text: "修好测试", workMode: "goal" })).toBe("done");
      const steers = goal.events.filter(
        (event): event is Extract<RuntimeEvent, { type: "message.user" }> =>
          event.type === "message.user" && event.payload.steer === true,
      );
      expect(steers.some((event) => event.payload.workMode?.name === "goal")).toBe(true);
      expect(parentRequests(goal.provider.requests).length).toBeGreaterThan(1);
      expect(goal.prepareCalls()).toBe(1);
      const beforeCompact = goal.prepareCalls();
      await goal.session.compact().catch(() => undefined);
      expect(goal.prepareCalls()).toBe(beforeCompact);
    } finally {
      await goal.session.close();
    }

    const background = await harness({
      subagent: true,
      parent: (index) =>
        index === 0
          ? [
              {
                type: "tool_call",
                toolCallId: "t1",
                name: "task",
                input: { task: "research t1", background: true, preset: "explore" },
              },
              ...ask("q-bg"),
            ]
          : textDone,
    });
    onQuestions(background.session, [
      async () => {
        await vi.waitFor(
          () => {
            expect(
              background.session.pendingInputs().items.some((item) => item.mode === "subagent"),
            ).toBe(true);
          },
          { timeout: 5_000 },
        );
      },
    ]);
    try {
      expect(await background.session.submit({ text: "去查" })).toBe("done");
      expect(
        background.events.some(
          (event) =>
            event.type === "message.user" &&
            event.payload.steer === true &&
            event.payload.subagent !== undefined,
        ),
      ).toBe(true);
      expect(parentRequests(background.provider.requests)).toHaveLength(2);
      expect(background.prepareCalls()).toBe(1);
    } finally {
      await background.session.close();
    }
  });

  it("插话边界等待期间中断立即返回", async () => {
    const f = await harness({ holdRecover: true });
    onQuestions(f.session, [
      async () => {
        await f.session.enqueueInput("steer", { text: "停" });
      },
    ]);
    const turn = f.session.submit({ text: "开始" });
    await f.entered.promise;
    const started = performance.now();
    f.session.interrupt();
    expect(await turn).toBe("aborted");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.prepareCalls()).toBe(2);
    await f.session.close();
  });
});
