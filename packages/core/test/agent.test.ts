import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runTurn, DEFAULT_TURN_CONFIG, type TurnDeps } from "../src/agent/index.js";
import { createWorkspaceReadPolicy } from "../src/permission/index.js";
import { createPlatform, type Platform } from "../src/platform/index.js";
import {
  FakeProvider,
  ProviderError,
  type FakeHandler,
  type FakeScript,
  type ResolvedModel,
} from "../src/provider/index.js";
import type { RuntimeEvent, ToolCallRef } from "../src/protocol/index.js";
import { createSessionStore, type Session } from "../src/session/index.js";
import {
  createBuiltinRegistry,
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  type PermissionGate,
} from "../src/tools/index.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

interface Harness {
  session: Session;
  deps: TurnDeps;
  events: RuntimeEvent[];
  provider: FakeProvider;
  ws: string;
}

async function makeHarness(options: {
  scripts?: FakeScript[];
  handler?: FakeHandler;
  gate?: PermissionGate;
  config?: Partial<TurnDeps["config"]>;
  signal?: AbortSignal;
}): Promise<Harness> {
  const ws = makeTmpDir("nct-agent-ws-");
  const sessionsDir = makeTmpDir("nct-agent-sessions-");
  const store = createSessionStore({
    fs: platform.fs,
    paths: platform.paths,
    sessionsDir,
  });
  const wsReal = await platform.resolveReal(ws);
  const provider = new FakeProvider({
    scripts: options.scripts,
    handler: options.handler,
  });
  const model: ResolvedModel = {
    provider,
    model:
      provider.models()[0] ??
      (() => {
        throw new Error("no model");
      })(),
  };
  const session = await store.create({
    cwd: ws,
    workspaceRoot: wsReal,
    model: model.model.ref,
    permissionPreset: "phase1",
    nocturneVersion: "0.0.0-test",
  });
  const registry = createBuiltinRegistry();
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  const deps: TurnDeps = {
    session,
    model,
    tools: registry,
    executor: createToolExecutor(registry),
    execEnv: {
      platform,
      gate:
        options.gate ??
        createPolicyGate(
          createWorkspaceReadPolicy({
            workspaceRoot: wsReal,
            caseSensitive: platform.caseSensitivePaths,
          }),
        ),
      readState: createReadStateStore(platform.paths),
    },
    instructions: { project: [] },
    environment: {
      os: "test-os",
      cwd: ws,
      workspaceRoot: wsReal,
      sessionDate: "2025-01-01",
    },
    config: { ...DEFAULT_TURN_CONFIG, retryBaseDelayMs: 1, ...options.config },
    signal: options.signal ?? new AbortController().signal,
  };
  return { session, deps, events, provider, ws };
}

const durableTypes = (events: RuntimeEvent[]) =>
  events.filter((e): e is Extract<RuntimeEvent, { seq: number }> => "seq" in e).map((e) => e.type);

const prompt = (text = "hi"): Parameters<typeof runTurn>[1] => [{ type: "text", text }];

describe("runTurn", () => {
  it("完整 Turn：prompt → 流式文本 → 工具调用 → 工具结果回模型 → done", async () => {
    const h = await makeHarness({
      scripts: [
        [
          { type: "text_delta", text: "Let me read " },
          { type: "text_delta", text: "the file." },
          {
            type: "tool_call",
            toolCallId: "p1",
            name: "read",
            input: { path: "note.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "File says hi." },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    await platform.fs.writeFile(path.join(h.ws, "note.txt"), "hello file");
    const reason = await runTurn(h.deps, prompt());

    expect(reason).toBe("done");
    const types = durableTypes(h.events);
    // session.created 在订阅前已发布，不在列表中
    expect(types).toEqual([
      "turn.started",
      "message.user",
      "message.assistant",
      "tool.started",
      "tool.completed",
      "message.assistant",
      "turn.completed",
    ]);
    // Runtime 分配 callId，providerCallId 保存原始 ID
    const assistant = h.events.find((e) => e.type === "message.assistant");
    const calls = assistant?.type === "message.assistant" ? assistant.payload.toolCalls : [];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerCallId).toBe("p1");
    expect(calls[0]?.callId).not.toBe("p1");
    // 工具结果经下一次请求回到模型（agent-loop.md 3.1）
    expect(h.provider.requests).toHaveLength(2);
    const secondReq = h.provider.requests[1];
    const toolMsg = secondReq?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("hello file");
    // 增量事件归属对应 Step 的 messageId（events.md 不变量 5）
    const deltas = h.events.filter((e) => e.type === "message.assistant.delta");
    expect(deltas.length).toBe(3);
    const messageIds = new Set(
      h.events
        .filter((e) => e.type === "message.assistant")
        .map((e) => (e.type === "message.assistant" ? e.payload.messageId : "")),
    );
    expect(
      deltas.every(
        (d) => d.type === "message.assistant.delta" && messageIds.has(d.payload.messageId),
      ),
    ).toBe(true);
  });

  it("一个 Step 多个工具调用：按顺序执行，各有一个 tool.completed", async () => {
    const h = await makeHarness({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "a",
            name: "glob",
            input: { pattern: "*.ts" },
          },
          {
            type: "tool_call",
            toolCallId: "b",
            name: "grep",
            input: { pattern: "x" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("done");
    const completed = h.events.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(2);
    expect(completed.map((c) => (c.type === "tool.completed" ? c.payload.name : ""))).toEqual([
      "glob",
      "grep",
    ]);
  });

  it("finish=length → truncated；content_filter → refused；other → error", async () => {
    for (const [fr, expected] of [
      ["length", "truncated"],
      ["content_filter", "refused"],
      ["other", "error"],
    ] as const) {
      const h = await makeHarness({
        scripts: [
          [
            { type: "text_delta", text: "partial" },
            { type: "finish", reason: fr },
          ],
        ],
      });
      const reason = await runTurn(h.deps, prompt());
      expect(reason).toBe(expected);
      const done = h.events.find((e) => e.type === "turn.completed");
      expect(done?.type === "turn.completed" && done.payload.reason).toBe(expected);
    }
  });

  it("finish=tool_calls 但没有工具调用 → unexpected_finish error", async () => {
    const h = await makeHarness({
      scripts: [[{ type: "finish", reason: "tool_calls" }]],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("error");
  });

  it("Provider 可重试错误：重试后成功，发出 provider.retry", async () => {
    const h = await makeHarness({
      scripts: [
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "network", message: "net down" }),
          },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("done");
    expect(h.provider.requests).toHaveLength(2);
    expect(h.events.some((e) => e.type === "provider.retry")).toBe(true);
  });

  it("产生输出后的 Provider 错误不重试，部分内容保存后 error", async () => {
    const h = await makeHarness({
      scripts: [
        [
          { type: "text_delta", text: "partial output" },
          {
            type: "throw",
            error: new ProviderError({ kind: "network", message: "boom" }),
          },
        ],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("error");
    expect(h.provider.requests).toHaveLength(1); // 未重试
    const assistant = h.events.find((e) => e.type === "message.assistant");
    expect(assistant?.type === "message.assistant" && assistant.payload.finishReason).toBe(
      "aborted",
    );
  });

  it("不可重试的 Provider 错误直接 error", async () => {
    const h = await makeHarness({
      scripts: [
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "auth", message: "bad key" }),
          },
        ],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("error");
    expect(h.provider.requests).toHaveLength(1);
  });

  it("重试耗尽 → error", async () => {
    const h = await makeHarness({
      config: { retryLimit: 2 },
      scripts: [
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "overloaded", message: "x" }),
          },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "overloaded", message: "x" }),
          },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "overloaded", message: "x" }),
          },
        ],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("error");
    expect(h.provider.requests).toHaveLength(3);
    expect(h.events.filter((e) => e.type === "provider.retry")).toHaveLength(2);
  });

  it("中断：流式中 abort → aborted，部分内容以 finishReason=aborted 保存", async () => {
    const ac = new AbortController();
    const h = await makeHarness({
      signal: ac.signal,
      scripts: [
        [
          { type: "text_delta", text: "chunk1" },
          { type: "text_delta", text: "chunk2" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    h.session.subscribe((e) => {
      if (e.type === "message.assistant.delta") ac.abort();
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("aborted");
    const done = h.events.find((e) => e.type === "turn.completed");
    expect(done?.type === "turn.completed" && done.payload.reason).toBe("aborted");
  });

  it("max_steps：模型持续要求工具 → max_steps", async () => {
    const h = await makeHarness({
      config: { maxSteps: 3 },
      handler: () => [
        {
          type: "tool_call",
          toolCallId: "x",
          name: "glob",
          input: { pattern: "*.ts" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("max_steps");
    expect(h.provider.requests).toHaveLength(3);
    // 每个工具调用都有恰好一个 tool.completed
    const calls = h.events
      .filter((e) => e.type === "message.assistant")
      .flatMap((e) => (e.type === "message.assistant" ? e.payload.toolCalls : []))
      .map((c: ToolCallRef) => c.callId);
    const completed = h.events.filter((e) => e.type === "tool.completed");
    for (const c of calls) {
      expect(
        completed.filter((e) => e.type === "tool.completed" && e.payload.callId === c),
      ).toHaveLength(1);
    }
  });

  it("权限拒绝：denied 结果回模型，Turn 正常继续", async () => {
    const h = await makeHarness({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "p",
            name: "read",
            input: { path: "..\\outside-secret.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("done");
    const completed = h.events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
    // denied 结果作为 isError 回模型
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.isError).toBe(true);
  });

  it("用户拒绝并停止 → aborted", async () => {
    const gate: PermissionGate = {
      check: (subjects) =>
        Promise.resolve({
          subjects,
          decision: {
            action: "deny",
            source: "user",
            reason: "拒绝并停止",
          },
          stopTurn: true,
        }),
      checkLexical: () => "deny",
    };
    const h = await makeHarness({
      gate,
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "p",
            name: "read",
            input: { path: "a" },
          },
          {
            type: "tool_call",
            toolCallId: "q",
            name: "read",
            input: { path: "b" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("aborted");
    // 第二个未执行的调用由 finish 结算为 cancelled：仍保证恰好一个 tool.completed
    const completed = h.events.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(2);
    const statuses = completed.map((e) => (e.type === "tool.completed" ? e.payload.status : ""));
    expect(statuses.sort()).toEqual(["cancelled", "denied"]);
  });
});
