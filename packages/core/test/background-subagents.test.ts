/**
 * 后台子代理（ADR-0073）集成测试：FakeProvider 驱动父子会话，全程离线。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { backgroundAdmission } from "../src/agent/background-subagents.js";
import { createRuntime, type RuntimeOptions, type RuntimeSession } from "../src/index.js";
import type { DurableEvent } from "../src/protocol/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import type { ModelRequest } from "../src/provider/types.js";
import { foldEvents } from "../src/session/fold.js";
import { builtinTools, createTaskTool } from "../src/tools/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const done: FakeScript = [
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "stop" },
];
const call = (id: string, name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: id,
  name,
  input,
});
const bg = (id: string, extra: Record<string, unknown> = {}) =>
  call(id, "task", { task: `research ${id}`, background: true, preset: "explore", ...extra });
const isChild = (request: ModelRequest) => request.tools.some((tool) => tool.name === "finish");

interface Setup {
  /** 父会话第 n 次请求（从 0 起）的脚本；超出后回 done */
  parent?: FakeScript[];
  /** 子会话 finish 前的等待；可按任务文本区分 */
  childWait?: (request: ModelRequest) => number;
  subagent?: RuntimeOptions["subagent"];
  hooks?: RuntimeOptions["hooks"];
}

async function setup(options: Setup = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-background-"));
  roots.push(root);
  let parentCalls = 0;
  const childRequests: ModelRequest[] = [];
  const provider = new FakeProvider({
    handler: (request) => {
      if (isChild(request)) {
        childRequests.push(request);
        return [
          { type: "wait", ms: options.childWait?.(request) ?? 150 },
          call("finish", "finish", { result: "child result" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      const script = (options.parent ?? [[bg("t1"), { type: "finish", reason: "tool_calls" }]])[
        parentCalls++
      ];
      return script ?? done;
    },
  });
  const sessionsDir = path.join(root, "sessions");
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir,
    providers: [provider],
    subagent: { background: true, ...options.subagent },
    permissions: { autoApproveAsk: true },
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  return { root, runtime, session, childRequests };
}

type UserEvent = Extract<DurableEvent, { type: "message.user" }>;
const results = (session: RuntimeSession) =>
  session
    .durableEvents()
    .filter(
      (event): event is UserEvent =>
        event.type === "message.user" && event.payload.subagent !== undefined,
    );
const turns = (session: RuntimeSession) =>
  session.durableEvents().filter((event) => event.type === "turn.started").length;
const taskCompleted = (session: RuntimeSession) =>
  session
    .durableEvents()
    .filter(
      (event): event is Extract<DurableEvent, { type: "tool.completed" }> =>
        event.type === "tool.completed" && event.payload.name === "task",
    );
const running = async (runtime: Awaited<ReturnType<typeof setup>>["runtime"], id: string) =>
  (await runtime.listSubagents({ parentSessionId: id })).filter(
    (item) => item.background === true && item.state === "running",
  );

describe("准入与 schema", () => {
  it("只读工具集放行，含 edit / shell / write / task 拒绝，外部 agent 拒绝", () => {
    const tools = builtinTools();
    expect(
      backgroundAdmission({
        tools: tools.filter((tool) => !tool.traits.mutates),
        isolation: "none",
      }),
    ).toBeUndefined();
    for (const name of ["edit", "shell", "write"]) {
      const picked = tools.filter((tool) => !tool.traits.mutates || tool.name === name);
      expect(backgroundAdmission({ tools: picked, isolation: "none" })).toBe(
        "后台子代理只能只读；需要写入请同步调用",
      );
    }
    expect(
      backgroundAdmission({ tools: [{ traits: { mutates: true } }] as never, isolation: "none" }),
    ).toBeDefined();
    expect(backgroundAdmission({ tools: [], isolation: "none", external: true })).toBeDefined();
  });

  it("开关关闭时 schema 与描述都没有 background；开启时有", () => {
    const off = createTaskTool();
    expect(off.inputSchema.properties).not.toHaveProperty("background");
    expect(off.description).not.toContain("background");
    const on = createTaskTool(undefined, undefined, undefined, [], undefined, () => undefined);
    expect(on.inputSchema.properties).toHaveProperty("background");
    expect(off.validateInput?.({ task: "x", background: true } as never)).toBe(
      "当前会话不支持后台子代理",
    );
  });

  it("子会话请求里的 task 工具不带 background", async () => {
    const { session, childRequests } = await setup({
      parent: [[call("t1", "task", { task: "sync" }), { type: "finish", reason: "tool_calls" }]],
    });
    try {
      await session.submit({ text: "go" });
      expect(childRequests.length).toBeGreaterThan(0);
      for (const request of childRequests) {
        const task = request.tools.find((tool) => tool.name === "task");
        expect(JSON.stringify(task ?? {})).not.toContain("background");
      }
    } finally {
      await session.close();
    }
  });

  it.each([
    ["general 预设", { preset: "general" }],
    ["tools 含 edit", { preset: undefined, tools: ["read", "edit"] }],
    ["tools 含 shell", { preset: undefined, tools: ["read", "shell"] }],
    ["tools 含 task", { preset: undefined, tools: ["read", "task"] }],
  ])("%s 报 invalid_input，不启动子会话", async (_name, extra) => {
    // maxDepth 2 让 task 出现在子会话工具池里，走到准入判断
    const { runtime, session, childRequests } = await setup({
      subagent: { maxDepth: 2 },
      parent: [[bg("t1", extra), { type: "finish", reason: "tool_calls" }]],
    });
    try {
      await session.submit({ text: "go" });
      const completed = taskCompleted(session)[0];
      expect(completed?.payload.status).toBe("error");
      expect(completed?.payload.error?.code).toBe("invalid_input");
      expect(completed?.payload.modelContent).toContain("后台子代理只能只读");
      expect(childRequests).toHaveLength(0);
      expect(await running(runtime, session.id)).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

describe("启动与交付", () => {
  it("立即返回、父 Turn 先结束；空闲收束自动开新 Turn；fold 保留 subagent", async () => {
    const progress: string[] = [];
    const { runtime, session } = await setup({ childWait: () => 300 });
    session.subscribe((event) => {
      if (event.type === "tool.progress") progress.push(event.payload.callId);
    });
    try {
      expect(await session.submit({ text: "go" })).toBe("done");
      expect(results(session)).toHaveLength(0);
      const completed = taskCompleted(session)[0];
      expect(completed?.payload.output).toMatchObject({ background: true });
      expect(completed?.payload.modelContent).toMatch(/^Background subagent started \(id: /u);
      expect(progress).toHaveLength(0);
      expect(await running(runtime, session.id)).toHaveLength(1);
      await vi.waitFor(() => expect(turns(session)).toBe(2), { timeout: 5000 });
      const result = results(session)[0];
      expect(result?.payload.subagent).toMatchObject({
        callId: completed?.payload.callId,
        status: "ok",
        profile: "explore",
      });
      expect(result?.payload.steer).toBeUndefined();
      const text = JSON.stringify(result?.payload.content);
      expect(text).toContain("<subagent-result");
      expect(text).toContain("child result");
      const user = foldEvents(session.durableEvents())
        .history.filter((entry) => entry.kind === "user")
        .at(-1);
      expect(user).toHaveProperty("subagent.status", "ok");
      await vi.waitFor(async () => expect(await running(runtime, session.id)).toHaveLength(0));
    } finally {
      await session.close();
    }
  });

  it("运行中收束：在安全点作为插话写入，不另开 Turn", async () => {
    const { root, session } = await setup({
      childWait: () => 50,
      parent: [
        [bg("t1"), { type: "finish", reason: "tool_calls" }],
        [
          { type: "wait", ms: 600 },
          call("r1", "read", { path: "a.txt" }),
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });
    writeFileSync(path.join(root, "a.txt"), "hello");
    try {
      expect(await session.submit({ text: "go" })).toBe("done");
      expect(turns(session)).toBe(1);
      const result = results(session)[0];
      expect(result?.payload.subagent?.status).toBe("ok");
      expect(result?.payload.steer).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("两个同时收束：按收束顺序交付", async () => {
    const { session } = await setup({
      childWait: (request) => (JSON.stringify(request.messages).includes("research a") ? 400 : 100),
      parent: [[bg("a"), bg("b"), { type: "finish", reason: "tool_calls" }]],
    });
    try {
      await session.submit({ text: "go" });
      await vi.waitFor(() => expect(results(session)).toHaveLength(2), { timeout: 5000 });
      const [a, b] = taskCompleted(session).map((event) => event.payload.callId);
      expect(results(session).map((event) => event.payload.subagent?.callId)).toEqual([b, a]);
    } finally {
      await session.close();
    }
  });

  it("父 Turn 中断不取消后台；暂停时收束追加为暂停条目、不唤起；撤回即丢弃、不能编辑", async () => {
    const { session } = await setup({
      childWait: () => 300,
      parent: [
        [bg("t1"), { type: "finish", reason: "tool_calls" }],
        [{ type: "wait", ms: 10_000 }, ...done],
      ],
    });
    try {
      const turn = session.submit({ text: "go" });
      await vi.waitFor(() => expect(taskCompleted(session)).toHaveLength(1));
      session.interrupt();
      expect(await turn).toBe("aborted");
      await vi.waitFor(() => expect(session.pendingInputs().items).toHaveLength(1), {
        timeout: 5000,
      });
      const item = must(session.pendingInputs().items[0]);
      expect(item).toMatchObject({ mode: "subagent", paused: true });
      expect(turns(session)).toBe(1);
      await expect(session.updateInput(item.id, { input: { text: "x" } })).rejects.toMatchObject({
        code: "invalid_command",
      });
      await session.cancelInput(item.id);
      expect(session.pendingInputs().items).toHaveLength(0);
      expect(results(session)).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it("取消后交付 cancelled；非运行中再取消报 invalid_command", async () => {
    const { runtime, session } = await setup({ childWait: () => 10_000 });
    try {
      await session.submit({ text: "go" });
      const child = must((await running(runtime, session.id))[0]);
      await runtime.cancelSubagent({
        parentSessionId: session.id,
        childSessionId: child.childSessionId,
      });
      await vi.waitFor(
        () => expect(results(session)[0]?.payload.subagent?.status).toBe("cancelled"),
        {
          timeout: 5000,
        },
      );
      await expect(
        runtime.cancelSubagent({
          parentSessionId: session.id,
          childSessionId: child.childSessionId,
        }),
      ).rejects.toMatchObject({ code: "invalid_command" });
      await expect(
        runtime.cancelSubagent({ parentSessionId: "other", childSessionId: child.childSessionId }),
      ).rejects.toMatchObject({ code: "invalid_command" });
    } finally {
      await session.close();
    }
  });

  it("超时沿用 timeoutMs，交付 timeout", async () => {
    const { session } = await setup({ childWait: () => 10_000, subagent: { timeoutMs: 200 } });
    try {
      await session.submit({ text: "go" });
      await vi.waitFor(
        () => expect(results(session)[0]?.payload.subagent?.status).toBe("timeout"),
        {
          timeout: 5000,
        },
      );
    } finally {
      await session.close();
    }
  });

  it("唤起的 Turn 触发 TurnStart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-background-hook-"));
    roots.push(root);
    const log = path.join(root, "hooks.log");
    const args = [
      "-e",
      `let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => { const who = JSON.parse(d).subagent ? "child" : "main"; require("fs").appendFileSync(${JSON.stringify(log)}, process.env.NOCTURNE_HOOK_EVENT + ":" + who + "\\n"); })`,
    ];
    const { session } = await setup({ hooks: { TurnStart: [{ command: "node", args }] } });
    try {
      await session.submit({ text: "go" });
      await vi.waitFor(() => expect(turns(session)).toBe(2), { timeout: 5000 });
      // 子会话同样触发 TurnStart（hooks.md 子会话一节），写入顺序不定，排序后比较
      await vi.waitFor(() =>
        expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual([
          "TurnStart:child",
          "TurnStart:main",
          "TurnStart:main",
        ]),
      );
    } finally {
      await session.close();
    }
  });
});

describe("生命周期", () => {
  it("父会话关闭：取消且不交付，子会话收束后才返回", async () => {
    const { runtime, session } = await setup({ childWait: () => 10_000 });
    await session.submit({ text: "go" });
    await session.close();
    expect(results(session)).toHaveLength(0);
    expect(await running(runtime, session.id)).toHaveLength(0);
  });

  it("回退到启动调用之前：取消且不交付", async () => {
    const { runtime, session } = await setup({ childWait: () => 10_000 });
    try {
      await session.submit({ text: "go" });
      const user = must(session.durableEvents().find((event) => event.type === "message.user"));
      await session.rewind(user.seq, "conversation");
      expect(await running(runtime, session.id)).toHaveLength(0);
      expect(session.pendingInputs().items).toHaveLength(0);
      expect(results(session)).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it("分叉不继承运行中的后台子代理，也不补 interrupted", async () => {
    const { runtime, session } = await setup({ childWait: () => 10_000 });
    try {
      await session.submit({ text: "go" });
      const fork = await runtime.resumeSession(await runtime.forkSession(session.id));
      try {
        expect(await running(runtime, fork.id)).toHaveLength(0);
        expect(fork.pendingInputs().items).toHaveLength(0);
        expect(await running(runtime, session.id)).toHaveLength(1);
      } finally {
        await fork.close();
      }
    } finally {
      await session.close();
    }
  });

  it("重启后按父日志补 interrupted 暂停条目，不自动唤起；送达后不再重复", async () => {
    const { runtime, session } = await setup({ childWait: () => 10_000 });
    await session.submit({ text: "go" });
    const id = session.id;
    await session.close();
    const resumed = await runtime.resumeSession(id);
    try {
      expect(resumed.pendingInputs()).toMatchObject({
        paused: true,
        items: [{ mode: "subagent", paused: true }],
      });
      expect(turns(resumed)).toBe(1);
      await resumed.resumeInputs();
      await vi.waitFor(() => expect(results(resumed)).toHaveLength(1));
      expect(results(resumed)[0]?.payload.subagent).toMatchObject({
        callId: taskCompleted(resumed)[0]?.payload.callId,
        status: "interrupted",
        profile: "explore",
      });
      expect(JSON.stringify(results(resumed)[0]?.payload.content)).toContain(
        "Background subagent did not deliver its result before Nocturne restarted. It may have been interrupted, or its result was still waiting to be sent. Re-run it if the result is still needed.",
      );
    } finally {
      await resumed.close();
    }
    const again = await runtime.resumeSession(id);
    try {
      expect(again.pendingInputs().items).toHaveLength(0);
    } finally {
      await again.close();
    }
  });
});

describe("并发", () => {
  it("maxBackground 超出报 subagent_concurrency", async () => {
    const { session } = await setup({
      childWait: () => 10_000,
      subagent: { maxBackground: 1 },
      parent: [[bg("a"), bg("b"), { type: "finish", reason: "tool_calls" }]],
    });
    try {
      await session.submit({ text: "go" });
      const [a, b] = taskCompleted(session);
      expect(a?.payload.status).toBe("ok");
      expect(b?.payload.error?.code).toBe("subagent_concurrency");
    } finally {
      await session.close();
    }
  });

  it("后台占 maxConcurrent 槽直到收束，同步调用此时报 subagent_concurrency", async () => {
    const { session } = await setup({
      childWait: () => 10_000,
      subagent: { maxConcurrent: 1 },
      parent: [
        [bg("a"), { type: "finish", reason: "tool_calls" }],
        [call("s", "task", { task: "sync" }), { type: "finish", reason: "tool_calls" }],
      ],
    });
    try {
      await session.submit({ text: "go" });
      const [, sync] = taskCompleted(session);
      expect(sync?.payload.error?.code).toBe("subagent_concurrency");
    } finally {
      await session.close();
    }
  });
});
