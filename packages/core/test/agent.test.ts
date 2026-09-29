import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runTurn, DEFAULT_TURN_CONFIG, type TurnDeps } from "../src/agent/index.js";
import { redactRequestImages } from "../src/agent/redact.js";
import { createWorkspaceReadPolicy } from "../src/permission/index.js";
import { createPlatform, type Platform } from "../src/platform/index.js";
import {
  FakeProvider,
  ProviderError,
  type FakeHandler,
  type FakeScript,
  type ModelRequest,
  type ResolvedModel,
} from "../src/provider/index.js";
import type { RuntimeEvent, ToolCallRef } from "../src/protocol/index.js";
import { createSessionStore, type Session } from "../src/session/index.js";
import {
  createAttachmentStore,
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
  provider?: FakeProvider;
  attachments?: TurnDeps["execEnv"]["attachments"];
  diagnostics?: TurnDeps["execEnv"]["diagnostics"];
}): Promise<Harness> {
  const ws = makeTmpDir("nct-agent-ws-");
  const sessionsDir = makeTmpDir("nct-agent-sessions-");
  const store = createSessionStore({ platform, sessionsDir });
  const wsReal = await platform.resolveReal(ws);
  const provider =
    options.provider ??
    new FakeProvider({
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
      ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
      ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
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
  it("空 stop 重试后成功；重试用尽返回明确错误码", async () => {
    const recovered = await makeHarness({
      scripts: [
        [{ type: "finish", reason: "stop" }],
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    expect(await runTurn(recovered.deps, prompt())).toBe("done");
    expect(recovered.provider.requests).toHaveLength(2);
    expect(recovered.events.find((e) => e.type === "provider.retry")?.payload.error.kind).toBe(
      "empty_response",
    );

    const exhausted = await makeHarness({
      scripts: [[{ type: "finish", reason: "stop" }], [{ type: "finish", reason: "stop" }]],
      config: { retryLimit: 1 },
    });
    expect(await runTurn(exhausted.deps, prompt())).toBe("error");
    expect(exhausted.provider.requests).toHaveLength(2);
    const end = exhausted.events.find((e) => e.type === "turn.completed");
    expect(end?.type === "turn.completed" && end.payload.error?.code).toBe(
      "provider_empty_response",
    );
  });

  it("首事件超时后重试成功；空闲超时在已有输出后保存部分内容且不重试", async () => {
    const first = await makeHarness({
      scripts: [
        [{ type: "wait" }],
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
      config: { firstEventTimeoutMs: 20, idleTimeoutMs: 20 },
    });
    expect(await runTurn(first.deps, prompt())).toBe("done");
    expect(first.provider.requests).toHaveLength(2);
    expect(first.events.filter((e) => e.type === "provider.retry")).toHaveLength(1);

    const idle = await makeHarness({
      scripts: [[{ type: "text_delta", text: "partial" }, { type: "wait" }]],
      config: { firstEventTimeoutMs: 20, idleTimeoutMs: 20 },
    });
    expect(await runTurn(idle.deps, prompt())).toBe("error");
    expect(idle.provider.requests).toHaveLength(1);
    const end = idle.events.find((e) => e.type === "turn.completed");
    expect(end?.type === "turn.completed" && end.payload.error?.code).toBe("provider_timeout");
  });

  it("首事件超时重试用尽，以 provider_timeout 结束", async () => {
    const h = await makeHarness({
      scripts: [[{ type: "wait" }], [{ type: "wait" }]],
      config: { retryLimit: 1, firstEventTimeoutMs: 20 },
    });
    expect(await runTurn(h.deps, prompt())).toBe("error");
    expect(h.events.filter((e) => e.type === "provider.retry")).toHaveLength(1);
    const end = h.events.find((e) => e.type === "turn.completed");
    expect(end?.type === "turn.completed" && end.payload.error?.code).toBe("provider_timeout");
  });

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
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
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
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
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
        [
          { type: "text_delta", text: "recovered" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("error");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.events.some((e) => e.type === "message.assistant")).toBe(false);
    expect(await runTurn(h.deps, prompt())).toBe("done");
    expect(h.provider.requests[1]?.messages.every((m) => m.role !== "assistant")).toBe(true);
  });

  // provider-setup.md 第 1 节：向导不做连接测试，错误提示推迟到首次真实请求
  it("Provider auth 错误：提示密钥可能无效并给出 /provider key", async () => {
    const h = await makeHarness({
      scripts: [
        [{ type: "throw", error: new ProviderError({ kind: "auth", message: "bad key" }) }],
      ],
    });
    expect(await runTurn(h.deps, prompt())).toBe("error");
    const done = h.events.find((e) => e.type === "turn.completed");
    const msg = done?.type === "turn.completed" ? done.payload.error?.message : "";
    expect(msg).toContain("密钥可能无效");
    expect(msg).toContain("/provider key fake");
  });

  it("Provider network/timeout 错误：提示地址不通并给出 nctrn setup", async () => {
    for (const kind of ["network", "timeout"] as const) {
      const h = await makeHarness({
        config: { retryLimit: 0 },
        scripts: [[{ type: "throw", error: new ProviderError({ kind, message: "unreachable" }) }]],
      });
      expect(await runTurn(h.deps, prompt())).toBe("error");
      const done = h.events.find((e) => e.type === "turn.completed");
      const msg = done?.type === "turn.completed" ? done.payload.error?.message : "";
      expect(msg).toContain("地址不通");
      expect(msg).toContain("nctrn setup");
    }
  });

  it("Provider invalid_request（含 404）错误：提示模型 id 或地址路径有误", async () => {
    const h = await makeHarness({
      scripts: [
        [
          {
            type: "throw",
            error: new ProviderError({
              kind: "invalid_request",
              message: "no such model",
              status: 404,
            }),
          },
        ],
      ],
    });
    expect(await runTurn(h.deps, prompt())).toBe("error");
    const done = h.events.find((e) => e.type === "turn.completed");
    const msg = done?.type === "turn.completed" ? done.payload.error?.message : "";
    expect(msg).toContain("模型 id 或地址路径");
    const code = done?.type === "turn.completed" ? done.payload.error?.code : "";
    expect(code).toBe("provider_invalid_request");
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
    const end = h.events.find((e) => e.type === "turn.completed");
    expect(end?.type === "turn.completed" && end.payload.steps).toBe(3);
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

  it(
    "默认不设 maxSteps：151 次工具调用后模型自行 stop → done，无 max_steps",
    { timeout: 60_000 },
    async () => {
      // 前 151 个请求一律要求 glob，第 152 个请求输出文本并 stop：
      // 超出旧默认 100 之上仍能继续，证明默认不限制步数
      const h = await makeHarness({
        handler: (_req, callIndex) =>
          callIndex < 151
            ? [
                {
                  type: "tool_call",
                  toolCallId: `x${callIndex}`,
                  name: "glob",
                  input: { pattern: "*.ts" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                { type: "text_delta", text: "done" },
                { type: "finish", reason: "stop" },
              ],
      });
      const reason = await runTurn(h.deps, prompt());
      expect(reason).toBe("done");
      expect(h.provider.requests).toHaveLength(152);
      const end = h.events.find((e) => e.type === "turn.completed");
      expect(end?.type === "turn.completed" && end.payload.reason).toBe("done");
      expect(end?.type === "turn.completed" && end.payload.steps).toBe(152);
    },
  );

  it("不设 maxSteps 时在工具循环中中断：aborted，不出现 max_steps", async () => {
    const ac = new AbortController();
    const h = await makeHarness({
      signal: ac.signal,
      // 模型永远要求工具：不中断则 Turn 不会自行结束
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
    let completed = 0;
    h.session.subscribe((e) => {
      if (e.type === "tool.completed" && ++completed === 5) ac.abort();
    });
    const reason = await runTurn(h.deps, prompt());
    expect(reason).toBe("aborted");
    const end = h.events.find((e) => e.type === "turn.completed");
    expect(end?.type === "turn.completed" && end.payload.reason).toBe("aborted");
    expect(reason).not.toBe("max_steps");
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
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
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

describe("图片附件接线（ADR-0023）", () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
    0, 0, 0, 3, 8, 6, 0, 0, 0,
  ]);
  const visionProvider = (scripts: FakeScript[]): FakeProvider =>
    new FakeProvider({
      scripts,
      models: [
        {
          ref: { provider: "fake", model: "fake-vision" },
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "none",
            imageInput: true,
            promptCache: false,
          },
        },
      ],
    });
  const readImageScript = (): FakeScript[] => [
    [
      { type: "tool_call", toolCallId: "tc1", name: "read", input: { path: "pic.png" } },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "看到了" },
      { type: "finish", reason: "stop" },
    ],
  ];

  it("read 读图 → 附件落盘 → 下一请求的 tool 消息携带 base64 images", async () => {
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const ws = makeTmpDir("nct-agent-img-");
    const sessionsDir = makeTmpDir("nct-agent-img-sessions-");
    // 手工搭 harness 以接管 workspace/attachmentsDir
    const store = createSessionStore({ platform, sessionsDir });
    const wsReal = await platform.resolveReal(ws);
    await platform.fs.writeFile(path.join(ws, "pic.png"), PNG);
    const provider = visionProvider(readImageScript());
    const session = await store.create({
      cwd: ws,
      workspaceRoot: wsReal,
      model: { provider: "fake", model: "fake-vision" },
      permissionPreset: "phase1",
      nocturneVersion: "0.0.0-test",
    });
    const registry = createBuiltinRegistry();
    const attachments = createAttachmentStore({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir: path.join(sessionsDir, "attachments"),
      sessionId: session.id,
    });
    const model = provider.models()[0];
    if (model === undefined) throw new Error("no model");
    const deps: TurnDeps = {
      session,
      model: { provider, model },
      tools: registry,
      executor: createToolExecutor(registry),
      execEnv: {
        platform,
        gate: createPolicyGate(
          createWorkspaceReadPolicy({
            workspaceRoot: wsReal,
            caseSensitive: platform.caseSensitivePaths,
          }),
        ),
        readState: createReadStateStore(platform.paths),
        attachments,
        diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      },
      instructions: { project: [] },
      environment: {
        os: "test-os",
        cwd: ws,
        workspaceRoot: wsReal,
        sessionDate: "2025-01-01",
      },
      config: { ...DEFAULT_TURN_CONFIG, retryBaseDelayMs: 1 },
      signal: new AbortController().signal,
    };
    expect(await runTurn(deps, prompt())).toBe("done");
    expect(provider.requests).toHaveLength(2);
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    const pngB64 = Buffer.from(PNG).toString("base64");
    expect(toolMsg?.role === "tool" && toolMsg.images?.[0]?.data).toBe(pngB64);
    expect(toolMsg?.role === "tool" && toolMsg.images?.[0]?.mimeType).toBe("image/png");
    // provider.request 诊断：base64 脱敏为 { mimeType, bytes, sha256 }（C5）
    const withImages = records
      .filter((r) => r.kind === "provider.request")
      .map((r) => r.data)
      .find((d) => JSON.stringify(d).includes('"mimeType":"image/png"'));
    expect(withImages).toBeDefined();
    const redactedImgs = (
      (withImages?.["request"] as { messages?: { images?: unknown[] }[] })?.messages ?? []
    ).flatMap((m) => m.images ?? [])[0] as
      { mimeType: string; bytes: number; sha256: string } | undefined;
    expect(redactedImgs?.mimeType).toBe("image/png");
    expect(redactedImgs?.bytes).toBe(PNG.length);
    expect(redactedImgs?.sha256).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(JSON.stringify(withImages)).not.toContain(pngB64);
  });

  it("模型不支持看图：同一附件在请求里只有占位文字", async () => {
    const ws = makeTmpDir("nct-agent-img-");
    const sessionsDir = makeTmpDir("nct-agent-img-sessions-");
    const store = createSessionStore({ platform, sessionsDir });
    const wsReal = await platform.resolveReal(ws);
    await platform.fs.writeFile(path.join(ws, "pic.png"), PNG);
    const provider = new FakeProvider({ scripts: readImageScript() });
    const session = await store.create({
      cwd: ws,
      workspaceRoot: wsReal,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "phase1",
      nocturneVersion: "0.0.0-test",
    });
    const registry = createBuiltinRegistry();
    const model = provider.models()[0];
    if (model === undefined) throw new Error("no model");
    const deps: TurnDeps = {
      session,
      model: { provider, model },
      tools: registry,
      executor: createToolExecutor(registry),
      execEnv: {
        platform,
        gate: createPolicyGate(
          createWorkspaceReadPolicy({
            workspaceRoot: wsReal,
            caseSensitive: platform.caseSensitivePaths,
          }),
        ),
        readState: createReadStateStore(platform.paths),
        attachments: createAttachmentStore({
          fs: platform.fs,
          paths: platform.paths,
          attachmentsDir: path.join(sessionsDir, "attachments"),
          sessionId: session.id,
        }),
      },
      instructions: { project: [] },
      environment: {
        os: "test-os",
        cwd: ws,
        workspaceRoot: wsReal,
        sessionDate: "2025-01-01",
      },
      config: { ...DEFAULT_TURN_CONFIG, retryBaseDelayMs: 1 },
      signal: new AbortController().signal,
    };
    expect(await runTurn(deps, prompt())).toBe("done");
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain(
      "[image omitted: current model does not support image input]",
    );
  });

  it("附件文件缺失：缺失占位 + context.attachment_missing 诊断", async () => {
    const records: { kind: string; data: Record<string, unknown> }[] = [];
    const h = await makeHarness({
      provider: visionProvider([
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      diagnostics: { record: (kind, data) => records.push({ kind, data: data ?? {} }) },
      attachments: createAttachmentStore({
        fs: platform.fs,
        paths: platform.paths,
        attachmentsDir: makeTmpDir("nct-agent-att-"),
        sessionId: "will-be-replaced",
      }),
    });
    // 直接写入一条带附件引用的 tool.completed（文件并不存在）
    await h.session.emit("turn.started", { turnIndex: 1 }, { turnId: "t0" });
    await h.session.emit(
      "message.assistant",
      {
        messageId: "m0",
        model: { provider: "fake", model: "fake-model" },
        content: [{ type: "text", text: "" }],
        toolCalls: [{ callId: "cx", name: "read" }],
        usage: undefined,
        finishReason: "tool_calls",
      },
      { turnId: "t0" },
    );
    await h.session.emit(
      "tool.completed",
      {
        callId: "cx",
        name: "read",
        status: "ok",
        modelContent: "Image file: x.png",
        attachments: [
          {
            type: "image",
            file: "img-9.png",
            mimeType: "image/png",
            bytes: 29,
            sha256: "f".repeat(64),
            source: "read",
          },
        ],
      },
      { turnId: "t0" },
    );
    await h.session.emit(
      "turn.completed",
      { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
      { turnId: "t0" },
    );
    expect(await runTurn(h.deps, prompt())).toBe("done");
    const toolMsg = h.provider.requests[0]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain(
      "[image unavailable: attachment file missing]",
    );
    expect(toolMsg?.role === "tool" && toolMsg.images).toBeUndefined();
    const miss = records.filter((r) => r.kind === "context.attachment_missing");
    expect(miss).toHaveLength(1);
    expect(miss[0]?.data["file"]).toBe("img-9.png");
    expect(miss[0]?.data["sha256"]).toBe("f".repeat(64));
    // provider.request 诊断中的请求不含 base64（已脱敏为摘要）
    const reqRecord = records.find((r) => r.kind === "provider.request");
    expect(JSON.stringify(reqRecord?.data)).not.toContain("base64,");
  });
});

describe("redactRequestImages（ADR-0023 C5）", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const baseRequest = (images?: { mimeType: "image/png"; data: string }[]): ModelRequest => ({
    model: "m",
    system: [{ text: "sys" }],
    messages: [
      {
        role: "tool",
        callId: "c1",
        name: "read",
        content: "out",
        isError: false,
        ...(images !== undefined ? { images } : {}),
      },
    ],
    tools: [],
  });

  it("无图片：原样返回同一对象引用", () => {
    const req = baseRequest();
    expect(redactRequestImages(req)).toBe(req);
    const emptyImages = baseRequest([]);
    expect(redactRequestImages(emptyImages)).toBe(emptyImages);
  });

  it("有图片：替换为 { mimeType, bytes, sha256 }，不含 base64", () => {
    const data = Buffer.from(PNG_BYTES).toString("base64");
    const req = baseRequest([{ mimeType: "image/png", data }]);
    const redacted = redactRequestImages(req);
    expect(redacted).not.toBe(req);
    const msg = redacted.messages[0] as {
      images?: { mimeType: string; bytes: number; sha256: string }[];
    };
    expect(msg.images?.[0]).toEqual({
      mimeType: "image/png",
      bytes: PNG_BYTES.length,
      sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
    });
    expect(JSON.stringify(redacted)).not.toContain(data);
    // 原请求不被修改
    const orig = req.messages[0];
    expect(orig !== undefined && orig.role === "tool" && orig.images?.[0]?.data).toBe(data);
  });
});
