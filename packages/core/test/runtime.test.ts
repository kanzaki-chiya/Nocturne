import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  RuntimeCommandError,
  type Runtime,
  type RuntimeSession,
} from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

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

async function makeRuntime(
  scripts: FakeScript[][] | FakeScript[] | undefined,
  ws?: string,
  extra?: { interactive?: boolean; autoApproveAsk?: boolean },
): Promise<{ runtime: Runtime; ws: string; provider: FakeProvider }> {
  const workspace = ws ?? makeTmpDir("nct-rt-ws-");
  const sessionsDir = makeTmpDir("nct-rt-sessions-");
  const provider = new FakeProvider({ scripts: scripts as FakeScript[] | undefined });
  const runtime = await createRuntime({
    cwd: workspace,
    sessionsDir,
    providers: [provider],
    interactive: extra?.interactive,
    permissions: extra?.autoApproveAsk === true ? { autoApproveAsk: true } : undefined,
  });
  return { runtime, ws: workspace, provider };
}

const makeSession = (runtime: Runtime) => runtime.createSession({ model: "fake/fake-model" });

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

const durableTypes = (events: RuntimeEvent[]) =>
  events.filter((e): e is Extract<RuntimeEvent, { seq: number }> => "seq" in e).map((e) => e.type);

describe("公开 Runtime API", () => {
  it("createRuntime → createSession → submit：完整 Turn 经公开 API 走通", async () => {
    const { runtime, ws, provider } = await makeRuntime([
      [
        { type: "text_delta", text: "reading" },
        {
          type: "tool_call",
          toolCallId: "t1",
          name: "read",
          input: { path: "a.txt" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done!" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    writeFileSync(path.join(ws, "a.txt"), "content-A");

    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "read a.txt" });

    expect(reason).toBe("done");
    expect(durableTypes(events)).toEqual([
      "turn.started",
      "message.user",
      "message.assistant",
      "tool.started",
      "tool.completed",
      "message.assistant",
      "turn.completed",
    ]);
    // 工具结果回到第二次模型请求
    const req2 = provider.requests[1];
    const toolMsg = req2?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("content-A");
    await session.close();
  });

  it("模型字符串解析：非法形式抛 invalid_command", async () => {
    const { runtime } = await makeRuntime([]);
    await expect(runtime.createSession({ model: "nomodel" })).rejects.toMatchObject({
      code: "invalid_command",
    });
    await expect(runtime.createSession({ model: "unknown/m" })).rejects.toThrow(
      /未配置的 Provider/,
    );
  });

  it("submit 忙时拒绝 session_busy", async () => {
    const provider = new FakeProvider({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return [{ type: "finish", reason: "stop" }];
      },
    });
    const rt = await createRuntime({
      cwd: makeTmpDir("nct-rt-busy-"),
      sessionsDir: makeTmpDir("nct-rt-sessions-"),
      providers: [provider],
    });
    const session = await makeSession(rt);
    const turn = session.submit({ text: "hi" });
    await expect(session.submit({ text: "again" })).rejects.toMatchObject({
      code: "session_busy",
    });
    expect(await turn).toBe("done");
  });

  it("interrupt 中断运行中的 Turn", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "text_delta", text: "1" },
        { type: "text_delta", text: "2" },
        { type: "text_delta", text: "3" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await makeSession(runtime);
    session.subscribe((e) => {
      if (e.type === "message.assistant.delta") session.interrupt();
    });
    const reason = await session.submit({ text: "hi" });
    expect(reason).toBe("aborted");
  });

  it("respondPermission：Phase 1 无等待请求 → unknown_request", async () => {
    const { runtime } = await makeRuntime([]);
    const session = await makeSession(runtime);
    await expect(session.respondPermission("req-1", { decision: "allow" })).rejects.toMatchObject({
      code: "unknown_request",
    });
    expect(RuntimeCommandError).toBeDefined();
  });

  it("resumeSession：重开后状态一致，可继续 submit", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "text_delta", text: "hi" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const s1 = await makeSession(runtime);
    await s1.submit({ text: "first" });
    const id = s1.id;
    await s1.close();

    const s2 = await runtime.resumeSession(id);
    expect(s2.id).toBe(id);
    expect(s2.state().history.length).toBeGreaterThan(0);
    await s2.close();
  });

  it("listSessions 返回已创建会话", async () => {
    const { runtime } = await makeRuntime([]);
    const s = await makeSession(runtime);
    const list = await runtime.listSessions();
    expect(list.some((x) => x.id === s.id)).toBe(true);
  });

  it("工作区边界：越界读取在公开 API 路径下被拒绝", async () => {
    const { runtime } = await makeRuntime([
      [
        {
          type: "tool_call",
          toolCallId: "e",
          name: "read",
          input: { path: "..\\..\\outside.txt" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "finish", reason: "stop" }],
    ]);
    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "escape" });
    expect(reason).toBe("done");
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
  });

  it("junction 指向工作区外：经公开 API 的 read 被拒绝", async () => {
    const ws = makeTmpDir("nct-rt-jws-");
    const outside = makeTmpDir("nct-rt-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "SECRET");
    const link = path.join(ws, "linkdir");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // 平台不支持创建 junction 时跳过
    }
    const { runtime } = await makeRuntime(
      [
        [
          {
            type: "tool_call",
            toolCallId: "j",
            name: "read",
            input: { path: path.join("linkdir", "secret.txt") },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      ws,
    );
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "junction escape" });
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
  });

  it("grep/glob 不泄漏工作区外资源（junction 目录不跟随）", async () => {
    const ws = makeTmpDir("nct-rt-gws-");
    const outside = makeTmpDir("nct-rt-goutside-");
    writeFileSync(path.join(outside, "hidden.txt"), "SECRET_TOKEN");
    writeFileSync(path.join(ws, "inside.txt"), "hello");
    try {
      symlinkSync(outside, path.join(ws, "ext"), "junction");
    } catch {
      return;
    }
    const { runtime } = await makeRuntime(
      [
        [
          {
            type: "tool_call",
            toolCallId: "g",
            name: "grep",
            input: { pattern: "SECRET_TOKEN" },
          },
          {
            type: "tool_call",
            toolCallId: "l",
            name: "glob",
            input: { pattern: "**/*.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      ws,
    );
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "scan" });
    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(2);
    for (const c of completed) {
      const content = c.type === "tool.completed" ? String(c.payload.modelContent) : "";
      expect(content).not.toContain("SECRET_TOKEN");
      expect(content).not.toContain("hidden.txt");
    }
  });
});

describe("ask 权限流程（Phase 2 default 预设）", () => {
  const writeThenDone = (rel: string): FakeScript[] => [
    [
      {
        type: "tool_call",
        toolCallId: "w1",
        name: "write",
        input: { path: rel, content: "written-by-agent" },
      },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "stop" },
    ],
  ];

  it("ask → 允许：permission.requested → respondPermission(allow) → 写入成功", async () => {
    const { runtime, ws } = await makeRuntime(writeThenDone("out.txt"), undefined, {
      interactive: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, { decision: "allow" });
      }
    });
    const reason = await session.submit({ text: "write" });

    expect(reason).toBe("done");
    expect(readFileSync(path.join(ws, "out.txt"), "utf8")).toBe("written-by-agent");
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.type === "permission.resolved" && resolved.payload.action).toBe("allow");
    expect(resolved?.type === "permission.resolved" && resolved.payload.source).toBe("user");
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await session.close();
  });

  it("ask → 拒绝：tool.completed denied + resolved(user)，反馈回模型", async () => {
    const { runtime, ws, provider } = await makeRuntime(writeThenDone("out.txt"), undefined, {
      interactive: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, {
          decision: "deny",
          feedback: "不要写这个文件",
        });
      }
    });
    const reason = await session.submit({ text: "write" });

    expect(reason).toBe("done");
    expect(existsSync(path.join(ws, "out.txt"))).toBe(false);
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.type === "permission.resolved" && resolved.payload.action).toBe("deny");
    expect(resolved?.type === "permission.resolved" && resolved.payload.source).toBe("user");
    expect(resolved?.type === "permission.resolved" && resolved.payload.feedback).toBe(
      "不要写这个文件",
    );
    // 反馈随 tool.completed 的 modelContent 回到模型
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("不要写这个文件");
    await session.close();
  });

  it("非交互模式：ask 一律拒绝（source=non_interactive），不发 permission.requested", async () => {
    const { runtime, ws } = await makeRuntime(writeThenDone("out.txt"));
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "write" });

    expect(existsSync(path.join(ws, "out.txt"))).toBe(false);
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.type === "permission.resolved" && resolved.payload.source).toBe(
      "non_interactive",
    );
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
    await session.close();
  });

  it("--yes（autoApproveAsk）：非交互下 ask 被自动批准为 allow", async () => {
    const { runtime, ws } = await makeRuntime(writeThenDone("out.txt"), undefined, {
      autoApproveAsk: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "write" });

    expect(reason).toBe("done");
    expect(readFileSync(path.join(ws, "out.txt"), "utf8")).toBe("written-by-agent");
    // 直接 allow：无 requested/resolved 事件（走规则通道）
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    const started = events.find((e) => e.type === "tool.started");
    expect(started?.type === "tool.started" && started.payload.permission.source).toBe("rule");
    await session.close();
  });

  it("reply.remember 被忽略：同一 Turn 的下一次写仍需确认", async () => {
    const { runtime } = await makeRuntime(
      [
        [
          {
            type: "tool_call",
            toolCallId: "w1",
            name: "write",
            input: { path: "a.txt", content: "A" },
          },
          {
            type: "tool_call",
            toolCallId: "w2",
            name: "write",
            input: { path: "b.txt", content: "B" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
      undefined,
      { interactive: true },
    );
    const session = await makeSession(runtime);
    const requested: string[] = [];
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        requested.push(e.payload.requestId);
        void session.respondPermission(e.payload.requestId, {
          decision: "allow",
          remember: "session",
        });
      }
    });
    await session.submit({ text: "write two" });
    // 两次写各自触发了 requested：remember 没有产生持久授权
    expect(requested).toHaveLength(2);
    await session.close();
  });

  it("ask 等待期间中断：resolved(cancelled) + 调用结算为 cancelled", async () => {
    const { runtime } = await makeRuntime(writeThenDone("out.txt"), undefined, {
      interactive: true,
    });
    const session = await makeSession(runtime);
    const events = collect(session);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        session.interrupt();
      }
    });
    const reason = await session.submit({ text: "write" });

    expect(reason).toBe("aborted");
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.type === "permission.resolved" && resolved.payload.source).toBe("cancelled");
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("cancelled");
    await session.close();
  });

  it("deny + stop：Turn 以 aborted 结束", async () => {
    const { runtime } = await makeRuntime(writeThenDone("out.txt"), undefined, {
      interactive: true,
    });
    const session = await makeSession(runtime);
    session.subscribe((e) => {
      if (e.type === "permission.requested") {
        void session.respondPermission(e.payload.requestId, {
          decision: "deny",
          stop: true,
        });
      }
    });
    const reason = await session.submit({ text: "write" });
    expect(reason).toBe("aborted");
    await session.close();
  });
});
