/**
 * Phase 6 子代理（subagent.md）离线集成测试。
 * 全部经 FakeProvider 脚本化驱动父子两层会话，不触网。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import {
  FakeProvider,
  ProviderError,
  type FakeScript,
  type ModelInfo,
  type ModelRequest,
} from "../src/provider/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";
import { type SecurityReviewer, createRulePolicy } from "../src/permission/index.js";
import type { McpSession, ToolDefinition } from "../src/tools/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeTmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};

/** 子会话请求：注册表里有 finish 工具；孙会话（maxDepth=2 的第二层）则没有 task */
const isChildRequest = (r: ModelRequest) => r.tools.some((t) => t.name === "finish");
const isNestedChild = (r: ModelRequest) =>
  isChildRequest(r) && r.tools.some((t) => t.name === "task");
const isGrandchild = (r: ModelRequest) => isChildRequest(r) && !isNestedChild(r);

interface RuntimeExtra {
  interactive?: boolean;
  autoApproveAsk?: boolean;
  reviewer?: SecurityReviewer;
  provider?: FakeProvider;
  /** 主会话 Turn 上限覆盖（验证不影响子会话独立上限） */
  turn?: { maxSteps?: number };
  subagent?: {
    enabled?: boolean;
    maxDepth?: number;
    maxConcurrent?: number;
    maxStepsPerTurn?: number;
    maxAttempts?: number;
    timeoutMs?: number;
  };
  mcp?: { open: () => Promise<McpSession> };
  mcpServers?: { name: string; command: string; origin: "user" | "project" }[];
  policy?: ReturnType<typeof createRulePolicy>;
}

async function makeRuntime(
  scripts: FakeScript[] | undefined,
  extra: RuntimeExtra = {},
): Promise<{ runtime: Runtime; ws: string; provider: FakeProvider; sessionsDir: string }> {
  const ws = makeTmp("nct-sa-ws-");
  const sessionsDir = makeTmp("nct-sa-sessions-");
  const provider = extra.provider ?? new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [provider],
    interactive: extra.interactive,
    permissions: { autoApproveAsk: extra.autoApproveAsk, reviewer: extra.reviewer },
    ...(extra.turn !== undefined ? { turn: extra.turn } : {}),
    ...(extra.subagent !== undefined ? { subagent: extra.subagent } : {}),
    ...(extra.mcp !== undefined ? { mcp: extra.mcp } : {}),
    ...(extra.mcpServers !== undefined ? { mcpServers: extra.mcpServers } : {}),
    ...(extra.policy !== undefined ? { policy: extra.policy } : {}),
  });
  return { runtime, ws, provider, sessionsDir };
}

const makeSession = (runtime: Runtime) => runtime.createSession({ model: "fake/fake-model" });

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

/** 父侧第一个请求：调用 task 后 finish(tool_calls)；其余请求直接收尾 */
const parentTaskScript = (input: Record<string, unknown>): FakeScript[] => [
  [
    { type: "tool_call", toolCallId: "task-1", name: "task", input },
    { type: "finish", reason: "tool_calls" },
  ],
  [
    { type: "text_delta", text: "done" },
    { type: "finish", reason: "stop" },
  ],
];

const taskCompleted = (events: RuntimeEvent[]) =>
  events.find((e) => e.type === "tool.completed" && e.payload.name === "task");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("subagent：基本往返", () => {
  it("explore 预设默认放行：父调用 → 子 finish → 结果回到父模型，子日志带父关联", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          // 子代理：读文件后 finish
          const sawToolResult = req.messages.some((m) => m.role === "tool");
          if (!sawToolResult) {
            return [
              {
                type: "tool_call",
                toolCallId: "cr1",
                name: "read",
                input: { path: "a.txt" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cf1",
              name: "finish",
              input: { result: "调查结论：文件内容正常" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const index = req.messages.filter((m) => m.role === "user").length;
        void index;
        return req.messages.some((m) => m.role === "tool")
          ? [
              { type: "text_delta", text: "收到结果" },
              { type: "finish", reason: "stop" },
            ]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "读 a.txt 并总结", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime, ws, sessionsDir } = await makeRuntime(undefined, { provider });
    writeFileSync(path.join(ws, "a.txt"), "content-A");

    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "调查一下" });

    expect(reason).toBe("done");
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    const output =
      completed?.type === "tool.completed"
        ? (completed.payload.output as {
            childSessionId: string;
            childLogPath: string;
            turns: number;
            steps: number;
          })
        : undefined;
    expect(output?.childSessionId).toBeTruthy();
    expect(output?.turns).toBe(1);
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("调查结论");

    // 结果文本回到父模型的下一轮请求
    const lastParentReq = provider.requests.at(-1);
    const toolMsg = lastParentReq?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("调查结论");

    // ADR-0031 §3：主会话与子会话的每个模型请求都携带根会话 ID
    // （子代理沿 parent 链到顶取同一个值）
    expect(provider.requests.length).toBeGreaterThan(1);
    for (const req of provider.requests) {
      expect(req.sessionId).toBe(session.id);
    }

    // 子会话日志：独立文件 + session.created.parent 关联父会话与 callId
    if (output === undefined) throw new Error("task 未返回子会话统计");
    expect(existsSync(output.childLogPath)).toBe(true);
    const firstLine = JSON.parse(
      readFileSync(output.childLogPath, "utf8").split("\n")[0] ?? "{}",
    ) as { type: string; payload: { parent?: { sessionId: string; callId: string } } };
    expect(firstLine.type).toBe("session.created");
    // callId 是运行时内部分配的（turn-…-call-N），取父侧 tool.started 的实际值
    const taskStarted = events.find((e) => e.type === "tool.started" && e.payload.name === "task");
    const parentCallId =
      taskStarted?.type === "tool.started" ? taskStarted.payload.callId : undefined;
    expect(parentCallId).toBeTruthy();
    expect(firstLine.payload.parent).toEqual({
      sessionId: session.id,
      callId: parentCallId,
    });

    // --sessions 默认隐藏子会话；includeSubagents 可见且带 parent
    const list = await runtime.listSessions();
    expect(list.some((s) => s.id === output.childSessionId)).toBe(false);
    const all = await runtime.listSessions({ includeSubagents: true });
    const childSummary = all.find((s) => s.id === output.childSessionId);
    expect(childSummary?.parent?.sessionId).toBe(session.id);

    // 按 id 显式 resume 子会话仍然可用（排查路径）
    const child = await runtime.resumeSession(output.childSessionId);
    expect(child.id).toBe(output.childSessionId);
    await child.close();
    await session.close();
    void sessionsDir;
  });

  it("subagent.enabled=false：task 不注册，模型调用得到 unknown_tool", async () => {
    const { runtime } = await makeRuntime(parentTaskScript({ task: "x" }), {
      subagent: { enabled: false },
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("error");
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "unknown_tool",
    );
    await session.close();
  });
});

describe("subagent：结构化结果", () => {
  it("outputSchema 校验通过：structured 随 output 返回", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return [
            {
              type: "tool_call",
              toolCallId: "cf1",
              name: "finish",
              input: { result: { answer: 42 } },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: {
                  task: "回答",
                  preset: "explore",
                  outputSchema: {
                    type: "object",
                    required: ["answer"],
                    properties: { answer: { type: "number" } },
                  },
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    const output = completed?.type === "tool.completed" ? completed.payload.output : undefined;
    expect(output).toMatchObject({ structured: { answer: 42 } });
    await session.close();
  });

  it("outputSchema 校验失败：invalid_input 回到子模型，修正后仍可 finish", async () => {
    let childCalls = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          childCalls += 1;
          // 第一次给不符合 schema 的 result，看到 invalid_input 反馈后修正
          return childCalls === 1
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: { wrong: "shape" } },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cf2",
                  name: "finish",
                  input: { result: { answer: 7 } },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: {
                  task: "回答",
                  preset: "explore",
                  outputSchema: {
                    type: "object",
                    required: ["answer"],
                    properties: { answer: { type: "number" } },
                  },
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    expect(childCalls).toBe(2);
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await session.close();
  });
});

describe("subagent：催促与兜底", () => {
  it("缺 finish → 催促重试，最后一轮请求携带 toolChoice=finish", async () => {
    const childRequests: ModelRequest[] = [];
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          childRequests.push(req);
          if (req.toolChoice !== undefined) {
            // 兜底轮：遵守强制选择
            return [
              {
                type: "tool_call",
                toolCallId: "cf-last",
                name: "finish",
                input: { result: "兜底提交" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          // 前两轮只输出文本不调用 finish
          return [
            { type: "text_delta", text: "还在想" },
            { type: "finish", reason: "stop" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "只读调查", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });

    expect(childRequests).toHaveLength(3);
    expect(childRequests[0]?.toolChoice).toBeUndefined();
    expect(childRequests[1]?.toolChoice).toBeUndefined();
    expect(childRequests[2]?.toolChoice).toEqual({ name: "finish" });
    // 催促轮的用户消息提到 finish
    const nudge = childRequests[1]?.messages.at(-1);
    expect(nudge?.role === "user").toBe(true);
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    expect(
      completed?.type === "tool.completed" &&
        String((completed.payload.output as { turns: number }).turns),
    ).toBe("3");
    await session.close();
  });

  it("轮次用尽仍无 finish → subagent_no_result，带最后输出尾部", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return [
            { type: "text_delta", text: "一直没提交" },
            { type: "finish", reason: "stop" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "调查", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("error");
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "subagent_no_result",
    );
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("一直没提交");
    await session.close();
  });
});

describe("subagent：中断、超时与失败", () => {
  it("父会话中断 → 子会话取消，父侧恰好一个 tool.completed(cancelled)", async () => {
    const provider = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          // 子代理慢：给中断留窗口（stream 循环逐事件检查 signal）
          await sleep(150);
          return [
            { type: "text_delta", text: "慢" },
            { type: "finish", reason: "stop" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "慢任务", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    // 子会话开始转动（进度转发）后中断父会话
    session.subscribe((e) => {
      if (e.type === "tool.progress") session.interrupt();
    });
    const reason = await session.submit({ text: "go" });

    expect(reason).toBe("aborted");
    const taskCalls = events.filter(
      (e) => e.type === "tool.completed" && e.payload.name === "task",
    );
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0]?.type === "tool.completed" && taskCalls[0].payload.status).toBe(
      "cancelled",
    );
    await session.close();
  });

  it("子会话模型报错 → subagent_turn_failed", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return [
            {
              type: "throw",
              error: new ProviderError({
                kind: "server",
                message: "child boom",
                retryable: false,
              }),
            },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "会失败", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "subagent_turn_failed",
    );
    await session.close();
  });

  it(
    "父 Turn 上限不影响子会话独立默认 50 步：子 50 步后 max_steps → subagent_turn_failed",
    { timeout: 60_000 },
    async () => {
      const provider = new FakeProvider({
        handler: (req) => {
          if (isChildRequest(req)) {
            // 子模型永远只调用 glob 不提交：耗尽默认 50 步上限
            return [
              {
                type: "tool_call",
                toolCallId: `cr-${req.messages.length}`,
                name: "glob",
                input: { pattern: "*.ts" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return req.messages.some((m) => m.role === "tool")
            ? [
                { type: "text_delta", text: "结束" },
                { type: "finish", reason: "stop" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "task-1",
                  name: "task",
                  input: { task: "无限读", preset: "explore" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        },
      });
      // 父 Turn maxSteps=3：父会话两步内结束证明上限未触发；若子会话
      // 继承父上限只会发出 3 个请求
      const { runtime } = await makeRuntime(undefined, {
        provider,
        turn: { maxSteps: 3 },
      });
      const session = await makeSession(runtime);
      const events = collect(session);
      const reason = await session.submit({ text: "go" });
      expect(reason).toBe("done");

      expect(provider.requests.filter(isChildRequest)).toHaveLength(50);
      const completed = taskCompleted(events);
      expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
        "subagent_turn_failed",
      );
      expect(completed?.type === "tool.completed" && completed.payload.error?.message).toContain(
        "max_steps",
      );
      // 子会话日志佐证：turn.completed 以 max_steps、steps=50 结算
      const output =
        completed?.type === "tool.completed"
          ? (completed.payload.output as { childLogPath?: string } | undefined)
          : undefined;
      expect(output?.childLogPath !== undefined && existsSync(output.childLogPath)).toBe(true);
      if (output?.childLogPath === undefined) throw new Error("task 未返回子会话日志路径");
      const childCompleted = readFileSync(output.childLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; payload: { reason?: string; steps?: number } })
        .find((e) => e.type === "turn.completed");
      expect(childCompleted?.payload.reason).toBe("max_steps");
      expect(childCompleted?.payload.steps).toBe(50);
      await session.close();
    },
  );

  it("子会话超步数上限 → subagent_turn_failed", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          // 永远只读不提交：步数耗尽
          return [
            {
              type: "tool_call",
              toolCallId: `cr-${req.messages.length}`,
              name: "read",
              input: { path: "a.txt" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "无限读", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const ws = makeTmp("nct-sa-steps-");
    const { runtime } = await makeRuntime(undefined, {
      provider,
      subagent: { maxStepsPerTurn: 3 },
    });
    writeFileSync(path.join(runtime === undefined ? "" : ws, "a.txt"), "x");
    const session = await makeSession(runtime);
    writeFileSync(path.join(session.state().meta.cwd, "a.txt"), "x");
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.error?.code).toBe(
      "subagent_turn_failed",
    );
    expect(completed?.type === "tool.completed" && completed.payload.error?.message).toContain(
      "max_steps",
    );
    await session.close();
  });

  it("子会话超时 → task 结算为 error（父侧信号未触发）", async () => {
    const provider = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          await sleep(400);
          return [{ type: "finish", reason: "stop" }];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "慢", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, {
      provider,
      subagent: { timeoutMs: 120 },
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("error");
    await session.close();
  });
});

describe("subagent：递归与并发上限", () => {
  it("maxDepth=1：子会话注册表没有 task，硬调得到 unknown_tool", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          // unknown_tool 是 error.code，不进 tool 消息正文；按 isError + 工具名判定
          const retried = req.messages.some(
            (m) => m.role === "tool" && m.name === "task" && m.isError === true,
          );
          return retried
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: "无法派生，直接交结果" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cn1",
                  name: "task",
                  input: { task: "孙任务" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                // general 保留全量工具池——注册表里没有 task 只能来自深度上限
                input: { task: "试试派生", preset: "general" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, {
      provider,
      autoApproveAsk: true, // general 的 subagent 主体 ask → --yes 放行
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("无法派生");
    await session.close();
  });

  it("maxDepth=2：子会话可再派生一层；孙会话不能再派生", async () => {
    let grandchildRuns = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        if (isGrandchild(req)) {
          grandchildRuns += 1;
          // 孙会话没有 task 工具
          expect(req.tools.some((t) => t.name === "task")).toBe(false);
          return [
            {
              type: "tool_call",
              toolCallId: "gf1",
              name: "finish",
              input: { result: "孙结果" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (isNestedChild(req)) {
          const spawned = req.messages.some((m) => m.role === "tool");
          return spawned
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: "子结果" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ct1",
                  name: "task",
                  input: { task: "孙任务", preset: "explore" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "再派生一层", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, {
      provider,
      subagent: { maxDepth: 2 },
      autoApproveAsk: true, // 子会话里 subagent 主体 ask → --yes 继承放行
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    expect(grandchildRuns).toBe(1);
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await session.close();
  });

  it("并发上限占满 → 嵌套派生立即 subagent_concurrency", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isGrandchild(req)) {
          return [
            {
              type: "tool_call",
              toolCallId: "gf1",
              name: "finish",
              input: { result: "不应到达" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (isNestedChild(req)) {
          const retried = req.messages.some((m) => m.role === "tool");
          return retried
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: "槽位满" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ct1",
                  name: "task",
                  input: { task: "孙任务", preset: "explore" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                // general：explore 按 mutates 过滤会连带裁掉 task，测不出并发上限
                input: { task: "占满槽位", preset: "general" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, {
      provider,
      subagent: { maxDepth: 2, maxConcurrent: 1 },
      autoApproveAsk: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    // 子会话里的嵌套 task 调用得到 subagent_concurrency 错误结果
    // （父侧 task 占着唯一槽位，子派生 fail-fast）
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("槽位满");
    await session.close();
  });
});

describe("subagent：权限", () => {
  it("default 预设 general 子代理尝试 edit：非交互拒绝带指引，仍能 finish", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const denied = req.messages.some(
            (m) => m.role === "tool" && String(m.content).includes("无法请求用户确认"),
          );
          return denied
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: "需要写入 a.txt：请父代理执行" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ce1",
                  name: "edit",
                  input: { path: "a.txt", old: "x", new: "y" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "试着改文件" }, // 缺省 general
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime, ws } = await makeRuntime(undefined, {
      provider,
      interactive: true,
    });
    writeFileSync(path.join(ws, "a.txt"), "x");
    const session = await makeSession(runtime);
    const events = collect(session);
    // 父侧 subagent general → ask → 允许
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, { decision: "allow" });
      }
    });
    await session.submit({ text: "go" });

    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("请父代理执行");
    // 文件未被写
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("x");
    // 子会话日志：edit 被拒 + non_interactive + 指引文案
    const output = completed?.type === "tool.completed" ? completed.payload.output : undefined;
    const childLog = readFileSync((output as { childLogPath: string }).childLogPath, "utf8");
    expect(childLog).toContain('"source":"non_interactive"');
    expect(childLog).toContain("无法请求用户确认");
    expect(childLog).toContain("由父代理执行");
    await session.close();
  });

  it("--yes 继承：general 子代理的 edit 在 autoApproveAsk 下放行", async () => {
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const wrote = req.messages.some((m) => m.role === "tool");
          return wrote
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: "已写入" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cw1",
                  name: "write",
                  input: { path: "out.txt", content: "by-child" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "写文件" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime, ws } = await makeRuntime(undefined, {
      provider,
      autoApproveAsk: true,
    });
    const session = await makeSession(runtime);
    await session.submit({ text: "go" });
    expect(readFileSync(path.join(ws, "out.txt"), "utf8")).toBe("by-child");
    await session.close();
  });

  it("deny 规则不被 --yes 或子会话越过", async () => {
    const ws = makeTmp("nct-sa-deny-");
    const sessionsDir = makeTmp("nct-sa-deny-s-");
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const denied = req.messages.some((m) => m.role === "tool");
          return denied
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf1",
                  name: "finish",
                  input: { result: "被拒" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cw1",
                  name: "write",
                  input: { path: "out.txt", content: "x" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "写" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      permissions: { autoApproveAsk: true },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [
          {
            rule: { kind: "edit", pattern: "*", action: "deny" },
            origin: "user",
          },
        ],
        autoApproveAsk: true,
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => {
      events.push(e);
    });
    await session.submit({ text: "go" });
    expect(existsSync(path.join(ws, "out.txt"))).toBe(false);
    const completed = events.find((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await session.close();
  });
});

describe("subagent：MCP 复用", () => {
  it("子会话复用父会话 MCP 连接：不产生第二次 open", async () => {
    let mcpCalls = 0;
    let opens = 0;
    const pingTool: ToolDefinition = {
      name: "mcp__srv__ping",
      description: "ping",
      inputSchema: { type: "object", properties: {} },
      traits: { mutates: false, concurrencySafe: true, timeoutMs: 10_000 },
      permissionSubjects: () => [{ kind: "mcp", target: "srv/ping" }],
      async execute() {
        mcpCalls += 1;
        return { status: "ok", modelContent: "pong" };
      },
    };
    const { runtime } = await makeRuntime(undefined, {
      provider: new FakeProvider({
        handler: (req) => {
          if (isChildRequest(req)) {
            const called = req.messages.some((m) => m.role === "tool");
            return called
              ? [
                  {
                    type: "tool_call",
                    toolCallId: "cf1",
                    name: "finish",
                    input: { result: "ping 完成" },
                  },
                  { type: "finish", reason: "tool_calls" },
                ]
              : [
                  {
                    type: "tool_call",
                    toolCallId: "cm1",
                    name: "mcp__srv__ping",
                    input: {},
                  },
                  { type: "finish", reason: "tool_calls" },
                ];
          }
          return req.messages.some((m) => m.role === "tool")
            ? [{ type: "finish", reason: "stop" }]
            : [
                {
                  type: "tool_call",
                  toolCallId: "task-1",
                  name: "task",
                  input: { task: "调 MCP", preset: "explore" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        },
      }),
      autoApproveAsk: true,
      mcpServers: [{ name: "srv", command: "fake-mcp", origin: "user" }],
      mcp: {
        open: async () => {
          opens += 1;
          return {
            tools: () => [pingTool],
            status: () => [],
            applyPendingTools: () => ({ add: [], remove: [] }),
            close: async () => undefined,
          };
        },
      },
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "go" });
    // 连接器只对父会话 open 一次；子会话拿到同一 ToolDefinition（复用连接）
    expect(opens).toBe(1);
    expect(mcpCalls).toBe(1);
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await session.close();
  });
});

describe("subagent：恢复", () => {
  it("强杀后恢复：父会话未结算的 task 调用补 interrupted；子日志保留父关联", async () => {
    const ws = makeTmp("nct-sa-rec-ws-");
    const sessionsDir = makeTmp("nct-sa-rec-s-");
    const provider = new FakeProvider({ scripts: [] });
    const runtime = await createRuntime({ cwd: ws, sessionsDir, providers: [provider] });

    // 手工构造"被杀"的父会话日志：task 已 tool.started 但未结算
    const parentId = "parent-dead";
    const childId = "child-dead";
    const created = {
      type: "session.created",
      seq: 1,
      sessionId: parentId,
      time: new Date().toISOString(),
      payload: {
        formatVersion: 1,
        nocturneVersion: "0.0.0",
        cwd: ws,
        workspaceRoot: ws,
        model: { provider: "fake", model: "fake-1" },
        permissionPreset: "default",
      },
    };
    const lines = [
      created,
      {
        type: "turn.started",
        seq: 2,
        sessionId: parentId,
        time: created.time,
        turnId: "t1",
        payload: { turnIndex: 1 },
      },
      {
        type: "message.assistant",
        seq: 3,
        sessionId: parentId,
        time: created.time,
        turnId: "t1",
        payload: {
          messageId: "m1",
          model: { provider: "fake", model: "fake-1" },
          content: [],
          toolCalls: [{ callId: "c1", name: "task" }],
          finishReason: "tool_calls",
        },
      },
      {
        type: "tool.started",
        seq: 4,
        sessionId: parentId,
        time: created.time,
        turnId: "t1",
        payload: {
          callId: "c1",
          name: "task",
          input: { task: "被杀时正在跑" },
          subjects: [{ kind: "subagent", target: "general" }],
          permission: { action: "allow", source: "rule" },
        },
      },
    ];
    writeFileSync(
      path.join(sessionsDir, `${parentId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    // 子会话日志：已写 session.created（带父关联）与自己的 turn.started
    const childLines = [
      {
        type: "session.created",
        seq: 1,
        sessionId: childId,
        time: created.time,
        payload: {
          ...created.payload,
          parent: { sessionId: parentId, callId: "c1" },
        },
      },
      {
        type: "turn.started",
        seq: 2,
        sessionId: childId,
        time: created.time,
        turnId: "ct1",
        payload: { turnIndex: 1 },
      },
    ];
    writeFileSync(
      path.join(sessionsDir, `${childId}.jsonl`),
      childLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    const session = await runtime.resumeSession(parentId);
    // 未结算 task 调用被补 interrupted，未结束 Turn 收束
    const durable = session.session.durableEvents();
    const interrupted = durable.find(
      (e) => e.type === "tool.completed" && e.payload.callId === "c1",
    );
    expect(interrupted?.type === "tool.completed" && interrupted.payload.status).toBe(
      "interrupted",
    );
    // 未结束 Turn 收束为 reason:"error" + error.code:"process_exited"（store.repair）
    const closed = durable.find((e) => e.type === "turn.completed");
    expect(
      closed?.type === "turn.completed" &&
        closed.payload.reason === "error" &&
        closed.payload.error?.code === "process_exited",
    ).toBe(true);
    await session.close();

    // 子会话日志完整可读、带父关联；其自身未结束 Turn 也被独立收束
    const child = await runtime.resumeSession(childId);
    expect(child.state().meta.parent).toEqual({ sessionId: parentId, callId: "c1" });
    await child.close();
  });
});

describe("subagent：编辑工具能力筛选（ADR-0035 §5）", () => {
  const patchModel: ModelInfo = {
    ref: { provider: "fake", model: "patchy" },
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none",
      imageInput: false,
      promptCache: false,
      editTool: "apply_patch",
    },
  };

  it("子会话工具池按子会话模型的 editTool 筛选；父侧同样口径", async () => {
    const childToolNames: string[][] = [];
    const provider = new FakeProvider({
      models: [patchModel],
      handler: (req) => {
        if (isChildRequest(req)) {
          childToolNames.push(req.tools.map((t) => t.name));
          return [
            {
              type: "tool_call",
              toolCallId: "cf1",
              name: "finish",
              input: { result: "ok" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? [{ type: "finish", reason: "stop" }]
          : [
              {
                type: "tool_call",
                toolCallId: "task-1",
                name: "task",
                input: { task: "看看", preset: "general" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const { runtime } = await makeRuntime(undefined, { provider, autoApproveAsk: true });
    const session = await runtime.createSession({ model: "fake/patchy" });
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    // 父侧请求也只有 apply_patch（无 edit/write）
    const parentNames = provider.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(parentNames).toContain("apply_patch");
    expect(parentNames).not.toContain("edit");
    // 子会话工具池同口径
    const names = childToolNames[0] ?? [];
    expect(names).toContain("apply_patch");
    expect(names).toContain("finish");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    await session.close();
  });

  it("tools 白名单点名未暴露的编辑工具 → invalid_input", async () => {
    const provider = new FakeProvider({
      models: [patchModel],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "task-1",
            name: "task",
            input: { task: "改东西", tools: ["edit"] },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, { provider, autoApproveAsk: true });
    const session = await runtime.createSession({ model: "fake/patchy" });
    const events = collect(session);
    await session.submit({ text: "go" });
    const completed = taskCompleted(events);
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("error");
    const content =
      completed?.type === "tool.completed" ? String(completed.payload.modelContent) : "";
    expect(content).toContain("tools 含不可用名");
    expect(content).toContain("edit");
    expect(content).toContain("apply_patch");
    await session.close();
  });
});

describe("smart 子代理继承审查器", () => {
  for (const verdict of ["allow", "block", "unsure"] as const) {
    it(`${verdict} 经父审查器处理子会话工作区外 edit，非交互不询问`, async () => {
      const target = path.join(makeTmp("nct-review-child-outside-"), "result.txt");
      const inputs: unknown[] = [];
      const reviewer: SecurityReviewer = {
        backend: "custom",
        review: async (input) => {
          inputs.push(input);
          return { verdict, reason: "继承父会话审查" };
        },
      };
      const provider = new FakeProvider({
        handler: (request) => {
          const hasResult = request.messages.some((message) => message.role === "tool");
          if (isChildRequest(request))
            return hasResult
              ? [
                  {
                    type: "tool_call",
                    toolCallId: "child-finish",
                    name: "finish",
                    input: { result: "结束" },
                  },
                  { type: "finish", reason: "tool_calls" },
                ]
              : [
                  {
                    type: "tool_call",
                    toolCallId: "child-write",
                    name: "write",
                    input: { path: target, content: "approved" },
                  },
                  { type: "finish", reason: "tool_calls" },
                ];
          return hasResult
            ? [
                { type: "text_delta", text: "完成" },
                { type: "finish", reason: "stop" },
              ]
            : (parentTaskScript({ task: "写指定目标", preset: "general" })[0] ?? []);
        },
      });
      const { runtime } = await makeRuntime(undefined, { provider, reviewer, interactive: false });
      const session = await runtime.createSession({
        model: "fake/fake-model",
        permissionPreset: "smart",
      });
      const events = collect(session);
      const reason = await session.submit({ text: "请子代理写指定目标" });
      expect(
        reason,
        JSON.stringify(
          events.filter(
            (event) => event.type === "turn.completed" || event.type === "runtime.error",
          ),
        ),
      ).toBe("done");
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ recentUserMessages: ["请子代理写指定目标"] });
      expect(existsSync(target)).toBe(verdict === "allow");
      const completed = taskCompleted(events);
      if (completed?.type !== "tool.completed") throw new Error("缺少子代理结果");
      const output = completed.payload.output as { childLogPath: string };
      const log = readFileSync(output.childLogPath, "utf-8");
      expect(log).toContain('"type":"permission.reviewed"');
      expect(log).toContain(`"verdict":"${verdict}"`);
      expect(log).not.toContain('"type":"permission.requested"');
      await session.close();
    });
  }
});
