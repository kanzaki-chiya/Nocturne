import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { createPlatform } from "../src/platform/index.js";

import {
  createRuntime,
  RuntimeCommandError,
  type Runtime,
  type RuntimeSession,
} from "../src/index.js";
import {
  FakeProvider,
  ProviderError,
  type FakeScript,
  type ModelInfo,
} from "../src/provider/index.js";
import { replaySessionView, type RuntimeEvent } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

const tmpRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  scripts: FakeScript[] | undefined,
  ws?: string,
  extra?: {
    interactive?: boolean;
    autoApproveAsk?: boolean;
    provider?: FakeProvider;
    providers?: FakeProvider[];
  },
): Promise<{ runtime: Runtime; ws: string; provider: FakeProvider }> {
  const workspace = ws ?? makeTmpDir("nct-rt-ws-");
  const sessionsDir = makeTmpDir("nct-rt-sessions-");
  const provider = extra?.provider ?? new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: workspace,
    sessionsDir,
    providers: extra?.providers ?? [provider],
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
  it("createSession 未指定目录时保留 Runtime 的 workspaceRoot，而非 cwd", async () => {
    const cwd = makeTmpDir("nct-rt-cwd-");
    const workspaceRoot = makeTmpDir("nct-rt-root-");
    const sessionsDir = makeTmpDir("nct-rt-sessions-");
    const runtime = await createRuntime({
      cwd,
      workspaceRoot,
      sessionsDir,
      providers: [new FakeProvider({})],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    try {
      expect(session.state().meta.cwd).toBe(cwd);
      expect(session.state().meta.workspaceRoot).toBe(
        await createPlatform().resolveReal(workspaceRoot),
      );
    } finally {
      await session.close();
    }
  });

  it("偏好方法转交 RuntimeConfig；未注入时读取为空且写入明确拒绝", async () => {
    const root = makeTmpDir("nct-prefs-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "ws");
    const sessionsDir = path.join(root, "sessions");
    const previous = process.env.NOCTURNE_HOME;
    process.env.NOCTURNE_HOME = home;
    try {
      const config = await loadConfig(createPlatform(), {
        nocturneHome: home,
        env: (key) => (key === "NOCTURNE_HOME" ? home : undefined),
      });
      const runtime = await createRuntime({ cwd: workspace, sessionsDir, config });
      expect(runtime.getPreference("theme")).toBeUndefined();
      await runtime.setPreference("theme", "custom-string");
      expect(runtime.getPreference("theme")).toBe("custom-string");
      expect(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))).toMatchObject({
        theme: "custom-string",
      });
      await runtime.setPreference("theme", undefined);
      expect(runtime.getPreference("theme")).toBeUndefined();
      const withoutConfig = await createRuntime({ cwd: workspace, sessionsDir });
      expect(withoutConfig.getPreference("theme")).toBeUndefined();
      await expect(withoutConfig.setPreference("theme", "dark")).rejects.toThrow(
        "未注入 RuntimeConfig，无法保存偏好",
      );
    } finally {
      if (previous === undefined) delete process.env.NOCTURNE_HOME;
      else process.env.NOCTURNE_HOME = previous;
    }
  });
  it("close 等待运行中的 Turn 以 aborted 落盘后才释放会话", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "wait", ms: 100 },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    const turn = session.submit({ text: "close race" });
    await new Promise((r) => setTimeout(r, 20));
    await session.close();
    expect(await turn).toBe("aborted");
    expect(durableTypes(events)).toContain("turn.started");
    expect(events.filter((e) => e.type === "turn.completed")).toMatchObject([
      { payload: { reason: "aborted" } },
    ]);
    expect(durableTypes(events).indexOf("turn.completed")).toBeGreaterThan(
      durableTypes(events).indexOf("turn.started"),
    );
  });

  it("close 在 Provider 重建准备阶段中断并等待 Turn 日志收尾", async () => {
    const workspace = makeTmpDir("nct-rt-ws-");
    const sessionsDir = makeTmpDir("nct-rt-sessions-");
    const config = await loadConfig(createPlatform(), {
      nocturneHome: makeTmpDir("nct-rt-home-"),
      env: () => undefined,
    });
    const runtime = await createRuntime({
      cwd: workspace,
      sessionsDir,
      providers: [new FakeProvider({})],
      config,
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    let begin!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    runtime.updateProviders({
      ...config,
      forWorkspace: async (root) => {
        begin();
        await blocked;
        return config.forWorkspace(root);
      },
    });
    const turn = session.submit({ text: "close during rebuild" });
    await entered;
    expect(session.state().openTurn).toBeUndefined();
    const close = session.close();
    resume();
    await close;
    expect(await turn).toBe("aborted");
    const log = readFileSync(path.join(sessionsDir, `${session.id}.jsonl`), "utf8");
    expect(log).toContain('"type":"turn.started"');
    expect(log).toContain('"type":"turn.completed"');
    expect(log).toContain('"reason":"aborted"');
  });

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
    expect(durableTypes(events).filter((type) => type !== "session.titled")).toEqual([
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

  it.each(["model", "jev"] as const)(
    "smart %s 审查用量计入会话与 Turn，恢复日志不把审查写进上下文",
    async (backend) => {
      const workspace = makeTmpDir("nct-review-ws-");
      writeFileSync(path.join(workspace, "context.txt"), "FILE SNAPSHOT MUST NOT ENTER REVIEW");
      const outside = path.join(makeTmpDir("nct-review-out-"), "result.txt");
      const sessionsDir = makeTmpDir("nct-review-sessions-");
      const config = await loadConfig(createPlatform(), {
        nocturneHome: makeTmpDir("nct-review-home-"),
        env: () => undefined,
      });
      const fetchReview = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          answers: { "0": { choice: "allow", confidence: 0.99 } },
          usage: { input_tokens: 11, output_tokens: 3 },
        }),
      );
      if (backend === "jev") {
        vi.stubGlobal("fetch", fetchReview);
        vi.spyOn(config.credentials, "get").mockImplementation(async (id) =>
          id === "opencode-go" ? "test-key" : undefined,
        );
      }
      await config.updateSettings({
        "permission.reviewer":
          backend === "model"
            ? { backend, model: { provider: "fake", model: "fake-1" } }
            : {
                backend,
                endpoint: "opencode-zen",
                model: "jev-1.13-free",
                credential: { provider: "opencode-go" },
              },
      });
      const provider = new FakeProvider({
        handler: (request) => {
          if (request.tools.length === 0)
            return [
              { type: "text_delta", text: "ALLOW\n用户明确授权写入" },
              { type: "usage", usage: { inputTokens: 11, outputTokens: 3 } },
              { type: "finish", reason: "stop" },
            ];
          if (request.messages.some((m) => m.role === "tool"))
            return [
              { type: "text_delta", text: "done" },
              { type: "finish", reason: "stop" },
            ];
          return [
            {
              type: "tool_call",
              toolCallId: "outside-write",
              name: "write",
              input: { path: outside, content: "approved" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        },
      });
      const runtime = await createRuntime({
        cwd: workspace,
        sessionsDir,
        providers: [provider],
        config,
        interactive: false,
      });
      const session = await runtime.createSession({
        model: "fake/fake-1",
        permissionPreset: "smart",
      });
      const events = collect(session);
      expect(await session.submit({ text: "写入工作区外的 result.txt @context.txt" })).toBe("done");
      expect(readFileSync(outside, "utf8")).toBe("approved");
      expect(events.filter((e) => e.type === "permission.reviewed")).toMatchObject([
        {
          payload: {
            verdict: "allow",
            backend,
            cached: false,
            usage: { inputTokens: 11, outputTokens: 3 },
          },
        },
      ]);
      expect(events.find((e) => e.type === "tool.started")).toMatchObject({
        payload: { permission: { source: "reviewer" } },
      });
      expect(events.find((e) => e.type === "turn.completed")).toMatchObject({
        payload: { usage: { inputTokens: 11, outputTokens: 3 } },
      });
      expect(session.state().usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
      if (backend === "model") {
        const audit = provider.requests.find((r) => r.tools.length === 0);
        if (audit === undefined) throw new Error("未发审查请求");
        expect(
          JSON.parse((audit.messages[0] as { content: { text: string }[] }).content[0]?.text ?? ""),
        ).toMatchObject({ recentUserMessages: ["写入工作区外的 result.txt @context.txt"] });
        expect(audit).toMatchObject({ maxOutputTokens: 300, tools: [] });
        expect(JSON.stringify(audit.messages)).not.toContain("FILE SNAPSHOT MUST NOT ENTER REVIEW");
      } else {
        expect(fetchReview).toHaveBeenCalledOnce();
        const call = fetchReview.mock.calls[0];
        if (!call) throw new Error("未发 Jev 请求");
        const [url, request] = call;
        expect(url).toBe("https://opencode.ai/zen/v1/systemone");
        expect(request?.headers).toMatchObject({
          Authorization: "Bearer test-key",
          "x-opencode-session": session.id,
        });
        const body = JSON.parse(String(request?.body));
        expect(body.state).toMatchObject({
          cwd: workspace,
          recentUserMessages: ["写入工作区外的 result.txt @context.txt"],
        });
        expect(JSON.stringify(body)).not.toContain("FILE SNAPSHOT MUST NOT ENTER REVIEW");
      }
      expect(
        provider.requests
          .at(-1)
          ?.messages.some((m) => JSON.stringify(m).includes("用户明确授权写入")),
      ).toBe(false);
      await session.close();
      const restored = await runtime.resumeSession(session.id);
      expect(restored.state().usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
      expect(restored.state().config.permissionPreset).toBe("smart");
      expect(
        replaySessionView(restored.durableEvents()).entries.find((e) => e.kind === "tool"),
      ).toMatchObject({ review: { verdict: "allow" } });
      await restored.close();
    },
  );

  it("smart 未配置审查器只提示一次，旧日志 full-access 可恢复为 guarded", async () => {
    const { runtime } = await makeRuntime([]);
    const session = await runtime.createSession({
      model: "fake/fake-model",
      permissionPreset: "full-access",
    });
    expect(session.state().config.permissionPreset).toBe("guarded");
    const events = collect(session);
    await session.setPermissionPreset("smart");
    await session.setPermissionPreset("guarded");
    await session.setPermissionPreset("smart");
    expect(
      events.filter(
        (e) => e.type === "runtime.warning" && e.payload.code === "permission_reviewer_missing",
      ),
    ).toHaveLength(1);
    await session.close();
    // 真实旧版日志的两种字段都要能打开，而非只测 API 别名。
    const logPath = internalSession(session).logPath;
    writeFileSync(
      logPath,
      readFileSync(logPath, "utf8")
        .replaceAll('"permissionPreset":"guarded"', '"permissionPreset":"full-access"')
        .replaceAll('"permissionPreset":"smart"', '"permissionPreset":"full-access"'),
    );
    const restored = await runtime.resumeSession(session.id);
    expect(restored.state().config.permissionPreset).toBe("guarded");
    await restored.close();
  });

  it("Turn 进行中切换权限预设：下一次求值用新预设，等待中的请求保持原样（ADR-0036）", async () => {
    const { runtime, ws } = await makeRuntime(
      [
        [
          {
            type: "tool_call",
            toolCallId: "w1",
            name: "write",
            input: { path: "a.txt", content: "first" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "w2",
            name: "write",
            input: { path: "b.txt", content: "second" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
      undefined,
      { interactive: true },
    );
    const session = await runtime.createSession({
      model: "fake/fake-model",
      permissionPreset: "default",
    });
    const events = collect(session);
    const requested = new Promise<string>((resolve) => {
      session.subscribe((e) => {
        if (e.type === "permission.requested") resolve(e.payload.requestId);
      });
    });
    const turn = session.submit({ text: "write two files" });
    const requestId = await requested;

    // Turn 进行中（等待确认）：切换不再拒绝，落 config_changed 并立即重建策略
    await session.setPermissionPreset("bypass");
    expect(session.state().config.permissionPreset).toBe("bypass");
    // 已弹出的请求保持原样：不会因为切到宽松预设而自动放行
    expect(events.some((e) => e.type === "permission.resolved")).toBe(false);
    await session.respondPermission(requestId, { decision: "deny" });

    expect(await turn).toBe("done");
    // 第一个请求按用户决定结算；第二个写入在新预设（bypass）下直接放行
    expect(existsSync(path.join(ws, "a.txt"))).toBe(false);
    expect(readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("second");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    const resolved = events.filter((e) => e.type === "permission.resolved");
    expect(resolved).toMatchObject([{ payload: { action: "deny", source: "user" } }]);
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

  it("durableEvents 经公开方法返回持久事件，内部 Session 不出现在公开会话对象上", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await makeSession(runtime);
    const live: number[] = [];
    session.subscribe((e) => {
      if ("seq" in e) live.push(e.seq);
    });
    await session.submit({ text: "hi" });

    const durable = session.durableEvents();
    expect(durable[0]?.type).toBe("session.created");
    expect(durable.map((e) => e.seq)).toEqual(durable.map((_, i) => i + 1));
    expect(live.every((seq) => durable.some((e) => e.seq === seq))).toBe(true);
    expect(replaySessionView(durable).entries.some((e) => e.kind === "user")).toBe(true);
    // 公开对象的可枚举键里没有内部 Session
    expect(Object.keys(session)).not.toContain("session");
    expect(internalSession(session).durableEvents()).toEqual(durable);
    await session.close();
  });

  it("submit 忙时拒绝 session_busy", async () => {
    const provider = new FakeProvider({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
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
    const { runtime, provider } = await makeRuntime([
      [
        { type: "text_delta", text: "hi" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", text: "again" },
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

    // turnId 编号在恢复后随 turnIndex 继续递增（不再从 1 重新计数）
    const events2 = collect(s2);
    await s2.submit({ text: "second" });
    const started = events2.find((e) => e.type === "turn.started");
    expect(started?.type === "turn.started" && started.payload.turnIndex).toBe(2);
    expect(started?.turnId).toMatch(/^turn-2-/);
    // 环境段的日期取会话创建时间：恢复前后 system 完全相同，缓存前缀不破
    const sys = provider.requests.map((r) => r.system.map((b) => b.text).join("\n"));
    expect(sys).toHaveLength(2);
    expect(sys[1]).toBe(sys[0]);
    expect(sys[0]).toContain(`Session date: ${s2.state().meta.createdAt}`);
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
          input: { path: path.join("..", "..", "outside.txt") },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
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

describe("上下文与运行时命令（Phase 2）", () => {
  const tinyModel: ModelInfo = {
    ref: { provider: "fake", model: "tiny" },
    contextWindow: 8_000,
    maxOutputTokens: 256,
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none",
      imageInput: false,
      promptCache: false,
      editTool: "edit",
    },
  };

  it("L1 修剪：超阈值时写 context.compacted(prune)，工具结果以占位说明回模型", async () => {
    const ws = makeTmpDir("nct-rt-prune-");
    writeFileSync(path.join(ws, "big.txt"), "x".repeat(20_000));
    const provider = new FakeProvider({
      models: [tinyModel],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "r1",
            name: "read",
            input: { path: "big.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, ws, { provider });
    const session = await runtime.createSession({ model: "fake/tiny" });
    const events = collect(session);
    const reason = await session.submit({ text: "read big" });

    expect(reason).toBe("done");
    const compacted = events.find((e) => e.type === "context.compacted");
    expect(compacted?.type === "context.compacted" && compacted.payload.kind).toBe("prune");
    // 修剪后的请求里，工具结果是占位说明而非原文
    const req2 = provider.requests[1];
    const toolMsg = req2?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("输出已省略");
    expect(toolMsg?.role === "tool" && toolMsg.content).not.toContain("xxxx");
    // 修剪事件持久化：折叠后的历史带 inputSummary
    const toolEntry = session.state().history.find((h) => h.kind === "tool");
    expect(toolEntry?.kind === "tool" && toolEntry.inputSummary).toContain("path=");
    await session.close();
  });

  it("超预算且无可行边界：Turn 以 error(compaction_failed) 结束", async () => {
    const impossible: ModelInfo = { ...tinyModel, contextWindow: 500 };
    const provider = new FakeProvider({
      models: [impossible],
      scripts: [[{ type: "finish", reason: "stop" }]],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await runtime.createSession({ model: "fake/tiny" });
    const events = collect(session);
    const reason = await session.submit({ text: "hi" });

    expect(reason).toBe("error");
    const done = events.find((e) => e.type === "turn.completed");
    expect(done?.type === "turn.completed" && done.payload.error?.code).toBe("compaction_failed");
    await session.close();
  });

  it("Provider context_overflow：存在边界时先 prune 再重试", async () => {
    const ws = makeTmpDir("nct-rt-ovf-");
    writeFileSync(path.join(ws, "big.txt"), ("y".repeat(200) + "\n").repeat(100));
    const provider = new FakeProvider({
      // ADR-0037：20k 字符的输出须达到 R，才能测试溢出后的修剪路径。
      models: [
        {
          ...tinyModel,
          ref: { provider: "fake", model: "fake-model" },
          contextWindow: 40_000,
          maxOutputTokens: 8192,
        },
      ],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "r1",
            name: "read",
            input: { path: "big.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "context_overflow", message: "too many tokens" }),
          },
        ],
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, ws, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "go" });

    expect(reason).toBe("done");
    expect(provider.requests).toHaveLength(3);
    const compacted = events.find((e) => e.type === "context.compacted");
    expect(compacted?.type === "context.compacted" && compacted.payload.kind).toBe("prune");
    const req3 = provider.requests[2];
    const toolMsg = req3?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("输出已省略");
    await session.close();
  });

  it("Provider context_overflow：prune 用尽后升级为 L2 摘要，重注入进行中输入", async () => {
    const ws = makeTmpDir("nct-rt-ovf2-");
    writeFileSync(path.join(ws, "big.txt"), ("y".repeat(200) + "\n").repeat(100));
    const provider = new FakeProvider({
      models: [
        {
          ...tinyModel,
          ref: { provider: "fake", model: "fake-model" },
          contextWindow: 40_000,
          maxOutputTokens: 8192,
        },
      ],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "r1",
            name: "read",
            input: { path: "big.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 第 2、3 次模型调用都溢出：第一次触发 prune，第二次升级为 summary
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "context_overflow", message: "too many tokens" }),
          },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "context_overflow", message: "still too many" }),
          },
        ],
        // 摘要调用沿用工具声明，但指令要求不调用。
        [
          { type: "text_delta", text: "自动摘要：读取了大文件 big.txt" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, ws, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "task-go" });

    expect(reason).toBe("done");
    expect(provider.requests).toHaveLength(5);
    const compacted = events.filter((e) => e.type === "context.compacted");
    expect(compacted.map((e) => (e.type === "context.compacted" ? e.payload.kind : ""))).toEqual([
      "prune",
      "summary",
    ]);
    // 摘要请求是第 4 次模型调用：沿用主请求工具声明、输出受限。
    const summaryReq = provider.requests[3];
    expect(summaryReq?.tools).toEqual(provider.requests[2]?.tools);
    expect(summaryReq?.maxOutputTokens).toBeLessThanOrEqual(4_000);
    // 最终请求：摘要覆盖到 tool.completed，且进行中 Turn 的用户输入被重新注入
    const finalText = JSON.stringify(provider.requests[4]?.messages);
    expect(finalText).toContain("会话历史摘要");
    expect(finalText).toContain("自动摘要");
    expect(finalText).toContain("task-go");
    // 原文工具结果不再出现（被摘要覆盖）
    expect(finalText).not.toContain("yyyy");
    await session.close();
  });

  it("Provider context_overflow：L2 摘要失败以 compaction_failed 结束", async () => {
    const ws = makeTmpDir("nct-rt-ovf3-");
    writeFileSync(path.join(ws, "big.txt"), ("y".repeat(200) + "\n").repeat(100));
    const provider = new FakeProvider({
      models: [
        {
          ...tinyModel,
          ref: { provider: "fake", model: "fake-model" },
          contextWindow: 40_000,
          maxOutputTokens: 8192,
        },
      ],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "r1",
            name: "read",
            input: { path: "big.txt" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "context_overflow", message: "too many tokens" }),
          },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "context_overflow", message: "still too many" }),
          },
        ],
        // 摘要调用抛错 → 溢出路径下无可行压缩 → compaction_failed
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "network", message: "summary boom" }),
          },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, ws, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    const reason = await session.submit({ text: "go" });

    expect(reason).toBe("error");
    const done = events.find((e) => e.type === "turn.completed");
    expect(done?.type === "turn.completed" && done.payload.error?.code).toBe("compaction_failed");
    // 摘要失败不写任何 context.compacted 事件（只有成功的 prune 一条）
    const summaries = events.filter(
      (e) => e.type === "context.compacted" && e.payload.kind === "summary",
    );
    expect(summaries).toHaveLength(0);
    await session.close();
  });

  it("compact() 保留最近报错与改动，文件提示在恢复后相同，摘要工具调用被忽略", async () => {
    const ws = makeTmpDir("nct-rt-retain-");
    writeFileSync(path.join(ws, "old.txt"), "旧".repeat(6000));
    writeFileSync(path.join(ws, "recent.txt"), "最新报错 E42：改动后重试");
    const provider = new FakeProvider({
      models: [{ ...tinyModel, contextWindow: 20_000, maxOutputTokens: 1000 }],
      scripts: [
        [
          { type: "tool_call", toolCallId: "old", name: "read", input: { path: "old.txt" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "旧文件已检查" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "tool_call", toolCallId: "recent", name: "read", input: { path: "recent.txt" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "刚修改了最近的报错" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "旧工作摘要" },
          {
            type: "tool_call",
            toolCallId: "ignored",
            name: "edit",
            input: { path: "old.txt", old: "旧", new: "破坏" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, ws, { provider });
    const session = await runtime.createSession({ model: "fake/tiny" });
    await session.submit({ text: "查看旧文件" });
    await session.submit({ text: "检查最新的报错" });
    const events = collect(session);
    await session.compact();
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(0);
    expect(readFileSync(path.join(ws, "old.txt"), "utf8")).toBe("旧".repeat(6000));
    const projected = session.describeContext().request;
    const text = JSON.stringify(projected.messages);
    expect(text).toContain("旧工作摘要");
    expect(text).toContain("本会话最近读过或改过的文件");
    expect(text).toContain("old.txt");
    expect(text).toContain("最新报错 E42：改动后重试");
    expect(text).toContain("刚修改了最近的报错");
    expect(text).not.toContain("旧旧旧");
    await session.close();
    const restored = await runtime.resumeSession(session.id);
    expect(restored.describeContext().request).toEqual(projected);
    await restored.close();
  });

  it("压缩阈值设置即时用于当前与恢复会话的下一 Turn，预防摘要失败只尝试一次", async () => {
    const ws = makeTmpDir("nct-rt-threshold-");
    const config = await loadConfig(createPlatform(), {
      nocturneHome: makeTmpDir("nct-rt-home-"),
      env: () => undefined,
    });
    const provider = new FakeProvider({
      models: [{ ...tinyModel, contextWindow: 20_000, maxOutputTokens: 1000 }],
      scripts: [
        [
          { type: "text_delta", text: "第一轮" },
          { type: "usage", usage: { inputTokens: 16_000, outputTokens: 100 } },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "未压缩" },
          { type: "usage", usage: { inputTokens: 16_100, outputTokens: 100 } },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "tool_call", toolCallId: "ignored", name: "read", input: { path: "never" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "摘要失败仍可继续" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: makeTmpDir("nct-rt-sessions-"),
      providers: [provider],
      config,
    });
    const session = await runtime.createSession({ model: "fake/tiny" });
    await session.submit({ text: "第一轮" });
    await runtime.updateSettings({ "compaction.threshold": "200k" });
    const events = collect(session);
    expect(await session.submit({ text: "第二轮" })).toBe("done");
    expect(provider.requests).toHaveLength(2);
    expect(events.filter((event) => event.type === "context.compacted")).toHaveLength(0);
    await session.close();
    const restored = await runtime.resumeSession(session.id);
    await runtime.updateSettings({ "compaction.threshold": "80%" });
    const resumedEvents = collect(restored);
    expect(await restored.submit({ text: "第三轮" })).toBe("done");
    expect(provider.requests).toHaveLength(4);
    expect(
      resumedEvents.filter(
        (event) => event.type === "runtime.warning" && event.payload.code === "compaction_failed",
      ),
    ).toHaveLength(1);
    expect(
      resumedEvents.filter(
        (event) => event.type === "context.compacted" || event.type === "tool.started",
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(provider.requests[3]?.messages)).toContain("第一轮");
    expect(provider.requests[2]?.reasoningEffort).toBeUndefined();
    await restored.close();
  });

  it("预防摘要失败后上游溢出，仍可尝试尚未用过的修剪且不重复摘要", async () => {
    const ws = makeTmpDir("nct-rt-failed-summary-");
    writeFileSync(path.join(ws, "large.txt"), ("新".repeat(100) + "\n").repeat(50));
    const config = await loadConfig(createPlatform(), {
      nocturneHome: makeTmpDir("nct-rt-home-"),
      env: () => undefined,
    });
    await config.updateSettings({ "compaction.threshold": "80%" });
    const provider = new FakeProvider({
      models: [{ ...tinyModel, contextWindow: 20_000, maxOutputTokens: 1000 }],
      scripts: [
        [
          { type: "text_delta", text: "第一轮" },
          { type: "usage", usage: { inputTokens: 16_000, outputTokens: 100 } },
          { type: "finish", reason: "stop" },
        ],
        [{ type: "finish", reason: "stop" }],
        [
          { type: "tool_call", toolCallId: "read", name: "read", input: { path: "large.txt" } },
          { type: "usage", usage: { inputTokens: 1000, outputTokens: 100 } },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "throw",
            error: new ProviderError({ kind: "context_overflow", message: "too many" }),
          },
        ],
        [
          { type: "text_delta", text: "修剪后继续" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: makeTmpDir("nct-rt-sessions-"),
      providers: [provider],
      config,
    });
    const session = await runtime.createSession({ model: "fake/tiny" });
    await session.submit({ text: "第一轮" });
    const events = collect(session);
    expect(await session.submit({ text: "读取大文件" })).toBe("done");
    expect(provider.requests).toHaveLength(5);
    expect(
      events
        .filter((event) => event.type === "context.compacted")
        .map((event) => event.payload.kind),
    ).toEqual(["prune"]);
    expect(
      events.filter(
        (event) => event.type === "runtime.warning" && event.payload.code === "compaction_failed",
      ),
    ).toHaveLength(1);
    await session.close();
  });

  it("compact()：一次模型调用写 context.compacted(summary)，历史被折叠", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "首轮回复" },
          { type: "finish", reason: "stop" },
        ],
        // compact 的摘要调用
        [
          { type: "text_delta", text: "摘要：用户要求打招呼，已回复。" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "第二轮" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "hi" });

    await session.compact();
    const compacted = events.find((e) => e.type === "context.compacted");
    expect(compacted?.type === "context.compacted" && compacted.payload.kind).toBe("summary");
    expect(compacted?.type === "context.compacted" && compacted.payload.summary).toContain("摘要");
    // 摘要请求沿用主请求投影。
    const summaryReq = provider.requests[1];
    expect(summaryReq?.tools).toEqual(provider.requests[0]?.tools);
    const userMsg = summaryReq?.messages.find((m) => m.role === "user");
    expect(userMsg?.role === "user" && JSON.stringify(userMsg.content)).toContain("hi");

    // 后续请求只携带摘要，不重复原文
    await session.submit({ text: "again" });
    const req3 = provider.requests[2];
    const texts = JSON.stringify(req3?.messages);
    expect(texts).toContain("会话历史摘要");
    await session.close();
  });

  it("compact() 重复调用：无新内容时 compaction_failed，不再写摘要事件", async () => {
    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "首轮回复" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "SUMMARY1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "第二轮回复" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "SUMMARY2" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "hi" });
    await session.compact();

    const callsAfterFirst = provider.requests.length;
    // 没有新可压缩内容：同一批历史不得再压出第二份摘要
    await expect(session.compact()).rejects.toMatchObject({ code: "compaction_failed" });
    expect(provider.requests.length).toBe(callsAfterFirst);
    const summaries = events.filter(
      (e) => e.type === "context.compacted" && e.payload.kind === "summary",
    );
    expect(summaries).toHaveLength(1);

    // 新 Turn 产生新边界后，第二次压缩才能成功并覆盖更广范围
    await session.submit({ text: "again" });
    await session.compact();
    const all = events.filter(
      (e) => e.type === "context.compacted" && e.payload.kind === "summary",
    );
    expect(all).toHaveLength(2);
    const second = all[1];
    expect(second?.type === "context.compacted" && second.payload.summary).toContain("SUMMARY2");
    await session.close();
  });

  it("setModel：strictModels=false 的 Provider 接受清单外模型 id", async () => {
    const provider = new FakeProvider({
      strictModels: false,
      models: [tinyModel],
      scripts: [[{ type: "finish", reason: "stop" }]],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await runtime.createSession({ model: "fake/tiny" });
    const events = collect(session);

    await session.setModel("fake/any-model-id");
    const changed = events.find((e) => e.type === "session.config_changed");
    expect(changed?.type === "session.config_changed" && changed.payload.model).toEqual({
      provider: "fake",
      model: "any-model-id",
    });
    expect(session.state().config.model.model).toBe("any-model-id");
    await session.close();
  });

  it("compact 并发约束：Turn 进行中 session_busy；压缩进行中 compaction_in_progress", async () => {
    const provider = new FakeProvider({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return [
          { type: "text_delta", text: "s" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await makeSession(runtime);
    await session.submit({ text: "seed" });

    // Turn 进行中
    const turn = session.submit({ text: "busy" });
    await expect(session.compact()).rejects.toMatchObject({ code: "session_busy" });
    await turn;

    // 压缩进行中（compacting 状态在 compact() 调用内同步发出，先订阅再启动）
    const compacting = new Promise<void>((resolve) => {
      const unsub = session.subscribe((e) => {
        if (e.type === "runtime.status" && e.payload.status === "compacting") {
          unsub();
          resolve();
        }
      });
    });
    const first = session.compact();
    await compacting;
    await expect(session.compact()).rejects.toMatchObject({
      code: "compaction_in_progress",
    });
    await first;
    await session.close();
  });

  it("interrupt 中断 compact：compaction_interrupted，不写任何压缩事件", async () => {
    const provider = new FakeProvider({
      handler: async (_req, i) => {
        if (i === 0) {
          return [
            { type: "text_delta", text: "seed" },
            { type: "finish", reason: "stop" },
          ];
        }
        await new Promise((r) => setTimeout(r, 300));
        return [
          { type: "text_delta", text: "late" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await makeSession(runtime);
    const events = collect(session);
    await session.submit({ text: "seed" });

    session.subscribe((e) => {
      if (e.type === "runtime.status" && e.payload.status === "compacting") {
        session.interrupt();
      }
    });
    await expect(session.compact()).rejects.toMatchObject({
      code: "compaction_interrupted",
    });
    expect(events.some((e) => e.type === "context.compacted")).toBe(false);
    // 会话仍可继续使用
    const reason = await session.submit({ text: "after" });
    expect(reason).toBe("done");
    await session.close();
  });

  it("setModel：config_changed + 后续请求走新模型；未知模型 invalid_model", async () => {
    const p1 = new FakeProvider({
      id: "fake",
      models: [tinyModel],
      scripts: [[{ type: "finish", reason: "stop" }]],
    });
    const p2 = new FakeProvider({
      id: "fake2",
      models: [
        {
          ref: { provider: "fake2", model: "m2" },
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "none",
            imageInput: false,
            promptCache: false,
            editTool: "edit",
          },
        },
      ],
      scripts: [
        [
          { type: "text_delta", text: "from-m2" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, undefined, {
      provider: p1,
      providers: [p1, p2],
    });
    const session = await runtime.createSession({ model: "fake/tiny" });
    const events = collect(session);

    await session.setModel("fake2/m2");
    const changed = events.find((e) => e.type === "session.config_changed");
    expect(changed?.type === "session.config_changed" && changed.payload.model).toEqual({
      provider: "fake2",
      model: "m2",
    });
    expect(session.state().config.model).toEqual({ provider: "fake2", model: "m2" });

    await session.submit({ text: "hi" });
    expect(p2.requests).toHaveLength(1);
    expect(p1.requests).toHaveLength(0);

    await expect(session.setModel("nope/x")).rejects.toMatchObject({
      code: "invalid_model",
    });
    await expect(session.setModel("fake/unknown-model")).rejects.toMatchObject({
      code: "invalid_model",
    });
    await session.close();
  });

  it("editTool 能力：换模型后下一次请求的工具单随之变化（ADR-0035 §5）", async () => {
    const patchModel: ModelInfo = {
      ...tinyModel,
      ref: { provider: "fake", model: "patchy" },
      capabilities: { ...tinyModel.capabilities, editTool: "apply_patch" },
    };
    const provider = new FakeProvider({
      models: [tinyModel, patchModel],
      // finish-only 脚本算空响应会触发重试——带一个 text_delta
      // 让每次 submit 恰好消耗一份脚本
      scripts: [
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await runtime.createSession({ model: "fake/tiny" });

    await session.submit({ text: "hi" });
    const names = (i: number) => provider.requests[i]?.tools.map((t) => t.name) ?? [];
    expect(names(0)).toContain("edit");
    expect(names(0)).toContain("write");
    expect(names(0)).not.toContain("apply_patch");

    await session.setModel("fake/patchy");
    await session.submit({ text: "hi" });
    expect(names(1)).toContain("apply_patch");
    expect(names(1)).not.toContain("edit");
    expect(names(1)).not.toContain("write");
    // 非编辑工具不受影响
    expect(names(1)).toContain("read");

    // 系统提示对编辑工具中性：两套工具下是同一份文本（缓存前缀不破）
    const sys = provider.requests.map((r) => r.system.map((b) => b.text).join("\n"));
    expect(sys[0]).toBe(sys[1]);
    expect(sys[0]).toContain("File-editing tools");
    expect(sys[0]).not.toMatch(/\bapply_patch\b/);
    expect(sys[0]).not.toMatch(/\bedit\b/);
    expect(sys[0]).not.toMatch(/\bwrite\b/);
    await session.close();
  }, 20_000);

  it("setModel / compact 在 Turn 进行中拒绝 session_busy", async () => {
    const provider = new FakeProvider({
      handler: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return [{ type: "finish", reason: "stop" }];
      },
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    const session = await makeSession(runtime);
    const turn = session.submit({ text: "slow" });
    await expect(session.setModel("fake/fake-1")).rejects.toMatchObject({
      code: "session_busy",
    });
    await turn;
    await session.close();
  });

  it("describeContext 返回报告；runtime.listModels 汇总各 Provider", async () => {
    const { runtime } = await makeRuntime([
      [
        { type: "text_delta", text: "hi" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = await makeSession(runtime);
    await session.submit({ text: "x" });

    const built = session.describeContext();
    expect(built.report.budgetTokens).toBeGreaterThan(0);
    expect(built.report.sections.map((s) => s.name)).toContain("history");
    expect(built.overBudget).toBe(false);

    const models = runtime.listModels();
    expect(models.some((m) => m.ref.provider === "fake")).toBe(true);
    await session.close();
  });
});

// ── 按模型协议（ADR-0026）───────────────────────────────

describe("按模型协议（ADR-0026）", () => {
  const entryOf = (endpoints: Record<string, string[]>) => ({
    id: "gw",
    type: "openai-compatible",
    baseURL: "https://gw.test/v1",
    models: Object.fromEntries(
      Object.entries(endpoints).map(([id, eps]) => [id, { endpoints: eps }]),
    ),
  });

  const writeProviders = (home: string, providers: unknown[]) =>
    writeFileSync(path.join(home, "providers.json"), JSON.stringify({ version: 1, providers }));

  it("清单照常列出不可用模型并带 reason；createSession/setModel 拒绝", async () => {
    const workspace = makeTmpDir("nct-rt-ws-");
    const sessionsDir = makeTmpDir("nct-rt-sessions-");
    const home = makeTmpDir("nct-rt-home-");
    writeProviders(home, [
      entryOf({
        chat: ["/chat/completions"],
        msg: ["/messages"],
        resp: ["/responses"],
        bad: ["/embeddings"],
      }),
    ]);
    const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
    const runtime = await createRuntime({ cwd: workspace, sessionsDir, config });

    // 模型页：不可用模型照常列出并带说明；三协议各按 endpoints 盖章
    const models = runtime.listModels();
    const bad = models.find((m) => m.ref.model === "bad");
    expect(bad?.unavailable?.reason).toContain("没有可用的服务协议");
    expect(bad?.protocol).toBeUndefined();
    expect(models.find((m) => m.ref.model === "chat")?.protocol).toBe("openai-compatible");
    expect(models.find((m) => m.ref.model === "msg")?.protocol).toBe("anthropic");
    // /responses-only → openai-responses（ADR-0031 §1），不再是不可用
    const resp = models.find((m) => m.ref.model === "resp");
    expect(resp?.protocol).toBe("openai-responses");
    expect(resp?.unavailable).toBeUndefined();

    // --model / createSession 选到不可用模型即拒绝
    await expect(runtime.createSession({ model: "gw/bad" })).rejects.toMatchObject({
      code: "invalid_model",
    });

    const session = await runtime.createSession({ model: "gw/chat" });
    // /model 等价路径：setModel 拒绝并给同一说明
    await expect(session.setModel("gw/bad")).rejects.toMatchObject({
      code: "invalid_model",
    });
    expect(session.state().config.model.model).toBe("chat");
    await session.close();
  });

  it("刷新后模型变为不可用：下一轮发请求前以说明结束，不发 HTTP", async () => {
    const workspace = makeTmpDir("nct-rt-ws-");
    const sessionsDir = makeTmpDir("nct-rt-sessions-");
    const home = makeTmpDir("nct-rt-home-");
    writeProviders(home, [entryOf({ m1: ["/chat/completions"] })]);
    const platform = createPlatform();
    const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
    const runtime = await createRuntime({ cwd: workspace, sessionsDir, config });
    const session = await runtime.createSession({ model: "gw/m1" });

    // 模拟 refresh 后上游只剩无法识别的接口：同一条目下该模型变为不可用
    writeProviders(home, [entryOf({ m1: ["/embeddings"] })]);
    runtime.updateProviders(
      await loadConfig(platform, { nocturneHome: home, env: () => undefined }),
    );

    await expect(session.submit({ text: "hi" })).rejects.toMatchObject({
      code: "invalid_model",
    });
    await session.close();
  });

  it("message.assistant 记录生效协议；无协议的 Provider 不写该字段", async () => {
    const protoModel: ModelInfo = {
      ref: { provider: "fake", model: "fake-1" },
      protocol: "anthropic",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: "none",
        imageInput: false,
        promptCache: false,
        editTool: "edit",
      },
    };
    const provider = new FakeProvider({
      models: [protoModel],
      scripts: [
        [
          { type: "text_delta", text: "x" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = await makeRuntime(undefined, undefined, { provider });
    // 清单内模型（ref.model=fake-1）才能拿到声明的 protocol
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const events = collect(session);
    await session.submit({ text: "hi" });
    const assistant = events.find((e) => e.type === "message.assistant");
    expect(assistant?.type === "message.assistant" && assistant.payload.protocol).toBe("anthropic");
    await session.close();
  });
});
